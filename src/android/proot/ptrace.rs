use nix::sys::ptrace;
use nix::sys::ptrace::Options;
use nix::sys::signal::Signal;
use nix::sys::wait::{waitpid, WaitStatus};
use nix::unistd::Pid;
use nix::errno::Errno;
use nix::libc;
use std::fs;
use std::io;
use std::os::unix::process::CommandExt;
use std::process::{Child, ChildStderr, ChildStdout, Command};
use std::mem;
use std::thread;

pub struct Args {
    pub command: String,
    pub binds: Vec<(String, String)>,
}

pub struct TracedChild {
    child: Child,
    wait_handle: thread::JoinHandle<io::Result<i32>>,
}

impl TracedChild {
    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }

    pub fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.child.stderr.take()
    }

    pub fn wait(self) -> io::Result<i32> {
        self.wait_handle
            .join()
            .map_err(|_| io::Error::new(io::ErrorKind::Other, "ptrace wait thread panicked"))?
    }
}

fn nix_to_io(error: nix::Error) -> io::Error {
    io::Error::new(io::ErrorKind::Other, error)
}

const MAX_PATH: usize = 4096;

#[cfg(target_arch = "aarch64")]
const NT_PRSTATUS: libc::c_int = 1;

#[cfg(target_arch = "aarch64")]
fn get_regs(pid: Pid) -> nix::Result<libc::user_regs_struct> {
    let mut regs = mem::MaybeUninit::<libc::user_regs_struct>::uninit();
    let mut iov = libc::iovec {
        iov_base: regs.as_mut_ptr().cast(),
        iov_len: mem::size_of::<libc::user_regs_struct>(),
    };
    let res = unsafe {
        libc::ptrace(
            libc::PTRACE_GETREGSET,
            libc::pid_t::from(pid),
            NT_PRSTATUS as *mut libc::c_void,
            &mut iov as *mut libc::iovec as *mut libc::c_void,
        )
    };
    Errno::result(res).map(|_| unsafe { regs.assume_init() })
}

#[cfg(target_arch = "x86_64")]
fn get_regs(pid: Pid) -> nix::Result<libc::user_regs_struct> {
    let mut regs = mem::MaybeUninit::<libc::user_regs_struct>::uninit();
    let res = unsafe {
        libc::ptrace(
            libc::PTRACE_GETREGS,
            libc::pid_t::from(pid),
            std::ptr::null_mut::<libc::c_void>(),
            regs.as_mut_ptr().cast(),
        )
    };
    Errno::result(res).map(|_| unsafe { regs.assume_init() })
}

#[cfg(target_arch = "aarch64")]
fn set_regs(pid: Pid, regs: libc::user_regs_struct) -> nix::Result<()> {
    let mut regs = regs;
    let mut iov = libc::iovec {
        iov_base: (&mut regs as *mut libc::user_regs_struct).cast(),
        iov_len: mem::size_of::<libc::user_regs_struct>(),
    };
    let res = unsafe {
        libc::ptrace(
            libc::PTRACE_SETREGSET,
            libc::pid_t::from(pid),
            NT_PRSTATUS as *mut libc::c_void,
            &mut iov as *mut libc::iovec as *mut libc::c_void,
        )
    };
    Errno::result(res).map(drop)
}

#[cfg(target_arch = "x86_64")]
fn set_regs(pid: Pid, regs: libc::user_regs_struct) -> nix::Result<()> {
    let res = unsafe {
        libc::ptrace(
            libc::PTRACE_SETREGS,
            libc::pid_t::from(pid),
            std::ptr::null_mut::<libc::c_void>(),
            (&regs as *const libc::user_regs_struct).cast(),
        )
    };
    Errno::result(res).map(drop)
}

#[cfg(target_arch = "aarch64")]
fn syscall_number(regs: &libc::user_regs_struct) -> libc::c_long {
    regs.regs[8] as libc::c_long
}

#[cfg(target_arch = "x86_64")]
fn syscall_number(regs: &libc::user_regs_struct) -> libc::c_long {
    regs.orig_rax as libc::c_long
}

#[cfg(target_arch = "aarch64")]
fn syscall_arg(regs: &libc::user_regs_struct, index: usize) -> usize {
    regs.regs.get(index).copied().unwrap_or(0) as usize
}

