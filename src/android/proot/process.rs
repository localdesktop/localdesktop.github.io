use crate::android::utils::application_context::get_application_context;
use crate::core::{config, logging::PolarBearExpectation};
use std::fs;
use std::io::BufRead;
use std::io::BufReader;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

pub type Log = Box<dyn Fn(String)>;

const DEFAULT_FAKE_KERNEL_RELEASE: &str = "6.17.0-PRoot-Distro";
const PROOT_FATAL_MARKER: &str = "fatal error: see `libproot.so --help`";
const PROC_LOADAVG_CONTENT: &str = "0.12 0.07 0.02 2/165 765\n";
const PROC_STAT_CONTENT: &str =
    "cpu  1957 0 2877 93280 262 342 254 87 0 0\ncpu0 31 0 226 12027 82 10 4 9 0 0\n";
const PROC_UPTIME_CONTENT: &str = "124.08 932.80\n";
const PROC_VERSION_CONTENT: &str = "Linux version 6.2.1 (proot@termux) (gcc (GCC) 12.2.1 20230201, GNU ld (GNU Binutils) 2.40) #1 SMP PREEMPT_DYNAMIC Wed, 01 Mar 2023 00:00:00 +0000\n";
const PROC_VMSTAT_CONTENT: &str =
    "nr_free_pages 1743136\nnr_zone_inactive_anon 179281\nnr_zone_active_anon 7183\n";
const PROC_CAP_LAST_CAP_CONTENT: &str = "40\n";
const PROC_MAX_USER_WATCHES_CONTENT: &str = "4096\n";

static FORCE_NO_SECCOMP: AtomicBool = AtomicBool::new(false);

pub struct ArchProcess {
    pub command: String,
    pub user: String,
    pub process: Option<Child>,
}

impl ArchProcess {
    fn should_use_no_seccomp() -> bool {
        FORCE_NO_SECCOMP.load(Ordering::Relaxed)
    }

    fn enable_no_seccomp(reason: &str) {
        if !FORCE_NO_SECCOMP.swap(true, Ordering::Relaxed) {
            log::warn!(
                "Enabling PROOT_NO_SECCOMP=1 fallback due to proot ENOSYS failure: {}",
                reason
            );
        }
    }

    pub fn no_seccomp_enabled() -> bool {
        Self::should_use_no_seccomp()
    }

    pub fn enable_no_seccomp_fallback(reason: &str) {
        Self::enable_no_seccomp(reason);
    }

    fn has_proot_fatal_error(stderr: &str) -> bool {
        stderr.contains(PROOT_FATAL_MARKER)
    }

    pub fn is_execve_enosys(stderr: &str) -> bool {
        stderr.contains("proot error: execve(") && stderr.contains("Function not implemented")
    }

    fn log_failure_diagnostics(
        phase: &str,
        command: &str,
        user: &str,
        stderr: &str,
        use_no_seccomp: bool,
    ) {
        let context = get_application_context();
        let bind_sources = vec![
            "/dev".to_string(),
            "/proc".to_string(),
            "/sys".to_string(),
            "/dev/urandom".to_string(),
            "/proc/self/fd".to_string(),
            "/proc/self/fd/0".to_string(),
            "/proc/self/fd/1".to_string(),
            "/proc/self/fd/2".to_string(),
            format!("{}/tmp", config::ARCH_FS_ROOT),
            format!("{}/proc/.loadavg", config::ARCH_FS_ROOT),
            format!("{}/proc/.stat", config::ARCH_FS_ROOT),
            format!("{}/proc/.uptime", config::ARCH_FS_ROOT),
            format!("{}/proc/.version", config::ARCH_FS_ROOT),
            format!("{}/proc/.vmstat", config::ARCH_FS_ROOT),
            format!("{}/proc/.sysctl_entry_cap_last_cap", config::ARCH_FS_ROOT),
            format!(
                "{}/proc/.sysctl_inotify_max_user_watches",
                config::ARCH_FS_ROOT
            ),
            format!("{}/sys/.empty", config::ARCH_FS_ROOT),
        ];
        let missing_bind_sources: Vec<String> = bind_sources
            .into_iter()
            .filter(|src| !Path::new(src).exists())
            .collect();

        log::warn!(
            "PROOT_FATAL_DIAGNOSTIC phase={} user={} no_seccomp={} all_files_access={} rootfs_exists={} command='{}' missing_bind_sources={:?}",
            phase,
            user,
            use_no_seccomp,
            context.permission_all_files_access,
            Path::new(config::ARCH_FS_ROOT).exists(),
            command,
            missing_bind_sources
        );
        log::warn!(
            "PRoot command failed: phase={} command='{}' user={} no_seccomp={} rootfs_exists={} missing_bind_sources={:?}",
            phase,
            command,
            user,
            use_no_seccomp,
            Path::new(config::ARCH_FS_ROOT).exists(),
            missing_bind_sources
        );
        log::warn!("PRoot stderr (phase={}): {}", phase, stderr);
    }

