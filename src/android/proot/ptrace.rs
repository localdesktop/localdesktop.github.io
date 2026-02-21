use nix::fcntl::{fcntl, FcntlArg, OFlag};
use nix::sys::ptrace::AddressType;
use nix::sys::{ptrace, wait};
use nix::unistd::Pid;
use std::{
    collections::HashMap,
    ffi::{CString, OsString},
    io::Read,
    os::unix::ffi::OsStrExt,
    os::unix::process::CommandExt,
    path::Path,
    process::{Command, Stdio},
};
use std::{fs, mem};

pub struct Args<'a> {
    pub command: Command,
    pub rootfs: String,
    pub binds: Vec<(String, String)>, // host_path:guest_path
    // Path to the external loader-shim binary.
    pub shim_exe: OsString,
    pub log: Option<Box<dyn FnMut(String) + 'a>>,
}

pub fn rootless_chroot<'a>(args: Args<'a>) -> i32 {
    rootless_chroot_ptrace(args)
}

fn rootless_chroot_ptrace<'a>(mut args: Args<'a>) -> i32 {
    // Emulate chroot by running the child from rootfs and mapping guest paths
    // into paths relative to that directory.
    //
    // Why ptrace path rewriting (instead of `chroot(2)` / mount namespaces):
    // - On Android/Termux we typically don't have privileges for real `chroot` or mounts.
    // - So we keep the host filesystem as-is and "lie" to the tracee by rewriting path
    //   arguments at the syscall boundary.
    let mappings = build_path_mappings(&args.rootfs, &args.binds);
    let rootfs_abs =
        fs::canonicalize(&args.rootfs).unwrap_or_else(|_| Path::new(&args.rootfs).to_path_buf());
    let rootfs_abs_s = rootfs_abs.to_string_lossy().to_string();

    // Build the command:
    // - Use external loader-shim for dynamically-linked guest ELFs.
    // - Otherwise execute directly (legacy behavior used by tests like `can_ls_root`).
    let shim_exe = args.shim_exe.clone();
    let mut command = args.command;
    if let Some(prepared) = maybe_wrap_with_external_loader_shim(&command, &args.rootfs, &shim_exe)
    {
        command = prepared;
    } else {
        command = remap_command_program_in_rootfs(command, &args.rootfs, &mappings);
    }
    command.env_remove("LD_PRELOAD");
    command.current_dir(&args.rootfs);

    // Pipe stdout/stderr to Rust
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    // PTRACE_TRACE_ME
    unsafe {
        command.pre_exec(|| Ok(ptrace::traceme()?));
    }

    // Spawn it
    let mut child = command.spawn().unwrap();
    let pid = Pid::from_raw(child.id() as i32);
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();

    // Make stdout/stderr non-blocking
    let flags = OFlag::from_bits_truncate(fcntl(&stdout, FcntlArg::F_GETFL).unwrap());
    fcntl(&stdout, FcntlArg::F_SETFL(flags | OFlag::O_NONBLOCK)).unwrap();
    let flags = OFlag::from_bits_truncate(fcntl(&stderr, FcntlArg::F_GETFL).unwrap());
    fcntl(&stderr, FcntlArg::F_SETFL(flags | OFlag::O_NONBLOCK)).unwrap();

    // Wait for the initial exec stop and enable syscall-stops.
    wait::waitpid(pid, None).unwrap();
    // Debug-only startup maps dump.
    let trace_opts = ptrace::Options::PTRACE_O_TRACESYSGOOD
        | ptrace::Options::PTRACE_O_TRACECLONE
        | ptrace::Options::PTRACE_O_TRACEFORK
        | ptrace::Options::PTRACE_O_TRACEVFORK
        | ptrace::Options::PTRACE_O_TRACEEXEC
        | ptrace::Options::PTRACE_O_EXITKILL;
    let _ = ptrace::setoptions(pid, trace_opts);
    let _ = ptrace::syscall(pid, None);

    // Prepare to read stdout/stderr non-blockingly
    let mut buf = [0u8; 4096];
    let mut carry = String::new();
    let mut carry_err = String::new();
    let mut in_syscall_fallback: HashMap<Pid, bool> = HashMap::new();
    let mut pending_sp_restore: HashMap<Pid, PendingSysenterRestore> = HashMap::new();
    let do_rewrite = true;
    let mut step_remaining: Option<u32> = None;
    // Mitigation: glibc ld-linux writes TPIDR_EL0 early. On Android, linker64 assumes TPIDR_EL0
    // points to bionic TLS and can crash in its signal handler if the guest changes it.
    // We patch the guest ld-linux's `msr TPIDR_EL0, x0` instructions to NOP once it's mapped.
    // With loader_shim unmapping linker64 and installing its own signal/restorer plumbing,
    // we want glibc's ld-linux to manage TPIDR_EL0 normally (don't patch out the MSR).
    let mut patched_guest_tpidr_msr = true;
    let mut exit_code: i32 = 1;
    loop {
        match wait::waitpid(Pid::from_raw(-1), Some(wait::WaitPidFlag::__WALL)) {
            Ok(wait::WaitStatus::PtraceSyscall(tracee)) => {
                drain_stdout(&mut stdout, &mut buf, &mut carry, &mut args.log);
                drain_stdout(&mut stderr, &mut buf, &mut carry_err, &mut args.log);

                let is_entry = ptrace_syscall_is_entry(tracee, &mut in_syscall_fallback);
                if let Ok(regs) = read_regs(tracee) {
                    if !patched_guest_tpidr_msr {
                        if let Ok(maps_txt) =
                            fs::read_to_string(format!("/proc/{}/maps", tracee))
                        {
                            if let Some(line) = maps_txt.lines().find(|l| {
                                l.contains("archfs/usr/lib/ld-linux-aarch64.so.1")
                                    && l.contains("r-xp")
                            }) {
                                if let Some((start, _end)) = parse_map_range(line) {
                                    let nop = 0xd503201fu32.to_le_bytes(); // AArch64 NOP
                                                                           // Offsets observed in this rootfs build via `llvm-objdump -d`.
                                    for off in [0x16ed0u64, 0x19da0u64] {
                                        let addr = start + off;
                                        let _ = write_bytes(tracee, addr as usize, &nop);
                                    }
                                    eprintln!(
                                        "patched guest ld-linux: disabled TPIDR_EL0 writes (base=0x{start:x})"
                                    );
                                    patched_guest_tpidr_msr = true;
                                }
                            }
                        }
                    }

                    let is_guest = should_rewrite_from_pc(tracee, regs.pc, &rootfs_abs_s);

                    if do_rewrite && is_entry && is_guest {
                        match rewrite_syscall_path_with_regs(tracee, regs, &mappings) {
                            Ok(Some(r)) => {
                                pending_sp_restore.insert(tracee, r);
                            }
                            Ok(None) => {}
                            Err(e) => eprintln!("rewrite error: {e}"),
                        }
                    }
                    if !is_entry {
                        if let Some(r) = pending_sp_restore.remove(&tracee) {
                            if let Ok(mut regs_exit) = read_regs(tracee) {
                                if let Some((mapped_path, mode, flags)) = r.access_emu.as_ref() {
                                    let ret = regs_exit.regs[0] as i64;
                                    if ret == -(nix::libc::ENETDOWN as i64)
                                        || (r.syscall == nix::libc::SYS_faccessat2
                                            && ret == -(nix::libc::EINVAL as i64))
                                    {
                                        let fixed = emulate_faccessat_result(
                                            tracee,
                                            mapped_path,
                                            *mode,
                                            *flags,
                                        );
                                        regs_exit.regs[0] = fixed as u64;
                                    }
                                }
                                regs_exit.sp = r.original_sp;
                                let _ = write_regs(tracee, &regs_exit);
                            }
                        }
                    }

                    if !is_entry
                        && is_guest
                        && (regs.regs[8] as i64) == nix::libc::SYS_set_robust_list
                    {
                        step_remaining = Some(32);
                    }
                }

                if let Some(rem) = step_remaining {
                    if rem <= 1 {
                        step_remaining = None;
                        let _ = ptrace::syscall(tracee, None);
                    } else {
                        step_remaining = Some(rem - 1);
                        let _ = ptrace::step(tracee, None);
                    }
                } else {
                    let _ = ptrace::syscall(tracee, None);
                }
            }
            Ok(wait::WaitStatus::Stopped(tracee, sig)) => {
                drain_stdout(&mut stdout, &mut buf, &mut carry, &mut args.log);
                drain_stdout(&mut stderr, &mut buf, &mut carry_err, &mut args.log);

                if step_remaining.is_some() && sig == nix::sys::signal::Signal::SIGTRAP {
                    if let Some(rem) = step_remaining {
                        if rem <= 1 {
                            step_remaining = None;
                            let _ = ptrace::syscall(tracee, None);
                        } else {
                            step_remaining = Some(rem - 1);
                            let _ = ptrace::step(tracee, None);
                        }
                    }
                    continue;
                }

                if sig == nix::sys::signal::Signal::SIGSEGV {
                    if let Ok(regs) = read_regs(tracee) {
                        let maps_txt = fs::read_to_string(format!("/proc/{}/maps", tracee))
                            .unwrap_or_else(|_| String::new());
                        let mut fault_addr_kernel: Option<u64> = None;
                        if let Some((signo, errno, code, addr)) =
                            segv_siginfo_decoded(tracee, &maps_txt)
                        {
                            eprintln!(
                                "siginfo: signo={} errno={} code={} ({}) si_addr=0x{:x}",
                                signo,
                                errno,
                                code,
                                segv_code_name(code),
                                addr
                            );
                            fault_addr_kernel = Some(addr);
                        }
                        let si_addr = fault_addr_kernel.or_else(|| segv_fault_addr(tracee));
                        eprintln!(
                            "tracee stopped on SIGSEGV pc=0x{:x} sp=0x{:x} si_addr={}",
                            regs.pc,
                            regs.sp,
                            si_addr
                                .map(|a| format!("0x{a:x}"))
                                .unwrap_or_else(|| "?".to_string())
                        );

                        // Robust decode: find the real rt_sigframe on the stack by searching for
                        // a `siginfo_t` that matches (SIGSEGV, si_addr). This avoids relying on
                        // Android/linker signal chaining which can clobber regs/PC.
                        if let Some(addr) = si_addr {
                            let around_sp = read_bytes_process_vm_best_effort(
                                tracee,
                                (regs.sp as usize).saturating_sub(128 * 1024),
                                256 * 1024,
                            );
                            let siginfo_raw = read_siginfo_raw(tracee);
                            if let Some(sf) =
                                find_aarch64_sigframe_in_stack_blob(&around_sp, addr, &siginfo_raw)
                            {
                                eprintln!(
                                    "sigframe(decoded): fault_addr=0x{:x} pc=0x{:x} sp=0x{:x} pstate=0x{:x} x19=0x{:x} x20=0x{:x} x30=0x{:x} esr={}",
                                    sf.fault_address,
                                    sf.pc,
                                    sf.sp,
                                    sf.pstate,
                                    sf.regs[19],
                                    sf.regs[20],
                                    sf.regs[30],
                                    sf.esr.map(|v| format!("0x{v:x}")).unwrap_or_else(|| "?".to_string())
                                );
                                if !maps_txt.is_empty() {
                                    if let Some((start, _end, line)) =
                                        find_mapping_containing(&maps_txt, sf.pc)
                                    {
                                        eprintln!("sigframe pc mapping: {line}");
                                        eprintln!(
                                            "sigframe pc offset in mapping: 0x{:x}",
                                            sf.pc.saturating_sub(start)
                                        );
                                    }
                                }
                            } else {
                                eprintln!("sigframe(decoded): not found on stack (scan)");
                            }
                        }

                        // Try to recover the real fault PC/SP from the signal frame / ucontext
                        // by pattern-scanning for `[sp][pc][pstate]` into the guest ld-linux mapping.
                        let mut guest_text: Option<(u64, u64)> = None;
                        let mut stack_r: Option<(u64, u64)> = None;
                        if !maps_txt.is_empty() {
                            for line in maps_txt.lines() {
                                if guest_text.is_none()
                                    && line.contains("ld-linux")
                                    && line.contains("r-xp")
                                {
                                    guest_text = parse_map_range(line);
                                }
                                if stack_r.is_none() && mapping_contains_pc(line, regs.sp) {
                                    stack_r = parse_map_range(line);
                                }
                            }
                        }
                        let score_hit = |hit: &SigCtxAarch64Hit, si_addr: Option<u64>| -> i32 {
                            let mut s = 0i32;
                            if let Some(a) = si_addr {
                                if hit.fault_address == a {
                                    s += 10;
                                }
                            }
                            if let Some((ss, se)) = stack_r {
                                if ss <= hit.regs[29] && hit.regs[29] < se {
                                    s += 4; // fp
                                }
                                if ss <= hit.regs[30] && hit.regs[30] < se {
                                    s += 1; // lr on stack is suspicious but possible
                                }
                            }
                            if let Some((gs, ge)) = guest_text {
                                if gs <= hit.regs[30] && hit.regs[30] < ge {
                                    s += 4; // lr inside guest text
                                }
                                if gs <= hit.regs[0] && hit.regs[0] < ge {
                                    s += 1;
                                }
                            }
                            s
                        };
                        let fmt_regs_matching = |hit: &SigCtxAarch64Hit, needle: u64| -> String {
                            let mut out = String::new();
                            for i in 0..hit.regs.len() {
                                if hit.regs[i] != needle {
                                    continue;
                                }
                                if !out.is_empty() {
                                    out.push(',');
                                }
                                out.push_str(&format!("x{i}"));
                            }
                            if hit.pc == needle {
                                if !out.is_empty() {
                                    out.push(',');
                                }
                                out.push_str("pc");
                            }
                            if out.is_empty() {
                                "-".to_string()
                            } else {
                                out
                            }
                        };

                        // Scan around SP.
                        let around_sp = read_bytes_process_vm_best_effort(
                            pid,
                            (regs.sp as usize).saturating_sub(32 * 1024),
                            64 * 1024,
                        );
                        let mut best_sp =
                            sigcontext_scan_all_hits_from_blob(&around_sp, stack_r, guest_text);
                        best_sp.sort_by_key(|h| -score_hit(h, si_addr));
                        if let Some(hit) = best_sp.first() {
                            eprintln!(
                                "sigcontext(pattern@sp): pc=0x{:x} sp=0x{:x} fault_addr=0x{:x} x8=0x{:x} x19=0x{:x} x20=0x{:x} x30=0x{:x} regs==si_addr:{} score={}",
                                hit.pc,
                                hit.sp,
                                hit.fault_address,
                                hit.regs[8],
                                hit.regs[19],
                                hit.regs[20],
                                hit.regs[30],
                                fmt_regs_matching(hit, si_addr.unwrap_or(0)),
                                score_hit(hit, si_addr)
                            );
                            if let Ok(code) = read_bytes_process_vm(pid, hit.pc as usize, 32) {
                                eprintln!("fault pc bytes: {}", hex_bytes(&code));
                            }
                            if !maps_txt.is_empty() {
                                if let Some((start, _end, line)) =
                                    find_mapping_containing(&maps_txt, hit.pc)
                                {
                                    eprintln!("fault pc mapping: {line}");
                                    eprintln!(
                                        "fault pc offset in mapping: 0x{:x}",
                                        hit.pc.saturating_sub(start)
                                    );
                                }
                            }
                            // Also print a couple of runner-ups if present (helps disambiguate).
                            for (i, h2) in best_sp.iter().skip(1).take(2).enumerate() {
                                eprintln!(
                                    "sigcontext(alt@sp#{i}): pc=0x{:x} sp=0x{:x} fault_addr=0x{:x} x8=0x{:x} x19=0x{:x} x30=0x{:x} regs==si_addr:{} score={}",
                                    h2.pc,
                                    h2.sp,
                                    h2.fault_address,
                                    h2.regs[8],
                                    h2.regs[19],
                                    h2.regs[30],
                                    fmt_regs_matching(h2, si_addr.unwrap_or(0)),
                                    score_hit(h2, si_addr)
                                );
                            }
                        }

                        // Scan uctx pointers if they look plausible (often passed as x2).
                        for (name, ptr) in [("x1", regs.regs[1]), ("x2", regs.regs[2])] {
                            if ptr == 0 {
                                continue;
                            }
                            let blob =
                                read_bytes_process_vm_best_effort(pid, ptr as usize, 64 * 1024);
                            let mut hits =
                                sigcontext_scan_all_hits_from_blob(&blob, stack_r, guest_text);
                            hits.sort_by_key(|h| -score_hit(h, si_addr));
                            if let Some(hit) = hits.first() {
                                eprintln!(
                                    "sigcontext(pattern@{name}=0x{ptr:x}): pc=0x{:x} sp=0x{:x} fault_addr=0x{:x} x8=0x{:x} x19=0x{:x} x20=0x{:x} x30=0x{:x} regs==si_addr:{} score={}",
                                    hit.pc,
                                    hit.sp,
                                    hit.fault_address,
                                    hit.regs[8],
                                    hit.regs[19],
                                    hit.regs[20],
                                    hit.regs[30],
                                    fmt_regs_matching(hit, si_addr.unwrap_or(0)),
                                    score_hit(hit, si_addr)
                                );
                                if let Ok(code) = read_bytes_process_vm(pid, hit.pc as usize, 32) {
                                    eprintln!("fault pc bytes: {}", hex_bytes(&code));
                                }
                                if !maps_txt.is_empty() {
                                    if let Some((start, _end, line)) =
                                        find_mapping_containing(&maps_txt, hit.pc)
                                    {
                                        eprintln!("fault pc mapping: {line}");
                                        eprintln!(
                                            "fault pc offset in mapping: 0x{:x}",
                                            hit.pc.saturating_sub(start)
                                        );
                                    }
                                }
                                for (i, h2) in hits.iter().skip(1).take(2).enumerate() {
                                    eprintln!(
                                        "sigcontext(alt@{name}#{i}): pc=0x{:x} sp=0x{:x} fault_addr=0x{:x} x8=0x{:x} x19=0x{:x} x30=0x{:x} regs==si_addr:{} score={}",
                                        h2.pc,
                                        h2.sp,
                                        h2.fault_address,
                                        h2.regs[8],
                                        h2.regs[19],
                                        h2.regs[30],
                                        fmt_regs_matching(h2, si_addr.unwrap_or(0)),
                                        score_hit(h2, si_addr)
                                    );
                                }
                            }
                        }

                        if let Some(addr) = si_addr {
                            if let Some((pc2, sp2)) =
                                segv_fault_regs_from_stack_scan(pid, regs.sp, addr, &maps_txt)
                            {
                                eprintln!(
                                    "sigframe(stack-scan): pc=0x{pc2:x} sp=0x{sp2:x} (sp=0x{:x})",
                                    regs.sp
                                );
                                if let Ok(code) = read_bytes_process_vm(pid, pc2 as usize, 32) {
                                    eprintln!("fault pc bytes: {}", hex_bytes(&code));
                                }
                                if !maps_txt.is_empty() {
                                    if let Some((start, _end, line)) =
                                        find_mapping_containing(&maps_txt, pc2)
                                    {
                                        eprintln!("fault pc mapping: {line}");
                                        eprintln!(
                                            "fault pc offset in mapping: 0x{:x}",
                                            pc2.saturating_sub(start)
                                        );
                                    }
                                }
                            }
                        }
                        eprintln!(
                            "sig handler args: x0(sig)=0x{:x} x1(siginfo*)=0x{:x} x2(uctx*)=0x{:x}",
                            regs.regs[0], regs.regs[1], regs.regs[2]
                        );
                        if regs.regs[2] != 0 {
                            if let Ok(bs) = read_bytes_process_vm(pid, regs.regs[2] as usize, 512) {
                                eprintln!("uctx[0..512]: {}", hex_bytes(&bs));
                                if let Some(addr) = si_addr {
                                    let needle = addr.to_ne_bytes();
                                    for off in 0..bs.len().saturating_sub(8) {
                                        if bs[off..off + 8] == needle {
                                            eprintln!("uctx contains si_addr at +0x{:x}", off);
                                            break;
                                        }
                                    }
                                }
                            }
                            if let Some((fault, sp2, pc2, pstate)) =
                                decode_ucontext_aarch64_android(pid, regs.regs[2] as usize)
                            {
                                eprintln!(
                                    "ucontext(aarch64): fault_addr=0x{fault:x} pc=0x{pc2:x} sp=0x{sp2:x} pstate=0x{pstate:x}"
                                );
                                if !maps_txt.is_empty() {
                                    if let Some((start, _end, _line)) =
                                        find_mapping_containing(&maps_txt, pc2)
                                    {
                                        eprintln!(
                                            "fault pc offset in mapping: 0x{:x}",
                                            pc2.saturating_sub(start)
                                        );
                                    }
                                }
                            }
                            let bs2 =
                                read_bytes_process_vm_best_effort(pid, regs.regs[2] as usize, 2048);
                            eprintln!("uctx best-effort len={}", bs2.len());
                            if let Some((fault_addr, sp2, pc2, pstate, xregs)) =
                                decode_aarch64_ucontext_prefix(&bs2)
                            {
                                eprintln!(
                                    "ucontext(decoded): fault_addr=0x{fault_addr:x} sp=0x{sp2:x} pc=0x{pc2:x} pstate=0x{pstate:x}"
                                );
                                eprintln!(
                                    "ucontext regs: x0=0x{:x} x1=0x{:x} x2=0x{:x} x3=0x{:x} x4=0x{:x} x5=0x{:x}",
                                    xregs[0], xregs[1], xregs[2], xregs[3], xregs[4], xregs[5]
                                );
                                if !maps_txt.is_empty() {
                                    if let Some((start, _end, _line)) =
                                        find_mapping_containing(&maps_txt, pc2)
                                    {
                                        eprintln!(
                                            "fault pc offset in mapping: 0x{:x}",
                                            pc2.saturating_sub(start)
                                        );
                                    }
                                }
                            }
                            if let Some(addr) = si_addr {
                                let needle = addr.to_ne_bytes();
                                let mut shown = 0usize;
                                for off in (0..bs2.len().saturating_sub(8)).step_by(8) {
                                    if bs2[off..off + 8] != needle {
                                        continue;
                                    }
                                    let sp_off = off + 8 + 31 * 8;
                                    let pc_off = sp_off + 8;
                                    if pc_off + 8 <= bs2.len() {
                                        let sp2 = u64::from_ne_bytes(
                                            bs2[sp_off..sp_off + 8].try_into().unwrap(),
                                        );
                                        let pc2 = u64::from_ne_bytes(
                                            bs2[pc_off..pc_off + 8].try_into().unwrap(),
                                        );
                                        if pc2 != 0 || sp2 != 0 {
                                            eprintln!(
                                                "sigcontext(candidate): off=0x{off:x} pc=0x{pc2:x} sp=0x{sp2:x}"
                                            );
                                            shown += 1;
                                            if shown >= 4 {
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        if regs.regs[2] != 0 {
                            if let Some(addr) = fault_addr_kernel.or(si_addr) {
                                if let Some((pc2, sp2)) = segv_fault_regs_from_sigcontext_scan(
                                    pid,
                                    regs.regs[2] as usize,
                                    addr,
                                ) {
                                    eprintln!(
                                        "sigcontext(scan): pc=0x{pc2:x} sp=0x{sp2:x} (uctx=0x{:x})",
                                        regs.regs[2]
                                    );
                                    if let Ok(code) = read_bytes_process_vm(pid, pc2 as usize, 32) {
                                        eprintln!("fault pc bytes: {}", hex_bytes(&code));
                                    }
                                    if let Ok(stack) = read_bytes_process_vm(pid, sp2 as usize, 64)
                                    {
                                        eprintln!("fault sp bytes: {}", hex_bytes(&stack));
                                    }
                                }
                            }
                        }
                        // Best-effort instruction/stack dump to help debug early loader crashes.
                        if let Ok(code) = read_bytes_process_vm(pid, regs.pc as usize, 32) {
                            eprintln!("pc bytes: {}", hex_bytes(&code));
                        }
                        if let Ok(stack) = read_bytes_process_vm(pid, regs.sp as usize, 64) {
                            eprintln!("sp bytes: {}", hex_bytes(&stack));
                        }
                        if !maps_txt.is_empty() {
                            if let Some(line) = maps_txt
                                .lines()
                                .find(|l| mapping_contains_pc(l, regs.pc as u64))
                            {
                                eprintln!("pc mapping: {line}");
                            }
                            if let Some(sp_line) = maps_txt
                                .lines()
                                .find(|l| mapping_contains_pc(l, regs.sp as u64))
                            {
                                eprintln!("sp mapping: {sp_line}");
                            }
                            for line in maps_txt
                                .lines()
                                .filter(|l| l.contains("ld-linux") || l.contains("linker64"))
                            {
                                eprintln!("maps: {line}");
                            }
                        }
                    } else {
                        eprintln!("tracee stopped on SIGSEGV (failed reading regs)");
                    }
                    // Don't try to "let Android handle it" while we're debugging; it tends to
                    // jump into linker64/sigchain and obscures the real fault site.
                    let _ = ptrace::kill(tracee);
                    let _ = wait::waitpid(tracee, None);
                    exit_code = 128 + (nix::sys::signal::Signal::SIGSEGV as i32);
                    break;
                }
                let _ = ptrace::syscall(tracee, Some(sig));
            }
            Ok(wait::WaitStatus::Exited(tracee, code)) => {
                in_syscall_fallback.remove(&tracee);
                pending_sp_restore.remove(&tracee);
                if tracee != pid {
                    continue;
                }
                drain_stdout(&mut stdout, &mut buf, &mut carry, &mut args.log);
                drain_stdout(&mut stderr, &mut buf, &mut carry_err, &mut args.log);
                // Flush any trailing partial line.
                if !carry.is_empty() {
                    let line = carry.trim_end_matches('\r');
                    if let Some(log) = args.log.as_mut() {
                        log(line.to_string());
                    } else {
                        println!("{line}");
                    }
                    carry.clear();
                }
                if !carry_err.is_empty() {
                    let line = carry_err.trim_end_matches('\r');
                    if let Some(log) = args.log.as_mut() {
                        log(line.to_string());
                    } else {
                        eprintln!("{line}");
                    }
                    carry_err.clear();
                }
                exit_code = code;
                break;
            }
            Ok(wait::WaitStatus::Signaled(tracee, sig, _)) => {
                in_syscall_fallback.remove(&tracee);
                pending_sp_restore.remove(&tracee);
                if tracee != pid {
                    continue;
                }
                drain_stdout(&mut stdout, &mut buf, &mut carry, &mut args.log);
                drain_stdout(&mut stderr, &mut buf, &mut carry_err, &mut args.log);
                exit_code = 128 + (sig as i32);
                break;
            }
            Ok(wait::WaitStatus::PtraceEvent(tracee, _, _evt)) => {
                if let Ok(new_raw) = ptrace::getevent(tracee) {
                    let new_pid = Pid::from_raw(new_raw as i32);
                    let _ = ptrace::setoptions(new_pid, trace_opts);
                    let _ = ptrace::syscall(new_pid, None);
                }
                let _ = ptrace::syscall(tracee, None);
            }
            Ok(wait::WaitStatus::Continued(tracee)) => {
                let _ = ptrace::syscall(tracee, None);
            }
            Ok(wait::WaitStatus::StillAlive) => {}
            Ok(_) => {
                let _ = ptrace::syscall(pid, None);
            }
            Err(e) => {
                println!("{e:?}");
                exit_code = 1;
                break;
            }
        }
    }

    // The end
    exit_code
}

fn drain_stdout<'a>(
    stdout: &mut impl Read,
    buf: &mut [u8],
    carry: &mut String,
    log: &mut Option<Box<dyn FnMut(String) + 'a>>,
) {
    loop {
        match stdout.read(buf) {
            Ok(0) => break, // EOF
            Ok(n) => {
                carry.push_str(&String::from_utf8_lossy(&buf[..n]));
                while let Some(pos) = carry.find('\n') {
                    let line = carry[..pos].trim_end_matches('\r');
                    let suppress_loader_log = line.starts_with("loader_shim:");
                    if suppress_loader_log {
                        carry.drain(..=pos);
                        continue;
                    }
                    if let Some(log) = log.as_mut() {
                        log(line.to_string());
                    } else {
                        println!("{line}");
                    }
                    carry.drain(..=pos);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                break; // nothing available right now -> don't block
            }
            Err(e) => {
                eprintln!("read error: {e}");
                break;
            }
        }
    }
}

struct PendingSysenterRestore {
    original_sp: u64,
    syscall: i64,
    access_emu: Option<(String, i32, i32)>,
}

fn rewrite_syscall_path_with_regs(
    pid: Pid,
    mut regs: UserPtRegs,
    mappings: &[(String, String)],
) -> nix::Result<Option<PendingSysenterRestore>> {
    let syscall = regs.regs[8]; // x8
    let mut args = [0u64; 6];
    args.copy_from_slice(&regs.regs[0..6]);

    let path_addr = match syscall as i64 {
        nix::libc::SYS_openat => Some(args[1] as usize),
        nix::libc::SYS_openat2 => Some(args[1] as usize),
        n if syscall_is_fstatat(n) => Some(args[1] as usize),
        nix::libc::SYS_faccessat => Some(args[1] as usize),
        nix::libc::SYS_faccessat2 => Some(args[1] as usize),
        nix::libc::SYS_readlinkat => Some(args[1] as usize),
        nix::libc::SYS_mkdirat => Some(args[1] as usize),
        nix::libc::SYS_unlinkat => Some(args[1] as usize),
        nix::libc::SYS_execve => Some(args[0] as usize),
        nix::libc::SYS_execveat => Some(args[1] as usize),
        nix::libc::SYS_statx => Some(args[1] as usize),
        nix::libc::SYS_chdir => Some(args[0] as usize),
        _ => None,
    };

    let Some(addr_raw) = path_addr else {
        return Ok(None);
    };

    let (_addr, path_bytes) = match read_cstring_candidates(pid, addr_raw) {
        Ok(v) => v,
        Err(e) => {
            let _ = e;
            return Ok(None);
        }
    };
    let path = String::from_utf8_lossy(&path_bytes);
    let Some(mapped) = apply_path_mappings(&path, mappings) else {
        return Ok(None);
    };
    let mapped_is_relative = !mapped.starts_with('/');
    let path_was_absolute = path.starts_with('/');

    if requires_existing_path(syscall, &args) && !mapped_path_exists(pid, &mapped) {
        return Ok(None);
    }

    let mut mapped_bytes = mapped.as_bytes().to_vec();
    mapped_bytes.push(0);
    let original_sp = regs.sp;
    let new_ptr = alloc_tracee_stack_data(pid, &mut regs, &mapped_bytes)?;

    // `openat*` ignores dirfd for absolute paths. Once rewritten to a relative
    // path, preserve intended semantics by forcing dirfd=AT_FDCWD.
    if path_was_absolute && mapped_is_relative {
        let sys = syscall as i64;
        if (matches!(
            sys,
            nix::libc::SYS_openat
                | nix::libc::SYS_openat2
                | nix::libc::SYS_execveat
                | nix::libc::SYS_faccessat
                | nix::libc::SYS_faccessat2
                | nix::libc::SYS_readlinkat
                | nix::libc::SYS_mkdirat
                | nix::libc::SYS_unlinkat
                | nix::libc::SYS_statx
        ) || syscall_is_fstatat(sys))
            && (regs.regs[0] as i64) != nix::libc::AT_FDCWD as i64
        {
            regs.regs[0] = nix::libc::AT_FDCWD as i64 as u64;
        }
    }

    match syscall as i64 {
        nix::libc::SYS_execve | nix::libc::SYS_chdir => regs.regs[0] = new_ptr as u64,
        n if syscall_is_fstatat(n) => regs.regs[1] = new_ptr as u64,
        nix::libc::SYS_openat
        | nix::libc::SYS_openat2
        | nix::libc::SYS_faccessat
        | nix::libc::SYS_faccessat2
        | nix::libc::SYS_readlinkat
        | nix::libc::SYS_mkdirat
        | nix::libc::SYS_unlinkat
        | nix::libc::SYS_execveat
        | nix::libc::SYS_statx => regs.regs[1] = new_ptr as u64,
        _ => return Ok(None),
    }
    write_regs(pid, &regs)?;

    let sys = syscall as i64;
    let access_emu = if matches!(sys, nix::libc::SYS_faccessat | nix::libc::SYS_faccessat2) {
        Some((mapped.clone(), args[2] as i32, args[3] as i32))
    } else {
        None
    };
    if matches!(sys, nix::libc::SYS_execve | nix::libc::SYS_execveat) {
        return Ok(Some(PendingSysenterRestore {
            original_sp,
            syscall: sys,
            access_emu,
        }));
    }
    Ok(Some(PendingSysenterRestore {
        original_sp,
        syscall: sys,
        access_emu,
    }))
}

fn alloc_tracee_stack_data(pid: Pid, regs: &mut UserPtRegs, data: &[u8]) -> nix::Result<usize> {
    let aligned = (data.len() + 15) & !15;
    if (aligned as u64) > regs.sp {
        return Err(nix::Error::from(nix::errno::Errno::EFAULT));
    }
    let new_sp = regs.sp - aligned as u64;
    write_bytes(pid, new_sp as usize, data)?;
    if aligned > data.len() {
        let zeros = vec![0u8; aligned - data.len()];
        write_bytes(pid, new_sp as usize + data.len(), &zeros)?;
    }
    regs.sp = new_sp;
    Ok(new_sp as usize)
}

fn ptrace_syscall_is_entry(pid: Pid, fallback: &mut HashMap<Pid, bool>) -> bool {
    const PTRACE_GET_SYSCALL_INFO: nix::libc::c_int = 0x420e;
    const PTRACE_SYSCALL_INFO_ENTRY: u8 = 1;
    const PTRACE_SYSCALL_INFO_EXIT: u8 = 2;
    const PTRACE_SYSCALL_INFO_SECCOMP: u8 = 3;
    let mut buf = [0u8; 64];
    let ret = unsafe {
        nix::libc::ptrace(
            PTRACE_GET_SYSCALL_INFO,
            pid.as_raw(),
            buf.len(),
            buf.as_mut_ptr() as *mut nix::libc::c_void,
        )
    };
    if ret > 0 {
        match buf[0] {
            PTRACE_SYSCALL_INFO_ENTRY | PTRACE_SYSCALL_INFO_SECCOMP => return true,
            PTRACE_SYSCALL_INFO_EXIT => return false,
            _ => {}
        }
    }
    let was_entry = fallback.get(&pid).copied().unwrap_or(false);
    let is_entry = !was_entry;
    fallback.insert(pid, is_entry);
    is_entry
}

fn should_rewrite_from_pc(pid: Pid, pc: u64, rootfs_abs: &str) -> bool {
    // Rewrite path syscalls for almost all code in the tracee, but never for Android's
    // dynamic linker (`linker64`) while it is relocating/starting the process.
    //
    // This keeps the loader alive long enough for our loader-shim to run, after which it
    // unmaps linker64 and we can safely apply "rootfs" semantics to absolute paths.
    //
    // Why we gate by the *PC mapping* (instead of "only rewrite when the pathname points into
    // rootfs" or "only rewrite guest code"):
    // - We need the shim's own syscalls (open target/interpreter, read /proc/self/maps, etc.)
    //   to see the guest rootfs view.
    // - But touching linker64's syscalls is fragile: it does early process bring-up and expects
    //   real absolute paths on the host (e.g. /system/bin/linker64 internals).
    let Ok(maps) = fs::read_to_string(format!("/proc/{}/maps", pid)) else {
        return false;
    };
    let Some((_, _, line)) = find_mapping_containing(&maps, pc) else {
        return false;
    };
    let _ = rootfs_abs;
    !line.contains("linker64")
}

fn read_cstring_candidates(pid: Pid, addr_raw: usize) -> nix::Result<(usize, Vec<u8>)> {
    // Try a small set of de-tagging/canonicalization masks commonly seen on Android/AArch64.
    // We only accept candidates that decode into an absolute path (starts with '/').
    let a = addr_raw as u64;
    let cands: [u64; 6] = [
        a,
        a & 0x00ff_ffff_ffff_ffff, // drop top byte (TBI)
        a & 0x0000_ffff_ffff_ffff, // drop top 16 bits (48-bit VA)
        a & 0x0000_0fff_ffff_ffff, // drop top 20 bits (52-bit VA / PAC-ish)
        a & 0x0000_00ff_ffff_ffff, // 40-bit VA
        a & 0x0000_007f_ffff_ffff, // 39-bit VA
    ];

    let mut last_err: Option<nix::Error> = None;
    for cand in cands {
        if cand == 0 {
            continue;
        }
        match read_cstring(pid, cand as usize) {
            Ok(bs) => {
                if bs.first() == Some(&b'/') {
                    return Ok((cand as usize, bs));
                }
            }
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| nix::Error::from(nix::errno::Errno::EIO)))
}

#[repr(C)]
#[derive(Clone, Copy)]
struct UserPtRegs {
    regs: [u64; 31], // x0..x30
    sp: u64,
    pc: u64,
    pstate: u64,
}

fn read_regs(pid: Pid) -> nix::Result<UserPtRegs> {
    let mut regs: UserPtRegs = unsafe { mem::zeroed() };
    let mut iov = nix::libc::iovec {
        iov_base: (&mut regs as *mut UserPtRegs).cast(),
        iov_len: mem::size_of::<UserPtRegs>(),
    };
    // NT_PRSTATUS is 1 on Linux.
    let nt_prstatus: usize = 1;
    let ret = unsafe {
        nix::libc::ptrace(
            nix::libc::PTRACE_GETREGSET,
            pid.as_raw(),
            nt_prstatus as *mut nix::libc::c_void,
            &mut iov as *mut nix::libc::iovec as *mut nix::libc::c_void,
        )
    };
    if ret < 0 {
        return Err(nix::Error::last());
    }
    Ok(regs)
}

fn write_regs(pid: Pid, regs: &UserPtRegs) -> nix::Result<()> {
    let mut regs = *regs;
    let mut iov = nix::libc::iovec {
        iov_base: (&mut regs as *mut UserPtRegs).cast(),
        iov_len: mem::size_of::<UserPtRegs>(),
    };
    // NT_PRSTATUS is 1 on Linux.
    let nt_prstatus: usize = 1;
    let ret = unsafe {
        nix::libc::ptrace(
            nix::libc::PTRACE_SETREGSET,
            pid.as_raw(),
            nt_prstatus as *mut nix::libc::c_void,
            &mut iov as *mut nix::libc::iovec as *mut nix::libc::c_void,
        )
    };
    if ret < 0 {
        return Err(nix::Error::last());
    }
    Ok(())
}

fn build_path_mappings(rootfs: &str, binds: &[(String, String)]) -> Vec<(String, String)> {
    let _ = rootfs;
    let mut mappings = Vec::with_capacity(binds.len() + 1);
    mappings.push(("/".to_string(), ".".to_string()));
    for (host_path, guest_path) in binds {
        mappings.push((
            normalize_guest_prefix(guest_path),
            normalize_host_prefix(host_path),
        ));
    }
    mappings
}

fn remap_command_program_in_rootfs(
    command: Command,
    rootfs: &str,
    mappings: &[(String, String)],
) -> Command {
    let program = command.get_program().to_string_lossy().to_string();
    if !program.starts_with('/') {
        return command;
    }

    // Treat the program as a guest absolute path only if it exists inside rootfs.
    // This avoids accidentally remapping host absolute paths (e.g. the loader-shim itself).
    let host_program = Path::new(rootfs).join(program.trim_start_matches('/'));
    if !host_program.exists() {
        return command;
    }

    let Some(mapped_program) = apply_path_mappings(&program, mappings) else {
        return command;
    };

    rebuild_command(command, OsString::from(mapped_program), &[])
}

fn maybe_wrap_with_external_loader_shim(
    command: &Command,
    rootfs: &str,
    shim_exe: &OsString,
) -> Option<Command> {
    let guest_program = command.get_program().to_string_lossy().to_string();
    if guest_program.is_empty() {
        return None;
    }

    // If it's a guest absolute path (/usr/bin/...), resolve it inside rootfs.
    // If it's already host-relative (./usr/bin/...), resolve from rootfs cwd.
    let host_program = if guest_program.starts_with('/') {
        Path::new(rootfs).join(guest_program.trim_start_matches('/'))
    } else {
        Path::new(rootfs).join(&guest_program)
    };
    if !is_elf(&host_program) {
        return None;
    }
    // Wrap only dynamically-linked ELFs.
    let _ = elf_interp_path(&host_program)?;

    // Ensure the shim path is absolute so it isn't affected by current_dir(rootfs).
    let p = Path::new(std::ffi::OsStr::from_bytes(shim_exe.as_bytes()));
    let abs = fs::canonicalize(p).unwrap_or_else(|_| {
        let cwd = std::env::current_dir().unwrap_or_default();
        cwd.join(p)
    });
    let shim = abs.into_os_string();

    // Invoke loader_shim as: loader_shim <guest-program> [args...]
    // The tracer will rewrite the shim's path syscalls so the guest absolute path resolves inside rootfs.
    let prefix = [OsString::from(guest_program)];
    Some(rebuild_command_from_ref(command, shim, &prefix))
}

fn is_elf(path: &Path) -> bool {
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    bytes.len() >= 4 && bytes[0] == 0x7f && bytes[1] == b'E' && bytes[2] == b'L' && bytes[3] == b'F'
}

fn elf_interp_path(path: &Path) -> Option<String> {
    // Minimal ELF64 little-endian parser for PT_INTERP.
    let mut file = fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    if bytes.len() < 64 || &bytes[0..4] != b"\x7fELF" {
        return None;
    }
    if bytes[4] != 2 || bytes[5] != 1 {
        return None;
    }

    let phoff = read_u64(&bytes, 32)?;
    let phentsize = read_u16(&bytes, 54)?;
    let phnum = read_u16(&bytes, 56)?;

    for i in 0..phnum as usize {
        let base = phoff as usize + i * phentsize as usize;
        if base + 56 > bytes.len() {
            return None;
        }
        let p_type = read_u32(&bytes, base)?;
        if p_type == 3 {
            let p_offset = read_u64(&bytes, base + 8)?;
            let p_filesz = read_u64(&bytes, base + 32)?;
            let start = p_offset as usize;
            let end = start + p_filesz as usize;
            if end <= bytes.len() {
                let raw = &bytes[start..end];
                let nul = raw.iter().position(|b| *b == 0).unwrap_or(raw.len());
                return Some(String::from_utf8_lossy(&raw[..nul]).to_string());
            }
            return None;
        }
    }
    None
}

fn read_u16(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*bytes.get(at)?, *bytes.get(at + 1)?]))
}

fn read_u32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *bytes.get(at)?,
        *bytes.get(at + 1)?,
        *bytes.get(at + 2)?,
        *bytes.get(at + 3)?,
    ]))
}

