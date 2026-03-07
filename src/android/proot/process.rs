use crate::android::utils::application_context::get_application_context;
use crate::core::{config, logging::PolarBearExpectation};
use std::io::BufRead;
use std::io::BufReader;
use std::process::{Command, ExitStatus, Output, Stdio};
use std::sync::{Arc, OnceLock};

static USE_NO_SECCOMP: OnceLock<bool> = OnceLock::new();

pub type Log = Arc<dyn Fn(String) + Send + Sync>;

/// Runs a shell command inside the Arch Linux PRoot environment.
///
/// - `command`: The shell command to execute (passed to `sh -c`).
/// - `user`: The user to run as. Defaults to `"root"` when `None`.
/// - `log`: Optional stdout line callback. When set, stdout is streamed line-by-line
///   to the callback. When `None`, stdout/stderr are captured.
pub struct ArchProcess {
    pub command: String,
    pub user: Option<String>,
    pub log: Option<Log>,
}

impl ArchProcess {
    fn probe_proot(no_seccomp: bool) -> bool {
        let context = get_application_context();
        let proot_loader = context.native_library_dir.join("libproot_loader.so");

        let mut process = Command::new(context.native_library_dir.join("libproot.so"));
        process
            .env("PROOT_LOADER", &proot_loader)
            .env("PROOT_TMP_DIR", &context.data_dir);

        if no_seccomp {
            process.env("PROOT_NO_SECCOMP", "1");
        }

        process
            .arg("-V")
            .output()
            .map(|o| {
                log::info!(
                    "probe_proot(no_seccomp={}) {:?}, stdout: {}, stderr: {}",
                    no_seccomp,
                    o.status.code(),
                    String::from_utf8_lossy(&o.stdout),
                    String::from_utf8_lossy(&o.stderr)
                );
                o.status.success()
            })
            .unwrap_or_else(|e| {
                log::info!("probe_proot(no_seccomp={}) error: {}", no_seccomp, e);
                false
            })
    }

    pub fn is_supported() -> bool {
        // Try with seccomp first (default), fall back to PROOT_NO_SECCOMP=1
        let supported = if Self::probe_proot(false) {
            USE_NO_SECCOMP.set(false).ok();
            log::info!("PRoot works with seccomp filter enabled");
            true
        } else if Self::probe_proot(true) {
            USE_NO_SECCOMP.set(true).ok();
            log::info!("PRoot works with PROOT_NO_SECCOMP=1");
            true
        } else {
            USE_NO_SECCOMP.set(false).ok();
            false
        };

        if !supported {
            log::error!("⚡️ Device Unsupported");
        }
        supported
    }

    pub fn run(self) -> Output {
        let context = get_application_context();
        let user = self.user.as_deref().unwrap_or("root");

        let mut process = Command::new(context.native_library_dir.join("libproot.so"));
        process
            .env("PROOT_LOADER", context.native_library_dir.join("libproot_loader.so"))
            .env("PROOT_TMP_DIR", context.data_dir);

        if *USE_NO_SECCOMP.get().unwrap_or(&false) {
            process.env("PROOT_NO_SECCOMP", "1");
        }

        process
            .arg("-r")
            .arg(config::ARCH_FS_ROOT)
            .arg("-L")
            .arg("--link2symlink")
            .arg("--sysvipc")
            .arg("--kill-on-exit")
            .arg("--root-id")
            .arg("--bind=/dev")
            .arg("--bind=/proc")
            .arg("--bind=/sys")
            .arg(format!("--bind={}/tmp:/dev/shm", config::ARCH_FS_ROOT));

        if context.permission_all_files_access {
            process
                .arg("--bind=/sdcard:/android")
                .arg("--bind=/sdcard:/root/Android");
        }

        process
            .arg("--bind=/dev/urandom:/dev/random")
            .arg("--bind=/proc/self/fd:/dev/fd")
            .arg("--bind=/proc/self/fd/0:/dev/stdin")
            .arg("--bind=/proc/self/fd/1:/dev/stdout")
            .arg("--bind=/proc/self/fd/2:/dev/stderr")
            .arg(format!("--bind={}/proc/.loadavg:/proc/loadavg", config::ARCH_FS_ROOT))
            .arg(format!("--bind={}/proc/.stat:/proc/stat", config::ARCH_FS_ROOT))
            .arg(format!("--bind={}/proc/.uptime:/proc/uptime", config::ARCH_FS_ROOT))
            .arg(format!("--bind={}/proc/.version:/proc/version", config::ARCH_FS_ROOT))
            .arg(format!("--bind={}/proc/.vmstat:/proc/vmstat", config::ARCH_FS_ROOT))
            .arg(format!("--bind={}/proc/.sysctl_entry_cap_last_cap:/proc/sys/kernel/cap_last_cap", config::ARCH_FS_ROOT))
            .arg(format!("--bind={}/proc/.sysctl_inotify_max_user_watches:/proc/sys/fs/inotify/max_user_watches", config::ARCH_FS_ROOT))
            .arg(format!("--bind={}/sys/.empty:/sys/fs/selinux", config::ARCH_FS_ROOT));

        // env vars
        process.arg("/usr/bin/env").arg("-i");
        if user == "root" {
            process.arg("HOME=/root");
        } else {
            process.arg(format!("HOME=/home/{}", user));
        }
        process
            .arg("LANG=C.UTF-8")
            .arg("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/games:/usr/games:/system/bin:/system/xbin")
            .arg("TMPDIR=/tmp")
            .arg(format!("USER={}", user))
            .arg(format!("LOGNAME={}", user));

        // user shell
        if user == "root" {
            process.arg("sh");
        } else {
            process.arg("runuser").arg("-u").arg(user).arg("--").arg("sh");
        }

        process.arg("-c").arg(&self.command);

        if let Some(log) = self.log {
            let mut child = process
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .pb_expect("Failed to run command");

            let reader = BufReader::new(child.stdout.take().unwrap());
            for line in reader.lines() {
                let line = line.unwrap();
                log(line);
            }

            child.wait_with_output().pb_expect("Failed to wait for command")
        } else {
            process
                .output()
                .pb_expect("Failed to run command")
        }
    }
}