    fn setup_base_command(use_no_seccomp: bool) -> Command {
        let context = get_application_context();
        let proot_loader = context.native_library_dir.join("libproot_loader.so");

        let mut process = Command::new(context.native_library_dir.join("libproot.so"));
        process
            .env("PROOT_LOADER", proot_loader)
            .env("PROOT_TMP_DIR", context.data_dir);
        if use_no_seccomp {
            process.env("PROOT_NO_SECCOMP", "1");
        }
        process
    }

    fn ensure_guest_bind_sources() -> std::io::Result<Vec<String>> {
        let fs_root = Path::new(config::ARCH_FS_ROOT);
        if !fs_root.exists() {
            return Ok(Vec::new());
        }

        let mut repaired_paths: Vec<String> = Vec::new();
        let required_dirs = ["tmp", "proc", "sys", "sys/.empty"];
        for relative_dir in required_dirs {
            let full_path = fs_root.join(relative_dir);
            if !full_path.exists() {
                fs::create_dir_all(&full_path)?;
                repaired_paths.push(full_path.display().to_string());
            }
        }

        let proc_files = [
            ("proc/.loadavg", PROC_LOADAVG_CONTENT),
            ("proc/.stat", PROC_STAT_CONTENT),
            ("proc/.uptime", PROC_UPTIME_CONTENT),
            ("proc/.version", PROC_VERSION_CONTENT),
            ("proc/.vmstat", PROC_VMSTAT_CONTENT),
            ("proc/.sysctl_entry_cap_last_cap", PROC_CAP_LAST_CAP_CONTENT),
            (
                "proc/.sysctl_inotify_max_user_watches",
                PROC_MAX_USER_WATCHES_CONTENT,
            ),
        ];

        for (relative_path, content) in proc_files {
            let full_path = fs_root.join(relative_path);
            if !full_path.exists() {
                fs::write(&full_path, content)?;
                repaired_paths.push(full_path.display().to_string());
            }
        }

        Ok(repaired_paths)
    }

    fn with_args(mut process: Command) -> Command {
        let context = get_application_context();
        match Self::ensure_guest_bind_sources() {
            Ok(repaired_paths) => {
                if !repaired_paths.is_empty() {
                    log::warn!(
                        "PROOT_BIND_SOURCES_REPAIRED count={} paths={:?}",
                        repaired_paths.len(),
                        repaired_paths
                    );
                }
            }
            Err(err) => {
                log::warn!("Failed to prepare simulated bind sources: {}", err);
            }
        }

        process
            .arg("-r")
            .arg(config::ARCH_FS_ROOT)
            .arg("-L")
            .arg(format!("--kernel-release={}", DEFAULT_FAKE_KERNEL_RELEASE))
            .arg("--link2symlink")
            .arg("--sysvipc")
            .arg("--kill-on-exit")
            .arg("--root-id")
            .arg("--cwd=/")
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
        process
    }

