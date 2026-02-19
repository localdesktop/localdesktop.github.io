use super::ptrace;
use crate::android::utils::application_context::get_application_context;
use crate::core::config;
use std::{
    fs,
    fs::File,
    path::Path,
    process::{Command, Stdio},
};

pub type Log = Box<dyn Fn(String)>;

pub struct ArchProcess {
    pub command: String,
    pub user: Option<String>,
    pub log: Option<Log>,
}

impl ArchProcess {
    /// Runs the process inside the proot environment.
    /// Returns the raw exit code from the tracee (0 means success).
    pub fn run_code(self) -> i32 {
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
        populate_core_db_from_local_mirror(Path::new(&rootfs));

        let mut process = Command::new("/usr/bin/env");
        process.arg("-i");

        let user = self.user.unwrap_or("root".to_string());
        let home = if user == "root" {
            "HOME=/root".to_string()
        } else {
            format!("HOME=/home/{}", user)
        };
        process.arg(home);

        process
            .arg("LANG=C.UTF-8")
            .arg("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/games:/usr/games:/system/bin:/system/xbin")
            .arg("TMPDIR=/tmp")
            .arg(format!("USER={}", user))
            .arg(format!("LOGNAME={}", user));

        if user == "root" {
            process.arg("sh");
        } else {
            process
                .arg("runuser")
                .arg("-u")
                .arg(&user)
                .arg("--")
                .arg("sh");
        }

        process
            .arg("-c")
            .arg(&self.command)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        log::info!("Running command in arch rootless-chroot: {}", &self.command);
        log::info!("As user: {}", &user);
        log::info!("With binds: {:?}", &binds);

        // Prefer an explicit shim path if provided (useful for tests/dev runs where the shim
        // isn't packaged as `librootless_chroot_loader.so` in the app's native library dir).
        //
        // For unit tests, prefer the checked-in shim under `assets/` so `cargo test` works
        // without requiring a prior build step.
        let shim_exe = std::env::var_os("PTRACE_PLAYGROUND_SHIM")
            .or_else(|| {
                if cfg!(test) {
                    let p = std::path::Path::new("assets/libs/arm64-v8a/librootless_chroot_loader.so");
                    if p.exists() {
                        return Some(p.as_os_str().to_os_string());
                    }
                }
                None
            })
            .or_else(|| {
                let p = context.native_library_dir.join("librootless_chroot_loader.so");
                if p.exists() {
                    Some(p.into_os_string())
                } else {
                    None
                }
            });

        let log = self.log.map(|l| Box::new(move |s: String| l(s)) as Box<dyn FnMut(String)>);

        let code = ptrace::rootless_chroot(ptrace::Args {
            command: process,
            rootfs,
            binds,
            shim_exe,
            log,
        });
        code
    }

    /// Runs the process inside the proot environment.
    /// Returns true if the process exited with code 0, false otherwise.
    pub fn run(self) -> bool {
        self.run_code() == 0
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
    cmd.env("PTRACE_PLAYGROUND_FAKE_ROOT", "1");

        ptrace::rootless_chroot(ptrace::Args {
            command: cmd,
            rootfs: rootfs.clone(),
            binds: default_binds(&rootfs),
            shim_exe: Some(shim),
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
            ["-Qg", "lxqt"].as_slice(),
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
}