fn read_u64(bytes: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_le_bytes([
        *bytes.get(at)?,
        *bytes.get(at + 1)?,
        *bytes.get(at + 2)?,
        *bytes.get(at + 3)?,
        *bytes.get(at + 4)?,
        *bytes.get(at + 5)?,
        *bytes.get(at + 6)?,
        *bytes.get(at + 7)?,
    ]))
}

fn rebuild_command(command: Command, new_program: OsString, prefix_args: &[OsString]) -> Command {
    let args: Vec<OsString> = command.get_args().map(OsString::from).collect();
    let envs: Vec<(OsString, Option<OsString>)> = command
        .get_envs()
        .map(|(k, v)| (k.to_os_string(), v.map(OsString::from)))
        .collect();
    let current_dir = command.get_current_dir().map(|p| p.to_path_buf());

    let mut rebuilt = Command::new(new_program);
    rebuilt.args(prefix_args);
    rebuilt.args(args);
    if let Some(dir) = current_dir {
        rebuilt.current_dir(dir);
    }
    for (key, value) in envs {
        if let Some(value) = value {
            rebuilt.env(key, value);
        } else {
            rebuilt.env_remove(key);
        }
    }
    rebuilt
}

fn rebuild_command_from_ref(
    command: &Command,
    new_program: OsString,
    prefix_args: &[OsString],
) -> Command {
    let args: Vec<OsString> = command.get_args().map(OsString::from).collect();
    let envs: Vec<(OsString, Option<OsString>)> = command
        .get_envs()
        .map(|(k, v)| (k.to_os_string(), v.map(OsString::from)))
        .collect();
    let current_dir = command.get_current_dir().map(|p| p.to_path_buf());

    let mut rebuilt = Command::new(new_program);
    rebuilt.args(prefix_args);
    rebuilt.args(args);
    if let Some(dir) = current_dir {
        rebuilt.current_dir(dir);
    }
    for (key, value) in envs {
        if let Some(value) = value {
            rebuilt.env(key, value);
        } else {
            rebuilt.env_remove(key);
        }
    }
    rebuilt
}