#[cfg(target_arch = "x86_64")]
fn syscall_arg(regs: &libc::user_regs_struct, index: usize) -> usize {
    match index {
        0 => regs.rdi as usize,
        1 => regs.rsi as usize,
        2 => regs.rdx as usize,
        3 => regs.r10 as usize,
        4 => regs.r8 as usize,
        5 => regs.r9 as usize,
        _ => 0,
    }
}

#[cfg(target_arch = "aarch64")]
fn set_syscall_arg(regs: &mut libc::user_regs_struct, index: usize, value: usize) {
    if let Some(slot) = regs.regs.get_mut(index) {
        *slot = value as u64;
    }
}

#[cfg(target_arch = "x86_64")]
fn set_syscall_arg(regs: &mut libc::user_regs_struct, index: usize, value: usize) {
    match index {
        0 => regs.rdi = value as libc::c_ulong,
        1 => regs.rsi = value as libc::c_ulong,
        2 => regs.rdx = value as libc::c_ulong,
        3 => regs.r10 = value as libc::c_ulong,
        4 => regs.r8 = value as libc::c_ulong,
        5 => regs.r9 = value as libc::c_ulong,
        _ => {}
    }
}

#[cfg(target_arch = "aarch64")]
fn stack_pointer(regs: &libc::user_regs_struct) -> usize {
    regs.sp as usize
}

#[cfg(target_arch = "x86_64")]
fn stack_pointer(regs: &libc::user_regs_struct) -> usize {
    regs.rsp as usize
}

#[cfg(target_arch = "aarch64")]
fn syscall_path_args(sysno: libc::c_long) -> &'static [usize] {
    const ARGS0: &[usize] = &[0];
    const ARGS1: &[usize] = &[1];
    const ARGS13: &[usize] = &[1, 3];

    match sysno {
        libc::SYS_openat => ARGS1,
        libc::SYS_openat2 => ARGS1,
        libc::SYS_statx => ARGS1,
        libc::SYS_faccessat => ARGS1,
        libc::SYS_faccessat2 => ARGS1,
        libc::SYS_readlinkat => ARGS1,
        libc::SYS_execve => ARGS0,
        libc::SYS_execveat => ARGS1,
        libc::SYS_mkdirat => ARGS1,
        libc::SYS_unlinkat => ARGS1,
        libc::SYS_symlinkat => &[2],
        libc::SYS_linkat => ARGS13,
        libc::SYS_renameat => ARGS13,
        libc::SYS_renameat2 => ARGS13,
        libc::SYS_chdir => ARGS0,
        libc::SYS_chroot => ARGS0,
        _ => &[],
    }
}

#[cfg(target_arch = "x86_64")]
fn syscall_path_args(sysno: libc::c_long) -> &'static [usize] {
    const ARGS0: &[usize] = &[0];
    const ARGS1: &[usize] = &[1];
    const ARGS01: &[usize] = &[0, 1];
    const ARGS13: &[usize] = &[1, 3];

    match sysno {
        libc::SYS_open => ARGS0,
        libc::SYS_openat => ARGS1,
        libc::SYS_openat2 => ARGS1,
        libc::SYS_stat => ARGS0,
        libc::SYS_lstat => ARGS0,
        libc::SYS_newfstatat => ARGS1,
        libc::SYS_statx => ARGS1,
        libc::SYS_access => ARGS0,
        libc::SYS_faccessat => ARGS1,
        libc::SYS_faccessat2 => ARGS1,
        libc::SYS_readlink => ARGS0,
        libc::SYS_readlinkat => ARGS1,
        libc::SYS_execve => ARGS0,
        libc::SYS_execveat => ARGS1,
        libc::SYS_mkdir => ARGS0,
        libc::SYS_mkdirat => ARGS1,
        libc::SYS_unlink => ARGS0,
        libc::SYS_unlinkat => ARGS1,
        libc::SYS_symlink => &[1],
        libc::SYS_symlinkat => &[2],
        libc::SYS_link => ARGS01,
        libc::SYS_linkat => ARGS13,
        libc::SYS_rename => ARGS01,
        libc::SYS_renameat => ARGS13,
        libc::SYS_renameat2 => ARGS13,
        libc::SYS_chdir => ARGS0,
        libc::SYS_chroot => ARGS0,
        _ => &[],
    }
}

