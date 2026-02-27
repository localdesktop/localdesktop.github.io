use super::ptrace;
use crate::android::utils::application_context::get_application_context;
use crate::core::config;
use std::{
    ffi::OsString,
    fs,
    fs::File,
    io::{BufRead, BufReader},
    os::unix::{fs::symlink, process::ExitStatusExt},
    path::Path,
    process::{Command, Stdio},
    sync::Arc,
    thread,
};

pub type Log = Arc<dyn Fn(String) + Send + Sync>;

pub struct ArchProcess {
    pub command: String,
    pub user: Option<String>,
    pub log: Option<Log>,
}

impl ArchProcess {
    /// Runs the process inside the proot environment.
    /// Returns the raw exit code from the tracee (0 means success).
    pub fn run_code(self) -> i32 {
        let Self { command, user, log } = self;
        // In unit tests we often have a rootfs checked into the repo at `./archfs`.
        // Prefer it automatically so `cargo test` can run locally without writing to
        // `/data/local/tmp`.
        let rootfs = if cfg!(test) {
            let p = std::path::Path::new("archfs/usr/bin/pacman");
            if p.exists() {
                "archfs".to_string()
            } else {
                config::ARCH_FS_ROOT.to_string()
            }
        } else {
            config::ARCH_FS_ROOT.to_string()
        };

        let mut binds: Vec<(String, String)> = Vec::new();
        binds.push(("/dev".to_string(), "/dev".to_string()));
        binds.push(("/proc".to_string(), "/proc".to_string()));
        binds.push(("/sys".to_string(), "/sys".to_string()));
        binds.push((
            format!("{}/tmp", rootfs),
            "/dev/shm".to_string(),
        ));

        let context = get_application_context();
        if context.permission_all_files_access {
            binds.push(("/sdcard".to_string(), "/android".to_string()));
            binds.push(("/sdcard".to_string(), "/root/Android".to_string()));
        }

        binds.push(("/dev/urandom".to_string(), "/dev/random".to_string()));
        binds.push(("/proc/self/fd".to_string(), "/dev/fd".to_string()));
        binds.push(("/proc/self/fd/0".to_string(), "/dev/stdin".to_string()));
        binds.push(("/proc/self/fd/1".to_string(), "/dev/stdout".to_string()));
        binds.push(("/proc/self/fd/2".to_string(), "/dev/stderr".to_string()));
        // These "fake proc/sys" files are created during Android app setup.
        // For local dev/tests using a plain extracted rootfs, they may not exist; don't bind
        // missing sources (fall back to the host /proc,/sys bind instead).
        let push_if_exists = |binds: &mut Vec<(String, String)>, host: String, guest: &str| {
            if std::path::Path::new(&host).exists() {
                binds.push((host, guest.to_string()));
            }
        };
        push_if_exists(&mut binds, format!("{}/proc/.loadavg", rootfs), "/proc/loadavg");
        push_if_exists(&mut binds, format!("{}/proc/.stat", rootfs), "/proc/stat");
        push_if_exists(&mut binds, format!("{}/proc/.uptime", rootfs), "/proc/uptime");
        push_if_exists(&mut binds, format!("{}/proc/.version", rootfs), "/proc/version");
        push_if_exists(&mut binds, format!("{}/proc/.vmstat", rootfs), "/proc/vmstat");
        push_if_exists(
            &mut binds,
            format!("{}/proc/.sysctl_entry_cap_last_cap", rootfs),
            "/proc/sys/kernel/cap_last_cap",
        );
        push_if_exists(
            &mut binds,
            format!("{}/proc/.sysctl_inotify_max_user_watches", rootfs),
            "/proc/sys/fs/inotify/max_user_watches",
        );
        push_if_exists(&mut binds, format!("{}/sys/.empty", rootfs), "/sys/fs/selinux");

        ensure_archfs_ready(Path::new(&rootfs));
        ensure_resolv_conf(Path::new(&rootfs));
        ensure_pacman_conf_compat(Path::new(&rootfs));
        ensure_mtab_compat(Path::new(&rootfs));
        ensure_mirrorlist_compat(Path::new(&rootfs));
        populate_core_db_from_local_mirror(Path::new(&rootfs));

        let user = user.unwrap_or("root".to_string());
        let rootless_command = strip_stdbuf_wrapper(&command);
        if rootless_command != command {
            log::info!(
                "rootless-chroot: stripped stdbuf wrapper for compatibility: {} -> {}",
                &command,
                &rootless_command
            );
        }
        log::info!("Running command in arch rootless-chroot: {}", &rootless_command);
        log::info!("As user: {}", &user);
        log::info!("With binds: {:?}", &binds);

        // Prefer an explicit shim path if provided (useful for tests/dev runs where the shim
        // isn't packaged as `librootless_chroot_loader.so` in the app's native library dir).
        //
        // For unit tests, prefer the checked-in shim under `assets/` so `cargo test` works
        // without requiring a prior build step.
        let shim_exe = if cfg!(test) {
            let p = std::path::Path::new("assets/libs/arm64-v8a/librootless_chroot_loader.so");
            if p.exists() {
                p.as_os_str().to_os_string()
            } else {
                panic!("missing loader shim at {}", p.display())
            }
        } else {
            let p = context.native_library_dir.join("librootless_chroot_loader.so");
            if p.exists() {
                p.into_os_string()
            } else {
                panic!("missing loader shim at {}", p.display())
            }
        };

        let mode = arch_runner_mode();
        if mode == ArchRunnerMode::Proot {
            return run_with_proot(&command, &user, &rootfs, &binds, log.as_ref());
        }

        let rootless_code = ptrace::rootless_chroot(ptrace::Args {
            command: build_guest_shell_command(&rootless_command, &user),
            rootfs: rootfs.clone(),
            binds: binds.clone(),
            emulate_root_identity: user == "root",
            emulate_sigsys: true,
            shim_exe,
            log: rootless_log_sink(log.as_ref()),
        });

        match mode {
            ArchRunnerMode::Rootless => rootless_code,
            ArchRunnerMode::Proot => unreachable!("handled above"),
            ArchRunnerMode::Auto if rootless_code == 139 => {
                log::warn!(
                    "rootless-chroot exited 139 (SIGSEGV) for command; retrying with proot: {}",
                    &command
                );
                run_with_proot(&command, &user, &rootfs, &binds, log.as_ref())
            }
            ArchRunnerMode::Auto => rootless_code,
        }
    }

