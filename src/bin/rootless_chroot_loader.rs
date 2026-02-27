#![no_std]
#![no_main]

// Minimal aarch64 loader shim inspired by proot-rs/loader-shim.
//
// Why this exists (Android-specific):
// - We want to start a *glibc* dynamic loader (`ld-linux-aarch64.so.1`) inside an Android process.
// - Android's host dynamic loader (`/system/bin/linker64`) cannot "linger" in the address space,
//   because glibc's ld.so assumes a different TLS layout (TPIDR_EL0 usage) and will crash if
//   host runtime signal/TLS machinery runs after glibc takes over.
// - Therefore we do a two-stage start:
//   1) Let Android exec a normal PIE binary (this shim) so the kernel/linker64 are happy.
//   2) In this shim, explicitly dismantle linker64 state we must not keep (munmap it), then map
//      and jump into the guest interpreter with a Linux-like initial stack/auxv.
//
// This binary runs as the tracee. The tracer (our ptrace "rootless chroot") rewrites path syscalls
// so guest absolute paths resolve inside the chosen rootfs.

use core::arch::{asm, global_asm};

// We need the initial kernel-provided stack pointer before any Rust prologue runs.
// Define a tiny assembly `_start` that forwards `sp` into `rust_start(sp)`.
//
// Why custom `_start`:
// - It keeps the very first instructions under our control (no libc crt, no TLS, no stack probes).
// - That matters because we will later replace TPIDR_EL0 and unmap linker64; any early runtime
//   code that assumes Android TLS or signal trampolines would become a time bomb.
global_asm!(
    r#"
    .global _start
    .type _start,%function
_start:
    mov x0, sp
    b rust_start

    .global shim_rt_sigreturn
    .type shim_rt_sigreturn,%function
shim_rt_sigreturn:
    // Why we need a private sigreturn trampoline:
    // - After we `munmap()` linker64, any signal handler/restorer pointer that used to point into
    //   linker64 becomes invalid.
    // - The kernel uses the `sa_restorer` pointer (SA_RESTORER) to return from a signal handler.
    // - So we provide a tiny "restorer" that just performs the `rt_sigreturn` syscall.
    mov x8, #139         // __NR_rt_sigreturn on aarch64
    svc #0
"#
);

type Word = usize;

const AT_NULL: Word = 0;
const AT_PHDR: Word = 3;
const AT_PHENT: Word = 4;
const AT_PHNUM: Word = 5;
const AT_PAGESZ: Word = 6;
const AT_BASE: Word = 7;
const AT_ENTRY: Word = 9;
const AT_PLATFORM: Word = 15;
const AT_BASE_PLATFORM: Word = 24;
const AT_RANDOM: Word = 25;
const AT_EXECFN: Word = 31;

const PT_LOAD: u32 = 1;
const PT_INTERP: u32 = 3;
const PT_PHDR: u32 = 6;

const MAP_PRIVATE: usize = 0x02;
const MAP_FIXED: usize = 0x10;
const MAP_ANONYMOUS: usize = 0x20;

const PROT_READ: usize = 0x1;
const PROT_WRITE: usize = 0x2;
const PROT_EXEC: usize = 0x4;
const PROT_NONE: usize = 0x0;
const PROT_GROWSDOWN: usize = 0x01000000;

const O_RDONLY: usize = 0;
const AT_FDCWD: isize = -100;
const SHIM_DEBUG_LOGS: bool = false;

#[inline(always)]
unsafe fn syscall0(nr: usize) -> isize {
    let ret: isize;
    asm!("svc 0", in("x8") nr, lateout("x0") ret, options(nostack));
    ret
}
#[inline(always)]
unsafe fn syscall1(nr: usize, a0: usize) -> isize {
    let ret: isize;
    asm!("svc 0", in("x8") nr, in("x0") a0, lateout("x0") ret, options(nostack));
    ret
}
#[inline(always)]
unsafe fn syscall2(nr: usize, a0: usize, a1: usize) -> isize {
    let ret: isize;
    asm!(
        "svc 0",
        in("x8") nr,
        in("x0") a0,
        in("x1") a1,
        lateout("x0") ret,
        options(nostack)
    );
    ret
}
#[inline(always)]
unsafe fn syscall3(nr: usize, a0: usize, a1: usize, a2: usize) -> isize {
    let ret: isize;
    asm!(
        "svc 0",
        in("x8") nr,
        in("x0") a0,
        in("x1") a1,
        in("x2") a2,
        lateout("x0") ret,
        options(nostack)
    );
    ret
}
#[inline(always)]
unsafe fn syscall4(nr: usize, a0: usize, a1: usize, a2: usize, a3: usize) -> isize {
    let ret: isize;
    asm!(
        "svc 0",
        in("x8") nr,
        in("x0") a0,
        in("x1") a1,
        in("x2") a2,
        in("x3") a3,
        lateout("x0") ret,
        options(nostack)
    );
    ret
}
#[inline(always)]
unsafe fn syscall6(nr: usize, a0: usize, a1: usize, a2: usize, a3: usize, a4: usize, a5: usize) -> isize {
    let ret: isize;
    asm!(
        "svc 0",
        in("x8") nr,
        in("x0") a0,
        in("x1") a1,
        in("x2") a2,
        in("x3") a3,
        in("x4") a4,
        in("x5") a5,
        lateout("x0") ret,
        options(nostack)
    );
    ret
}

// Linux aarch64 syscall numbers
const SYS_OPENAT: usize = 56;
const SYS_CLOSE: usize = 57;
const SYS_READ: usize = 63;
const SYS_LSEEK: usize = 62;
const SYS_MMAP: usize = 222;
const SYS_MUNMAP: usize = 215;
const SYS_EXIT: usize = 93;
const SYS_WRITE: usize = 64;
const SYS_MPROTECT: usize = 226;
const SYS_SIGALTSTACK: usize = 132;
const SYS_RT_SIGACTION: usize = 134;
const SYS_RT_SIGRETURN: usize = 139;

#[inline(always)]
unsafe fn sys_exit(code: i32) -> ! {
    let _ = syscall1(SYS_EXIT, code as usize);
    core::hint::unreachable_unchecked()
}

#[inline(always)]
unsafe fn sys_write(fd: usize, buf: *const u8, len: usize) {
    let _ = syscall3(SYS_WRITE, fd, buf as usize, len);
}

#[inline(always)]
unsafe fn sys_open(path: *const u8) -> isize {
    syscall4(SYS_OPENAT, AT_FDCWD as usize, path as usize, O_RDONLY, 0)
}