fn apply_path_mappings(path: &str, mappings: &[(String, String)]) -> Option<String> {
    if !path.starts_with('/') {
        return None;
    }

    let mut best: Option<(&str, &str)> = None;
    for (guest, host) in mappings {
        if path_matches_prefix(path, guest) {
            if best.is_none() || guest.len() > best.unwrap().0.len() {
                best = Some((guest.as_str(), host.as_str()));
            }
        }
    }

    let (guest, host) = best?;
    let mut rest = &path[guest.len()..];
    if host == "." {
        let trimmed = rest.trim_start_matches('/');
        return if trimmed.is_empty() {
            Some(".".to_string())
        } else {
            Some(trimmed.to_string())
        };
    }
    let mut mapped = host.to_string();
    if mapped.ends_with('/') && rest.starts_with('/') {
        rest = rest.trim_start_matches('/');
    }
    if !rest.is_empty() {
        if !mapped.ends_with('/') && !rest.starts_with('/') {
            mapped.push('/');
        }
        mapped.push_str(rest);
    }
    if mapped == path {
        None
    } else {
        Some(mapped)
    }
}

fn normalize_host_root(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    }
}

fn normalize_host_prefix(path: &str) -> String {
    normalize_host_root(path)
}

fn normalize_guest_prefix(path: &str) -> String {
    if path == "/" {
        "/".to_string()
    } else {
        path.trim_end_matches('/').to_string()
    }
}