#[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
fn syscall_path_args(_sysno: libc::c_long) -> &'static [usize] {
    &[]
}

fn read_c_string(pid: Pid, addr: usize) -> nix::Result<(String, usize)> {
    let word_size = mem::size_of::<libc::c_long>();
    let mut bytes = Vec::new();
    let mut offset = 0usize;

    while offset < MAX_PATH {
        let data = ptrace::read(pid, (addr + offset) as ptrace::AddressType)?;
        let chunk = data.to_ne_bytes();
        for byte in chunk.iter().take(word_size) {
            if *byte == 0 {
                let path = String::from_utf8_lossy(&bytes).to_string();
                return Ok((path, bytes.len()));
            }
            bytes.push(*byte);
            offset += 1;
            if offset >= MAX_PATH {
                break;
            }
        }
    }

    let path = String::from_utf8_lossy(&bytes).to_string();
    Ok((path, bytes.len()))
}

fn write_bytes(pid: Pid, addr: usize, bytes: &[u8]) -> nix::Result<()> {
    let word_size = mem::size_of::<libc::c_long>();
    let mut offset = 0usize;

    while offset < bytes.len() {
        let end = usize::min(offset + word_size, bytes.len());
        let chunk_len = end - offset;
        let mut word = [0u8; 8];
        word[..chunk_len].copy_from_slice(&bytes[offset..end]);
        if chunk_len < word_size {
            let existing = ptrace::read(pid, (addr + offset) as ptrace::AddressType)?;
            let existing_bytes = existing.to_ne_bytes();
            word[chunk_len..word_size].copy_from_slice(&existing_bytes[chunk_len..word_size]);
        }

        let data = if word_size == 8 {
            i64::from_ne_bytes(word)
        } else {
            i32::from_ne_bytes(word[..4].try_into().unwrap()) as i64
        };
        ptrace::write(pid, (addr + offset) as ptrace::AddressType, data as libc::c_long)?;
        offset += word_size;
    }

    Ok(())
}

fn path_suffix<'a>(path: &'a str, guest: &str) -> Option<&'a str> {
    if guest.is_empty() || !path.starts_with(guest) {
        return None;
    }
    if path.len() == guest.len() {
        return Some("");
    }
    if guest.ends_with('/') {
        return Some(&path[guest.len()..]);
    }
    if path.as_bytes().get(guest.len()) == Some(&b'/') {
        return Some(&path[guest.len()..]);
    }
    None
}

fn resolve_bind(path: &str, binds: &[(String, String)]) -> Option<String> {
    let mut best: Option<(&str, &str)> = None;
    let mut best_suffix: &str = "";

    for (host, guest) in binds {
        if let Some(suffix) = path_suffix(path, guest) {
            let take = match best {
                None => true,
                Some((_, best_guest)) => guest.len() > best_guest.len(),
            };
            if take {
                best = Some((host.as_str(), guest.as_str()));
                best_suffix = suffix;
            }
        }
    }

    best.map(|(host, _)| {
        if best_suffix.is_empty() {
            host.to_string()
        } else if host.ends_with('/') || best_suffix.starts_with('/') {
            format!("{}{}", host, best_suffix)
        } else {
            format!("{}/{}", host, best_suffix)
        }
    })
}

fn stack_range(pid: Pid) -> Option<(usize, usize)> {
    let maps = fs::read_to_string(format!("/proc/{}/maps", pid.as_raw())).ok()?;
    for line in maps.lines() {
        if !line.ends_with("[stack]") {
            continue;
        }
        let range = line.split_whitespace().next()?;
        let mut parts = range.split('-');
        let start = usize::from_str_radix(parts.next()?, 16).ok()?;
        let end = usize::from_str_radix(parts.next()?, 16).ok()?;
        return Some((start, end));
    }
    None
}

