use nix::fcntl::{fcntl, FcntlArg, OFlag};
use nix::sys::ptrace::AddressType;
use nix::sys::{ptrace, wait};
use nix::unistd::Pid;
use std::{
    collections::{HashMap, HashSet},
    ffi::{CString, OsString},
    io::Read,
    os::unix::ffi::OsStrExt,
    os::unix::process::CommandExt,
    path::Path,
    ptr,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use std::{fs, mem};

pub struct Args<'a> {
    pub command: Command,
    pub rootfs: String,
    pub binds: Vec<(String, String)>, // host_path:guest_path
    pub emulate_root_identity: bool,
    pub emulate_sigsys: bool,
    // Path to the external loader-shim binary.
    pub shim_exe: OsString,
    pub log: Option<Box<dyn FnMut(String) + 'a>>,
}

pub fn rootless_chroot<'a>(args: Args<'a>) -> i32 {
    rootless_chroot_ptrace(args)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WaitMode {
    AnyWall,
    Any,
    KnownTids,
}

fn rootless_chroot_ptrace<'a>(mut args: Args<'a>) -> i32 {
    // Emulate chroot by running the child from rootfs and mapping guest paths
    // into paths relative to that directory.
    //
    // Why ptrace path rewriting (instead of `chroot(2)` / mount namespaces):
    // - On Android/Termux we typically don't have privileges for real `chroot` or mounts.
    // - So we keep the host filesystem as-is and "lie" to the tracee by rewriting path
    //   arguments at the syscall boundary.
    let rootfs_abs =
        fs::canonicalize(&args.rootfs).unwrap_or_else(|_| Path::new(&args.rootfs).to_path_buf());
    let rootfs_abs_s = rootfs_abs.to_string_lossy().to_string();
    let mappings = build_path_mappings(&rootfs_abs_s, &args.binds);

    // Build the command:
    // - Use external loader-shim for dynamically-linked guest ELFs.
    // - Otherwise execute directly (legacy behavior used by tests like `can_ls_root`).
    let shim_exe = args.shim_exe.clone();
    let shim_exe_abs = {
        let p = Path::new(std::ffi::OsStr::from_bytes(shim_exe.as_bytes()));
        fs::canonicalize(p).unwrap_or_else(|_| {
            let cwd = std::env::current_dir().unwrap_or_default();
            cwd.join(p)
        })
    };
    let mut command = args.command;
    if let Some(prepared) = maybe_wrap_with_external_loader_shim(&command, &args.rootfs, &shim_exe)
    {
        command = prepared;
    } else {
        command = remap_command_program_in_rootfs(command, &args.rootfs, &mappings);
    }
    // PRoot explicitly sanitizes LD_* variables when handing execution to a guest loader.
    // On Android app processes, host loader-related LD_* variables can leak into guest glibc and
    // destabilize ld-linux startup under our loader-shim path.
    let mut removed_ld_env = 0usize;
    for (k, _) in std::env::vars_os() {
        if let Some(name) = k.to_str() {
            if name.starts_with("LD_") {
                command.env_remove(name);
                removed_ld_env += 1;
            }
        }
    }
    command.env_remove("LD_PRELOAD");
    if removed_ld_env != 0 {
        eprintln!("rootless spawn: removed {removed_ld_env} host LD_* env vars");
    }
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
    let mut pending_identity_emulation: HashMap<Pid, PendingIdentityEmulation> = HashMap::new();
    let mut pending_syscall_result_emulation: HashMap<Pid, PendingSyscallResultEmulation> =
        HashMap::new();
    let mut pending_sigsys_access_emu: HashMap<Pid, (String, i32, i32)> = HashMap::new();
    let mut force_next_syscall_entry_after_sigsys: HashSet<Pid> = HashSet::new();
    let mut traced_tids: HashSet<Pid> = HashSet::from([pid]);
    let mut pending_clone_stops: HashSet<Pid> = HashSet::new();
    let tracer_tid = current_tid();
    let mut wait_mode = WaitMode::KnownTids;
    let mut last_rescue = Instant::now();
    let emulate_sigsys =
        args.emulate_sigsys || std::env::var_os("POLAR_BEAR_PTRACE_EMULATE_SIGSYS").is_some();
    let do_rewrite = true;
    let mut step_remaining: Option<u32> = None;
    // Mitigation: glibc ld-linux writes TPIDR_EL0 early. On Android, linker64 can still crash in
    // signal handling paths when the guest mutates TPIDR_EL0 on some devices, so patch the guest
    // ld-linux `msr TPIDR_EL0, x0` instructions to NOP once the guest loader is mapped.
    // Broadly NOP-ing guest ld-linux TPIDR_EL0 writes was a bring-up workaround, but it prevents
    // glibc from installing the real guest TCB/TLS and crashes later in libc init (`__ctype_init`).
    // Keep it available only as an opt-in debug escape hatch.
    let patch_guest_tpidr_msr = std::env::var_os("LOCALDESKTOP_PATCH_GUEST_TPIDR_MSR").is_some();
    let mut patched_guest_tpidr_msr = !patch_guest_tpidr_msr;
    let mut exit_code: i32 = 1;
    loop {
        let wait_result = match wait_mode {
            WaitMode::AnyWall => match waitpid_raw(
                Pid::from_raw(-1),
                wait::WaitPidFlag::__WALL.bits(),
            ) {
                Err(nix::errno::Errno::EINVAL) => {
                    wait_mode = WaitMode::KnownTids;
                    eprintln!(
                        "waitpid(__WALL) returned EINVAL; switching to traced-TID polling"
                    );
                    wait_for_known_tracee_event(&traced_tids)
                }
                other => other,
            },
            WaitMode::Any => waitpid_raw(Pid::from_raw(-1), 0),
            WaitMode::KnownTids => wait_for_known_tracee_event(&traced_tids),
        };
        let wait_result = match wait_result {
            Err(nix::errno::Errno::EINVAL) if wait_mode == WaitMode::Any => {
                wait_mode = WaitMode::KnownTids;
                eprintln!("waitpid(-1) returned EINVAL; switching to traced-TID polling");
                wait_for_known_tracee_event(&traced_tids)
            }
            other => other,
        };
        match wait_result {
            Ok(wait::WaitStatus::PtraceSyscall(tracee)) => {
                traced_tids.insert(tracee);
                maybe_periodic_rescue(
                    wait_mode,
                    &mut last_rescue,
                    &mut traced_tids,
                    tracer_tid,
                    trace_opts,
                    &mut pending_clone_stops,
                );
                drain_stdout(&mut stdout, &mut buf, &mut carry, &mut args.log);
                drain_stdout(&mut stderr, &mut buf, &mut carry_err, &mut args.log);

                let is_entry = ptrace_syscall_is_entry(
                    tracee,
                    &mut in_syscall_fallback,
                    &mut force_next_syscall_entry_after_sigsys,
                );
                if let Ok(regs) = read_regs(tracee) {
                    if is_entry {
                        let current_sys = regs.regs[8] as i64;
                        let pending_mismatch = pending_sp_restore
                            .get(&tracee)
                            .map(|p| p.syscall)
                            .filter(|sys| *sys != current_sys);
                        if let Some(pending_sys) = pending_mismatch {
                                if let Some(pending) = pending_sp_restore.remove(&tracee) {
                                    let stack_adjusted = !pending.stack_write_restores.is_empty();
                                    if stack_adjusted {
                                        restore_tracee_stack_writes(tracee, &pending.stack_write_restores);
                                    }
                                    if stack_adjusted {
                                        if let Ok(mut regs_fix) = read_regs(tracee) {
                                            if regs_fix.sp < pending.original_sp {
                                        eprintln!(
                                            "restored stale pending syscall stack on next sysenter: tid={} pending_sys={} current_sys={} sp=0x{:x} -> 0x{:x}",
                                            tracee,
                                            pending_sys,
                                            current_sys,
                                            regs_fix.sp,
                                            pending.original_sp
                                        );
                                        regs_fix.sp = pending.original_sp;
                                        let _ = write_regs(tracee, &regs_fix);
                                    }
                                }
                                    }
                                }
                                pending_syscall_result_emulation.remove(&tracee);
                        }
                    }
                    if is_entry {
                        let sys = regs.regs[8] as i64;
                        if sys == nix::libc::SYS_set_robust_list || sys == 293 {
                            eprintln!(
                                "syscall-entry observe: tid={} sys={} pc=0x{:x} sp=0x{:x} x0=0x{:x} x1=0x{:x} x2=0x{:x}",
                                tracee,
                                sys,
                                regs.pc,
                                regs.sp,
                                regs.regs[0],
                                regs.regs[1],
                                regs.regs[2]
                            );
                        }
                    }
                    if args.emulate_root_identity {
                        if is_entry {
                            if let Some(pending) = capture_pending_identity_emulation(&regs) {
                                pending_identity_emulation.insert(tracee, pending);
                            }
                        } else {
                            apply_root_identity_emulation(
                                tracee,
                                &mut pending_identity_emulation,
                            );
                        }
                    }

                    if !patched_guest_tpidr_msr {
                        if let Ok(maps_txt) =
                            fs::read_to_string(format!("/proc/{}/maps", tracee))
                        {
                            if let Some(line) = maps_txt.lines().find(|l| {
                                l.contains(&rootfs_abs_s)
                                    && l.contains("/usr/lib/ld-linux-aarch64.so.1")
                                    && l.contains("r-xp")
                            }) {
                                if let Some((start, end)) = parse_map_range(line) {
                                    let nop = 0xd503201fu32.to_le_bytes(); // AArch64 NOP
                                    let text_len = end.saturating_sub(start) as usize;
                                    let text =
                                        read_bytes_process_vm_best_effort(tracee, start as usize, text_len);
                                    let mut patched_offsets: Vec<u64> = Vec::new();
                                    for off in (0..text.len().saturating_sub(4)).step_by(4) {
                                        let word = u32::from_le_bytes([
                                            text[off],
                                            text[off + 1],
                                            text[off + 2],
                                            text[off + 3],
                                        ]);
                                        // AArch64: `msr TPIDR_EL0, xN` encodes as 0xd51bd040 | Rt.
                                        if (word & !0x1f) == 0xd51bd040 {
                                            let addr = start + off as u64;
                                            if write_bytes(tracee, addr as usize, &nop).is_ok() {
                                                patched_offsets.push(off as u64);
                                            }
                                        }
                                    }
                                    eprintln!(
                                        "patched guest ld-linux: disabled TPIDR_EL0 writes at offsets {:?} (base=0x{start:x})",
                                        patched_offsets
                                    );
                                    patched_guest_tpidr_msr = true;
                                }
                            }
                        }
                    }

                    let is_guest = should_rewrite_from_pc(tracee, regs.pc, &rootfs_abs_s);
                    if !is_entry && is_guest {
                        log_pacman_fs_failure(tracee, &regs, &mappings);
                    }

                    if do_rewrite && is_entry && is_guest {
                        // Prefer shim-side SIGSYS emulation when available; ptrace-side syscall
                        // preemption remains disabled by default because Android seccomp also
                        // traps many placeholder syscalls on some devices.
                        match rewrite_syscall_path_with_regs(
                            tracee,
                            regs,
                            &mappings,
                            Some(&shim_exe_abs),
                        ) {
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
                                if let Some(emu) = pending_syscall_result_emulation.remove(&tracee) {
                                    regs_exit.regs[0] = emu.retval as u64;
                                }
                                if let Some((mapped_path, mode, flags)) = r.access_emu.as_ref() {
                                    let ret = regs_exit.regs[0] as i64;
                                    if ret == -(nix::libc::ENETDOWN as i64)
                                        || ((r.syscall == nix::libc::SYS_faccessat
                                            || r.syscall == nix::libc::SYS_faccessat2)
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
                                let is_exec = matches!(
                                    r.syscall,
                                    x if x == nix::libc::SYS_execve || x == nix::libc::SYS_execveat
                                );
                                if args.emulate_root_identity {
                                    let ret = regs_exit.regs[0] as i64;
                                    if fake_root_should_force_perm_success(r.syscall, ret) {
                                        eprintln!(
                                            "fake-root perm override: tid={} sys={} ret={} -> 0",
                                            tracee, r.syscall, ret
                                        );
                                        regs_exit.regs[0] = 0;
                                    }
                                }
                                let ret = regs_exit.regs[0] as i64;
                                if let Some(debug_path) = r.debug_path.as_deref() {
                                    if debug_path.contains("/var/lib/pacman") {
                                        eprintln!(
                                            "pacman rewritten syscall-exit: tid={} sys={} ret={} path={}",
                                            tracee, r.syscall, ret, debug_path
                                        );
                                    }
                                }
                                if args.emulate_root_identity && ret == 0 && syscall_is_fstatat(r.syscall) {
                                    patch_tracee_stat_uid_gid_root(tracee, r.original_args[2]);
                                }
                                let stack_adjusted = !r.stack_write_restores.is_empty();
                                if !is_exec || ret < 0 {
                                    restore_tracee_stack_writes(tracee, &r.stack_write_restores);
                                }
                                regs_exit.regs[1..6].copy_from_slice(&r.original_args[1..6]);
                                regs_exit.regs[8] = r.original_x8;
                                if (!is_exec || ret < 0) && stack_adjusted {
                                    regs_exit.sp = r.original_sp;
                                }
                                let _ = write_regs(tracee, &regs_exit);
                            }
                        }
                        if pending_sp_restore.get(&tracee).is_none() {
                            if let Some(emu) = pending_syscall_result_emulation.remove(&tracee) {
                                if let Ok(mut regs_exit) = read_regs(tracee) {
                                    regs_exit.regs[0] = emu.retval as u64;
                                    let _ = write_regs(tracee, &regs_exit);
                                }
                            }
                            if args.emulate_root_identity {
                                if let Ok(mut regs_exit) = read_regs(tracee) {
                                    let ret = regs_exit.regs[0] as i64;
                                    let sys = regs_exit.regs[8] as i64;
                                    let mut changed = false;
                                    if fake_root_should_force_perm_success(sys, ret) {
                                        eprintln!(
                                            "fake-root perm override (no pending rewrite): tid={} sys={} ret={} -> 0",
                                            tracee, sys, ret
                                        );
                                        regs_exit.regs[0] = 0;
                                        changed = true;
                                    }
                                    if ret == 0 {
                                        if sys == nix::libc::SYS_fstat {
                                            patch_tracee_stat_uid_gid_root(tracee, regs_exit.regs[1]);
                                        } else if syscall_is_fstatat(sys) {
                                            patch_tracee_stat_uid_gid_root(tracee, regs_exit.regs[2]);
                                        }
                                    }
                                    if changed {
                                        let _ = write_regs(tracee, &regs_exit);
                                    }
                                }
                            }
                        }
                    }

                    if false
                        && !is_entry
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
                traced_tids.insert(tracee);
                drain_stdout(&mut stdout, &mut buf, &mut carry, &mut args.log);
                drain_stdout(&mut stderr, &mut buf, &mut carry_err, &mut args.log);

                if pending_clone_stops.remove(&tracee) {
                    if let Err(e) = ptrace::setoptions(tracee, trace_opts) {
                        eprintln!("setoptions(new tracee {tracee}) failed: {e}");
                    }
                    let _ = ptrace::syscall(tracee, None);
                    continue;
                }

                if sig == nix::sys::signal::Signal::SIGSTOP {
                    // Suppress ptrace-internal clone/group-stop stops; forwarding SIGSTOP back to the
                    // guest can leave worker threads permanently stopped and stall pacman sync.
                    let _ = ptrace::syscall(tracee, None);
                    continue;
                }

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

                if sig == nix::sys::signal::Signal::SIGTRAP {
                    // Most plain SIGTRAP stops here are ptrace-internal (clone/exec/seccomp-adjacent)
                    // bookkeeping stops, not guest-intended signals. Forwarding them can strand guest
                    // worker threads in a stopped state; suppress and continue tracing.
                    let _ = ptrace::syscall(tracee, None);
                    continue;
                }

                if sig == nix::sys::signal::Signal::SIGSYS {
                    if let Some(p) = pending_sp_restore.get(&tracee) {
                        if let Ok(r) = read_regs(tracee) {
                            eprintln!(
                                "SIGSYS with pending rewrite: tid={} pending_sys={} current_sys={} sp=0x{:x} pending_sp=0x{:x}",
                                tracee,
                                p.syscall,
                                r.regs[8] as i64,
                                r.sp,
                                p.original_sp
                            );
                        }
                    }
                    if let Some(pending) = pending_sp_restore.remove(&tracee) {
                    let current_sysno = read_regs(tracee).ok().map(|r| r.regs[8] as i64);
                    let pending_is_exec = matches!(
                        pending.syscall,
                        x if x == nix::libc::SYS_execve || x == nix::libc::SYS_execveat
                    );
                    if pending.syscall == nix::libc::SYS_faccessat2 {
                        if let Some(v) = pending.access_emu.clone() {
                            pending_sigsys_access_emu.insert(tracee, v);
                        }
                    }
                    let stack_adjusted = !pending.stack_write_restores.is_empty();
                    if let Some(cur) = current_sysno {
                        if cur != pending.syscall {
                            if let Ok(mut regs_sig) = read_regs(tracee) {
                                if stack_adjusted {
                                    restore_tracee_stack_writes(tracee, &pending.stack_write_restores);
                                }
                                if stack_adjusted && regs_sig.sp < pending.original_sp {
                                    eprintln!(
                                        "restored stale pending syscall stack on SIGSYS mismatch: tid={} pending_sys={} current_sys={} sp=0x{:x} -> 0x{:x}",
                                        tracee,
                                        pending.syscall,
                                        cur,
                                        regs_sig.sp,
                                        pending.original_sp
                                    );
                                    regs_sig.sp = pending.original_sp;
                                    let _ = write_regs(tracee, &regs_sig);
                                }
                            }
                            let _ = pending_syscall_result_emulation.remove(&tracee);
                            eprintln!(
                                "dropping stale pending stack restore on SIGSYS: tid={} pending_sys={} current_sys={}",
                                tracee, pending.syscall, cur
                            );
                        } else
                    if pending_is_exec {
                        // Successful execve/execveat does not produce a normal syscall-exit stop.
                        // If the new image takes an early signal stop (e.g. seccomp SIGSYS in
                        // guest ld-linux), restoring the pre-exec synthetic argv/path stack bytes
                        // corrupts the new process image's stack/register state.
                        let _ = pending_syscall_result_emulation.remove(&tracee);
                        eprintln!(
                            "dropping pending exec stack restore on signal-stop {:?}: tid={} sys={}",
                            sig, tracee, pending.syscall
                        );
                    } else {
                    // A signal-stop can interrupt a rewritten syscall before we see the matching
                    // syscall-exit stop (e.g. seccomp SIGSYS). If we keep the synthetic path bytes
                    // on the tracee stack, repeated interruptions drift SP and eventually corrupt
                    // returns. Restore SP before forwarding the signal.
                        if let Ok(mut regs_sig) = read_regs(tracee) {
                            if stack_adjusted {
                                restore_tracee_stack_writes(tracee, &pending.stack_write_restores);
                            }
                            regs_sig.regs[1..6].copy_from_slice(&pending.original_args[1..6]);
                            regs_sig.regs[8] = pending.original_x8;
                            if stack_adjusted && regs_sig.sp != pending.original_sp {
                                eprintln!(
                                    "restored pending syscall stack on signal-stop {:?}: tid={} sp=0x{:x} -> 0x{:x} (sys={})",
                                    sig,
                                    tracee,
                                    regs_sig.sp,
                                    pending.original_sp,
                                    pending.syscall
                                );
                                regs_sig.sp = pending.original_sp;
                            }
                            let _ = write_regs(tracee, &regs_sig);
                        }
                        let _ = pending_syscall_result_emulation.remove(&tracee);
                    }
                    } else if pending_is_exec {
                        let _ = pending_syscall_result_emulation.remove(&tracee);
                    } else {
                        let _ = pending_syscall_result_emulation.remove(&tracee);
                    }
                    }
                }

                if sig == nix::sys::signal::Signal::SIGSYS {
                    in_syscall_fallback.remove(&tracee);
                    if !emulate_sigsys {
                        let _ = ptrace::syscall(tracee, Some(sig));
                        continue;
                    }
                    if let Ok(stop_regs) = read_regs(tracee) {
                        let sigsys_info = read_siginfo_raw(tracee);
                        let sigsys_decoded = sigsys_siginfo_decoded(&sigsys_info);
                        let mut sysno = stop_regs.regs[8] as i64;
                        if let Some((_, _, _, si_sysno, _, _)) = sigsys_decoded {
                            if si_sysno >= 0 {
                                sysno = si_sysno as i64;
                            }
                        }
                        let mut advance_pc = true;
                        let mut resume_pc = stop_regs.pc;
                        let mut used_call_addr = false;
                        if let Some((_signo, _errno, _code, _sys, call_addr, _arch)) = sigsys_decoded
                        {
                            if call_addr != 0 {
                                if let Ok(code) = read_bytes_process_vm(tracee, call_addr as usize, 4) {
                                    if code.len() == 4 {
                                        let insn = u32::from_le_bytes([code[0], code[1], code[2], code[3]]);
                                        if insn == 0xd4000001 {
                                            resume_pc = call_addr.wrapping_add(4);
                                            advance_pc = false;
                                            used_call_addr = true;
                                        }
                                    }
                                }
                                if !used_call_addr && call_addr >= 4 {
                                    if let Ok(code_prev) = read_bytes_process_vm(
                                        tracee,
                                        call_addr.wrapping_sub(4) as usize,
                                        4,
                                    ) {
                                        if code_prev.len() == 4 {
                                            let prev = u32::from_le_bytes([
                                                code_prev[0],
                                                code_prev[1],
                                                code_prev[2],
                                                code_prev[3],
                                            ]);
                                            if prev == 0xd4000001 {
                                                // Some kernels expose the post-svc address.
                                                resume_pc = call_addr;
                                                advance_pc = false;
                                                used_call_addr = true;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        if !used_call_addr {
                        if let Ok(code) = read_bytes_process_vm(tracee, stop_regs.pc as usize, 4) {
                            if code.len() == 4 {
                                let insn =
                                    u32::from_le_bytes([code[0], code[1], code[2], code[3]]);
                                // AArch64 `svc #0` used by our shim/guest syscall stubs.
                                if insn != 0xd4000001 {
                                    advance_pc = false;
                                }
                            }
                        }
                        }
                        let mut regs = stop_regs;
                        let restored_sigsys_frame =
                            try_restore_sigsys_interrupted_regs_from_stack(tracee, stop_regs, &mut regs);
                        regs.pc = resume_pc;
                        let mut emulated = false;
                        eprintln!(
                            "SIGSYS stop: sysno={} pc=0x{:x} sp=0x{:x} x0=0x{:x} x1=0x{:x} x2=0x{:x} x8=0x{:x} advance_pc={} restored_frame={} call_addr={} used_call_addr={} -> resume pc=0x{:x} sp=0x{:x}",
                            sysno,
                            stop_regs.pc,
                            stop_regs.sp,
                            stop_regs.regs[0],
                            stop_regs.regs[1],
                            stop_regs.regs[2],
                            stop_regs.regs[8],
                            advance_pc
                            ,
                            restored_sigsys_frame,
                            sigsys_decoded
                                .map(|(_, _, _, _, call_addr, _)| format!("0x{call_addr:x}"))
                                .unwrap_or_else(|| "?".to_string()),
                            used_call_addr,
                            regs.pc,
                            regs.sp
                        );
                        // Match proot's behavior for seccomp-trap SIGSYS handling: emulate/suppress
                        // the signal and resume, but do not try to "undo" a guessed rt_sigframe on
                        // the guest stack. The exact stop semantics vary across Android kernels.
                        match sysno {
                            99 => {
                                // Android app seccomp can trap `set_robust_list` even though the
                                // guest glibc expects a Linux kernel that supports it. Returning
                                // ENOSYS was tolerated in some bring-up paths but still leaves
                                // newer glibc/pacman startups unstable. Emulate success here.
                                regs.regs[0] = 0;
                                if advance_pc {
                                    regs.pc = regs.pc.wrapping_add(4);
                                }
                                eprintln!(
                                    "emulated SIGSYS set_robust_list as success: pc=0x{:x} sp=0x{:x} advance_pc={}",
                                    regs.pc, regs.sp, advance_pc
                                );
                                emulated = true;
                            }
                            439 => {
                                // Android kernels frequently seccomp-trap `faccessat2`. Use the
                                // already rewritten host path (when available) to emulate the access
                                // check directly; otherwise fall back to ENOSYS for libc compatibility.
                                let mode = regs.regs[2] as i32;
                                let flags = regs.regs[3] as i32;
                                let mut mapped_and_mode: Option<(String, i32, i32)> =
                                    pending_sigsys_access_emu
                                        .remove(&tracee)
                                        .map(|(mapped, mode0, flags0)| (mapped, mode0, flags0));
                                if mapped_and_mode.is_none() {
                                    let addr_raw = regs.regs[1] as usize;
                                    if let Ok((_addr, path_bytes)) =
                                        read_cstring_candidates_any(tracee, addr_raw)
                                    {
                                        let path = String::from_utf8_lossy(&path_bytes).to_string();
                                        let dirfd = regs.regs[0] as i64;
                                        let mapped = apply_path_mappings(&path, &mappings).or_else(|| {
                                            if path.starts_with('/') {
                                                None
                                            } else {
                                                resolve_effective_path_for_tracee(tracee, Some(dirfd), &path)
                                                    .and_then(|resolved| apply_path_mappings(&resolved, &mappings))
                                            }
                                        });
                                        if let Some(mapped) = mapped {
                                            mapped_and_mode = Some((mapped, mode, flags));
                                        }
                                    }
                                }
                                if let Some((mapped_path, mode, flags)) = mapped_and_mode {
                                    let emu = emulate_faccessat_result(
                                        tracee,
                                        &mapped_path,
                                        mode,
                                        flags,
                                    );
                                    regs.regs[0] = emu as u64;
                                    eprintln!(
                                        "emulated SIGSYS faccessat2 via host faccessat: path={} mode={} flags=0x{:x} ret={}",
                                        mapped_path,
                                        mode,
                                        flags,
                                        emu
                                    );
                                } else {
                                    regs.regs[0] = (-(nix::libc::ENOSYS as i64)) as u64;
                                    eprintln!(
                                        "emulated SIGSYS faccessat2 as ENOSYS (no mapped path): pc=0x{:x} sp=0x{:x} advance_pc={}",
                                        regs.pc, regs.sp, advance_pc
                                    );
                                }
                                if advance_pc {
                                    regs.pc = regs.pc.wrapping_add(4);
                                }
                                emulated = true;
                            }
                            293 => {
                                // Match proot: report unsupported and let glibc disable rseq.
                                regs.regs[0] = (-(nix::libc::ENOSYS as i64)) as u64;
                                if advance_pc {
                                    regs.pc = regs.pc.wrapping_add(4);
                                }
                                eprintln!(
                                    "emulated SIGSYS rseq as ENOSYS: pc=0x{:x} sp=0x{:x} advance_pc={}",
                                    regs.pc, regs.sp, advance_pc
                                );
                                emulated = true;
                            }
                            _ => {
                                // Default seccomp trap behavior for unsupported Linux syscalls:
                                // make it look like the syscall is unavailable.
                                regs.regs[0] = (-(nix::libc::ENOSYS as i64)) as u64;
                                if advance_pc {
                                    regs.pc = regs.pc.wrapping_add(4);
                                }
                                eprintln!(
                                    "emulated SIGSYS as ENOSYS: sysno={} pc=0x{:x} sp=0x{:x} advance_pc={}",
                                    sysno, regs.pc, regs.sp, advance_pc
                                );
                                emulated = true;
                            }
                        }
                        if emulated {
                            let _ = write_regs(tracee, &regs);
                            force_next_syscall_entry_after_sigsys.insert(tracee);
                            let _ = ptrace::syscall(tracee, None);
                            continue;
                        }
                    }
                }

                if sig == nix::sys::signal::Signal::SIGSEGV {
                    if let Some(p) = pending_sp_restore.get(&tracee) {
                        eprintln!(
                            "fatal SIGSEGV with pending rewrite: tid={} pending_sys={} pending_sp=0x{:x}",
                            tracee, p.syscall, p.original_sp
                        );
                    }
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
                    // Default behavior: log diagnostics, then forward SIGSEGV so guest handlers
                    // (loader shim / sigchain) can run. Keep the old kill-on-segv behavior as an
                    // opt-in debugging mode.
                    if std::env::var_os("POLAR_BEAR_PTRACE_KILL_ON_SEGV").is_some() {
                        let _ = ptrace::kill(tracee);
                        let _ = wait::waitpid(tracee, None);
                        exit_code = 128 + (nix::sys::signal::Signal::SIGSEGV as i32);
                        break;
                    }
                    let _ = ptrace::syscall(tracee, Some(sig));
                    continue;
                }
                if matches!(
                    sig,
                    nix::sys::signal::Signal::SIGBUS
                        | nix::sys::signal::Signal::SIGILL
                        | nix::sys::signal::Signal::SIGABRT
                ) {
                    if let Some(p) = pending_sp_restore.get(&tracee) {
                        eprintln!(
                            "fatal {:?} with pending rewrite: tid={} pending_sys={} pending_sp=0x{:x}",
                            sig, tracee, p.syscall, p.original_sp
                        );
                    }
                    log_non_segv_signal_diagnostics(tracee, sig);
                }
                let _ = ptrace::syscall(tracee, Some(sig));
            }
            Ok(wait::WaitStatus::Exited(tracee, code)) => {
                traced_tids.remove(&tracee);
                in_syscall_fallback.remove(&tracee);
                pending_sp_restore.remove(&tracee);
                pending_identity_emulation.remove(&tracee);
                pending_syscall_result_emulation.remove(&tracee);
                pending_sigsys_access_emu.remove(&tracee);
                force_next_syscall_entry_after_sigsys.remove(&tracee);
                pending_clone_stops.remove(&tracee);
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
                traced_tids.remove(&tracee);
                in_syscall_fallback.remove(&tracee);
                pending_sp_restore.remove(&tracee);
                pending_identity_emulation.remove(&tracee);
                pending_syscall_result_emulation.remove(&tracee);
                pending_sigsys_access_emu.remove(&tracee);
                force_next_syscall_entry_after_sigsys.remove(&tracee);
                pending_clone_stops.remove(&tracee);
                if tracee != pid {
                    continue;
                }
                drain_stdout(&mut stdout, &mut buf, &mut carry, &mut args.log);
                drain_stdout(&mut stderr, &mut buf, &mut carry_err, &mut args.log);
                eprintln!("tracee exited by signal {:?} ({})", sig, sig as i32);
                log_non_segv_signal_diagnostics(tracee, sig);
                exit_code = 128 + (sig as i32);
                break;
            }
            Ok(wait::WaitStatus::PtraceEvent(tracee, _, evt)) => {
                traced_tids.insert(tracee);
                maybe_periodic_rescue(
                    wait_mode,
                    &mut last_rescue,
                    &mut traced_tids,
                    tracer_tid,
                    trace_opts,
                    &mut pending_clone_stops,
                );
                match evt {
                    x if x == nix::libc::PTRACE_EVENT_EXEC => {
                        pending_sp_restore.remove(&tracee);
                        pending_syscall_result_emulation.remove(&tracee);
                        pending_sigsys_access_emu.remove(&tracee);
                        in_syscall_fallback.remove(&tracee);
                        force_next_syscall_entry_after_sigsys.remove(&tracee);
                    }
                    x if x == nix::libc::PTRACE_EVENT_CLONE
                        || x == nix::libc::PTRACE_EVENT_FORK
                        || x == nix::libc::PTRACE_EVENT_VFORK =>
                    {
                        match ptrace::getevent(tracee) {
                            Ok(new_raw) if new_raw > 0 => {
                                let new_pid = Pid::from_raw(new_raw as i32);
                                traced_tids.insert(new_pid);
                                pending_clone_stops.insert(new_pid);
                                // Android's ptrace waits for CLONE_THREAD children are quirky on
                                // some devices. Retry briefly here so we can resume the new tracee
                                // immediately after the clone event, instead of relying on a later
                                // child-stop wait that may never be reported.
                                let mut resumed_now = false;
                                let mut last_err: Option<nix::errno::Errno> = None;
                                for _ in 0..64 {
                                    match ptrace::setoptions(new_pid, trace_opts) {
                                        Ok(()) => match ptrace::syscall(new_pid, None) {
                                            Ok(()) => {
                                                pending_clone_stops.remove(&new_pid);
                                                resumed_now = true;
                                                break;
                                            }
                                            Err(e) => {
                                                last_err = Some(e);
                                            }
                                        },
                                        Err(e) => {
                                            last_err = Some(e);
                                        }
                                    }
                                    std::thread::sleep(Duration::from_millis(1));
                                }
                                if !resumed_now {
                                    if let Some(e) = last_err {
                                        eprintln!("new tracee {new_pid} deferred after retries: {e}");
                                    }
                                }
                            }
                            Ok(_) => {}
                            Err(e) => eprintln!("ptrace::getevent({tracee}) failed for clone event: {e}"),
                        }
                    }
                    _ => {}
                }
                let _ = ptrace::syscall(tracee, None);
            }
            Ok(wait::WaitStatus::Continued(tracee)) => {
                traced_tids.insert(tracee);
                maybe_periodic_rescue(
                    wait_mode,
                    &mut last_rescue,
                    &mut traced_tids,
                    tracer_tid,
                    trace_opts,
                    &mut pending_clone_stops,
                );
                let _ = ptrace::syscall(tracee, None);
            }
            Ok(wait::WaitStatus::StillAlive) => {
                if wait_mode == WaitMode::KnownTids {
                    rescue_stopped_tracees(
                        &mut traced_tids,
                        tracer_tid,
                        trace_opts,
                        &mut pending_clone_stops,
                    );
                    last_rescue = Instant::now();
                }
            }
            Ok(_) => {
                maybe_periodic_rescue(
                    wait_mode,
                    &mut last_rescue,
                    &mut traced_tids,
                    tracer_tid,
                    trace_opts,
                    &mut pending_clone_stops,
                );
                let _ = ptrace::syscall(pid, None);
            }
            Err(e) => {
                println!("{e:?}");
                exit_code = 1;
                break;
            }
        }
        if wait_mode == WaitMode::KnownTids {
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    // The end
    exit_code
}

fn rescue_stopped_tracees(
    traced_tids: &mut HashSet<Pid>,
    tracer_tid: Pid,
    trace_opts: ptrace::Options,
    pending_clone_stops: &mut HashSet<Pid>,
) {
    let mut candidates: Vec<Pid> = traced_tids.iter().copied().collect();
    for discovered in scan_tracer_owned_tracees(tracer_tid) {
        if traced_tids.insert(discovered) {
            eprintln!("rescue: discovered traced pid {} via /proc scan", discovered);
        }
        candidates.push(discovered);
    }
    candidates.sort_by_key(|p| p.as_raw());
    candidates.dedup_by_key(|p| p.as_raw());

    for tracee in candidates {
        if !thread_is_stopped(tracee) {
            continue;
        }
        let _ = ptrace::setoptions(tracee, trace_opts);
        if ptrace::syscall(tracee, None).is_ok() {
            pending_clone_stops.remove(&tracee);
        } else {
            let err = nix::errno::Errno::last();
            if matches!(err, nix::errno::Errno::ESRCH | nix::errno::Errno::ECHILD) {
                traced_tids.remove(&tracee);
            } else {
                eprintln!("rescue: ptrace::syscall({tracee}) failed: {err}");
            }
        }
    }
}

fn maybe_periodic_rescue(
    wait_mode: WaitMode,
    last_rescue: &mut Instant,
    traced_tids: &mut HashSet<Pid>,
    tracer_tid: Pid,
    trace_opts: ptrace::Options,
    pending_clone_stops: &mut HashSet<Pid>,
) {
    if wait_mode != WaitMode::KnownTids {
        return;
    }
    let rescue_due = last_rescue.elapsed() >= Duration::from_millis(25);
    if !rescue_due && pending_clone_stops.is_empty() {
        return;
    }
    rescue_stopped_tracees(traced_tids, tracer_tid, trace_opts, pending_clone_stops);
    *last_rescue = Instant::now();
}

fn current_tid() -> Pid {
    let tid = unsafe { nix::libc::syscall(nix::libc::SYS_gettid as nix::libc::c_long) } as i32;
    Pid::from_raw(tid)
}

fn scan_tracer_owned_tracees(tracer_tid: Pid) -> Vec<Pid> {
    let mut out = Vec::new();
    let Ok(proc_entries) = fs::read_dir("/proc") else {
        return out;
    };
    for entry in proc_entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let Ok(pid_raw) = name.parse::<i32>() else {
            continue;
        };
        let Ok(status) = fs::read_to_string(entry.path().join("status")) else {
            continue;
        };
        let mut tracer = None;
        for line in status.lines() {
            if let Some(v) = line.strip_prefix("TracerPid:") {
                tracer = v.trim().parse::<i32>().ok();
                break;
            }
        }
        if tracer == Some(tracer_tid.as_raw()) {
            out.push(Pid::from_raw(pid_raw));
        }
    }
    out
}

fn thread_is_stopped(tid: Pid) -> bool {
    let Ok(status) = fs::read_to_string(format!("/proc/{}/status", tid)) else {
        return false;
    };
    status
        .lines()
        .find_map(|line| line.strip_prefix("State:"))
        .map(|s| {
            let s = s.trim_start();
            s.starts_with('t') || s.starts_with('T')
        })
        .unwrap_or(false)
}

fn wait_for_known_tracee_event(traced_tids: &HashSet<Pid>) -> nix::Result<wait::WaitStatus> {
    const LINUX_WCLONE: i32 = 0x8000_0000u32 as i32;
    let mut saw_alive = false;
    let wnohang = wait::WaitPidFlag::WNOHANG.bits();
    let wnohang_wall = wnohang | wait::WaitPidFlag::__WALL.bits();
    let wnohang_wclone = wnohang | LINUX_WCLONE;
    let waitid_base =
        nix::libc::WNOHANG | nix::libc::WEXITED | nix::libc::WSTOPPED | nix::libc::WCONTINUED;
    let waitid_wall = waitid_base | (wait::WaitPidFlag::__WALL.bits() as nix::libc::c_int);
    let waitid_wclone = waitid_base | (LINUX_WCLONE as nix::libc::c_int);
    // First prefer nonblocking wait4(-1, ...) for ptrace events; Android appears to report
    // traced stops more reliably there than through waitid(P_ALL/P_PID) on some devices.
    for status in [
        waitpid_raw(Pid::from_raw(-1), wnohang_wall),
        waitpid_raw(Pid::from_raw(-1), wnohang_wclone),
        waitpid_raw(Pid::from_raw(-1), wnohang),
    ] {
        match status {
            Ok(wait::WaitStatus::StillAlive) | Err(nix::errno::Errno::EINVAL) => {}
            Ok(status) => return Ok(status),
            Err(nix::errno::Errno::ECHILD) => {}
            Err(e) => return Err(e),
        }
    }
    // Android kernels/userspace can be inconsistent for per-TID waits on traced clone threads.
    // First poll globally (P_ALL) in nonblocking mode so we don't miss a ready tracee event.
    for status in [
        waitid_any_raw(waitid_wall),
        waitid_any_raw(waitid_wclone),
        waitid_any_raw(waitid_base),
    ] {
        match status {
            Ok(wait::WaitStatus::StillAlive) | Err(nix::errno::Errno::EINVAL) => {}
            Ok(status) => return Ok(status),
            Err(nix::errno::Errno::ECHILD) => {}
            Err(e) => return Err(e),
        }
    }
    for tracee in traced_tids.iter().copied() {
        let status = match waitid_pid_raw(tracee, waitid_wall) {
            Err(nix::errno::Errno::EINVAL) => match waitid_pid_raw(tracee, waitid_wclone) {
                Err(nix::errno::Errno::EINVAL) => waitid_pid_raw(tracee, waitid_base),
                other => other,
            },
            other => other,
        };
        let status = match status {
            Ok(wait::WaitStatus::StillAlive) | Err(nix::errno::Errno::EINVAL) => {
                match waitpid_raw(tracee, wnohang_wall) {
                    Err(nix::errno::Errno::EINVAL) => match waitpid_raw(tracee, wnohang_wclone) {
                        Err(nix::errno::Errno::EINVAL) => waitpid_raw(tracee, wnohang),
                        other => other,
                    },
                    other => other,
                }
            }
            other => other,
        };
        match status {
            Ok(wait::WaitStatus::StillAlive) => {
                saw_alive = true;
            }
            Ok(status) => return Ok(status),
            Err(nix::errno::Errno::ECHILD) | Err(nix::errno::Errno::ESRCH) => {}
            Err(e) => {
                if e == nix::errno::Errno::EINVAL {
                    eprintln!(
                        "wait_for_known_tracee_event: wait4(tid={}, WNOHANG[/__WALL|__WCLONE]) -> EINVAL",
                        tracee
                    );
                }
                return Err(e);
            }
        }
    }
    if saw_alive {
        Ok(wait::WaitStatus::StillAlive)
    } else {
        Err(nix::errno::Errno::ECHILD)
    }
}

fn waitid_any_raw(options: nix::libc::c_int) -> nix::Result<wait::WaitStatus> {
    let mut siginfo: nix::libc::siginfo_t = unsafe { mem::zeroed() };
    let res = unsafe {
        nix::libc::syscall(
            nix::libc::SYS_waitid as nix::libc::c_long,
            nix::libc::P_ALL as nix::libc::c_int,
            0 as nix::libc::id_t,
            &mut siginfo as *mut nix::libc::siginfo_t,
            options,
            ptr::null_mut::<nix::libc::rusage>(),
        )
    };
    if res < 0 {
        return Err(nix::errno::Errno::last());
    }
    wait_status_from_siginfo(&siginfo)
}

fn waitpid_raw(pid: Pid, options: i32) -> nix::Result<wait::WaitStatus> {
    let mut status: nix::libc::c_int = 0;
    let res = unsafe {
        nix::libc::syscall(
            nix::libc::SYS_wait4 as nix::libc::c_long,
            pid.as_raw() as nix::libc::pid_t,
            &mut status as *mut nix::libc::c_int,
            options,
            ptr::null_mut::<nix::libc::rusage>(),
        )
    };
    if res == 0 {
        return Ok(wait::WaitStatus::StillAlive);
    }
    if res < 0 {
        return Err(nix::errno::Errno::last());
    }
    wait::WaitStatus::from_raw(Pid::from_raw(res as i32), status)
}

fn waitid_pid_raw(pid: Pid, options: nix::libc::c_int) -> nix::Result<wait::WaitStatus> {
    let mut siginfo: nix::libc::siginfo_t = unsafe { mem::zeroed() };
    let res = unsafe {
        nix::libc::syscall(
            nix::libc::SYS_waitid as nix::libc::c_long,
            nix::libc::P_PID as nix::libc::c_int,
            pid.as_raw() as nix::libc::id_t,
            &mut siginfo as *mut nix::libc::siginfo_t,
            options,
            ptr::null_mut::<nix::libc::rusage>(),
        )
    };
    if res < 0 {
        return Err(nix::errno::Errno::last());
    }
    wait_status_from_siginfo(&siginfo)
}

fn wait_status_from_siginfo(siginfo: &nix::libc::siginfo_t) -> nix::Result<wait::WaitStatus> {
    let si_pid = unsafe { siginfo.si_pid() };
    if si_pid == 0 {
        return Ok(wait::WaitStatus::StillAlive);
    }
    let pid = Pid::from_raw(si_pid);
    let si_status = unsafe { siginfo.si_status() };
    match siginfo.si_code {
        nix::libc::CLD_EXITED => Ok(wait::WaitStatus::Exited(pid, si_status)),
        nix::libc::CLD_KILLED | nix::libc::CLD_DUMPED => Ok(wait::WaitStatus::Signaled(
            pid,
            nix::sys::signal::Signal::try_from(si_status)?,
            siginfo.si_code == nix::libc::CLD_DUMPED,
        )),
        nix::libc::CLD_STOPPED => Ok(wait::WaitStatus::Stopped(
            pid,
            nix::sys::signal::Signal::try_from(si_status)?,
        )),
        nix::libc::CLD_CONTINUED => Ok(wait::WaitStatus::Continued(pid)),
        nix::libc::CLD_TRAPPED => {
            if si_status == (nix::libc::SIGTRAP | 0x80) {
                Ok(wait::WaitStatus::PtraceSyscall(pid))
            } else {
                Ok(wait::WaitStatus::PtraceEvent(
                    pid,
                    nix::sys::signal::Signal::try_from(si_status & 0xff)?,
                    (si_status >> 8) as nix::libc::c_int,
                ))
            }
        }
        _ => Err(nix::errno::Errno::EINVAL),
    }
}

fn drain_stdout<'a>(
    stdout: &mut impl Read,
    buf: &mut [u8],
    carry: &mut String,
    log: &mut Option<Box<dyn FnMut(String) + 'a>>,
) {
    let emit = |msg: &str, log: &mut Option<Box<dyn FnMut(String) + 'a>>| {
        if msg.is_empty() {
            return;
        }
        let suppress_loader_log = false && msg.starts_with("loader_shim:");
        if suppress_loader_log {
            return;
        }
        if let Some(log) = log.as_mut() {
            log(msg.to_string());
        } else {
            println!("{msg}");
        }
    };
    loop {
        match stdout.read(buf) {
            Ok(0) => {
                let tail = carry.trim_end_matches('\r').to_string();
                emit(&tail, log);
                carry.clear();
                break;
            } // EOF
            Ok(n) => {
                carry.push_str(&String::from_utf8_lossy(&buf[..n]));
                while let Some(pos) = carry.find('\n') {
                    let line = carry[..pos].trim_end_matches('\r');
                    emit(line, log);
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

fn log_non_segv_signal_diagnostics(tracee: Pid, sig: nix::sys::signal::Signal) {
    let maps_txt =
        fs::read_to_string(format!("/proc/{}/maps", tracee)).unwrap_or_else(|_| String::new());
    let si_addr = segv_fault_addr(tracee);
    if let Ok(regs) = read_regs(tracee) {
        eprintln!(
            "tracee stopped on {:?} pc=0x{:x} sp=0x{:x} si_addr={}",
            sig,
            regs.pc,
            regs.sp,
            si_addr
                .map(|a| format!("0x{a:x}"))
                .unwrap_or_else(|| "?".to_string())
        );
        if let Ok(code) = read_bytes_process_vm(tracee, regs.pc as usize, 32) {
            eprintln!("pc bytes: {}", hex_bytes(&code));
        }
        if let Ok(stack) = read_bytes_process_vm(tracee, regs.sp as usize, 64) {
            eprintln!("sp bytes: {}", hex_bytes(&stack));
        }
        if !maps_txt.is_empty() {
            if let Some(line) = maps_txt.lines().find(|l| mapping_contains_pc(l, regs.pc as u64)) {
                eprintln!("pc mapping: {line}");
            }
            if let Some(line) = maps_txt.lines().find(|l| mapping_contains_pc(l, regs.sp as u64)) {
                eprintln!("sp mapping: {line}");
            }
        }
    } else {
        eprintln!("tracee stopped on {:?} (failed reading regs)", sig);
    }
    let siginfo = read_siginfo_raw(tracee);
    if !siginfo.is_empty() {
        let n = siginfo.len().min(64);
        eprintln!("siginfo raw[0..{n}]: {}", hex_bytes(&siginfo[..n]));
    }
}

struct PendingSysenterRestore {
    original_sp: u64,
    original_args: [u64; 6],
    original_x8: u64,
    syscall: i64,
    access_emu: Option<(String, i32, i32)>,
    debug_path: Option<String>,
    stack_write_restores: Vec<PendingStackWriteRestore>,
}

#[derive(Clone, Copy)]
struct PendingSyscallResultEmulation {
    retval: i64,
}

struct PendingStackWriteRestore {
    addr: usize,
    original_bytes: Vec<u8>,
}

struct TraceeStackScratch {
    next: u64,
    floor: u64,
}

#[derive(Clone, Copy)]
enum PendingIdentityEmulation {
    Getresuid { ruid: u64, euid: u64, suid: u64 },
    Getresgid { rgid: u64, egid: u64, sgid: u64 },
}

fn capture_pending_identity_emulation(regs: &UserPtRegs) -> Option<PendingIdentityEmulation> {
    let sys = regs.regs[8] as i64;
    match sys {
        x if x == nix::libc::SYS_getresuid => Some(PendingIdentityEmulation::Getresuid {
            ruid: regs.regs[0],
            euid: regs.regs[1],
            suid: regs.regs[2],
        }),
        x if x == nix::libc::SYS_getresgid => Some(PendingIdentityEmulation::Getresgid {
            rgid: regs.regs[0],
            egid: regs.regs[1],
            sgid: regs.regs[2],
        }),
        _ => None,
    }
}

fn maybe_preempt_seccomp_trap_syscall(
    tracee: Pid,
    regs: &UserPtRegs,
    pending_syscall_result_emulation: &mut HashMap<Pid, PendingSyscallResultEmulation>,
) {
    let sys = regs.regs[8] as i64;
    const SYS_RSEQ_AARCH64: i64 = 293;
    let retval = match sys {
        x if x == nix::libc::SYS_set_robust_list => 0,
        x if x == SYS_RSEQ_AARCH64 => -(nix::libc::ENOSYS as i64),
        _ => return,
    };

    let mut patched = *regs;
    patched.regs[8] = nix::libc::SYS_clock_gettime as i64 as u64;
    patched.regs[0] = nix::libc::CLOCK_REALTIME as i64 as u64;
    patched.regs[1] = 0; // NULL timespec => EFAULT if executed, no side effect
    if write_regs(tracee, &patched).is_ok() {
        pending_syscall_result_emulation
            .insert(tracee, PendingSyscallResultEmulation { retval });
    }
}

fn write_u32_if_nonnull(pid: Pid, addr: u64, value: u32) {
    if addr == 0 {
        return;
    }
    let _ = write_bytes(pid, addr as usize, &value.to_ne_bytes());
}

fn apply_root_identity_emulation(
    tracee: Pid,
    pending_identity_emulation: &mut HashMap<Pid, PendingIdentityEmulation>,
) {
    let Ok(mut regs) = read_regs(tracee) else {
        pending_identity_emulation.remove(&tracee);
        return;
    };
    let sys = regs.regs[8] as i64;
    let mut changed = false;

    match sys {
        x if x == nix::libc::SYS_getuid
            || x == nix::libc::SYS_geteuid
            || x == nix::libc::SYS_getgid
            || x == nix::libc::SYS_getegid =>
        {
            regs.regs[0] = 0;
            changed = true;
        }
        x if x == nix::libc::SYS_setuid
            || x == nix::libc::SYS_setgid
            || x == nix::libc::SYS_setreuid
            || x == nix::libc::SYS_setregid
            || x == nix::libc::SYS_setresuid
            || x == nix::libc::SYS_setresgid
            || x == nix::libc::SYS_setfsuid
            || x == nix::libc::SYS_setfsgid
            || x == nix::libc::SYS_setgroups =>
        {
            regs.regs[0] = 0;
            changed = true;
        }
        _ => {}
    }

    if let Some(pending) = pending_identity_emulation.remove(&tracee) {
        match pending {
            PendingIdentityEmulation::Getresuid { ruid, euid, suid } => {
                write_u32_if_nonnull(tracee, ruid, 0);
                write_u32_if_nonnull(tracee, euid, 0);
                write_u32_if_nonnull(tracee, suid, 0);
                regs.regs[0] = 0;
                changed = true;
            }
            PendingIdentityEmulation::Getresgid { rgid, egid, sgid } => {
                write_u32_if_nonnull(tracee, rgid, 0);
                write_u32_if_nonnull(tracee, egid, 0);
                write_u32_if_nonnull(tracee, sgid, 0);
                regs.regs[0] = 0;
                changed = true;
            }
        }
    }

    if changed {
        let _ = write_regs(tracee, &regs);
    }
}

fn rewrite_syscall_path_with_regs(
    pid: Pid,
    mut regs: UserPtRegs,
    mappings: &[(String, String)],
    shim_exe_abs: Option<&Path>,
) -> nix::Result<Option<PendingSysenterRestore>> {
    let syscall = regs.regs[8]; // x8
    let mut args = [0u64; 6];
    args.copy_from_slice(&regs.regs[0..6]);
    let sys = syscall as i64;
    let mut stack_write_restores: Vec<PendingStackWriteRestore> = Vec::new();
    let mut scratch = init_tracee_stack_scratch(pid, regs.sp);

    if matches!(
        sys,
        nix::libc::SYS_renameat | nix::libc::SYS_renameat2 | nix::libc::SYS_linkat
    ) {
        let original_sp = regs.sp;
        let mut changed = false;
        let mut debug_pairs: Vec<(String, String)> = Vec::new();
        let mut debug_observed_rel: Vec<String> = Vec::new();
        for (path_idx, dirfd_idx) in [(1usize, 0usize), (3usize, 2usize)] {
            let addr_raw = args[path_idx] as usize;
            if addr_raw == 0 {
                continue;
            }
            let (_addr, path_bytes) = match read_cstring_candidates_any(pid, addr_raw) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let path = String::from_utf8_lossy(&path_bytes);
            let path_was_absolute = path.starts_with('/');
            let debug_is_pacman_path = path.contains("/var/lib/pacman");
            let dirfd = regs.regs[dirfd_idx] as i64;
            let resolved = if path_was_absolute {
                None
            } else {
                resolve_effective_path_for_tracee(pid, Some(dirfd), &path)
            };
            if let Some(resolved_path) = resolved.as_deref() {
                if resolved_path.contains("/var/lib/pacman/sync") {
                    debug_observed_rel.push(format!(
                        "idx={} dirfd={} raw={} resolved={}",
                        path_idx, dirfd, path, resolved_path
                    ));
                }
            }
            let Some(mapped) = apply_path_mappings(&path, mappings).or_else(|| {
                resolved
                    .as_deref()
                    .and_then(|resolved_path| apply_path_mappings(resolved_path, mappings))
            }) else {
                if debug_is_pacman_path {
                    eprintln!(
                        "pacman two-path no rewrite sys={} idx={} dirfd={} path={}",
                        sys, path_idx, dirfd, path
                    );
                }
                continue;
            };
            let mapped_is_relative = !mapped.starts_with('/');
            let debug_path = resolved.as_deref().unwrap_or(&path);
            if debug_path.contains("/var/lib/pacman/sync") {
                debug_pairs.push((debug_path.to_string(), mapped.clone()));
            }
            if debug_is_pacman_path || mapped.contains("/var/lib/pacman") {
                eprintln!(
                    "pacman two-path rewrite sys={} idx={} dirfd={} {} -> {}",
                    sys, path_idx, dirfd, debug_path, mapped
                );
            }

            let mut mapped_bytes = mapped.as_bytes().to_vec();
            mapped_bytes.push(0);
            let new_ptr = alloc_tracee_scratch_data(
                pid,
                &mut regs,
                &mapped_bytes,
                &mut stack_write_restores,
                &mut scratch,
            )?;
            regs.regs[path_idx] = new_ptr as u64;

            if (!path_was_absolute || (path_was_absolute && mapped_is_relative))
                && (regs.regs[dirfd_idx] as i64) != nix::libc::AT_FDCWD as i64
                && mapped.starts_with('/')
            {
                // Resolved a relative `*at` path to an absolute host path, or converted an
                // absolute guest path into a relative path: use AT_FDCWD to preserve meaning.
                regs.regs[dirfd_idx] = nix::libc::AT_FDCWD as i64 as u64;
            } else if path_was_absolute
                && mapped_is_relative
                && (regs.regs[dirfd_idx] as i64) != nix::libc::AT_FDCWD as i64
            {
                regs.regs[dirfd_idx] = nix::libc::AT_FDCWD as i64 as u64;
            }
            changed = true;
        }
        if !changed {
            if !debug_observed_rel.is_empty() {
                eprintln!("sync-db two-path observe sys={} {:?}", sys, debug_observed_rel);
            }
            return Ok(None);
        }
        if !debug_observed_rel.is_empty() {
            eprintln!("sync-db two-path observe sys={} {:?}", sys, debug_observed_rel);
        }
        if !debug_pairs.is_empty() {
            eprintln!("sync-db two-path rewrite sys={} {:?}", sys, debug_pairs);
        }
        write_regs(pid, &regs)?;
        return Ok(Some(PendingSysenterRestore {
            original_sp,
            original_args: args,
            original_x8: regs.regs[8],
            syscall: sys,
            access_emu: None,
            debug_path: None,
            stack_write_restores,
        }));
    }

    let path_addr = match syscall as i64 {
        nix::libc::SYS_openat => Some(args[1] as usize),
        nix::libc::SYS_openat2 => Some(args[1] as usize),
        n if syscall_is_fstatat(n) => Some(args[1] as usize),
        nix::libc::SYS_faccessat => Some(args[1] as usize),
        nix::libc::SYS_faccessat2 => Some(args[1] as usize),
        nix::libc::SYS_readlinkat => Some(args[1] as usize),
        nix::libc::SYS_mkdirat => Some(args[1] as usize),
        nix::libc::SYS_unlinkat => Some(args[1] as usize),
        nix::libc::SYS_fchmodat => Some(args[1] as usize),
        nix::libc::SYS_fchownat => Some(args[1] as usize),
        nix::libc::SYS_utimensat => Some(args[1] as usize),
        nix::libc::SYS_execve => Some(args[0] as usize),
        nix::libc::SYS_execveat => Some(args[1] as usize),
        nix::libc::SYS_statx => Some(args[1] as usize),
        n if syscall_is_statfs(n) => Some(args[0] as usize),
        nix::libc::SYS_chdir => Some(args[0] as usize),
        _ => None,
    };

    let Some(addr_raw) = path_addr else {
        return Ok(None);
    };

    let (_addr, path_bytes) = match read_cstring_candidates(pid, addr_raw) {
        Ok(v) => v,
        Err(_) => match read_cstring_candidates_any(pid, addr_raw) {
            Ok(v) => v,
            Err(e) => {
                let _ = e;
                return Ok(None);
            }
        },
    };
    let path = String::from_utf8_lossy(&path_bytes);
    let path_was_absolute = path.starts_with('/');
    let debug_is_pacman_path = path.contains("/var/lib/pacman");
    let dirfd_for_relative = match sys {
        n if syscall_is_fstatat(n) => Some(args[0] as i64),
        nix::libc::SYS_openat
        | nix::libc::SYS_openat2
        | nix::libc::SYS_faccessat
        | nix::libc::SYS_faccessat2
        | nix::libc::SYS_readlinkat
        | nix::libc::SYS_mkdirat
        | nix::libc::SYS_unlinkat
        | nix::libc::SYS_fchmodat
        | nix::libc::SYS_fchownat
        | nix::libc::SYS_utimensat
        | nix::libc::SYS_execveat
        | nix::libc::SYS_statx => Some(args[0] as i64),
        _ => None,
    };
    let mut resolved_debug: Option<String> = None;
    let mut used_relative_sync_fallback = false;
    let mapped = if let Some(mapped) = apply_path_mappings(&path, mappings) {
        mapped
    } else if !path_was_absolute {
        let Some(dirfd) = dirfd_for_relative else {
            if debug_is_pacman_path {
                eprintln!("pacman path relative no dirfd sys={} path={}", sys, path);
            }
            return Ok(None);
        };
        let Some(resolved) = resolve_effective_path_for_tracee(pid, Some(dirfd), &path) else {
            if debug_is_pacman_path {
                eprintln!(
                    "pacman path resolve failed sys={} dirfd={} path={}",
                    sys, dirfd, path
                );
            }
            return Ok(None);
        };
        // Narrow fallback: only rewrite fd-relative one-path syscalls when they resolve into
        // pacman DB paths. This covers both `sync/` and `local/` operations used by libalpm,
        // while still avoiding generic loader-shim relative opens like `bin/sh`.
        if !resolved.contains("/var/lib/pacman") {
            if debug_is_pacman_path || resolved.contains("/var/lib/pacman") {
                eprintln!(
                    "pacman relative fallback skipped sys={} path={} resolved={}",
                    sys, path, resolved
                );
            }
            return Ok(None);
        }
        let Some(mapped) = apply_path_mappings(&resolved, mappings) else {
            if debug_is_pacman_path {
                eprintln!(
                    "pacman relative fallback mapping failed sys={} resolved={}",
                    sys, resolved
                );
            }
            return Ok(None);
        };
        resolved_debug = Some(resolved);
        used_relative_sync_fallback = true;
        mapped
    } else {
        if debug_is_pacman_path {
            eprintln!("pacman path no rewrite sys={} path={}", sys, path);
        }
        return Ok(None);
    };
    let debug_path = resolved_debug.as_deref().unwrap_or(&path);
    if debug_path.contains("/var/lib/pacman/sync") {
        eprintln!("sync-db path rewrite sys={} {} -> {}", sys, debug_path, mapped);
    }
    if debug_is_pacman_path || mapped.contains("/var/lib/pacman") {
        eprintln!("pacman path rewrite sys={} {} -> {}", sys, debug_path, mapped);
    }
    if used_relative_sync_fallback {
        eprintln!("sync-db path relative-fallback sys={} {}", sys, debug_path);
    }
    let mapped_is_relative = !mapped.starts_with('/');

    if matches!(sys, nix::libc::SYS_execve | nix::libc::SYS_execveat) {
        if let Some(shim) = shim_exe_abs {
            if let Some(pending) =
                rewrite_execve_to_loader_shim(pid, &mut regs, sys, &args, &path, &mapped, shim)?
            {
                write_regs(pid, &regs)?;
                return Ok(Some(pending));
            }
        }
    }

    let mut mapped_bytes = mapped.as_bytes().to_vec();
    mapped_bytes.push(0);
    let original_sp = regs.sp;
    let new_ptr = alloc_tracee_scratch_data(
        pid,
        &mut regs,
        &mapped_bytes,
        &mut stack_write_restores,
        &mut scratch,
    )?;

    // `openat*` ignores dirfd for absolute paths. Once rewritten to a relative
    // path, preserve intended semantics by forcing dirfd=AT_FDCWD.
    if (path_was_absolute && mapped_is_relative)
        || (used_relative_sync_fallback && mapped.starts_with('/'))
    {
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
                | nix::libc::SYS_fchmodat
                | nix::libc::SYS_fchownat
                | nix::libc::SYS_utimensat
                | nix::libc::SYS_statx
        ) || syscall_is_fstatat(sys))
            && (regs.regs[0] as i64) != nix::libc::AT_FDCWD as i64
        {
            regs.regs[0] = nix::libc::AT_FDCWD as i64 as u64;
        }
    }

    match syscall as i64 {
        n if n == nix::libc::SYS_execve || n == nix::libc::SYS_chdir || syscall_is_statfs(n) => {
            regs.regs[0] = new_ptr as u64
        }
        n if syscall_is_fstatat(n) => regs.regs[1] = new_ptr as u64,
        nix::libc::SYS_openat
        | nix::libc::SYS_openat2
        | nix::libc::SYS_faccessat
        | nix::libc::SYS_faccessat2
        | nix::libc::SYS_readlinkat
        | nix::libc::SYS_mkdirat
        | nix::libc::SYS_unlinkat
        | nix::libc::SYS_fchmodat
        | nix::libc::SYS_fchownat
        | nix::libc::SYS_utimensat
        | nix::libc::SYS_execveat
        | nix::libc::SYS_statx => regs.regs[1] = new_ptr as u64,
        _ => return Ok(None),
    }
    write_regs(pid, &regs)?;

    let access_emu = if matches!(sys, nix::libc::SYS_faccessat | nix::libc::SYS_faccessat2) {
        Some((mapped.clone(), args[2] as i32, args[3] as i32))
    } else {
        None
    };
    if matches!(sys, nix::libc::SYS_execve | nix::libc::SYS_execveat) {
        return Ok(Some(PendingSysenterRestore {
            original_sp,
            original_args: args,
            original_x8: regs.regs[8],
            syscall: sys,
            access_emu,
            debug_path: Some(mapped.clone()),
            stack_write_restores,
        }));
    }
    Ok(Some(PendingSysenterRestore {
        original_sp,
        original_args: args,
        original_x8: regs.regs[8],
        syscall: sys,
        access_emu,
        debug_path: Some(mapped),
        stack_write_restores,
    }))
}

fn alloc_tracee_stack_data(
    pid: Pid,
    regs: &mut UserPtRegs,
    data: &[u8],
    restores: &mut Vec<PendingStackWriteRestore>,
) -> nix::Result<usize> {
    let aligned = (data.len() + 15) & !15;
    if (aligned as u64) > regs.sp {
        return Err(nix::Error::from(nix::errno::Errno::EFAULT));
    }
    let new_sp = regs.sp - aligned as u64;
    let original_bytes = read_bytes_ptrace_exact(pid, new_sp as usize, aligned)?;
    restores.push(PendingStackWriteRestore {
        addr: new_sp as usize,
        original_bytes,
    });
    write_bytes(pid, new_sp as usize, data)?;
    if aligned > data.len() {
        let zeros = vec![0u8; aligned - data.len()];
        write_bytes(pid, new_sp as usize + data.len(), &zeros)?;
    }
    regs.sp = new_sp;
    Ok(new_sp as usize)
}

fn init_tracee_stack_scratch(pid: Pid, sp: u64) -> Option<TraceeStackScratch> {
    let guard = 0x200u64;
    let window = 0x20000u64;
    if sp <= guard + 0x1000 {
        return None;
    }
    Some(TraceeStackScratch {
        next: sp - guard,
        floor: sp.saturating_sub(window),
    })
}

fn alloc_tracee_scratch_data(
    pid: Pid,
    regs: &mut UserPtRegs,
    data: &[u8],
    restores: &mut Vec<PendingStackWriteRestore>,
    scratch: &mut Option<TraceeStackScratch>,
) -> nix::Result<usize> {
    let aligned = (data.len() + 15) & !15;
    if let Some(arena) = scratch.as_mut() {
        let aligned_u64 = aligned as u64;
        if arena.next > arena.floor.saturating_add(aligned_u64) {
            let addr = (arena.next - aligned_u64) & !15u64;
            if addr >= arena.floor {
                write_bytes(pid, addr as usize, data)?;
                if aligned > data.len() {
                    let zeros = vec![0u8; aligned - data.len()];
                    write_bytes(pid, addr as usize + data.len(), &zeros)?;
                }
                arena.next = addr;
                return Ok(addr as usize);
            }
        }
    }
    eprintln!(
        "tracee scratch fallback to SP allocation: tid={} len={} aligned={} sp=0x{:x}",
        pid,
        data.len(),
        aligned,
        regs.sp
    );
    alloc_tracee_stack_data(pid, regs, data, restores)
}

fn restore_tracee_stack_writes(pid: Pid, restores: &[PendingStackWriteRestore]) {
    for restore in restores.iter().rev() {
        if let Err(e) = write_bytes(pid, restore.addr, &restore.original_bytes) {
            eprintln!(
                "failed restoring tracee stack scratch: tid={} addr=0x{:x} len={} err={e}",
                pid,
                restore.addr,
                restore.original_bytes.len()
            );
        }
    }
}

fn read_bytes_ptrace_exact(pid: Pid, addr: usize, len: usize) -> nix::Result<Vec<u8>> {
    let word_size = mem::size_of::<nix::libc::c_long>();
    let aligned_start = addr & !(word_size - 1);
    let aligned_end = (addr + len + (word_size - 1)) & !(word_size - 1);
    let mut out = Vec::with_capacity(aligned_end.saturating_sub(aligned_start));
    let mut cur = aligned_start;
    while cur < aligned_end {
        let word = ptrace::read(pid, cur as AddressType)? as usize;
        let bytes = word.to_ne_bytes();
        out.extend_from_slice(&bytes[..word_size]);
        cur += word_size;
    }
    let start_off = addr - aligned_start;
    Ok(out[start_off..start_off + len].to_vec())
}

fn read_u64_process(pid: Pid, addr: usize) -> nix::Result<u64> {
    let word_size = mem::size_of::<nix::libc::c_long>();
    let word = ptrace::read(pid, addr as AddressType)? as usize;
    let bytes = word.to_ne_bytes();
    let mut full = [0u8; 8];
    full[..word_size].copy_from_slice(&bytes[..word_size]);
    Ok(u64::from_ne_bytes(full))
}

fn read_argv_ptrs(pid: Pid, argv_ptr: usize, max_args: usize) -> nix::Result<Vec<u64>> {
    let mut out = Vec::new();
    for i in 0..max_args {
        let p = read_u64_process(pid, argv_ptr + i * 8)?;
        if p == 0 {
            break;
        }
        out.push(p);
    }
    Ok(out)
}

fn min_nonzero_u64(a: u64, b: u64) -> u64 {
    match (a, b) {
        (0, x) => x,
        (x, 0) => x,
        (x, y) => x.min(y),
    }
}

fn rewrite_execve_to_loader_shim(
    pid: Pid,
    regs: &mut UserPtRegs,
    sys: i64,
    args: &[u64; 6],
    guest_path: &str,
    mapped_host_path: &str,
    shim_exe_abs: &Path,
) -> nix::Result<Option<PendingSysenterRestore>> {
    let host_target = Path::new(mapped_host_path);
    if !is_elf(host_target) || elf_interp_path(host_target).is_none() {
        return Ok(None);
    }

    let shim_path = shim_exe_abs.to_string_lossy().to_string();
    if shim_path.is_empty() {
        return Ok(None);
    }

    let argv_ptr = match sys {
        x if x == nix::libc::SYS_execve => args[1] as usize,
        x if x == nix::libc::SYS_execveat => args[2] as usize,
        _ => return Ok(None),
    };
    let envp_ptr = match sys {
        x if x == nix::libc::SYS_execve => args[2] as usize,
        x if x == nix::libc::SYS_execveat => args[3] as usize,
        _ => 0,
    };
    if argv_ptr == 0 {
        return Ok(None);
    }

    let original_sp = regs.sp;
    let mut stack_write_restores: Vec<PendingStackWriteRestore> = Vec::new();
    let mut scratch = init_tracee_stack_scratch(pid, regs.sp);
    let arg_ptrs = read_argv_ptrs(pid, argv_ptr, 128).unwrap_or_default();
    let env_ptrs = if envp_ptr != 0 {
        read_argv_ptrs(pid, envp_ptr, 256).unwrap_or_default()
    } else {
        Vec::new()
    };

    // Avoid clobbering the shell's original argv/envp area before the kernel copies it for execve.
    let mut scratch_top = regs.sp;
    scratch_top = min_nonzero_u64(scratch_top, argv_ptr as u64);
    scratch_top = min_nonzero_u64(scratch_top, envp_ptr as u64);
    for p in &arg_ptrs {
        scratch_top = min_nonzero_u64(scratch_top, *p);
    }
    for p in &env_ptrs {
        scratch_top = min_nonzero_u64(scratch_top, *p);
    }
    // Keep a large guard below the tracee's existing argv/envp area before placing our shim
    // argv strings on the stack. Android app processes can have large environments, and a small
    // gap here can corrupt env/argv data that the kernel is about to copy for execve.
    const EXECVE_SHIM_STACK_GUARD: u64 = 0x4000;
    if scratch_top > (EXECVE_SHIM_STACK_GUARD as u64) {
        regs.sp = regs
            .sp
            .min(scratch_top.saturating_sub(EXECVE_SHIM_STACK_GUARD));
    }

    // Preserve original argv[1..] arguments. argv[0] becomes the shim path and argv[1] is the
    // guest target path so the shim can load it.
    let mut rest_arg_ptrs: Vec<u64> = Vec::new();
    for p in arg_ptrs.into_iter().skip(1).rev() {
        if p == 0 {
            continue;
        }
        let bs = match read_cstring(pid, p as usize) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let mut c = bs;
        c.push(0);
        let newp = alloc_tracee_scratch_data(
            pid,
            regs,
            &c,
            &mut stack_write_restores,
            &mut scratch,
        )? as u64;
        rest_arg_ptrs.push(newp);
    }
    rest_arg_ptrs.reverse();

    let mut guest_target_c = guest_path.as_bytes().to_vec();
    guest_target_c.push(0);
    let guest_target_ptr = alloc_tracee_scratch_data(
        pid,
        regs,
        &guest_target_c,
        &mut stack_write_restores,
        &mut scratch,
    )? as u64;

    let mut shim_c = shim_path.as_bytes().to_vec();
    shim_c.push(0);
    let shim_ptr =
        alloc_tracee_scratch_data(pid, regs, &shim_c, &mut stack_write_restores, &mut scratch)?
            as u64;

    let mut argv_new: Vec<u64> = Vec::with_capacity(rest_arg_ptrs.len() + 3);
    argv_new.push(shim_ptr);
    argv_new.push(guest_target_ptr);
    argv_new.extend(rest_arg_ptrs);
    argv_new.push(0);
    let mut argv_bytes = Vec::with_capacity(argv_new.len() * 8);
    for p in argv_new {
        argv_bytes.extend_from_slice(&p.to_ne_bytes());
    }
    let argv_new_ptr = alloc_tracee_scratch_data(
        pid,
        regs,
        &argv_bytes,
        &mut stack_write_restores,
        &mut scratch,
    )? as u64;

    match sys {
        x if x == nix::libc::SYS_execve => {
            regs.regs[0] = shim_ptr;
            regs.regs[1] = argv_new_ptr;
        }
        x if x == nix::libc::SYS_execveat => {
            regs.regs[1] = shim_ptr;
            regs.regs[2] = argv_new_ptr;
            if (regs.regs[0] as i64) != nix::libc::AT_FDCWD as i64 {
                regs.regs[0] = nix::libc::AT_FDCWD as i64 as u64;
            }
        }
        _ => {}
    }

    eprintln!(
        "wrapped nested exec via loader shim: guest={} host={} shim={} argv_ptr=0x{:x}",
        guest_path, mapped_host_path, shim_path, argv_new_ptr
    );
    Ok(Some(PendingSysenterRestore {
        original_sp,
        original_args: *args,
        original_x8: regs.regs[8],
        syscall: sys,
        access_emu: None,
        debug_path: None,
        stack_write_restores,
    }))
}

fn ptrace_syscall_is_entry(
    pid: Pid,
    fallback: &mut HashMap<Pid, bool>,
    force_entry_after_sigsys: &mut HashSet<Pid>,
) -> bool {
    const PTRACE_GET_SYSCALL_INFO: nix::libc::c_int = 0x420e;
    const PTRACE_SYSCALL_INFO_ENTRY: u8 = 1;
    const PTRACE_SYSCALL_INFO_EXIT: u8 = 2;
    const PTRACE_SYSCALL_INFO_SECCOMP: u8 = 3;
    if force_entry_after_sigsys.remove(&pid) {
        fallback.insert(pid, true);
        eprintln!("seccomp-phase reset: forcing next syscall-stop to sysenter for tid={pid}");
        return true;
    }
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

fn read_cstring_candidates_any(pid: Pid, addr_raw: usize) -> nix::Result<(usize, Vec<u8>)> {
    let a = addr_raw as u64;
    let cands: [u64; 6] = [
        a,
        a & 0x00ff_ffff_ffff_ffff,
        a & 0x0000_ffff_ffff_ffff,
        a & 0x0000_0fff_ffff_ffff,
        a & 0x0000_00ff_ffff_ffff,
        a & 0x0000_007f_ffff_ffff,
    ];

    let mut last_err: Option<nix::Error> = None;
    for cand in cands {
        if cand == 0 {
            continue;
        }
        match read_cstring(pid, cand as usize) {
            Ok(bs) => return Ok((cand as usize, bs)),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| nix::Error::from(nix::errno::Errno::EFAULT)))
}

fn resolve_effective_path_for_tracee(pid: Pid, dirfd: Option<i64>, path: &str) -> Option<String> {
    if path.is_empty() || path.starts_with('/') {
        return None;
    }
    let base = match dirfd {
        Some(fd) if fd != nix::libc::AT_FDCWD as i64 => {
            fs::read_link(format!("/proc/{}/fd/{}", pid, fd)).ok()?
        }
        _ => fs::read_link(format!("/proc/{}/cwd", pid)).ok()?,
    };
    if !base.is_absolute() {
        return None;
    }
    Some(base.join(path).to_string_lossy().to_string())
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
    let mut mappings = Vec::with_capacity(binds.len() + 1);
    mappings.push(("/".to_string(), normalize_host_root(rootfs)));
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

#[cfg(all(target_os = "android", target_arch = "aarch64"))]
fn syscall_is_statfs(syscall: i64) -> bool {
    // Android/aarch64 libc omits `SYS_statfs`, but the Linux kernel ABI keeps it at 43.
    syscall == 43
}

#[cfg(not(all(target_os = "android", target_arch = "aarch64")))]
fn syscall_is_statfs(syscall: i64) -> bool {
    syscall == nix::libc::SYS_statfs
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
    if err == nix::libc::EINVAL as i64 {
        let rc2 = try_faccess(flags & !AT_EACCESS_FALLBACK);
        if rc2 == 0 {
            return 0;
        }
        err = nix::errno::Errno::last_raw() as i64;
        if err == nix::libc::EINVAL as i64 && (flags & !AT_EACCESS_FALLBACK) != 0 {
            let rc3 = try_faccess(0);
            if rc3 == 0 {
                return 0;
            }
            err = nix::errno::Errno::last_raw() as i64;
        }
    }
    -err
}

fn fake_root_should_force_perm_success(sys: i64, ret: i64) -> bool {
    if ret != -(nix::libc::EPERM as i64) && ret != -(nix::libc::EACCES as i64) {
        return false;
    }
    // Mirror the practical subset used by proot fake_id0: permission failures from
    // ownership/metadata syscalls should succeed for emulated root.
    matches!(
        sys,
        5   // setxattr
            | 6   // lsetxattr
            | 7   // fsetxattr
            | 33  // mknodat
            | 52  // fchmod
            | 53  // fchmodat
            | 54  // fchownat
            | 55  // fchown
            | 88  // utimensat
            | 91  // capset
            | 161 // sethostname
            | 162 // setdomainname
    )
}

fn patch_tracee_stat_uid_gid_root(pid: Pid, stat_addr: u64) {
    if stat_addr == 0 {
        return;
    }
    let st = std::mem::MaybeUninit::<nix::libc::stat>::uninit();
    let base = st.as_ptr() as usize;
    let uid_off = unsafe { std::ptr::addr_of!((*st.as_ptr()).st_uid) as usize - base };
    let gid_off = unsafe { std::ptr::addr_of!((*st.as_ptr()).st_gid) as usize - base };
    let zero = 0u32.to_ne_bytes();
    let _ = write_bytes(pid, stat_addr as usize + uid_off, &zero);
    let _ = write_bytes(pid, stat_addr as usize + gid_off, &zero);
}

fn log_pacman_fs_failure(pid: Pid, regs: &UserPtRegs, mappings: &[(String, String)]) {
    let ret = regs.regs[0] as i64;
    if ret >= 0 {
        return;
    }
    let sys = regs.regs[8] as i64;
    let (path_idx, dirfd_idx) = match sys {
        n if syscall_is_fstatat(n) => (1usize, Some(0usize)),
        nix::libc::SYS_openat
        | nix::libc::SYS_openat2
        | nix::libc::SYS_faccessat
        | nix::libc::SYS_faccessat2
        | nix::libc::SYS_readlinkat
        | nix::libc::SYS_mkdirat
        | nix::libc::SYS_unlinkat
        | nix::libc::SYS_fchmodat
        | nix::libc::SYS_fchownat
        | nix::libc::SYS_utimensat
        | nix::libc::SYS_execveat
        | nix::libc::SYS_statx => (1usize, Some(0usize)),
        nix::libc::SYS_execve | nix::libc::SYS_chdir => (0usize, None),
        _ => return,
    };
    let addr_raw = regs.regs[path_idx] as usize;
    if addr_raw == 0 {
        return;
    }
    let Ok((_addr, path_bytes)) = read_cstring_candidates_any(pid, addr_raw) else {
        return;
    };
    let raw_path = String::from_utf8_lossy(&path_bytes).to_string();
    let mut candidates = vec![raw_path.clone()];
    if !raw_path.starts_with('/') {
        if let Some(di) = dirfd_idx {
            let dirfd = regs.regs[di] as i64;
            if let Some(resolved) = resolve_effective_path_for_tracee(pid, Some(dirfd), &raw_path) {
                candidates.push(resolved);
            }
        }
    }
    let mut mapped: Option<String> = None;
    let mut relevant = false;
    for candidate in &candidates {
        if candidate.contains("/var/lib/pacman") {
            relevant = true;
        }
        if mapped.is_none() {
            mapped = apply_path_mappings(candidate, mappings);
        }
    }
    if !relevant {
        if let Some(m) = mapped.as_deref() {
            relevant = m.contains("/var/lib/pacman");
        }
    }
    if !relevant {
        return;
    }
    let dirfd_display = dirfd_idx.map(|i| regs.regs[i] as i64);
    eprintln!(
        "pacman fs syscall error: tid={} sys={} ret={} raw={} resolved={:?} mapped={:?} dirfd={:?}",
        pid, sys, ret, raw_path, candidates, mapped, dirfd_display
    );
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

fn sigsys_siginfo_decoded(siginfo_raw: &[u8]) -> Option<(i32, i32, i32, i32, u64, u32)> {
    // Linux/Android 64-bit siginfo_t:
    //   0x00 si_signo (int)
    //   0x04 si_errno (int)
    //   0x08 si_code  (int)
    //   0x10 _sigsys._call_addr (void*)
    //   0x18 _sigsys._syscall   (int)
    //   0x1c _sigsys._arch      (u32)
    if siginfo_raw.len() < 0x20 {
        return None;
    }
    let si_signo = i32::from_ne_bytes(siginfo_raw.get(0x00..0x04)?.try_into().ok()?);
    let si_errno = i32::from_ne_bytes(siginfo_raw.get(0x04..0x08)?.try_into().ok()?);
    let si_code = i32::from_ne_bytes(siginfo_raw.get(0x08..0x0c)?.try_into().ok()?);
    let si_call_addr = u64::from_ne_bytes(siginfo_raw.get(0x10..0x18)?.try_into().ok()?);
    let si_syscall = i32::from_ne_bytes(siginfo_raw.get(0x18..0x1c)?.try_into().ok()?);
    let si_arch = u32::from_ne_bytes(siginfo_raw.get(0x1c..0x20)?.try_into().ok()?);
    Some((si_signo, si_errno, si_code, si_syscall, si_call_addr, si_arch))
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

#[cfg(target_arch = "aarch64")]
fn try_restore_sigsys_interrupted_regs_from_stack(
    pid: Pid,
    stop_regs: UserPtRegs,
    out_regs: &mut UserPtRegs,
) -> bool {
    // For seccomp SIGSYS delivery, Android kernels may present a ptrace signal-stop with the
    // interrupted PC already visible while SP points at a just-built rt_sigframe. If we suppress
    // delivery, restore the interrupted regs from that frame so execution continues as if the
    // signal had not been queued.
    // Android kernels vary in how much state they push for seccomp SIGSYS (SVE/extra contexts can
    // make the rt_sigframe much larger than a minimal frame), so search a wider window.
    let scan_back = 0x10000usize;
    let start = (stop_regs.sp as usize).saturating_sub(scan_back);
    let blob = read_bytes_process_vm_best_effort(pid, start, 0x30000);
    if blob.len() < 256 {
        return false;
    }
    for off in (0..blob.len().saturating_sub(256)).step_by(8) {
        let Some((_, sp, pc, pstate, saved_regs, _esr)) =
            decode_aarch64_ucontext_from_slice(&blob[off..])
        else {
            continue;
        };
        if pc == 0 || sp == 0 {
            continue;
        }
        let pc_diff = |a: u64, b: u64| a.abs_diff(b);
        let near_pc = pc_diff(pc, stop_regs.pc) <= 0x40
            || pc_diff(pc, stop_regs.pc.wrapping_sub(4)) <= 0x40
            || pc_diff(pc, stop_regs.pc.wrapping_add(4)) <= 0x40;
        if !near_pc {
            continue;
        }
        let delta = sp.abs_diff(stop_regs.sp);
        // Prefer the common "signal-frame SP below interrupted SP" case, but accept wider
        // deltas because Android can emit large extended signal frames.
        if delta == 0 || delta > 0x20000 {
            continue;
        }
        out_regs.regs = saved_regs;
        out_regs.sp = sp;
        out_regs.pc = pc;
        out_regs.pstate = pstate;
        eprintln!(
            "SIGSYS frame restore: uctx@0x{:x} (scan+0x{:x}) delta_sp=0x{:x} saved_pc=0x{:x} saved_sp=0x{:x} x8=0x{:x}",
            start + off,
            off,
            delta,
            pc,
            sp,
            saved_regs[8]
        );
        return true;
    }
    false
}

#[cfg(not(target_arch = "aarch64"))]
fn try_restore_sigsys_interrupted_regs_from_stack(
    _pid: Pid,
    _stop_regs: UserPtRegs,
    _out_regs: &mut UserPtRegs,
) -> bool {
    false
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
            emulate_root_identity: false,
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
            emulate_root_identity: false,
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