fn requires_existing_path(syscall: u64, args: &[u64; 6]) -> bool {
    let sys = syscall as i64;
    if matches!(sys, nix::libc::SYS_execve | nix::libc::SYS_execveat | nix::libc::SYS_statx) {
        return true;
    }
    if syscall_is_fstatat(sys)
        || matches!(
            sys,
            nix::libc::SYS_faccessat
                | nix::libc::SYS_faccessat2
                | nix::libc::SYS_readlinkat
                | nix::libc::SYS_chdir
        )
    {
        return true;
    }
    match sys {
        nix::libc::SYS_openat => {
            let flags = args[2] as i32;
            (flags & nix::fcntl::OFlag::O_CREAT.bits()) == 0
        }
        nix::libc::SYS_openat2 => true,
        _ => false,
    }
}

#[cfg(all(target_os = "android", target_arch = "aarch64"))]
fn syscall_is_fstatat(syscall: i64) -> bool {
    // `libc` for Android/aarch64 does not currently expose `SYS_newfstatat`,
    // but the kernel ABI syscall number is stable.
    syscall == 79
}

#[cfg(not(all(target_os = "android", target_arch = "aarch64")))]
fn syscall_is_fstatat(syscall: i64) -> bool {
    syscall == nix::libc::SYS_newfstatat
}