#[cfg(any(target_arch = "aarch64", target_arch = "x86_64"))]
fn handle_syscall(pid: Pid, binds: &[(String, String)]) -> nix::Result<()> {
    if binds.is_empty() {
        return Ok(());
    }

    let mut regs = get_regs(pid)?;
    let sysno = syscall_number(&regs);
    let args = syscall_path_args(sysno);
    if args.is_empty() {
        return Ok(());
    }

    let mut arg_addrs = Vec::with_capacity(args.len());
    for &arg in args {
        let addr = syscall_arg(&regs, arg);
        if addr != 0 {
            arg_addrs.push((arg, addr));
        }
    }

    if arg_addrs.is_empty() {
        return Ok(());
    }

    let word_size = mem::size_of::<libc::c_long>();
    let mut stack_start = None;
    let mut scratch_cursor = stack_pointer(&regs);
    #[cfg(target_arch = "x86_64")]
    {
        scratch_cursor = scratch_cursor.saturating_sub(128);
    }

    let mut regs_changed = false;

    for (arg_index, addr) in arg_addrs {
        let Ok((path, old_len)) = read_c_string(pid, addr) else {
            continue;
        };
        let Some(new_path) = resolve_bind(&path, binds) else {
            continue;
        };
        if new_path == path {
            continue;
        }

        let old_total = old_len.saturating_add(1);
        let new_total = new_path.len().saturating_add(1);
        let (write_addr, pad_len) = if new_path.len() <= old_len {
            (addr, Some(old_total))
        } else {
            if stack_start.is_none() {
                stack_start = stack_range(pid).map(|(start, _)| start);
            }
            let aligned = (new_total + word_size - 1) & !(word_size - 1);
            let next_addr = match scratch_cursor.checked_sub(aligned) {
                Some(candidate) => candidate,
                None => continue,
            };
            if let Some(start) = stack_start {
                if next_addr < start + word_size {
                    continue;
                }
            }
            scratch_cursor = next_addr;
            (next_addr, None)
        };

        let mut payload = Vec::with_capacity(new_total);
        payload.extend_from_slice(new_path.as_bytes());
        payload.push(0);
        if let Some(pad_len) = pad_len {
            if payload.len() < pad_len {
                payload.resize(pad_len, 0);
            }
        }

        write_bytes(pid, write_addr, &payload)?;
        if write_addr != addr {
            set_syscall_arg(&mut regs, arg_index, write_addr);
            regs_changed = true;
        }
    }

    if regs_changed {
        set_regs(pid, regs)?;
    }

    Ok(())
}

#[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
fn handle_syscall(_pid: Pid, _binds: &[(String, String)]) -> nix::Result<()> {
    Ok(())
}