#[inline(always)]
unsafe fn strip_leading_slash(p: *const u8) -> *const u8 {
    if p.is_null() {
        return p;
    }
    if *p == b'/' {
        // Treat absolute guest paths as relative to our cwd (the tracer sets cwd=rootfs).
        p.add(1)
    } else {
        p
    }
}

#[inline(always)]
unsafe fn sys_close(fd: isize) {
    let _ = syscall1(SYS_CLOSE, fd as usize);
}

#[inline(always)]
unsafe fn sys_read(fd: isize, buf: *mut u8, len: usize) -> isize {
    syscall3(SYS_READ, fd as usize, buf as usize, len)
}

#[inline(always)]
unsafe fn sys_lseek(fd: isize, off: usize) -> isize {
    syscall3(SYS_LSEEK, fd as usize, off, 0 /* SEEK_SET */)
}

#[inline(always)]
unsafe fn sys_mmap(addr: usize, len: usize, prot: usize, flags: usize, fd: isize, off: usize) -> isize {
    syscall6(SYS_MMAP, addr, len, prot, flags, fd as usize, off)
}

#[inline(always)]
unsafe fn sys_munmap(addr: usize, len: usize) -> isize {
    syscall2(SYS_MUNMAP, addr, len)
}

#[inline(always)]
unsafe fn sys_mprotect(addr: usize, len: usize, prot: usize) -> isize {
    syscall3(SYS_MPROTECT, addr, len, prot)
}

#[inline(always)]
unsafe fn read_tpidr_el0() -> u64 {
    let v: u64;
    asm!("mrs {v}, TPIDR_EL0", v = out(reg) v, options(nostack, preserves_flags));
    v
}

#[inline(always)]
unsafe fn write_tpidr_el0(v: u64) {
    asm!("msr TPIDR_EL0, {v}", v = in(reg) v, options(nostack, preserves_flags));
}

#[inline(always)]
unsafe fn shim_rt_sigreturn_runtime_addr() -> u64 {
    let p: usize;
    asm!(
        "adr {out}, shim_rt_sigreturn",
        out = out(reg) p,
        options(nostack, preserves_flags)
    );
    p as u64
}

#[inline(always)]
unsafe fn shim_sigsys_handler_runtime_addr() -> u64 {
    let p: usize;
    asm!(
        "adr {out}, shim_sigsys_handler",
        out = out(reg) p,
        options(nostack, preserves_flags)
    );
    p as u64
}

#[repr(C)]
#[derive(Clone, Copy)]
struct KernelSigSet {
    sig: [u64; 1], // aarch64 uapi: _KERNEL__NSIG=64 => _NSIG_WORDS=1
}

#[repr(C)]
#[derive(Clone, Copy)]
struct KernelSigAction {
    sa_handler: u64,
    sa_flags: u64,
    sa_restorer: u64,
    sa_mask: KernelSigSet,
}

// From bionic's kernel uapi (see /usr/include/aarch64-linux-android/asm/sigcontext.h and ucontext.h).
#[repr(C)]
struct SigContext {
    fault_address: u64,
    regs: [u64; 31],
    pc: u64,
    sp: u64,
    pstate: u64,
    __reserved: [u8; 4096],
}

#[repr(C)]
struct UContext {
    uc_flags: u64,
    uc_link: *mut UContext,
    uc_stack: KernelStackT,
    uc_sigmask: KernelSigSet,
    __padding: [u8; 128 - core::mem::size_of::<KernelSigSet>()],
    uc_mcontext: SigContext,
}

#[repr(C)]
struct KernelStackT {
    ss_sp: u64,
    ss_flags: i32,
    _pad: i32,
    ss_size: u64,
}

const SIGSEGV: usize = 11;
const SIGSYS: usize = 31;
const SS_DISABLE: i32 = 2;

const SA_SIGINFO: u64 = 0x4;
const SA_RESTORER: u64 = 0x0400_0000;
const SA_ONSTACK: u64 = 0x0800_0000;
const SA_RESTART: u64 = 0x1000_0000;

#[unsafe(no_mangle)]
unsafe extern "C" fn shim_segv_handler(sig: i32, _info: *mut u8, uctx: *mut UContext) {
    write_str("loader_shim: caught SIGSEGV\n");
    write_hex("loader_shim: sig=", sig as Word);
    if !uctx.is_null() {
        let uc = &*uctx;
        write_hex("loader_shim: fault_address=", uc.uc_mcontext.fault_address as Word);
        write_hex("loader_shim: fault_pc=", uc.uc_mcontext.pc as Word);
        write_hex("loader_shim: fault_sp=", uc.uc_mcontext.sp as Word);
        write_hex("loader_shim: fault_x0=", uc.uc_mcontext.regs[0] as Word);
        write_hex("loader_shim: fault_x1=", uc.uc_mcontext.regs[1] as Word);
        write_hex("loader_shim: fault_x2=", uc.uc_mcontext.regs[2] as Word);
        write_hex("loader_shim: fault_x3=", uc.uc_mcontext.regs[3] as Word);
    } else {
        write_str("loader_shim: ucontext is null\n");
    }
    sys_exit(128 + (sig as i32));
}

unsafe fn sys_disable_sigaltstack_and_handlers() {
    // Disable altstack so ptrace sees SIGSEGV at the actual faulting PC, not inside
    // the Android linker/bionic signal handler running on an alternate stack.
    //
    // Why we do this:
    // - Android's linker uses a sigchain mechanism and may handle faults first.
    // - Once we switch to guest TLS (TPIDR_EL0), host sigchain code can crash or obscure the real
    //   guest faulting PC (it runs with assumptions about bionic TLS).
    let ss = KernelStackT {
        ss_sp: 0,
        ss_flags: SS_DISABLE,
        _pad: 0,
        ss_size: 0,
    };
    let r1 = syscall2(SYS_SIGALTSTACK, (&ss as *const KernelStackT) as usize, 0);
    if r1 < 0 {
        write_hex("loader_shim: sigaltstack failed ret=", r1 as Word);
    }

    // Force SIGSEGV handling back to the kernel default. This prevents Android's linker64
    // sigchain handler from running after we switch TPIDR_EL0 for the guest glibc loader.
    //
    // Why "default", not our own handler:
    // - We want crashes to be "plain" process crashes rather than bouncing through host sigchain.
    // - The ptrace tracer can still observe SIGSEGV and dump the *guest* registers/stack.
    let mut old = KernelSigAction {
        sa_handler: 0,
        sa_flags: 0,
        sa_restorer: 0,
        sa_mask: KernelSigSet { sig: [0] },
    };
    let r0 = syscall4(
        SYS_RT_SIGACTION,
        SIGSEGV,
        0,
        (&mut old as *mut KernelSigAction) as usize,
        core::mem::size_of::<KernelSigSet>(),
    );
    if r0 >= 0 {
        write_hex("loader_shim: old_segv_handler=", old.sa_handler as Word);
        write_hex("loader_shim: old_segv_flags=", old.sa_flags as Word);
    } else {
        write_hex("loader_shim: get_old_segv failed ret=", r0 as Word);
    }

    let act = KernelSigAction {
        sa_handler: 0, // SIG_DFL
        sa_flags: 0,
        sa_restorer: old.sa_restorer,
        sa_mask: KernelSigSet { sig: [0] },
    };
    let r2 = syscall4(
        SYS_RT_SIGACTION,
        SIGSEGV,
        (&act as *const KernelSigAction) as usize,
        0,
        core::mem::size_of::<KernelSigSet>(),
    );
    if r2 < 0 {
        write_hex("loader_shim: rt_sigaction failed ret=", r2 as Word);
    }

    let mut now = KernelSigAction {
        sa_handler: 0,
        sa_flags: 0,
        sa_restorer: 0,
        sa_mask: KernelSigSet { sig: [0] },
    };
    let r3 = syscall4(
        SYS_RT_SIGACTION,
        SIGSEGV,
        0,
        (&mut now as *mut KernelSigAction) as usize,
        core::mem::size_of::<KernelSigSet>(),
    );
    if r3 >= 0 {
        write_hex("loader_shim: now_segv_handler=", now.sa_handler as Word);
        write_hex("loader_shim: now_segv_flags=", now.sa_flags as Word);
    } else {
        write_hex("loader_shim: get_now_segv failed ret=", r3 as Word);
    }
}