fn mapped_path_exists(pid: Pid, mapped: &str) -> bool {
    let path = if mapped.starts_with('/') {
        mapped.to_string()
    } else {
        let cwd = fs::read_link(format!("/proc/{}/cwd", pid)).unwrap_or_default();
        cwd.join(mapped).to_string_lossy().to_string()
    };
    fs::metadata(path).is_ok()
}

fn emulate_faccessat_result(pid: Pid, mapped: &str, mode: i32, flags: i32) -> i64 {
    const AT_EACCESS_FALLBACK: i32 = 0x200;
    let host_path = if mapped.starts_with('/') {
        mapped.to_string()
    } else {
        let cwd = fs::read_link(format!("/proc/{}/cwd", pid)).unwrap_or_default();
        cwd.join(mapped).to_string_lossy().to_string()
    };
    let Ok(c_path) = CString::new(host_path) else {
        return -(nix::libc::EINVAL as i64);
    };
    let try_faccess = |f: i32| unsafe { nix::libc::faccessat(nix::libc::AT_FDCWD, c_path.as_ptr(), mode, f) };
    let rc = try_faccess(flags);
    if rc == 0 {
        return 0;
    }
    let mut err = nix::errno::Errno::last_raw() as i64;
    if err == nix::libc::EINVAL as i64 && (flags & AT_EACCESS_FALLBACK) != 0 {
        let rc2 = try_faccess(flags & !AT_EACCESS_FALLBACK);
        if rc2 == 0 {
            return 0;
        }
        err = nix::errno::Errno::last_raw() as i64;
    }
    -err
}

fn path_matches_prefix(path: &str, prefix: &str) -> bool {
    if !path.starts_with(prefix) {
        return false;
    }
    if prefix.ends_with('/') || path.len() == prefix.len() {
        return true;
    }
    path.as_bytes().get(prefix.len()) == Some(&b'/')
}

fn read_cstring(pid: Pid, addr: usize) -> nix::Result<Vec<u8>> {
    // On Android, `PTRACE_PEEKDATA` can fail with EIO for valid userspace pointers
    // (e.g. tagged pointers, transient mappings, etc.). `process_vm_readv` is often
    // more reliable once we're already tracing the process.
    if let Ok(v) = read_cstring_process_vm(pid, addr) {
        return Ok(v);
    }

    let word_size = mem::size_of::<nix::libc::c_long>();
    let mut out = Vec::new();
    let aligned = addr & !(word_size - 1);
    let mut cur = aligned;
    let mut skip = addr - aligned;
    loop {
        if out.len() > 4096 {
            return Err(nix::Error::from(nix::errno::Errno::ENAMETOOLONG));
        }
        let word = ptrace::read(pid, cur as AddressType)? as usize;
        let bytes = word.to_ne_bytes();
        for i in skip..word_size {
            let b = bytes[i];
            if b == 0 {
                return Ok(out);
            }
            out.push(b);
        }
        cur += word_size;
        skip = 0;
    }
}