    fn with_env_vars(mut process: Command, user: &str) -> Command {
        let home = if user == "root" {
            "/root".to_string()
        } else {
            format!("/home/{}", user)
        };

        // Avoid relying on `/usr/bin/env` inside the guest rootfs. On some devices this
        // binary fails to exec under PRoot even when the shell command itself can run.
        process
            .env("HOME", home)
            .env("LANG", "C.UTF-8")
            .env("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/games:/usr/games:/system/bin:/system/xbin")
            .env(
                "TERM",
                std::env::var("TERM").unwrap_or_else(|_| "xterm-256color".to_string()),
            )
            .env("TMPDIR", "/tmp")
            .env("USER", user)
            .env("LOGNAME", user);
        process
    }

    fn with_user_shell(mut process: Command, user: &str) -> Command {
        if user == "root" {
            process.arg("/bin/sh");
        } else {
            process
                .arg("runuser")
                .arg("-u")
                .arg(user)
                .arg("--")
                .arg("/bin/sh");
        }
        process
    }

    pub fn is_supported() -> bool {
        let run_probe = |use_no_seccomp: bool| {
            Self::setup_base_command(use_no_seccomp)
                .arg("-r")
                .arg("/")
                .arg("-L")
                .arg("--link2symlink")
                .arg("--sysvipc")
                .arg("--kill-on-exit")
                .arg("--root-id")
                .arg("/system/bin/true")
                .output()
        };

        // Probe PRoot with a direct host binary instead of `sh -c ...`.
        // Some devices/app contexts fail on `/system/bin/sh` under `-r /` even though
        // the real app flow (running `/bin/sh` inside the Arch rootfs) can still work.
        let output_result = run_probe(Self::should_use_no_seccomp());

        match output_result {
            Ok(res) => {
                log::info!(
                    "PRoot support probe status: success={} code={:?} no_seccomp={}",
                    res.status.success(),
                    res.status.code(),
                    Self::should_use_no_seccomp()
                );
                let stderr = String::from_utf8_lossy(&res.stderr).replace('\n', "\\n");
                let stderr_raw = String::from_utf8_lossy(&res.stderr);
                if !stderr_raw.is_empty() {
                    log::warn!("PRoot support probe stderr: {}", stderr_raw);
                }
                let mut retry_failure_stderr: Option<String> = None;

                if !res.status.success()
                    && Self::is_execve_enosys(&stderr_raw)
                    && !Self::should_use_no_seccomp()
                {
                    Self::enable_no_seccomp("probe execve ENOSYS");
                    if let Ok(retry_res) = run_probe(true) {
                        let retry_stderr_raw = String::from_utf8_lossy(&retry_res.stderr);
                        log::info!(
                            "PRoot support probe retry with PROOT_NO_SECCOMP=1: success={} code={:?}",
                            retry_res.status.success(),
                            retry_res.status.code()
                        );
                        if !retry_stderr_raw.is_empty() {
                            log::warn!("PRoot support probe retry stderr: {}", retry_stderr_raw);
                        }
                        if retry_res.status.success() {
                            log::warn!(
                                "PROOT_ENOSYS_RECOVERED phase=support_probe fallback=PROOT_NO_SECCOMP"
                            );
                            log::info!("PRoot support probe decision: true");
                            return true;
                        }
                        retry_failure_stderr = Some(retry_stderr_raw.to_string());
                    }
                }

                let host_exec_enosys = !res.status.success()
                    && stderr_raw.contains("proot error: execve(\"/system/bin/")
                    && stderr.contains("Function not implemented")
                    && stderr.contains(PROOT_FATAL_MARKER)
                    && stderr.contains("proot error: execve(");
                let supported = if host_exec_enosys {
                    true
                } else {
                    res.status.success()
                };
                if !supported && Self::has_proot_fatal_error(&stderr_raw) {
                    Self::log_failure_diagnostics(
                        "support_probe",
                        "/system/bin/true",
                        "root",
                        &stderr_raw,
                        Self::should_use_no_seccomp(),
                    );
                }
                if let Some(retry_stderr_raw) = retry_failure_stderr {
                    if !supported && Self::has_proot_fatal_error(&retry_stderr_raw) {
                        Self::log_failure_diagnostics(
                            "support_probe_retry",
                            "/system/bin/true",
                            "root",
                            &retry_stderr_raw,
                            true,
                        );
                    }
                }
                if !supported {
                    log::info!(
                        "PRoot support probe determined unsupported: code={:?}, stderr={}",
                        res.status.code(),
                        stderr_raw.trim()
                    );
                }
                log::info!("PRoot support probe decision: {}", supported);
                supported
            }
            Err(e) => {
                log::info!("PRoot support probe failed to execute: {}", e);
                false
            }
        }
    }