#[repr(C)]
struct SigInfoHeader {
    si_signo: i32,
    si_errno: i32,
    si_code: i32,
    _pad: i32,
}

#[repr(C)]
struct SigInfoSigSys {
    hdr: SigInfoHeader,
    call_addr: u64,
    syscall: i32,
    arch: u32,
}

#[unsafe(no_mangle)]
unsafe extern "C" fn shim_sigsys_handler(_sig: i32, info: *mut u8, uctx: *mut UContext) {
    if uctx.is_null() {
        return;
    }
    let uc = &mut *uctx;
    let mut sysno: i32 = uc.uc_mcontext.regs[8] as i32;
    let mut call_addr: u64 = 0;
    if !info.is_null() {
        let sigsys = &*(info as *const SigInfoSigSys);
        sysno = sigsys.syscall;
        call_addr = sigsys.call_addr;
    }
    if SHIM_DEBUG_LOGS {
        write_hex("loader_shim: SIGSYS sysno=", sysno as Word);
        write_hex("loader_shim: SIGSYS pc=", uc.uc_mcontext.pc as Word);
        write_hex("loader_shim: SIGSYS sp=", uc.uc_mcontext.sp as Word);
        write_hex("loader_shim: SIGSYS call_addr=", call_addr as Word);
    }
    let mut resume_pc = uc.uc_mcontext.pc;
    let mut resume_pc_from_call_addr = false;
    if call_addr != 0 {
        let p = call_addr as *const u32;
        let insn = if !p.is_null() {
            core::ptr::read_unaligned(p)
        } else {
            0
        };
        if insn == 0xd4000001 {
            // si_call_addr points at the trapping `svc #0`; resume at the next instruction.
            resume_pc = call_addr.wrapping_add(4);
            resume_pc_from_call_addr = true;
        } else if call_addr >= 4 {
            let p_prev = (call_addr - 4) as *const u32;
            let prev = if !p_prev.is_null() {
                core::ptr::read_unaligned(p_prev)
            } else {
                0
            };
            if prev == 0xd4000001 {
                // Some kernels may report the post-svc address in `si_call_addr`.
                resume_pc = call_addr;
                resume_pc_from_call_addr = true;
            }
        }
        if SHIM_DEBUG_LOGS {
            write_hex("loader_shim: SIGSYS call_addr_resume_pc=", resume_pc as Word);
        }
    }
    let should_advance_pc = if resume_pc_from_call_addr {
        false
    } else {
        let pc = uc.uc_mcontext.pc as *const u32;
        let insn = if !pc.is_null() {
            // Best-effort decode of the faulting instruction. If the PC is already past the
            // `svc #0`, advancing again skips a real instruction and corrupts guest startup.
            core::ptr::read_unaligned(pc)
        } else {
            0
        };
        let is_svc_0 = insn == 0xd4000001;
        if SHIM_DEBUG_LOGS {
            write_hex("loader_shim: SIGSYS insn=", insn as Word);
        }
        is_svc_0
    };

    // Emulate (skip) selected syscalls.
    // On aarch64, return value is in x0.
    if sysno == 99 {
        uc.uc_mcontext.regs[0] = 0;
        uc.uc_mcontext.pc = resume_pc;
        if should_advance_pc {
            uc.uc_mcontext.pc = uc.uc_mcontext.pc.wrapping_add(4);
        }
        return;
    }
    if sysno == 439 {
        // faccessat2: Android seccomp commonly traps this. Many userspace libraries use it
        // as a best-effort capability/permission probe. Match proot: return ENOSYS so callers
        // can fall back to older syscalls.
        write_str("loader_shim: emu faccessat2 -> ENOSYS\n");
        uc.uc_mcontext.regs[0] = (!38u64).wrapping_add(1); // -ENOSYS
        uc.uc_mcontext.pc = resume_pc;
        if should_advance_pc {
            uc.uc_mcontext.pc = uc.uc_mcontext.pc.wrapping_add(4);
        }
        return;
    }
    if sysno == 293 {
        // Match PRoot-style behavior for unsupported rseq: let glibc disable it.
        uc.uc_mcontext.regs[0] = (!38u64).wrapping_add(1); // -ENOSYS
        uc.uc_mcontext.pc = resume_pc;
        if should_advance_pc {
            uc.uc_mcontext.pc = uc.uc_mcontext.pc.wrapping_add(4);
        }
        return;
    }

    // Default: pretend ENOSYS.
    uc.uc_mcontext.regs[0] = (!38u64).wrapping_add(1); // -ENOSYS
    uc.uc_mcontext.pc = resume_pc;
    if should_advance_pc {
        uc.uc_mcontext.pc = uc.uc_mcontext.pc.wrapping_add(4);
    }
}