fn read_cstring_process_vm(pid: Pid, addr: usize) -> nix::Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut off = 0usize;
    let mut buf = [0u8; 256];
    loop {
        if out.len() > 4096 {
            return Err(nix::Error::from(nix::errno::Errno::ENAMETOOLONG));
        }
        let n = process_vm_read(pid, addr + off, &mut buf)?;
        if n == 0 {
            return Err(nix::Error::from(nix::errno::Errno::EIO));
        }
        if let Some(pos) = buf[..n].iter().position(|b| *b == 0) {
            out.extend_from_slice(&buf[..pos]);
            return Ok(out);
        }
        out.extend_from_slice(&buf[..n]);
        off = off.saturating_add(n);
    }
}

fn process_vm_read(pid: Pid, remote_addr: usize, local_buf: &mut [u8]) -> nix::Result<usize> {
    // Use the raw syscall number to avoid libc symbol availability differences on Android.
    // aarch64: __NR_process_vm_readv = 270
    #[cfg(target_arch = "aarch64")]
    const NR_PROCESS_VM_READV: nix::libc::c_long = 270;

    #[cfg(not(target_arch = "aarch64"))]
    const NR_PROCESS_VM_READV: nix::libc::c_long = {
        // Best-effort: if you ever build on other arches, prefer wiring up a proper per-arch value.
        270
    };

    let mut local_iov = nix::libc::iovec {
        iov_base: local_buf.as_mut_ptr().cast(),
        iov_len: local_buf.len(),
    };
    let mut remote_iov = nix::libc::iovec {
        iov_base: (remote_addr as *mut nix::libc::c_void),
        iov_len: local_buf.len(),
    };

    // libc::syscall returns c_long.
    let rc = unsafe {
        nix::libc::syscall(
            NR_PROCESS_VM_READV,
            pid.as_raw(),
            &mut local_iov as *mut nix::libc::iovec,
            1usize,
            &mut remote_iov as *mut nix::libc::iovec,
            1usize,
            0usize,
        )
    };
    if rc < 0 {
        return Err(nix::Error::last());
    }
    Ok(rc as usize)
}

fn read_bytes_process_vm(pid: Pid, addr: usize, len: usize) -> nix::Result<Vec<u8>> {
    let mut out = vec![0u8; len];
    let mut off = 0usize;
    while off < len {
        let n = process_vm_read(pid, addr + off, &mut out[off..])?;
        if n == 0 {
            break;
        }
        off += n;
    }
    out.truncate(off);
    Ok(out)
}

fn read_bytes_process_vm_best_effort(pid: Pid, addr: usize, len: usize) -> Vec<u8> {
    let mut out = vec![0u8; len];
    let mut off = 0usize;
    while off < len {
        match process_vm_read(pid, addr + off, &mut out[off..]) {
            Ok(0) => break,
            Ok(n) => off += n,
            Err(_) => break,
        }
    }
    out.truncate(off);
    out
}

fn find_mapping_containing(maps: &str, addr: u64) -> Option<(u64, u64, &str)> {
    for line in maps.lines() {
        let Some((range, _rest)) = line.split_once(' ') else {
            continue;
        };
        let Some((start_s, end_s)) = range.split_once('-') else {
            continue;
        };
        let Ok(start) = u64::from_str_radix(start_s, 16) else {
            continue;
        };
        let Ok(end) = u64::from_str_radix(end_s, 16) else {
            continue;
        };
        if start <= addr && addr < end {
            return Some((start, end, line));
        }
    }
    None
}

#[cfg(target_arch = "aarch64")]
fn decode_ucontext_aarch64_android(pid: Pid, uctx_ptr: usize) -> Option<(u64, u64, u64, u64)> {
    // Android/bionic aarch64 ucontext_t layout (from /usr/include/aarch64-linux-android/sys/ucontext.h):
    //   u64 uc_flags;
    //   u64 uc_link;
    //   stack_t uc_stack;            // 24 bytes (pointer, int, size_t with padding)
    //   sigset_t uc_sigmask;         // 8 bytes
    //   char __padding[128-8];       // 120 bytes
    //   struct sigcontext uc_mcontext; // starts at offset 0xa8
    //
    // struct sigcontext (from asm/sigcontext.h):
    //   u64 fault_address;           // +0x00
    //   u64 regs[31];                // +0x08
    //   u64 sp;                      // +0x100
    //   u64 pc;                      // +0x108
    //   u64 pstate;                  // +0x110
    let read_u64 = |off: usize| -> Option<u64> {
        let bs = read_bytes_process_vm(pid, uctx_ptr + off, 8).ok()?;
        Some(u64::from_ne_bytes(bs[..8].try_into().ok()?))
    };
    let mcontext = 0xa8usize;
    let fault = read_u64(mcontext + 0x00)?;
    let sp = read_u64(mcontext + 0x100)?;
    let pc = read_u64(mcontext + 0x108)?;
    let pstate = read_u64(mcontext + 0x110)?;
    Some((fault, sp, pc, pstate))
}

#[cfg(not(target_arch = "aarch64"))]
fn decode_ucontext_aarch64_android(_pid: Pid, _uctx_ptr: usize) -> Option<(u64, u64, u64, u64)> {
    None
}

fn hex_bytes(bs: &[u8]) -> String {
    let mut s = String::new();
    for (i, b) in bs.iter().enumerate() {
        if i != 0 {
            s.push(' ');
        }
        s.push_str(&format!("{:02x}", b));
    }
    s
}

fn write_bytes(pid: Pid, addr: usize, data: &[u8]) -> nix::Result<()> {
    let word_size = mem::size_of::<nix::libc::c_long>();

    let aligned_start = addr & !(word_size - 1);
    let aligned_end = (addr + data.len() + (word_size - 1)) & !(word_size - 1);
    let mut cur = aligned_start;
    while cur < aligned_end {
        let existing = ptrace::read(pid, cur as AddressType)? as usize;
        let mut bytes = existing.to_ne_bytes();

        for i in 0..word_size {
            let at = cur + i;
            if at < addr || at >= addr + data.len() {
                continue;
            }
            bytes[i] = data[at - addr];
        }

        let mut full = [0u8; mem::size_of::<usize>()];
        full[..word_size].copy_from_slice(&bytes[..word_size]);
        let word = usize::from_ne_bytes(full) as nix::libc::c_long;
        ptrace::write(pid, cur as AddressType, word)?;
        cur += word_size;
    }
    Ok(())
}

fn mapping_contains_pc(line: &str, pc: u64) -> bool {
    let Some((range, _rest)) = line.split_once(' ') else {
        return false;
    };
    let Some((start_s, end_s)) = range.split_once('-') else {
        return false;
    };
    let Ok(start) = u64::from_str_radix(start_s, 16) else {
        return false;
    };
    let Ok(end) = u64::from_str_radix(end_s, 16) else {
        return false;
    };
    start <= pc && pc < end
}

fn parse_map_range(line: &str) -> Option<(u64, u64)> {
    let (range, _rest) = line.split_once(' ')?;
    let (start_s, end_s) = range.split_once('-')?;
    let start = u64::from_str_radix(start_s, 16).ok()?;
    let end = u64::from_str_radix(end_s, 16).ok()?;
    Some((start, end))
}

fn segv_code_name(code: i32) -> &'static str {
    match code {
        1 => "SEGV_MAPERR",
        2 => "SEGV_ACCERR",
        3 => "SEGV_BNDERR",
        4 => "SEGV_PKUERR",
        5 => "SEGV_ACCADI",
        6 => "SEGV_ADIDERR",
        7 => "SEGV_ADIPERR",
        8 => "SEGV_MTEAERR",
        9 => "SEGV_MTESERR",
        _ => "?",
    }
}

fn segv_siginfo_decoded(pid: Pid, maps_txt: &str) -> Option<(i32, i32, i32, u64)> {
    let mut si: nix::libc::siginfo_t = unsafe { mem::zeroed() };
    let ret = unsafe {
        nix::libc::ptrace(
            nix::libc::PTRACE_GETSIGINFO,
            pid.as_raw(),
            0,
            &mut si as *mut nix::libc::siginfo_t as *mut nix::libc::c_void,
        )
    };
    if ret < 0 {
        return None;
    }

    let base = (&si as *const nix::libc::siginfo_t).cast::<u8>();
    let rd_i32 = |off: usize| -> i32 {
        let p = unsafe { base.add(off).cast::<i32>() };
        unsafe { core::ptr::read_unaligned(p) }
    };
    let signo = rd_i32(0);
    let errno = rd_i32(4);
    let code = rd_i32(8);

    let raw = unsafe {
        core::slice::from_raw_parts(
            (&si as *const nix::libc::siginfo_t).cast::<u8>(),
            mem::size_of::<nix::libc::siginfo_t>(),
        )
    };

    // Prefer addresses that land inside the guest loader mapping if present.
    let mut preferred = Vec::new();
    if !maps_txt.is_empty() {
        for line in maps_txt.lines() {
            if !(line.contains("ld-linux") || line.contains("/usr/lib/ld-linux")) {
                continue;
            }
            if let Some((s, e)) = parse_map_range(line) {
                preferred.push((s, e));
            }
        }
    }

    let mut any = Vec::new();
    if !maps_txt.is_empty() {
        for line in maps_txt.lines() {
            if let Some((s, e)) = parse_map_range(line) {
                any.push((s, e));
            }
        }
    }

    let in_ranges = |v: u64, rs: &[(u64, u64)]| rs.iter().any(|(s, e)| *s <= v && v < *e);

    // Scan for a plausible `si_addr` word inside the siginfo blob.
    let mut best: Option<u64> = None;
    for off in 0..raw.len().saturating_sub(8) {
        let v = u64::from_ne_bytes(raw[off..off + 8].try_into().unwrap());
        if v == 0 {
            continue;
        }
        if !preferred.is_empty() && in_ranges(v, &preferred) {
            best = Some(v);
            break;
        }
        if best.is_none() && !any.is_empty() && in_ranges(v, &any) {
            best = Some(v);
        }
    }

    // Fall back to the common Linux offset if the scan didn't find anything.
    let addr = best.unwrap_or_else(|| {
        if raw.len() >= 24 {
            u64::from_ne_bytes(raw[16..24].try_into().unwrap())
        } else {
            0
        }
    });

    Some((signo, errno, code, addr))
}