    /// Runs the process inside the proot environment.
    /// Returns true if the process exited with code 0, false otherwise.
    pub fn run(self) -> bool {
        self.run_code() == 0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ArchRunnerMode {
    Auto,
    Rootless,
    Proot,
}

fn arch_runner_mode() -> ArchRunnerMode {
    match std::env::var("LOCALDESKTOP_ARCH_RUNNER")
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "rootless" | "rootless-chroot" => ArchRunnerMode::Rootless,
        "proot" => ArchRunnerMode::Proot,
        _ => ArchRunnerMode::Auto,
    }
}

fn rootless_log_sink(log: Option<&Log>) -> Option<Box<dyn FnMut(String)>> {
    log.cloned()
        .map(|cb| {
            Box::new(move |s: String| {
                log::info!("{s}");
                cb(s);
            }) as Box<dyn FnMut(String)>
        })
}

fn build_guest_shell_command(command: &str, user: &str) -> Command {
    let mut process = if user == "root" {
        Command::new("/bin/sh")
    } else {
        let mut p = Command::new("/usr/bin/runuser");
        p.arg("-u").arg(user).arg("--").arg("sh");
        p
    };
    process.env_clear();

    if user == "root" {
        process.env("HOME", "/root");
    } else {
        process.env("HOME", format!("/home/{}", user));
    }

    process
        .env("LANG", "C.UTF-8")
        .env(
            "PATH",
            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/games:/usr/games:/system/bin:/system/xbin",
        )
        .env("TMPDIR", "/tmp")
        .env("USER", user)
        .env("LOGNAME", user);

    process
        .arg("-c")
        .arg(command)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    process
}

fn run_with_proot(
    command: &str,
    user: &str,
    rootfs: &str,
    binds: &[(String, String)],
    log: Option<&Log>,
) -> i32 {
    let context = get_application_context();
    let proot_exe = context.native_library_dir.join("libproot.so");
    let proot_loader = context.native_library_dir.join("libproot_loader.so");
    let proot_tmp_dir = context.cache_dir.join("proot-tmp");
    let _ = fs::create_dir_all(&proot_tmp_dir);

    let proot_command = strip_stdbuf_wrapper(command);
    if proot_command != command {
        log::info!(
            "proot fallback: stripped stdbuf wrapper for compatibility: {} -> {}",
            command,
            proot_command
        );
    }

    log::info!("Running command in arch proot: {}", proot_command);
    log::info!("As user (proot): {}", user);
    log::info!("With binds (proot): {:?}", binds);

    let mut proot = Command::new(&proot_exe);
    proot
        .env("PROOT_LOADER", &proot_loader)
        .env("PROOT_TMP_DIR", &proot_tmp_dir)
        .arg("-0")
        .arg("-r")
        .arg(rootfs)
        .arg("-w")
        .arg("/");

    for (host, guest) in binds {
        proot.arg("-b");
        if host == guest {
            proot.arg(host);
        } else {
            let mut bind = OsString::from(host);
            bind.push(":");
            bind.push(guest);
            proot.arg(bind);
        }
    }

    let guest_cmd = build_guest_shell_command(proot_command, user);
    proot.arg("/usr/bin/env");
    proot.args(guest_cmd.get_args());
    proot.stdin(Stdio::null());
    run_host_command_streaming(proot, log)
}

fn strip_stdbuf_wrapper(command: &str) -> &str {
    command.strip_prefix("stdbuf -oL ").unwrap_or(command)
}

fn run_host_command_streaming(mut command: Command, log: Option<&Log>) -> i32 {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .unwrap_or_else(|e| panic!("failed to spawn process {:?}: {e}", command));

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let log_cb = log.cloned();

    let t_out = stdout.map(|pipe| {
        let log_cb = log_cb.clone();
        thread::spawn(move || stream_lines(pipe, log_cb))
    });
    let t_err = stderr.map(|pipe| thread::spawn(move || stream_lines(pipe, log_cb)));

    let status = child.wait().expect("failed waiting for child process");
    if let Some(t) = t_out {
        let _ = t.join();
    }
    if let Some(t) = t_err {
        let _ = t.join();
    }

    if let Some(code) = status.code() {
        code
    } else if let Some(sig) = status.signal() {
        128 + sig
    } else {
        1
    }
}

fn stream_lines<R: std::io::Read>(reader: R, log: Option<Log>) {
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) => break,
            Ok(_) => {
                let msg = String::from_utf8_lossy(&line)
                    .trim_end_matches(['\r', '\n'])
                    .to_string();
                if msg.is_empty() {
                    continue;
                }
                if let Some(cb) = &log {
                    cb(msg);
                } else {
                    log::info!("{}", msg);
                }
            }
            Err(e) => {
                log::warn!("failed reading child output: {e}");
                break;
            }
        }
    }
}