unsafe fn install_sigsys_emulation_handler() {
    // Install a SIGSYS handler with our own restorer so we can survive SECCOMP_RET_TRAP after
    // unmapping Android's linker64.
    //
    // Why this is needed:
    // - Some Android environments deliver seccomp "trap" events as SIGSYS.
    // - Normally bionic/linker64 provides the signal return machinery.
    // - After we unmap linker64, SIGSYS must still be handled because glibc ld.so may probe
    //   syscalls (e.g. set_robust_list, rseq). We emulate the minimum needed for bring-up.
    unsafe extern "C" {
        fn shim_rt_sigreturn();
    }

    let sigsys_handler_ptr = shim_sigsys_handler_runtime_addr();
    let shim_rt_sigreturn_ptr = shim_rt_sigreturn_runtime_addr();
    write_hex("loader_shim: shim_sigsys_handler(runtime)=", sigsys_handler_ptr as Word);
    write_hex(
        "loader_shim: shim_sigsys_handler(linktime)=",
        shim_sigsys_handler as usize as Word,
    );
    write_hex(
        "loader_shim: shim_rt_sigreturn(runtime)=",
        shim_rt_sigreturn_ptr as Word,
    );
    write_hex(
        "loader_shim: shim_rt_sigreturn(linktime)=",
        shim_rt_sigreturn as usize as Word,
    );

    let act = KernelSigAction {
        sa_handler: sigsys_handler_ptr,
        sa_flags: SA_SIGINFO | SA_RESTORER,
        sa_restorer: shim_rt_sigreturn_ptr,
        sa_mask: KernelSigSet { sig: [0] },
    };
    let r = syscall4(
        SYS_RT_SIGACTION,
        SIGSYS,
        (&act as *const KernelSigAction) as usize,
        0,
        core::mem::size_of::<KernelSigSet>(),
    );
    if r < 0 {
        write_hex("loader_shim: install SIGSYS failed ret=", r as Word);
    } else {
        write_str("loader_shim: installed SIGSYS emulation\n");
    }
}

unsafe fn reset_all_signal_handlers_to_default() {
    // If we unmap linker64, we must not leave any handlers pointing into it.
    // Reset almost all signals to SIG_DFL (ignore SIGKILL/SIGSTOP).
    //
    // Why "reset everything" instead of trying to be surgical:
    // - On Android, a surprising number of handlers are installed early (debuggerd, sigchain).
    // - Any stale handler pointer into unmapped linker64 is instant UB the next time that signal
    //   fires. Default actions are boring but safe for our "handoff to glibc" phase.
    let act = KernelSigAction {
        sa_handler: 0, // SIG_DFL
        sa_flags: 0,
        sa_restorer: 0,
        sa_mask: KernelSigSet { sig: [0] },
    };
    for sig in 1usize..=64usize {
        if sig == 9 || sig == 19 {
            continue; // SIGKILL, SIGSTOP
        }
        let _ = syscall4(
            SYS_RT_SIGACTION,
            sig,
            (&act as *const KernelSigAction) as usize,
            0,
            core::mem::size_of::<KernelSigSet>(),
        );
    }
}

#[inline(always)]
fn is_hex(b: u8) -> bool {
    (b'0'..=b'9').contains(&b) || (b'a'..=b'f').contains(&b) || (b'A'..=b'F').contains(&b)
}

#[inline(always)]
fn hex_val(b: u8) -> u8 {
    if (b'0'..=b'9').contains(&b) {
        b - b'0'
    } else if (b'a'..=b'f').contains(&b) {
        10 + (b - b'a')
    } else {
        10 + (b - b'A')
    }
}

fn parse_hex_u64(mut p: *const u8, end: *const u8) -> Option<(u64, *const u8)> {
    let mut v: u64 = 0;
    let mut n = 0usize;
    while p < end {
        let b = unsafe { *p };
        if !is_hex(b) {
            break;
        }
        v = (v << 4) | (hex_val(b) as u64);
        n += 1;
        p = unsafe { p.add(1) };
        if n > 16 {
            break;
        }
    }
    if n == 0 {
        None
    } else {
        Some((v, p))
    }
}

unsafe fn unmap_android_linker64() {
    // Best-effort: read /proc/self/maps and munmap every range whose pathname contains "linker64".
    //
    // Why `munmap()` at all:
    // - Keeping linker64 mapped means keeping Android TLS + sigchain assumptions alive.
    // - glibc ld.so will re-purpose TPIDR_EL0 and expects its own TLS layout; host code running
    //   after that can crash (and has, in practice) in signal paths.
    // - We cannot `dlclose()` here (no libc), so `/proc/self/maps` + `munmap()` is the pragmatic
    //   low-level approach.
    let path = b"/proc/self/maps\0";
    let fd = sys_open(path.as_ptr());
    if fd < 0 {
        write_str("loader_shim: open /proc/self/maps failed\n");
        return;
    }

    let mut buf = [0u8; 8192];
    let mut line = [0u8; 1024];
    let mut line_n = 0usize;

    let mut pending: [u64; 128] = [0; 128]; // pairs (start,end)
    let mut pend_n = 0usize;

    loop {
        let r = sys_read(fd, buf.as_mut_ptr(), buf.len());
        if r <= 0 {
            break;
        }
        let r = r as usize;
        for i in 0..r {
            let b = buf[i];
            if line_n < line.len() {
                line[line_n] = b;
                line_n += 1;
            }
            if b != b'\n' {
                continue;
            }

            let start_line = line.as_ptr();
            let end_line = start_line.add(line_n);

            // Parse "<start>-<end> ..."
            let Some((start, mut p)) = parse_hex_u64(start_line, end_line) else {
                line_n = 0;
                continue;
            };
            if p >= end_line || *p != b'-' {
                line_n = 0;
                continue;
            }
            p = p.add(1);
            let Some((end, _p2)) = parse_hex_u64(p, end_line) else {
                line_n = 0;
                continue;
            };

            // Check if line contains "linker64".
            let needle = b"linker64";
            let mut hit = false;
            if line_n >= needle.len() {
                for j in 0..=line_n - needle.len() {
                    let mut ok = true;
                    for k in 0..needle.len() {
                        if line[j + k] != needle[k] {
                            ok = false;
                            break;
                        }
                    }
                    if ok {
                        hit = true;
                        break;
                    }
                }
            }

            if hit && pend_n + 2 <= pending.len() {
                pending[pend_n] = start;
                pending[pend_n + 1] = end;
                pend_n += 2;
            }

            line_n = 0;
        }
    }
    sys_close(fd);

    if pend_n == 0 {
        write_str("loader_shim: no linker64 mappings found to unmap\n");
        return;
    }
    write_hex("loader_shim: unmapping linker64 ranges count=", (pend_n / 2) as Word);

    let mut i = 0usize;
    while i < pend_n {
        let s = pending[i];
        let e = pending[i + 1];
        i += 2;
        if e > s {
            let _ = sys_munmap(s as usize, (e - s) as usize);
        }
    }
}