fn segv_fault_addr(pid: Pid) -> Option<u64> {
    // Best-effort: for SIGSEGV, `siginfo_t` contains the faulting address at the start of the
    // `sigfault` union, which begins after (signo, errno, code) and padding.
    //
    // This is not a stable ABI promise across every libc, but works on Linux/Android in practice.
    let mut si: nix::libc::siginfo_t = unsafe { mem::zeroed() };
    let ret = unsafe {
        nix::libc::ptrace(
            nix::libc::PTRACE_GETSIGINFO,
            pid.as_raw(),
            0,
            &mut si as *mut nix::libc::siginfo_t as *mut nix::libc::c_void,
        )
    };
    if ret < 0 {
        return None;
    }
    // Union starts at offset 16 on 64-bit Linux ABIs.
    let base = (&si as *const nix::libc::siginfo_t).cast::<u8>();
    let addr_ptr = unsafe { base.add(16).cast::<u64>() };
    Some(unsafe { core::ptr::read_unaligned(addr_ptr) })
}

#[cfg(target_arch = "aarch64")]
fn decode_aarch64_ucontext_prefix(bs: &[u8]) -> Option<(u64, u64, u64, u64, [u64; 31])> {
    // Based on Linux aarch64 ucontext_t + sigcontext layout:
    // ucontext_t:
    //   0x00 uc_flags (u64)
    //   0x08 uc_link  (u64)
    //   0x10 uc_stack (stack_t, 24 bytes)
    //   0x28 uc_sigmask + padding to 0x80 total (128 bytes)
    //   0xa8 uc_mcontext (struct sigcontext)
    //
    // sigcontext:
    //   0x00 fault_address (u64)
    //   0x08 regs[31] (u64 each)
    //   0x100 sp (u64)
    //   0x108 pc (u64)
    //   0x110 pstate (u64)
    const UC_MCONTEXT_OFF: usize = 0xa8;
    const SC_FAULT_OFF: usize = UC_MCONTEXT_OFF + 0x00;
    const SC_REGS_OFF: usize = UC_MCONTEXT_OFF + 0x08;
    const SC_SP_OFF: usize = UC_MCONTEXT_OFF + 0x100;
    const SC_PC_OFF: usize = UC_MCONTEXT_OFF + 0x108;
    const SC_PSTATE_OFF: usize = UC_MCONTEXT_OFF + 0x110;
    if bs.len() < SC_PSTATE_OFF + 8 {
        return None;
    }
    let rd = |off: usize| -> u64 { u64::from_ne_bytes(bs[off..off + 8].try_into().unwrap()) };
    let fault = rd(SC_FAULT_OFF);
    let mut regs = [0u64; 31];
    for i in 0..31 {
        regs[i] = rd(SC_REGS_OFF + i * 8);
    }
    let sp = rd(SC_SP_OFF);
    let pc = rd(SC_PC_OFF);
    let pstate = rd(SC_PSTATE_OFF);
    Some((fault, sp, pc, pstate, regs))
}

#[cfg(not(target_arch = "aarch64"))]
fn decode_aarch64_ucontext_prefix(_bs: &[u8]) -> Option<(u64, u64, u64, u64, [u64; 31])> {
    None
}

#[derive(Clone)]
struct Aarch64SigFrameDecoded {
    fault_address: u64,
    sp: u64,
    pc: u64,
    pstate: u64,
    regs: [u64; 31],
    esr: Option<u64>,
}

fn read_siginfo_raw(pid: Pid) -> Vec<u8> {
    let mut si: nix::libc::siginfo_t = unsafe { mem::zeroed() };
    let ret = unsafe {
        nix::libc::ptrace(
            nix::libc::PTRACE_GETSIGINFO,
            pid.as_raw(),
            0,
            &mut si as *mut nix::libc::siginfo_t as *mut nix::libc::c_void,
        )
    };
    if ret < 0 {
        return Vec::new();
    }
    unsafe {
        core::slice::from_raw_parts(
            (&si as *const nix::libc::siginfo_t).cast::<u8>(),
            mem::size_of::<nix::libc::siginfo_t>(),
        )
        .to_vec()
    }
}

fn find_aarch64_sigframe_in_stack_blob(
    stack_blob: &[u8],
    si_addr: u64,
    siginfo_raw: &[u8],
) -> Option<Aarch64SigFrameDecoded> {
    // Linux/Android aarch64 rt_sigframe contains:
    //   siginfo_t (128 bytes)
    //   ucontext (starts immediately after siginfo_t)
    //
    const SIGINFO_SZ: usize = 128;
    let needle = si_addr.to_ne_bytes();

    // Determine where `si_addr` appears within the kernel-provided siginfo blob so we can
    // locate the same struct on the stack without assuming a fixed layout.
    let mut addr_off = None;
    if siginfo_raw.len() >= 24 {
        for o in 0..=siginfo_raw.len() - 8 {
            if siginfo_raw[o..o + 8] == needle {
                addr_off = Some(o);
                break;
            }
        }
    }
    let addr_off = addr_off.unwrap_or(16);

    // Use si_signo and si_code as additional anchors (these offsets are stable across 64-bit ABIs).
    let want_signo = siginfo_raw
        .get(0..4)
        .and_then(|b| b.try_into().ok())
        .map(i32::from_ne_bytes)
        .unwrap_or(11);
    let want_code = siginfo_raw
        .get(8..12)
        .and_then(|b| b.try_into().ok())
        .map(i32::from_ne_bytes)
        .unwrap_or(1);

    for off in (0..stack_blob.len().saturating_sub(SIGINFO_SZ + 0xb8 + 0x200)).step_by(8) {
        let signo = i32::from_ne_bytes(stack_blob.get(off..off + 4)?.try_into().ok()?);
        if signo != want_signo {
            continue;
        }
        let code = i32::from_ne_bytes(stack_blob.get(off + 8..off + 12)?.try_into().ok()?);
        if code != want_code {
            // Allow for slight differences in code interpretation.
            if !(code == 1 || code == 2) {
                continue;
            }
        }
        if stack_blob.get(off + addr_off..off + addr_off + 8)? != needle {
            continue;
        }

        // Decode ucontext that follows siginfo.
        let uctx_off = off + SIGINFO_SZ;
        let uctx = &stack_blob[uctx_off..];
        let (fault, sp, pc, pstate, regs, esr) = decode_aarch64_ucontext_from_slice(uctx)?;
        return Some(Aarch64SigFrameDecoded {
            fault_address: fault,
            sp,
            pc,
            pstate,
            regs,
            esr,
        });
    }
    None
}

#[cfg(target_arch = "aarch64")]
fn decode_aarch64_ucontext_from_slice(
    bs: &[u8],
) -> Option<(u64, u64, u64, u64, [u64; 31], Option<u64>)> {
    // ucontext_t:
    //   0x00 uc_flags (u64)
    //   0x08 uc_link  (u64)
    //   0x10 uc_stack (stack_t, 24 bytes)
    //   0x28 uc_sigmask + padding to 0x80 total (128 bytes)
    //   0xa8 uc_mcontext (struct sigcontext)
    //
    // sigcontext (asm/sigcontext.h):
    //   0x00 fault_address (u64)
    //   0x08 regs[31] (u64 each)
    //   0x100 sp (u64)
    //   0x108 pc (u64)
    //   0x110 pstate (u64)
    //   0x118 __reserved[4096]
    const UC_MCONTEXT_OFF: usize = 0xa8;
    const SC_FAULT_OFF: usize = UC_MCONTEXT_OFF + 0x00;
    const SC_REGS_OFF: usize = UC_MCONTEXT_OFF + 0x08;
    const SC_SP_OFF: usize = UC_MCONTEXT_OFF + 0x100;
    const SC_PC_OFF: usize = UC_MCONTEXT_OFF + 0x108;
    const SC_PSTATE_OFF: usize = UC_MCONTEXT_OFF + 0x110;
    const SC_RESERVED_OFF: usize = UC_MCONTEXT_OFF + 0x118;

    if bs.len() < SC_RESERVED_OFF + 64 {
        return None;
    }
    let rd = |off: usize| -> u64 { u64::from_ne_bytes(bs[off..off + 8].try_into().unwrap()) };
    let fault = rd(SC_FAULT_OFF);
    let mut regs = [0u64; 31];
    for i in 0..31 {
        regs[i] = rd(SC_REGS_OFF + i * 8);
    }
    let sp = rd(SC_SP_OFF);
    let pc = rd(SC_PC_OFF);
    let pstate = rd(SC_PSTATE_OFF);

    let reserved = &bs[SC_RESERVED_OFF..core::cmp::min(bs.len(), SC_RESERVED_OFF + 1024)];
    let esr = parse_esr_from_sigcontext_reserved(reserved);
    Some((fault, sp, pc, pstate, regs, esr))
}

#[cfg(not(target_arch = "aarch64"))]
fn decode_aarch64_ucontext_from_slice(
    _bs: &[u8],
) -> Option<(u64, u64, u64, u64, [u64; 31], Option<u64>)> {
    None
}

fn parse_esr_from_sigcontext_reserved(reserved: &[u8]) -> Option<u64> {
    // See /usr/include/aarch64-linux-android/asm/sigcontext.h:
    // struct esr_context { _aarch64_ctx head; u64 esr; }
    // head.magic = ESR_MAGIC (0x45535201), head.size is in bytes.
    const ESR_MAGIC: u32 = 0x4553_5201;
    for off in (0..reserved.len().saturating_sub(16)).step_by(4) {
        let magic = u32::from_ne_bytes(reserved[off..off + 4].try_into().ok()?);
        if magic != ESR_MAGIC {
            continue;
        }
        let size = u32::from_ne_bytes(reserved[off + 4..off + 8].try_into().ok()?);
        if size < 16 || (off + (size as usize)) > reserved.len() {
            continue;
        }
        let esr = u64::from_ne_bytes(reserved[off + 8..off + 16].try_into().ok()?);
        return Some(esr);
    }
    None
}