fn ensure_archfs_ready(rootfs_dir: &Path) {
    let archive_path = rootfs_dir.join("ArchLinuxARM-aarch64-latest.tar.gz");
    let url = "http://os.archlinuxarm.org/os/ArchLinuxARM-aarch64-latest.tar.gz";

    fs::create_dir_all(rootfs_dir).unwrap();
    if !rootfs_dir.join("usr/bin/pacman").exists() {
        if !archive_path.exists() {
            download_arch_rootfs(url, &archive_path);
        }
        extract_rootfs(&archive_path, rootfs_dir);
    }
}

fn ensure_resolv_conf(rootfs_dir: &Path) {
    let etc = rootfs_dir.join("etc");
    fs::create_dir_all(&etc).unwrap();
    let resolv = etc.join("resolv.conf");
    if let Ok(meta) = fs::symlink_metadata(&resolv) {
        if meta.file_type().is_symlink() {
            let _ = fs::remove_file(&resolv);
        }
    }
    if !resolv.exists() {
        fs::write(&resolv, "nameserver 1.1.1.1\nnameserver 8.8.8.8\n").unwrap();
    }
}

fn ensure_pacman_conf_compat(rootfs_dir: &Path) {
    let path = rootfs_dir.join("etc/pacman.conf");
    let Ok(content) = fs::read_to_string(&path) else {
        return;
    };
    let mut changed = false;
    let mut out = String::with_capacity(content.len() + 32);
    for line in content.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("DownloadUser") {
            if !trimmed.starts_with('#') {
                out.push_str("# ");
                out.push_str(line);
                out.push('\n');
                changed = true;
                continue;
            }
        }
        out.push_str(line);
        out.push('\n');
    }
    if changed {
        let _ = fs::write(&path, out);
    }
}