#[repr(C)]
struct Elf64Ehdr {
    e_ident: [u8; 16],
    e_type: u16,
    e_machine: u16,
    e_version: u32,
    e_entry: u64,
    e_phoff: u64,
    e_shoff: u64,
    e_flags: u32,
    e_ehsize: u16,
    e_phentsize: u16,
    e_phnum: u16,
    e_shentsize: u16,
    e_shnum: u16,
    e_shstrndx: u16,
}

#[repr(C)]
struct Elf64Phdr {
    p_type: u32,
    p_flags: u32,
    p_offset: u64,
    p_vaddr: u64,
    p_paddr: u64,
    p_filesz: u64,
    p_memsz: u64,
    p_align: u64,
}

#[derive(Clone, Copy)]
struct LoadSeg {
    off: u64,
    vaddr: u64,
    filesz: u64,
    memsz: u64,
    flags: u32,
}

struct ImageInfo {
    entry: u64,
    phoff: u64,
    phentsize: u16,
    phnum: u16,
    phdr_vaddr: u64,
    interp_off: u64,
    interp_len: u64,
    segs: [LoadSeg; 16],
    seg_count: usize,
    min_vaddr: u64,
    max_vaddr: u64,
    max_align: u64,
}

fn page_size() -> u64 {
    4096
}
fn align_down(v: u64, a: u64) -> u64 {
    v & !(a - 1)
}
fn align_up(v: u64, a: u64) -> u64 {
    (v + (a - 1)) & !(a - 1)
}
fn prot(flags: u32) -> usize {
    let mut p = 0;
    if flags & 0x4 != 0 {
        p |= PROT_READ;
    }
    if flags & 0x2 != 0 {
        p |= PROT_WRITE;
    }
    if flags & 0x1 != 0 {
        p |= PROT_EXEC;
    }
    p
}

unsafe fn read_exact(fd: isize, off: u64, dst: *mut u8, len: usize) -> bool {
    if sys_lseek(fd, off as usize) < 0 {
        return false;
    }
    let mut got = 0usize;
    while got < len {
        let r = sys_read(fd, dst.add(got), len - got);
        if r <= 0 {
            return false;
        }
        got += r as usize;
    }
    true
}

unsafe fn load_image_info(path: *const u8, out_interp: *mut u8, out_interp_cap: usize) -> Option<(isize, ImageInfo, usize)> {
    let fd = sys_open(path);
    if fd < 0 {
        return None;
    }
    let mut eh: Elf64Ehdr = core::mem::zeroed();
    if !read_exact(fd, 0, &mut eh as *mut _ as *mut u8, core::mem::size_of::<Elf64Ehdr>()) {
        sys_close(fd);
        return None;
    }
    if &eh.e_ident[0..4] != b"\x7fELF" || eh.e_ident[4] != 2 || eh.e_ident[5] != 1 {
        sys_close(fd);
        return None;
    }
    let phnum = eh.e_phnum as usize;
    if phnum == 0 || phnum > 64 {
        sys_close(fd);
        return None;
    }

    let mut info = ImageInfo {
        entry: eh.e_entry,
        phoff: eh.e_phoff,
        phentsize: eh.e_phentsize,
        phnum: eh.e_phnum,
        phdr_vaddr: 0,
        interp_off: 0,
        interp_len: 0,
        segs: [LoadSeg { off: 0, vaddr: 0, filesz: 0, memsz: 0, flags: 0 }; 16],
        seg_count: 0,
        min_vaddr: u64::MAX,
        max_vaddr: 0,
        max_align: 4096,
    };

    let mut interp_len = 0usize;
    for i in 0..phnum {
        let mut ph: Elf64Phdr = core::mem::zeroed();
        let off = eh.e_phoff + (i as u64) * (eh.e_phentsize as u64);
        if !read_exact(fd, off, &mut ph as *mut _ as *mut u8, core::mem::size_of::<Elf64Phdr>()) {
            sys_close(fd);
            return None;
        }
        if ph.p_type == PT_PHDR {
            info.phdr_vaddr = ph.p_vaddr;
        } else if ph.p_type == PT_INTERP {
            info.interp_off = ph.p_offset;
            info.interp_len = ph.p_filesz;
            let want = core::cmp::min(out_interp_cap, ph.p_filesz as usize);
            if want > 0 && read_exact(fd, ph.p_offset, out_interp, want) {
                // Ensure NUL termination for safety
                if want > 0 {
                    *out_interp.add(want - 1) = 0;
                }
                // compute strlen
                while interp_len < want && *out_interp.add(interp_len) != 0 {
                    interp_len += 1;
                }
            }
        } else if ph.p_type == PT_LOAD && info.seg_count < info.segs.len() {
            info.segs[info.seg_count] = LoadSeg {
                off: ph.p_offset,
                vaddr: ph.p_vaddr,
                filesz: ph.p_filesz,
                memsz: ph.p_memsz,
                flags: ph.p_flags,
            };
            info.seg_count += 1;
            let ps = page_size();
            info.min_vaddr = core::cmp::min(info.min_vaddr, align_down(ph.p_vaddr, ps));
            info.max_vaddr = core::cmp::max(info.max_vaddr, align_up(ph.p_vaddr + ph.p_memsz, ps));
            // Kernel aligns ET_DYN load addresses to p_align (often 64k for glibc ld-linux).
            if ph.p_align != 0 {
                info.max_align = core::cmp::max(info.max_align, ph.p_align);
            }
        }
    }

    // If PT_PHDR wasn't present, derive the in-memory program header address from the PT_LOAD
    // segment that contains the file range of the phdr table.
    if info.phdr_vaddr == 0 {
        let phoff = eh.e_phoff;
        for i in 0..info.seg_count {
            let seg = info.segs[i];
            let seg_end = seg.off.saturating_add(seg.filesz);
            if seg.off <= phoff && phoff < seg_end {
                info.phdr_vaddr = seg.vaddr + (phoff - seg.off);
                break;
            }
        }
        // As a last resort, many ET_DYN binaries map the ELF header at vaddr 0.
        if info.phdr_vaddr == 0 {
            info.phdr_vaddr = eh.e_phoff;
        }
    }

    Some((fd, info, interp_len))
}