pub fn spawn_traced(mut command: Command, binds: Vec<(String, String)>) -> io::Result<TracedChild> {
    unsafe {
        command.pre_exec(|| {
            ptrace::traceme().map_err(nix_to_io)?;
            // Pause until the parent sets ptrace options.
            let rc = unsafe { nix::libc::raise(nix::libc::SIGSTOP) };
            if rc != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let child = command.spawn()?;
    let pid = Pid::from_raw(child.id() as i32);

    let wait_handle = thread::spawn(move || trace_loop(pid, binds));

    Ok(TracedChild { child, wait_handle })
}

pub fn launch(args: Args) -> io::Result<i32> {
    let mut command = Command::new("sh");
    command.arg("-c").arg(&args.command);
    let traced = spawn_traced(command, args.binds)?;
    traced.wait()
}

fn trace_loop(pid: Pid, binds: Vec<(String, String)>) -> io::Result<i32> {
    loop {
        match waitpid(pid, None).map_err(nix_to_io)? {
            WaitStatus::Stopped(_, Signal::SIGSTOP) => break,
            WaitStatus::Exited(_, code) => return Ok(code),
            WaitStatus::Signaled(_, sig, _) => return Ok(128 + sig as i32),
            _ => {}
        }
    }

    let options = Options::PTRACE_O_TRACESYSGOOD | Options::PTRACE_O_EXITKILL;
    ptrace::setoptions(pid, options).map_err(nix_to_io)?;
    ptrace::syscall(pid, None).map_err(nix_to_io)?;

    let mut in_syscall = false;
    loop {
        match waitpid(pid, None).map_err(nix_to_io)? {
            WaitStatus::Exited(_, code) => return Ok(code),
            WaitStatus::Signaled(_, sig, _) => return Ok(128 + sig as i32),
            WaitStatus::PtraceSyscall(_) => {
                in_syscall = !in_syscall;
                if in_syscall {
                    handle_syscall(pid, &binds).map_err(nix_to_io)?;
                }
                ptrace::syscall(pid, None).map_err(nix_to_io)?;
            }
            WaitStatus::PtraceEvent(_, _, _) | WaitStatus::Continued(_) => {
                ptrace::syscall(pid, None).map_err(nix_to_io)?;
            }
            WaitStatus::Stopped(_, sig) => {
                let deliver = if sig == Signal::SIGTRAP {
                    None
                } else {
                    Some(sig)
                };
                ptrace::syscall(pid, deliver).map_err(nix_to_io)?;
            }
            WaitStatus::StillAlive => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{launch, path_suffix, resolve_bind, Args};
    use nix::libc;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn launch_exit_code(command: &str, binds: Vec<(String, String)>) -> Option<i32> {
        match launch(Args {
            command: command.to_string(),
            binds,
        }) {
            Ok(code) => Some(code),
            Err(err) => match err.raw_os_error() {
                Some(libc::EPERM | libc::EACCES) => {
                    eprintln!("ptrace blocked ({}); skipping test", err);
                    None
                }
                _ => panic!("launch failed: {err}"),
            },
        }
    }

    #[test]
    fn path_suffix_matches_exact_and_nested() {
        assert_eq!(path_suffix("/guest", "/guest"), Some(""));
        assert_eq!(path_suffix("/guest/app", "/guest"), Some("/app"));
        assert_eq!(path_suffix("/guest/app", "/guest/"), Some("app"));
    }

    #[test]
    fn path_suffix_rejects_non_matches() {
        assert_eq!(path_suffix("/guestroom/app", "/guest"), None);
        assert_eq!(path_suffix("/guest", "/guestroom"), None);
        assert_eq!(path_suffix("/other/app", "/guest"), None);
    }

    #[test]
    fn resolve_bind_prefers_longest_guest_prefix() {
        let binds = vec![
            ("/host".to_string(), "/guest".to_string()),
            ("/host/app".to_string(), "/guest/app".to_string()),
        ];
        let resolved = resolve_bind("/guest/app/bin", &binds);
        assert_eq!(resolved, Some("/host/app/bin".to_string()));
    }

    #[test]
    fn resolve_bind_returns_none_for_no_match() {
        let binds = vec![("/host".to_string(), "/guest".to_string())];
        assert_eq!(resolve_bind("/other/path", &binds), None);
    }

    #[test]
    fn resolve_bind_handles_root_guest() {
        let binds = vec![("/host".to_string(), "/".to_string())];
        let resolved = resolve_bind("/etc/hosts", &binds);
        assert_eq!(resolved, Some("/host/etc/hosts".to_string()));
    }

    #[test]
    #[ignore]
    fn launch_reports_success_exit_code() {
        let Some(code) = launch_exit_code("true", Vec::new()) else {
            return;
        };
        assert_eq!(code, 0);
    }

    #[test]
    #[ignore]
    fn launch_propagates_nonzero_exit_code() {
        let Some(code) = launch_exit_code("exit 42", Vec::new()) else {
            return;
        };
        assert_eq!(code, 42);
    }

    #[test]
    #[ignore]
    fn launch_rewrites_bound_paths() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let mut host_dir = std::env::temp_dir();
        host_dir.push(format!("ld_bind_test_{}_{}", std::process::id(), nanos));
        fs::create_dir_all(&host_dir).unwrap();
        let mut host_file = PathBuf::from(&host_dir);
        host_file.push("hello.txt");
        fs::write(&host_file, b"hello").unwrap();

        let guest_dir = "/__ld_guest_bind_test";
        let command = format!("cat {}/hello.txt > /dev/null", guest_dir);
        let binds = vec![(host_dir.to_string_lossy().to_string(), guest_dir.to_string())];
        let result = launch_exit_code(&command, binds);

        let _ = fs::remove_dir_all(&host_dir);

        let Some(code) = result else {
            return;
        };
        assert_eq!(code, 0);
    }
}