fn ensure_mtab_compat(rootfs_dir: &Path) {
    let etc = rootfs_dir.join("etc");
    let _ = fs::create_dir_all(&etc);
    let mtab = etc.join("mtab");
    if let Ok(meta) = fs::symlink_metadata(&mtab) {
        if meta.file_type().is_symlink() {
            if let Ok(target) = fs::read_link(&mtab) {
                if target == Path::new("/proc/mounts") {
                    return;
                }
            }
        }
        let _ = fs::remove_file(&mtab);
    }
    let _ = symlink("/proc/mounts", &mtab);
}

fn ensure_mirrorlist_compat(rootfs_dir: &Path) {
    let path = rootfs_dir.join("etc/pacman.d/mirrorlist");
    let _ = fs::create_dir_all(rootfs_dir.join("etc/pacman.d"));
    let content = fs::read_to_string(&path).unwrap_or_default();
    let preferred = [
        "Server = http://fl.us.mirror.archlinuxarm.org/$arch/$repo",
        "Server = http://nj.us.mirror.archlinuxarm.org/$arch/$repo",
        "Server = http://de3.mirror.archlinuxarm.org/$arch/$repo",
        "Server = http://eu.mirror.archlinuxarm.org/$arch/$repo",
        "Server = http://mirror.archlinuxarm.org/$arch/$repo",
    ];
    let marker = "# localdesktop: preferred ArchLinuxARM mirrors";
    let has_server = content
        .lines()
        .any(|line| line.trim_start().starts_with("Server = "));
    if content.trim().is_empty() || !has_server {
        let mut fresh = String::new();
        fresh.push_str(marker);
        fresh.push('\n');
        for line in preferred {
            fresh.push_str(line);
            fresh.push('\n');
        }
        let _ = fs::write(&path, fresh);
        return;
    }

    let mut out = String::new();
    if !content.contains(marker) {
        out.push_str(marker);
        out.push('\n');
        for line in preferred {
            out.push_str(line);
            out.push('\n');
        }
        out.push('\n');
    }

    for line in content.lines() {
        if line.trim() == "Server = http://mirror.archlinuxarm.org/$arch/$repo" {
            out.push_str("# ");
            out.push_str(line);
            out.push('\n');
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }

    let _ = fs::write(&path, out);
}

fn populate_core_db_from_local_mirror(rootfs_dir: &Path) {
    let mirror_core = rootfs_dir.join("local_mirror/core/core.db");
    if mirror_core.exists() {
        let core_dir = rootfs_dir.join("var/lib/pacman/sync");
        fs::create_dir_all(&core_dir).unwrap();
        let core_db = core_dir.join("core.db");
        let mut gzip = Command::new("gzip");
        gzip.arg("-dc").arg(&mirror_core);
        gzip.stdout(File::create(&core_db).unwrap());
        let status = gzip.status().expect("decompress core mirror");
        assert!(
            status.success(),
            "gzip -dc failed to populate core.db from local mirror"
        );
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::android::proot::ptrace;
    use crate::core::config::LocalConfig;
    use std::ffi::OsString;
    use std::process::Command;

    fn shim_path() -> OsString {
        let p = std::path::Path::new("assets/libs/arm64-v8a/librootless_chroot_loader.so");
        assert!(p.exists(), "missing loader shim at {}", p.display());
        p.as_os_str().to_os_string()
    }

    fn rootfs_path() -> String {
        let p = std::path::Path::new("archfs/usr/bin/pacman");
        assert!(
            p.exists(),
            "expected pacman inside rootfs at ./archfs (missing: {})",
            p.display()
        );
        "archfs".to_string()
    }

    fn default_binds(rootfs: &str) -> Vec<(String, String)> {
        let _ = rootfs; // keep signature stable if we expand binds later
        vec![
            ("/dev".to_string(), "/dev".to_string()),
            ("/proc".to_string(), "/proc".to_string()),
            ("/sys".to_string(), "/sys".to_string()),
            ("/dev/urandom".to_string(), "/dev/random".to_string()),
            ("/proc/self/fd".to_string(), "/dev/fd".to_string()),
            ("/proc/self/fd/0".to_string(), "/dev/stdin".to_string()),
            ("/proc/self/fd/1".to_string(), "/dev/stdout".to_string()),
            ("/proc/self/fd/2".to_string(), "/dev/stderr".to_string()),
        ]
    }

fn run_guest(program: &str, args: &[&str]) -> i32 {
    let rootfs = rootfs_path();
    let shim = shim_path();

    let mut cmd = Command::new(program);
    for a in args {
        cmd.arg(a);
    }
    ptrace::rootless_chroot(ptrace::Args {
        command: cmd,
        rootfs: rootfs.clone(),
        binds: default_binds(&rootfs),
        emulate_root_identity: true,
        emulate_sigsys: false,
        shim_exe: shim,
        log: None,
    })
    }

    #[test]
    fn command_check_can_run_pacman() {
        let cfg = LocalConfig::default();
        assert!(
            cfg.command.check.contains("pacman"),
            "default check command should reference pacman"
        );

        let code = run_guest("/usr/bin/pacman", &["-V"]);
        assert_eq!(code, 0, "pacman -V failed (exit code {code})");

        // Smoke-run each pacman check fragment. It can succeed or fail depending on packages,
        // but it must not crash or fail to exec. This exercises reading `/etc/pacman.conf`
        // and included files like `/etc/pacman.d/mirrorlist`.
        let fragments = [
            ["-Q", "lxqt-session"].as_slice(),
            ["-Q", "xorg-xwayland"].as_slice(),
            ["-Q", "lxqt-wayland-session"].as_slice(),
            ["-Q", "labwc"].as_slice(),
            ["-Q", "breeze-icons"].as_slice(),
            ["-Q", "onboard"].as_slice(),
        ];
        for frag in fragments {
            let code = run_guest("/usr/bin/pacman", frag);
            assert!(
                code == 0 || code == 1,
                "unexpected exit code from pacman {:?}: {}",
                frag,
                code
            );
        }
    }

    #[test]
    fn command_install_can_run_pacman() {
        let cfg = LocalConfig::default();
        assert!(
            cfg.command.install.contains("pacman"),
            "default install command should reference pacman"
        );
        assert!(
            cfg.command.install.contains("-S"),
            "default install command should include a pacman -S* operation"
        );

        let code = run_guest("/usr/bin/pacman", &["-Q", "pacman"]);
        assert_eq!(code, 0, "pacman -Q pacman failed (exit code {code})");

        // Ensure pacman can parse sync args used by the install command, without installing.
        let code = run_guest("/usr/bin/pacman", &["-Syu", "--help"]);
        assert_eq!(code, 0, "pacman -Syu --help failed (exit code {code})");
    }

    #[test]
    fn command_install_smoke_runs_package_targets() {
        let cfg = LocalConfig::default();
        assert!(
            cfg.command.install.contains("pacman"),
            "default install command should reference pacman"
        );

        // Mirror command_check style: each query can succeed or fail depending on local state,
        // but should execute cleanly under rootless_chroot.
        let packages = [
            "lxqt-session",
            "xorg-xwayland",
            "lxqt-wayland-session",
            "labwc",
            "breeze-icons",
            "onboard",
        ];
        for pkg in packages {
            let code = run_guest("/usr/bin/pacman", &["-Si", pkg]);
            assert!(
                code == 0 || code == 1,
                "unexpected exit code from pacman -Si {}: {}",
                pkg,
                code
            );
        }
    }
}