// Returns (load_bias, load_start, entry). load_bias is the ET_DYN relocation bias such that
// in-memory virtual addresses are `load_bias + p_vaddr`. load_start is the actual start address
// of the mapped image (first mapped page).
unsafe fn map_image(fd: isize, info: &ImageInfo) -> Option<(u64, u64, u64)> {
    let ps = page_size();
    if info.min_vaddr == u64::MAX || info.max_vaddr <= info.min_vaddr {
        return None;
    }
    let span = (info.max_vaddr - info.min_vaddr) as usize;
    let align = core::cmp::max(ps, info.max_align);
    // Reserve a bit extra so we can choose a base aligned to `align`.
    let reserve_len = span + (align as usize);
    // Hint the kernel to place guest images far away from the host/Android linker mappings.
    // proot-rs uses fixed high addresses for this reason.
    #[cfg(target_arch = "aarch64")]
    let hint: usize = 0x2000_0000_00;
    #[cfg(not(target_arch = "aarch64"))]
    let hint: usize = 0;
    let reserve = sys_mmap(hint, reserve_len, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if reserve < 0 {
        return None;
    }
    let reserve_start = reserve as u64;
    let mut load_start = align_up(reserve_start, align);
    // Trim prefix/suffix so the final reserved span is exactly [load_start, load_start+span).
    let prefix = load_start.saturating_sub(reserve_start) as usize;
    if prefix != 0 {
        let _ = sys_munmap(reserve as usize, prefix);
    }
    let end = reserve_start + reserve_len as u64;
    let want_end = load_start + span as u64;
    if want_end < end {
        let _ = sys_munmap(want_end as usize, (end - want_end) as usize);
    }
    let bias = load_start.wrapping_sub(info.min_vaddr);

    for i in 0..info.seg_count {
        let seg = info.segs[i];
        let seg_page = align_down(seg.vaddr, ps);
        let off_page = align_down(seg.off, ps);
        let page_delta = seg.vaddr - seg_page;
        let file_len = align_up(page_delta + seg.filesz, ps) as usize;
        if file_len > 0 {
            let addr = (bias + seg_page) as usize;
            let p = prot(seg.flags);
            let mapped = sys_mmap(
                addr,
                file_len,
                p,
                MAP_PRIVATE | MAP_FIXED,
                fd,
                off_page as usize,
            );
            if mapped < 0 {
                return None;
            }
            // Kernel behavior: if p_memsz > p_filesz, the extra bytes in the last file-backed
            // page (from end-of-file data to page boundary) must be zeroed. Otherwise we expose
            // unrelated file bytes in what should be .bss, which can crash the dynamic linker.
            if seg.memsz > seg.filesz {
                let file_end_in_seg = (page_delta + seg.filesz) as usize;
                let tail = file_len.saturating_sub(file_end_in_seg);
                if tail != 0 {
                    core::ptr::write_bytes((addr + file_end_in_seg) as *mut u8, 0, tail);
                }
            }
        }
        let mem_len = align_up(page_delta + seg.memsz, ps) as usize;
        if mem_len > file_len {
            let addr = (bias + seg_page) as usize + file_len;
            let anon_len = mem_len - file_len;
            let p = prot(seg.flags);
            let mapped = sys_mmap(
                addr,
                anon_len,
                p,
                MAP_PRIVATE | MAP_FIXED | MAP_ANONYMOUS,
                -1,
                0,
            );
            if mapped < 0 {
                return None;
            }
        }
    }

    Some((bias, load_start, bias + info.entry))
}

unsafe fn c_strlen(mut p: *const u8) -> usize {
    let mut n = 0usize;
    while *p != 0 {
        n += 1;
        p = p.add(1);
    }
    n
}

unsafe fn write_str(s: &str) {
    if SHIM_DEBUG_LOGS {
        sys_write(2, s.as_ptr(), s.len());
    }
}

unsafe fn write_hex(label: &str, v: Word) {
    if !SHIM_DEBUG_LOGS {
        return;
    }
    write_str(label);
    write_str("0x");
    let mut buf = [0u8; core::mem::size_of::<Word>() * 2];
    let mut x = v as u64;
    for i in 0..buf.len() {
        let shift = (buf.len() - 1 - i) * 4;
        let nib = ((x >> shift) & 0xf) as u8;
        buf[i] = if nib < 10 { b'0' + nib } else { b'a' + (nib - 10) };
    }
    sys_write(2, buf.as_ptr(), buf.len());
    write_str("\n");
}

unsafe fn write_cstr(label: &str, mut p: *const u8) {
    if !SHIM_DEBUG_LOGS {
        return;
    }
    write_str(label);
    if p.is_null() {
        write_str("(null)\n");
        return;
    }
    // Write up to a small cap to avoid hanging on non-terminated pointers.
    for _ in 0..512 {
        let b = *p;
        if b == 0 {
            break;
        }
        sys_write(2, &b as *const u8, 1);
        p = p.add(1);
    }
    write_str("\n");
}

unsafe fn c_str_eq(mut a: *const u8, mut b: *const u8) -> bool {
    if a.is_null() || b.is_null() {
        return false;
    }
    for _ in 0..4096 {
        let ca = *a;
        let cb = *b;
        if ca != cb {
            return false;
        }
        if ca == 0 {
            return true;
        }
        a = a.add(1);
        b = b.add(1);
    }
    false
}

unsafe fn mmap_stack(len: usize) -> *mut u8 {
    let p = sys_mmap(0, len, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if p < 0 {
        core::ptr::null_mut()
    } else {
        p as *mut u8
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_start(sp: *mut Word) -> ! {
    write_str("loader_shim: start\n");
    // Preserve the original kernel-provided stack pointer.
    let orig_sp = sp as usize;
    let mut sp = sp;

    // argv[1] is the target path (the tracer invokes: loader_shim <target> [args...]).
    let argc = *sp as usize;
    if argc < 2 {
        write_str("loader_shim: missing target\n");
        sys_exit(127);
    }
    let argv = sp.add(1) as *mut *const u8;
    write_hex("loader_shim: argc=", argc as Word);
    if argc >= 1 {
        write_cstr("loader_shim: argv0=", *argv.add(0));
    }
    if argc >= 2 {
        write_cstr("loader_shim: argv1=", *argv.add(1));
    }
    if argc >= 3 {
        write_cstr("loader_shim: argv2=", *argv.add(2));
    }
    // On some setups (notably Android's dynamic linker), `argv[1]` can be the executable path
    // duplicated, and the user-provided first argument becomes `argv[2]`.
    let mut target_idx = 1usize;
    if argc >= 3 {
        let a0 = *argv.add(0);
        let a1 = *argv.add(1);
        if c_str_eq(a0, a1) {
            target_idx = 2;
        }
    }
    if argc <= target_idx {
        write_str("loader_shim: missing target\n");
        sys_exit(127);
    }
    let target = *argv.add(target_idx);
    let target_open = strip_leading_slash(target);
    write_cstr("loader_shim: target=", target);

    // Debug utility: verify our SIGSEGV handler install actually works in this environment.
    if c_str_eq(target, b"/__shim_segv_test\0".as_ptr()) {
        write_str("loader_shim: segv test mode\n");
        sys_disable_sigaltstack_and_handlers();
        write_str("loader_shim: about to segv\n");
        *(0 as *mut u8) = 1;
        sys_exit(1);
    }

    // Read target ELF to find interpreter.
    let mut interp_buf = [0u8; 512];
    let Some((tfd, tinfo, _ilen)) = load_image_info(target_open, interp_buf.as_mut_ptr(), interp_buf.len()) else {
        write_str("loader_shim: failed reading target\n");
        sys_exit(127);
    };
    if tinfo.interp_len == 0 {
        write_str("loader_shim: target has no PT_INTERP\n");
        sys_exit(127);
    }
    let interp_path = interp_buf.as_ptr();
    write_str("loader_shim: parsed target\n");
    let interp_open = strip_leading_slash(interp_path);
    let Some((ifd, iinfo, _)) = load_image_info(interp_open, core::ptr::null_mut(), 0) else {
        write_str("loader_shim: failed reading interp\n");
        sys_exit(127);
    };

    // Why we open/parse/map both target and interpreter ourselves:
    // - If we `execve()` the guest binary normally, the host loader (linker64) remains in charge.
    // - We want a clean handoff into the guest interpreter without another round of host dynamic
    //   linking, so we map ET_DYN images ourselves and jump directly to ld.so entry.
    let Some((tbias, tstart, tentry)) = map_image(tfd, &tinfo) else {
        write_str("loader_shim: map target failed\n");
        sys_exit(127);
    };
    let Some((ibias, istart, ientry)) = map_image(ifd, &iinfo) else {
        write_str("loader_shim: map interp failed\n");
        sys_exit(127);
    };
    write_str("loader_shim: mapped images\n");
    sys_close(tfd);
    sys_close(ifd);

    // Debug: show the host thread pointer state. glibc's ld.so relies heavily on TPIDR_EL0.
    let tp = read_tpidr_el0();
    write_hex("loader_shim: TPIDR_EL0=", tp as Word);
    if tp >= 4096 {
        // Many libcs store the DTV pointer at [TP].
        let dtv = (tp as *const u64).read_volatile();
        write_hex("loader_shim: [TP]= ", dtv as Word);
    } else {
        write_str("loader_shim: [TP] skipped (low)\n");
    }

    // We delay changing TPIDR_EL0 until the last moment:
    // - While linker64 is still mapped and signal handlers are still pointing into it, switching
    //   TPIDR_EL0 to a glibc layout can crash host code (especially on signals).
    // - So we first install our own signal return plumbing and unmap linker64, then set TPIDR_EL0
    //   to a guest-compatible region right before entering glibc ld.so.

    // Rewrite the original kernel-provided stack in place so it looks like a direct execve() of
    // the target (remove the loader shim argv prefix and patch auxv). This matches proot's
    // approach more closely and preserves the kernel's exact stack alignment/placement.
    const MAX_ARGV: usize = 128;
    const MAX_ENVP: usize = 512;
    const MAX_AUX: usize = 256;

    let new_argc = argc - target_idx;
    if new_argc == 0 || new_argc > MAX_ARGV {
        write_str("loader_shim: argv too large\n");
        sys_exit(127);
    }

    // Locate envp on the original stack.
    // Layout: argc | argv[] NULL | envp[] NULL | auxv[]
    // argv has length `argc` and is terminated by a NULL at argv[argc].
    // envp starts immediately after that terminator, at argv[argc + 1].
    let envp = argv.add(argc + 1);
    let mut envc = 0usize;
    while !(*envp.add(envc)).is_null() {
        envc += 1;
        if envc > MAX_ENVP {
            write_str("loader_shim: envp too large\n");
            sys_exit(127);
        }
    }

    // Locate and bounds-check auxv on the original stack.
    let mut auxp = envp.add(envc + 1) as *mut Word;
    let mut auxc = 0usize;
    let mut at_random_bytes = [0u8; 16];
    let mut have_at_random = false;
    let mut at_platform_bytes = [0u8; 64];
    let mut at_platform_len = 0usize;
    let mut at_base_platform_bytes = [0u8; 64];
    let mut at_base_platform_len = 0usize;
    loop {
        if auxc >= MAX_AUX {
            write_str("loader_shim: auxv too large\n");
            sys_exit(127);
        }
        let k = auxp.read_unaligned();
        let v = auxp.add(1).read_unaligned();
        if k == AT_RANDOM && v != 0 {
            core::ptr::copy_nonoverlapping(
                v as usize as *const u8,
                at_random_bytes.as_mut_ptr(),
                at_random_bytes.len(),
            );
            have_at_random = true;
        } else if (k == AT_PLATFORM || k == AT_BASE_PLATFORM) && v != 0 {
            let src = v as usize as *const u8;
            let mut len = 0usize;
            while len < at_platform_bytes.len() && *src.add(len) != 0 {
                len += 1;
            }
            if len < at_platform_bytes.len() {
                let copy_len = len + 1; // include trailing NUL
                if k == AT_PLATFORM {
                    core::ptr::copy_nonoverlapping(src, at_platform_bytes.as_mut_ptr(), copy_len);
                    at_platform_len = copy_len;
                } else {
                    core::ptr::copy_nonoverlapping(
                        src,
                        at_base_platform_bytes.as_mut_ptr(),
                        copy_len,
                    );
                    at_base_platform_len = copy_len;
                }
            }
        }
        auxp = auxp.add(2);
        auxc += 1;
        if k == AT_NULL {
            break;
        }
    }
    // Rewrite argc and argv[] in place.
    (sp as *mut Word).write_unaligned(new_argc as Word);
    for i in 0..new_argc {
        let p = *argv.add(i + target_idx);
        (argv.add(i) as *mut *const u8).write_unaligned(p);
    }
    (argv.add(new_argc) as *mut *const u8).write_unaligned(core::ptr::null());

    // Compact the envp+auxv tail down so it immediately follows the shortened argv[] NULL.
    let tail_src = envp as *mut Word;
    let tail_dst = argv.add(new_argc + 1) as *mut Word;
    let tail_words =
        (auxp as usize).wrapping_sub(tail_src as usize) / core::mem::size_of::<Word>();
    core::ptr::copy(tail_src, tail_dst, tail_words);

    // Patch these auxv values to match our in-memory mappings.
    let phdr = tbias + tinfo.phdr_vaddr;
    let entry = tbias + tinfo.entry;
    let execfn_ptr = *argv.add(0) as Word;
    let mut auxp2 = (argv.add(new_argc + 1 + envc + 1)) as *mut Word;
    // Keep AT_RANDOM / AT_PLATFORM / AT_BASE_PLATFORM pointers as provided by the kernel stack.
    // PRoot's loader does not rewrite these, and AT_RANDOM directly feeds glibc stack canaries.
    // Repointing them to a copied page can subtly diverge from expected startup state.
    let at_random_ptr = if have_at_random { 1 as Word } else { 0 as Word };
    let at_platform_ptr = if at_platform_len != 0 { 1 as Word } else { 0 as Word };
    let at_base_platform_ptr = if at_base_platform_len != 0 { 1 as Word } else { 0 as Word };

    write_hex("loader_shim: patch_AT_PHDR=", phdr as Word);
    write_hex("loader_shim: patch_AT_BASE=", ibias as Word);
    write_hex("loader_shim: patch_AT_ENTRY=", entry as Word);
    write_hex("loader_shim: patch_AT_EXECFN_PTR=", execfn_ptr);
    write_hex("loader_shim: interp_entry_addr=", ientry as Word);
    loop {
        let k = auxp2.read_unaligned();
        let mut v = auxp2.add(1).read_unaligned();
        match k {
            AT_PHDR => v = phdr as Word,
            AT_PHENT => v = tinfo.phentsize as Word,
            AT_PHNUM => v = tinfo.phnum as Word,
            AT_PAGESZ => v = page_size() as Word,
            AT_BASE => v = ibias as Word,
            AT_ENTRY => v = entry as Word,
            AT_EXECFN => v = execfn_ptr,
            AT_RANDOM if at_random_ptr != 0 => {}
            AT_PLATFORM if at_platform_ptr != 0 => {}
            AT_BASE_PLATFORM if at_base_platform_ptr != 0 => {}
            _ => {}
        }
        auxp2.add(1).write_unaligned(v);
        auxp2 = auxp2.add(2);
        if k == AT_NULL {
            break;
        }
    }

    // Keep the kernel-provided initial stack layout (matches PRoot). A temporary header-relocation
    // experiment helped diagnostics but diverges from the startup state glibc expects.

    write_str("loader_shim: jumping\n");
    write_hex("loader_shim: final_sp=", sp as Word);
    write_hex("loader_shim: final_sp_mod16=", (sp as usize & 0xf) as Word);
    // Ordering here is deliberate:
    // 1) Neutralize Android's signal stack/handlers (avoid sigchain surprises).
    // 2) Reset signal handlers so nothing points into linker64.
    // 3) Install SIGSYS emulation with our own restorer (seccomp traps must still return safely).
    // 4) Unmap linker64 so host runtime can't accidentally run after we switch to guest TLS.
    sys_disable_sigaltstack_and_handlers();
    reset_all_signal_handlers_to_default();
    // Prefer ptrace-side seccomp/SIGSYS emulation on Android rootless path. Shim-side SIGSYS
    // handling is a fallback, but some kernels expose an unreliable ucontext PC for seccomp SIGSYS
    // (observed at non-`svc` instructions), which can corrupt guest startup if the shim handles it.
    // Keep the code available, but disable installation by default.
    // Prefer ptrace-side SIGSYS emulation when enabled in the tracer; keep shim-side support
    // available for fallback experiments.
    // Prefer ptrace-side SIGSYS emulation when enabled in the tracer; keep shim-side support
    // available for fallback experiments.
    // install_sigsys_emulation_handler();
    unmap_android_linker64();

    // Install a glibc-compatible "thread pointer" region for the guest loader.
    // glibc ld-linux writes at negative offsets from TPIDR_EL0 very early (e.g. TP-0x660),
    // which will SEGV if TPIDR_EL0 still points into bionic/linker64 TLS.
    //
    // This is inherently risky on Android (host code expects bionic TLS), which is why we
    // aggressively remove host loader influence above. At this point we want "as little Android
    // runtime as possible" and "as much Linux/glibc illusion as needed" to let ld.so initialize.
    // Install a dedicated guest TLS scratch region for glibc ld.so. The repeated stack-smashing
    // aborts during early startup strongly suggest glibc is touching stack-guard/TLS state via
    // Android's bionic TPIDR_EL0 layout. Give it a much larger private region and place TP in the
    // middle so both negative and positive offsets are safe until glibc installs its real TCB.
    let guest_tls_len = 8 * 1024 * 1024usize;
    let guest_tls = sys_mmap(
        0,
        guest_tls_len,
        PROT_READ | PROT_WRITE,
        MAP_PRIVATE | MAP_ANONYMOUS,
        -1,
        0,
    );
    if guest_tls > 0 {
        let guest_tp = ((guest_tls as usize) + guest_tls_len / 2) & !0xfusize;
        write_hex("loader_shim: guest_tls_base=", guest_tls as Word);
        write_hex("loader_shim: guest_tls_len=", guest_tls_len as Word);
        write_hex("loader_shim: setting TPIDR_EL0=", guest_tp as Word);
        write_tpidr_el0(guest_tp as u64);
    } else {
        write_str("loader_shim: guest TLS mmap failed, keeping host TPIDR_EL0\n");
    }

    asm!(
        "mov sp, {stack}",
        // Mimic the kernel's initial register state as closely as possible.
        // (proot-rs only clears x0; relying on x1/x2 values is not ABI-stable.)
        "mov x0, #0",
        "br {entry}",
        stack = in(reg) sp as usize,
        entry = in(reg) ientry as usize,
        options(noreturn)
    );
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    unsafe { sys_exit(182) }
}

// When this binary is built with `panic=unwind` (e.g. via `cargo test` profile),
// `core` may still reference the Rust EH personality. We never unwind (panic handler exits),
// so a stub is sufficient to satisfy the linker.
#[unsafe(no_mangle)]
pub extern "C" fn rust_eh_personality() {}

// `core` may emit calls to these even when you don't call them directly.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn memset(mut dst: *mut u8, c: i32, mut n: usize) -> *mut u8 {
    let ret = dst;
    let byte = c as u8;
    while n != 0 {
        dst.write(byte);
        dst = dst.add(1);
        n -= 1;
    }
    ret
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn memcpy(mut dst: *mut u8, mut src: *const u8, mut n: usize) -> *mut u8 {
    let ret = dst;
    while n != 0 {
        dst.write(src.read());
        dst = dst.add(1);
        src = src.add(1);
        n -= 1;
    }
    ret
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn memmove(dst: *mut u8, src: *const u8, n: usize) -> *mut u8 {
    let ret = dst;
    if (dst as usize) == (src as usize) || n == 0 {
        return ret;
    }
    if (dst as usize) < (src as usize) {
        memcpy(dst, src, n)
    } else {
        // Copy backwards.
        let mut i = n;
        while i != 0 {
            i -= 1;
            dst.add(i).write(src.add(i).read());
        }
        ret
    }
}
