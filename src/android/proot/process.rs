use crate::android::utils::application_context::get_application_context;
use crate::core::config;
use std::ffi::CString;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::os::raw::{c_char, c_int};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::sync::Arc;
use winit::platform::android::activity::AndroidApp;

pub type Log = Arc<dyn Fn(String) + Send + Sync>;

const SUPPORT_CHECK_BINARY: &str = "ld-linux-aarch64.so.1";
/// Marker file in the app data directory: the support probe passed for the build named inside.
const SUPPORT_STAMP: &str = ".proot-support-ok";

extern "C" {
    fn __system_property_get(name: *const c_char, value: *mut c_char) -> c_int;
}

/// Value of an Android system property, empty when unset.
fn system_property(name: &str) -> String {
    const PROP_VALUE_MAX: usize = 92;
    let Ok(name) = CString::new(name) else {
        return String::new();
    };
    let mut value = [0 as c_char; PROP_VALUE_MAX];
    // SAFETY: `name` is NUL-terminated and `value` has the PROP_VALUE_MAX bytes bionic requires.
    let len = unsafe { __system_property_get(name.as_ptr(), value.as_mut_ptr()) };
    if len <= 0 {
        return String::new();
    }
    let bytes: Vec<u8> = value[..(len as usize).min(PROP_VALUE_MAX - 1)]
        .iter()
        .map(|&b| b as u8)
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Identifies what the support probe result depends on: this app version, its native libraries
/// (proot) and the Android build (SELinux policy, kernel).
fn support_stamp_key() -> String {
    let context = get_application_context();
    format!(
        "{}|{}|{}|{}",
        config::VERSION,
        context.native_library_dir.display(),
        system_property("ro.build.fingerprint"),
        system_property("ro.build.version.sdk"),
    )
}

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
    /// Makes sure the probe binary exists in the data directory. The asset is only written when
    /// the file on disk differs (it is about 200 KB and the same on every launch).
    fn ensure_support_probe_rootfs(android_app: &AndroidApp) -> Option<()> {
        let context = get_application_context();
        let probe_exec = context.data_dir.join(SUPPORT_CHECK_BINARY);

        let asset_name = CString::new(SUPPORT_CHECK_BINARY).ok()?;
        let mut asset = android_app.asset_manager().open(&asset_name)?;

        let mut bytes = Vec::with_capacity(asset.length());
        asset.read_to_end(&mut bytes).ok()?;

        let unchanged = fs::read(&probe_exec).map_or(false, |existing| existing == bytes)
            && fs::metadata(&probe_exec)
                .map_or(false, |meta| meta.permissions().mode() & 0o111 == 0o111);
        if !unchanged {
            fs::write(&probe_exec, bytes).ok()?;
            fs::set_permissions(&probe_exec, fs::Permissions::from_mode(0o755)).ok()?;
        }

        Some(())
    }

    fn try_proot_probe(rootfs: &Path, guest_program: &str, args: &[&str]) -> bool {
        let context = get_application_context();
        let proot_loader = context.native_library_dir.join("libproot_loader.so");

        let mut process = Command::new(context.native_library_dir.join("libproot.so"));
        process
            .env("PROOT_LOADER", &proot_loader)
            .env("PROOT_TMP_DIR", &context.data_dir);

        process
            .arg("-r")
            .arg(rootfs)
            .arg("-w")
            .arg("/")
            .arg(guest_program)
            .args(args)
            .output()
            .map(|o| {
                log::info!(
                    "try_proot_probe rootfs={}, program={}, status={:?}, stdout: {}, stderr: {}",
                    rootfs.display(),
                    guest_program,
                    o.status.code(),
                    String::from_utf8_lossy(&o.stdout),
                    String::from_utf8_lossy(&o.stderr)
                );
                o.status.success()
            })
            .unwrap_or_else(|e| {
                log::info!(
                    "try_proot_probe rootfs={}, program={} error: {}",
                    rootfs.display(),
                    guest_program,
                    e
                );
                false
            })
    }

    /// Whether proot works on this device. A passing probe is remembered per app build and
    /// Android build, so normal launches skip the extra proot process.
    pub fn is_supported(android_app: &AndroidApp) -> bool {
        let context = get_application_context();
        let stamp_path = context.data_dir.join(SUPPORT_STAMP);
        let stamp_key = support_stamp_key();
        if fs::read_to_string(&stamp_path).map_or(false, |stamp| stamp == stamp_key) {
            log::info!("PRoot support probe skipped: it already passed for this build");
            return true;
        }

        let supported = if Self::ensure_support_probe_rootfs(android_app).is_some() {
            Self::try_proot_probe(
                &context.data_dir,
                &format!("/{}", SUPPORT_CHECK_BINARY),
                &["--help"],
            )
        } else {
            log::info!("Support probe asset missing or could not be extracted");
            false
        };

        if supported {
            if let Err(error) = fs::write(&stamp_path, &stamp_key) {
                log::warn!("Could not record the PRoot support probe result: {error}");
            }
        } else {
            let _ = fs::remove_file(&stamp_path);
            log::error!("⚡️ Device Unsupported");
        }
        supported
    }

    pub fn run(self) -> Output {
        self.run_tracked(|_| {})
    }

    /// Like `run`, and calls `on_spawn` with the pid of the proot process as soon as it exists
    /// (before the command finishes), so callers can tell whether the session is still alive.
    pub fn run_tracked(self, on_spawn: impl FnOnce(u32)) -> Output {
        let context = get_application_context();
        let user = self.user.as_deref().unwrap_or("root");

        let mut process = Command::new(context.native_library_dir.join("libproot.so"));
        process
            .env(
                "PROOT_LOADER",
                context.native_library_dir.join("libproot_loader.so"),
            )
            .env("PROOT_TMP_DIR", context.data_dir);

        process
            .arg("-r")
            .arg(config::ARCH_FS_ROOT)
            .arg("-L")
            .arg("--link2symlink")
            .arg("--sysvipc")
            .arg("--kill-on-exit")
            .arg("--root-id")
            // /dev/kgsl-3d0 and /dev/dma_heap/* (the opt-in GPU path) are reachable through this
            // bind, so no extra bind is needed for them.
            .arg("--bind=/dev")
            .arg("--bind=/proc")
            .arg("--bind=/sys")
            .arg(format!("--bind={}/tmp:/dev/shm", config::ARCH_FS_ROOT))
            // /dev/pts and /dev/ptmx are already covered by --bind=/dev above.
            // The explicit sub-binds added in commit 61d9079 were redundant and caused
            // proot to double-translate PTY ioctls (TIOCGPTN/TIOCSPTLCK/TIOCSWINSZ),
            // breaking terminal initialisation and keyboard arrow keys inside QTerminal.
            // We only need /dev/tty explicitly for processes that open it by path.
            .arg("--bind=/dev/tty:/dev/tty");

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
            .arg("TERM=xterm-256color")
            .arg("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/games:/usr/games:/system/bin:/system/xbin")
            .arg("TMPDIR=/tmp")
            .arg(format!("USER={}", user))
            .arg(format!("LOGNAME={}", user));

        // user shell
        if user == "root" {
            process.arg("sh");
        } else {
            process
                .arg("runuser")
                .arg("--pty")
                .arg("-u")
                .arg(user)
                .arg("--")
                .arg("sh");
        }

        process.arg("-c").arg(&self.command);

        if let Some(log) = self.log {
            let mut child = process
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .expect("Failed to run command");
            on_spawn(child.id());

            // Split on bytes: guest output is not guaranteed to be valid UTF-8 and must not
            // be able to take the reader (and with it the whole session thread) down.
            let reader = BufReader::new(child.stdout.take().unwrap());
            for line in reader.split(b'\n').map_while(Result::ok) {
                log(String::from_utf8_lossy(&line).into_owned());
            }

            child
                .wait_with_output()
                .expect("Failed to wait for command")
        } else {
            let child = process
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("Failed to run command");
            on_spawn(child.id());
            child
                .wait_with_output()
                .expect("Failed to run command")
        }
    }
}