    /// Run the command inside Proot
    pub fn spawn(mut self) -> Self {
        let mut process = Self::setup_base_command(Self::should_use_no_seccomp());
        process = Self::with_args(process);
        process = Self::with_env_vars(process, &self.user);
        process = Self::with_user_shell(process, &self.user);

        let child = process
            .arg("-c")
            .arg(&self.command)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .pb_expect("Failed to run command");

        self.process.replace(child);
        self
    }

    pub fn exec(command: &str) -> Self {
        ArchProcess {
            command: command.to_string(),
            user: "root".to_string(),
            process: None,
        }
        .spawn()
    }

    pub fn exec_as(command: &str, user: &str) -> Self {
        ArchProcess {
            command: command.to_string(),
            user: user.to_string(),
            process: None,
        }
        .spawn()
    }

    pub fn with_log(
        self,
        mut log: impl FnMut(String),
    ) -> std::io::Result<std::process::ExitStatus> {
        if let Some(mut child) = self.process {
            if let Some(stdout) = child.stdout.take() {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    log(line?);
                }
            }
            child.wait()
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "Process not spawned",
            ))
        }
    }

    pub fn exec_with_panic_on_error(command: &str) {
        let run_once = |use_no_seccomp: bool| {
            let mut process = Self::setup_base_command(use_no_seccomp);
            process = Self::with_args(process);
            process = Self::with_env_vars(process, "root");
            process = Self::with_user_shell(process, "root");
            process
                .arg("-c")
                .arg(command)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .pb_expect("Failed to run command")
        };

        let use_no_seccomp = Self::should_use_no_seccomp();
        let output = run_once(use_no_seccomp);
        let error_output = String::from_utf8_lossy(&output.stderr).to_string();
        if Self::has_proot_fatal_error(&error_output) {
            if !use_no_seccomp && Self::is_execve_enosys(&error_output) {
                Self::enable_no_seccomp("command execve ENOSYS");
                let retry_output = run_once(true);
                let retry_error_output = String::from_utf8_lossy(&retry_output.stderr).to_string();
                if Self::has_proot_fatal_error(&retry_error_output) {
                    Self::log_failure_diagnostics(
                        "exec_with_panic_on_error_retry",
                        command,
                        "root",
                        &retry_error_output,
                        true,
                    );
                    panic!("PRoot error: {}", retry_error_output);
                }
                log::warn!(
                    "PROOT_ENOSYS_RECOVERED phase=exec_with_panic_on_error fallback=PROOT_NO_SECCOMP command='{}'",
                    command
                );
                return;
            }

            Self::log_failure_diagnostics(
                "exec_with_panic_on_error",
                command,
                "root",
                &error_output,
                use_no_seccomp,
            );
            panic!("PRoot error: {}", error_output);
        }
    }

    pub fn wait_with_output(self) -> std::io::Result<std::process::Output> {
        if let Some(child) = self.process {
            child.wait_with_output()
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "Process not spawned",
            ))
        }
    }

    pub fn wait(self) -> std::io::Result<std::process::ExitStatus> {
        if let Some(mut child) = self.process {
            child.wait()
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "Process not spawned",
            ))
        }
    }
}