#[cfg(target_arch = "aarch64")]
fn segv_fault_regs_from_sigcontext_scan(
    pid: Pid,
    uctx_ptr: usize,
    fault_addr: u64,
) -> Option<(u64, u64)> {
    // Heuristic: scan the signal context blob for `fault_address` == fault_addr.
    // Once found, `struct sigcontext` layout is:
    //   u64 fault_address;
    //   u64 regs[31];
    //   u64 sp;
    //   u64 pc;
    //   u64 pstate;
    //   ...
    // Best-effort read: some frames live near the end of an alt-stack mapping.
    let bs = read_bytes_process_vm_best_effort(pid, uctx_ptr, 2048);
    if bs.len() < 280 {
        return None;
    }
    let needle = fault_addr.to_ne_bytes();
    for off in (0..bs.len().saturating_sub(8)).step_by(8) {
        if bs[off..off + 8] != needle {
            continue;
        }
        let sp_off = off + 8 + 31 * 8;
        let pc_off = sp_off + 8;
        if pc_off + 8 > bs.len() {
            continue;
        }
        let sp = u64::from_ne_bytes(bs[sp_off..sp_off + 8].try_into().ok()?);
        let pc = u64::from_ne_bytes(bs[pc_off..pc_off + 8].try_into().ok()?);
        // Basic sanity: pc shouldn't be zero.
        if pc == 0 {
            continue;
        }
        return Some((pc, sp));
    }
    None
}

#[cfg(not(target_arch = "aarch64"))]
fn segv_fault_regs_from_sigcontext_scan(
    _pid: Pid,
    _uctx_ptr: usize,
    _fault_addr: u64,
) -> Option<(u64, u64)> {
    None
}

// Android's sigchain/linker often clobbers x0/x1/x2 before we observe the ptrace signal-stop,
// so treating them as (sig, siginfo*, uctx*) is unreliable. However, the kernel still saves the
// faulting register state (sigcontext) into a signal frame. This helper scans around the current
// SP for a plausible sigcontext instance (by searching for `fault_addr`) and extracts (pc, sp).
#[cfg(target_arch = "aarch64")]
fn segv_fault_regs_from_stack_scan(
    pid: Pid,
    sp: u64,
    fault_addr: u64,
    maps_txt: &str,
) -> Option<(u64, u64)> {
    let sp = sp as usize;
    let win: usize = 64 * 1024;
    let start = sp.saturating_sub(win / 2);
    let bs = read_bytes_process_vm_best_effort(pid, start, win);
    if bs.len() < 280 {
        return None;
    }

    let needle = fault_addr.to_ne_bytes();
    let mut fallback: Option<(u64, u64)> = None;
    for off in (0..bs.len().saturating_sub(8)).step_by(8) {
        if bs[off..off + 8] != needle {
            continue;
        }
        let sp_off = off + 8 + 31 * 8;
        let pc_off = sp_off + 8;
        if pc_off + 8 > bs.len() {
            continue;
        }
        let sp2 = u64::from_ne_bytes(bs[sp_off..sp_off + 8].try_into().ok()?);
        let pc2 = u64::from_ne_bytes(bs[pc_off..pc_off + 8].try_into().ok()?);
        if pc2 == 0 {
            continue;
        }

        if !maps_txt.is_empty() {
            if let Some((_s, _e, line)) = find_mapping_containing(maps_txt, pc2) {
                if line.contains("ld-linux") || line.contains("/usr/lib/ld-linux") {
                    return Some((pc2, sp2));
                }
            }
        }

        if fallback.is_none() {
            fallback = Some((pc2, sp2));
        }
    }
    fallback
}

#[cfg(not(target_arch = "aarch64"))]
fn segv_fault_regs_from_stack_scan(
    _pid: Pid,
    _sp: u64,
    _fault_addr: u64,
    _maps_txt: &str,
) -> Option<(u64, u64)> {
    None
}

struct SigCtxAarch64Hit {
    fault_address: u64,
    regs: [u64; 31],
    sp: u64,
    pc: u64,
}

#[cfg(target_arch = "aarch64")]
fn sigcontext_scan_all_hits_from_blob(
    bs: &[u8],
    stack_range: Option<(u64, u64)>,
    guest_text_range: Option<(u64, u64)>,
) -> Vec<SigCtxAarch64Hit> {
    let mut hits = Vec::new();
    let Some((ss, se)) = stack_range else {
        return hits;
    };
    let Some((gs, ge)) = guest_text_range else {
        return hits;
    };
    if bs.len() < 24 {
        return hits;
    }
    for off in (0..bs.len().saturating_sub(24)).step_by(8) {
        let sp = match <[u8; 8]>::try_from(&bs[off..off + 8]) {
            Ok(a) => u64::from_ne_bytes(a),
            Err(_) => continue,
        };
        let pc = match <[u8; 8]>::try_from(&bs[off + 8..off + 16]) {
            Ok(a) => u64::from_ne_bytes(a),
            Err(_) => continue,
        };
        let _pstate = match <[u8; 8]>::try_from(&bs[off + 16..off + 24]) {
            Ok(a) => u64::from_ne_bytes(a),
            Err(_) => continue,
        };
        if !(ss <= sp && sp < se) {
            continue;
        }
        if !(gs <= pc && pc < ge) {
            continue;
        }
        let regs_start = match off.checked_sub(31 * 8) {
            Some(v) => v,
            None => continue,
        };
        let fault_off = match regs_start.checked_sub(8) {
            Some(v) => v,
            None => continue,
        };
        if fault_off + 8 > bs.len() {
            continue;
        }
        let fault_address = match <[u8; 8]>::try_from(&bs[fault_off..fault_off + 8]) {
            Ok(a) => u64::from_ne_bytes(a),
            Err(_) => continue,
        };
        let mut regs = [0u64; 31];
        let mut ok = true;
        for i in 0..31 {
            let roff = regs_start + i * 8;
            if roff + 8 > bs.len() {
                ok = false;
                break;
            }
            regs[i] = match <[u8; 8]>::try_from(&bs[roff..roff + 8]) {
                Ok(a) => u64::from_ne_bytes(a),
                Err(_) => {
                    ok = false;
                    break;
                }
            };
        }
        if !ok {
            continue;
        }
        hits.push(SigCtxAarch64Hit {
            fault_address,
            regs,
            sp,
            pc,
        });
    }
    hits
}

#[cfg(not(target_arch = "aarch64"))]
fn sigcontext_scan_all_hits_from_blob(
    _bs: &[u8],
    _stack_range: Option<(u64, u64)>,
    _guest_text_range: Option<(u64, u64)>,
) -> Vec<SigCtxAarch64Hit> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::{Arc, Mutex};

    // Ported from ../ptrace_playground/tests/rootless.rs:
    // - can_ls_root
    // - can_run_pacman_version_in_archlinux_arm64_rootfs (ignored by default)

    #[test]
    fn can_ls_root() {
        // Use the repo itself as a fake "rootfs": guest absolute "/src" should map to "./src".
        let rootfs = env!("CARGO_MANIFEST_DIR").to_string();
        let shim = shim_path();
        assert!(
            shim.exists(),
            "missing loader shim at {} (build and copy it into assets first)",
            shim.display()
        );

        let out = Arc::new(Mutex::new(String::new()));
        let out2 = Arc::clone(&out);

        let mut cmd = Command::new("ls");
        cmd.args(["/src"]);

        let code = rootless_chroot(Args {
            command: cmd,
            rootfs,
            binds: vec![],
            shim_exe: shim.into_os_string(),
            log: Some(Box::new(move |s| {
                let mut g = out2.lock().unwrap();
                g.push_str(&s);
                g.push('\n');
            })),
        });
        assert_eq!(code, 0, "ls exited with code={code}");

        let stdout = out.lock().unwrap().clone();
        assert!(
            stdout.contains("lib.rs") || stdout.contains("android"),
            "stdout was:\n{stdout}"
        );
    }

    #[test]
    fn can_run_pacman_version_in_archlinux_arm64_rootfs() {
        let rootfs_dir = Path::new("archfs");
        let archive_path = rootfs_dir.join("ArchLinuxARM-aarch64-latest.tar.gz");
        let url = "http://os.archlinuxarm.org/os/ArchLinuxARM-aarch64-latest.tar.gz";

        fs::create_dir_all(rootfs_dir).unwrap();
        if !rootfs_dir.join("usr/bin/pacman").exists() {
            if !archive_path.exists() {
                download_arch_rootfs(url, &archive_path);
            }
            extract_rootfs(&archive_path, rootfs_dir);
        }

        let shim = shim_path();
        assert!(
            shim.exists(),
            "missing loader shim at {} (build and copy it into assets first)",
            shim.display()
        );

        let out = Arc::new(Mutex::new(String::new()));
        let out2 = Arc::clone(&out);

        let mut cmd = Command::new("/usr/bin/pacman");
        cmd.arg("-V");

        let code = rootless_chroot(Args {
            command: cmd,
            rootfs: rootfs_dir.to_string_lossy().to_string(),
            binds: vec![],
            shim_exe: shim.into_os_string(),
            log: Some(Box::new(move |s| {
                let mut g = out2.lock().unwrap();
                g.push_str(&s);
                g.push('\n');
            })),
        });

        let stdout = out.lock().unwrap().clone();
        println!("{stdout:?}");

        assert_eq!(
            code, 0,
            "pacman exited with code={code}, stdout/stderr:\n{stdout}"
        );
        assert!(
            stdout.contains("Pacman v") || stdout.contains("pacman v"),
            "stdout was:\n{stdout}"
        );
    }

    fn shim_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("assets")
            .join("libs")
            .join("arm64-v8a")
            .join("librootless_chroot_loader.so")
    }

    fn download_arch_rootfs(url: &str, archive_path: &Path) {
        let archive = archive_path.to_string_lossy().to_string();
        let curl_status = Command::new("curl")
            .args(["-L", "--fail", "--retry", "3", "-o", &archive, url])
            .status();
        match curl_status {
            Ok(status) if status.success() => return,
            Ok(status) => panic!("curl failed downloading {url} with status {status}"),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => panic!("failed to execute curl: {err}"),
        }

        let wget_status = Command::new("wget")
            .args(["-O", &archive, url])
            .status()
            .unwrap_or_else(|err| panic!("failed to execute wget: {err}"));
        assert!(wget_status.success(), "wget failed downloading {url}");
    }

    fn extract_rootfs(archive_path: &Path, rootfs_dir: &Path) {
        let status = Command::new("tar")
            .arg("-xpf")
            .arg(archive_path)
            .arg("-C")
            .arg(rootfs_dir)
            .status()
            .unwrap_or_else(|err| panic!("failed to execute tar for extraction: {err}"));
        assert!(status.success(), "tar extraction failed");
    }
}
