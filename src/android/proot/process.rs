use crate::android::utils::application_context::get_application_context;
use crate::android::utils::external_debug_log::append_external_debug_log;
use crate::core::{config, logging::PolarBearExpectation};
use sentry::{protocol::Value, Level};
use smithay::reexports::rustix::path::Arg;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::io::BufRead;
use std::io::BufReader;
use std::process::{Child, Command, Stdio};
use std::thread;

pub type Log = Box<dyn Fn(String)>;

pub struct ArchProcess {
    pub command: String,
    pub user: String,
    pub process: Option<Child>,
    pub stderr_lines: Arc<Mutex<Vec<String>>>,
    pub used_no_seccomp: bool,
}

static PROOT_NO_SECCOMP_FALLBACK: AtomicBool = AtomicBool::new(false);

impl ArchProcess {
    fn is_no_seccomp_enabled() -> bool {
        PROOT_NO_SECCOMP_FALLBACK.load(Ordering::Relaxed)
    }

    fn enable_no_seccomp_fallback(reason: &str, command: Option<&str>, stderr: Option<&str>) {
        let was_enabled = PROOT_NO_SECCOMP_FALLBACK.swap(true, Ordering::Relaxed);
        append_external_debug_log(
            "proot_fallback",
            &format!(
                "enable PROOT_NO_SECCOMP=1 reason={} already_enabled={} command={}",
                reason,
                was_enabled,
                command.unwrap_or("<none>")
            ),
        );

        let stderr_excerpt = stderr.unwrap_or("").chars().take(3000).collect::<String>();
        sentry::with_scope(
            |scope| {
                scope.set_tag("component", "proot");
                scope.set_tag("fallback", "PROOT_NO_SECCOMP");
                scope.set_tag("reason", reason);
                if let Some(cmd) = command {
                    scope.set_extra("command", Value::String(cmd.to_string()));
                }
                if !stderr_excerpt.is_empty() {
                    scope.set_extra("stderr", Value::String(stderr_excerpt.clone()));
                }
            },
            || {
                sentry::capture_message(
                    "Enabled PRoot fallback PROOT_NO_SECCOMP after execve/ENOSYS failure",
                    Level::Error,
                )
            },
        );
    }

    fn is_execve_enosys_proot_fatal(stderr: &str) -> bool {
        stderr.contains("Function not implemented")
            && stderr.contains("fatal error: see `libproot.so --help`")
            && stderr.contains("proot error: execve(")
    }

    fn joined_stderr(&self) -> String {
        self.stderr_lines
            .lock()
            .map(|lines| lines.join("\n"))
            .unwrap_or_default()
    }

    fn setup_base_command() -> Command {
        let context = get_application_context();
        let proot_loader = context.native_library_dir.join("libproot_loader.so");
        let no_seccomp = Self::is_no_seccomp_enabled();

        let mut process = Command::new(context.native_library_dir.join("libproot.so"));
        process
            .env("PROOT_LOADER", proot_loader)
            .env("PROOT_TMP_DIR", context.data_dir);
        if no_seccomp {
            process.env("PROOT_NO_SECCOMP", "1");
        }
        append_external_debug_log(
            "proot_env",
            &format!("setup_base_command PROOT_NO_SECCOMP={}", if no_seccomp { 1 } else { 0 }),
        );
        process
    }

    fn with_args(mut process: Command) -> Command {
        let context = get_application_context();

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
        process
    }

    fn with_env_vars(mut process: Command, user: &str) -> Command {
        process.arg("/usr/bin/env").arg("-i");

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
        process
    }

    fn with_user_shell(mut process: Command, user: &str) -> Command {
        if user == "root" {
            process.arg("sh");
        } else {
            process
                .arg("runuser")
                .arg("-u")
                .arg(user)
                .arg("--")
                .arg("sh");
        }
        process
    }

    pub fn is_supported() -> bool {
        append_external_debug_log("is_supported", "starting support check");
        let context = get_application_context();
        let libproot = context.native_library_dir.join("libproot.so");
        let loader = context.native_library_dir.join("libproot_loader.so");
        append_external_debug_log(
            "is_supported",
            &format!(
                "native_library_dir={} libproot_exists={} loader_exists={}",
                context.native_library_dir.display(),
                libproot.exists(),
                loader.exists()
            ),
        );

        // Probe PRoot with a direct host binary instead of `sh -c ...`.
        // Some devices/app contexts fail on `/system/bin/sh` under `-r /` even though
        // the real app flow (running `/bin/sh` inside the Arch rootfs) can still work.
        let output_result = Self::setup_base_command()
            .arg("-r")
            .arg("/")
            .arg("-L")
            .arg("--link2symlink")
            .arg("--sysvipc")
            .arg("--kill-on-exit")
            .arg("--root-id")
            .arg("/system/bin/true")
            .output();

        match output_result {
            Ok(res) => {
                let stdout = String::from_utf8_lossy(&res.stdout).replace('\n', "\\n");
                let stderr = String::from_utf8_lossy(&res.stderr).replace('\n', "\\n");
                let stderr_raw = String::from_utf8_lossy(&res.stderr);
                let host_exec_enosys = !res.status.success()
                    && stderr_raw.contains("proot error: execve(\"/system/bin/")
                    && Self::is_execve_enosys_proot_fatal(&stderr_raw);

                let supported = if host_exec_enosys {
                    Self::enable_no_seccomp_fallback(
                        "is_supported_host_system_bin_execve_enosys",
                        Some("/system/bin/true"),
                        Some(&stderr_raw),
                    );
                    append_external_debug_log(
                        "is_supported",
                        "host /system/bin exec under -r / failed with ENOSYS; treating probe as inconclusive and allowing setup",
                    );
                    true
                } else {
                    res.status.success()
                };
                append_external_debug_log(
                    "is_supported",
                    &format!(
                        "status={:?} supported={} stdout=\"{}\" stderr=\"{}\"",
                        res.status, supported, stdout, stderr
                    ),
                );
                supported
            }
            Err(e) => {
                append_external_debug_log(
                    "is_supported",
                    &format!("failed to run proot support check: {}", e),
                );
                false
            }
        }
    }

    /// Run the command inside Proot
    pub fn spawn(mut self) -> Self {
        append_external_debug_log(
            "proot_spawn",
            &format!("user={} command={}", self.user, self.command),
        );

        let mut process = Self::setup_base_command();
        process = Self::with_args(process);
        process = Self::with_env_vars(process, &self.user);
        process = Self::with_user_shell(process, &self.user);

        let mut child = process
            .arg("-c")
            .arg(&self.command)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .pb_expect("Failed to run command");

        if let Some(stderr) = child.stderr.take() {
            let command = self.command.clone();
            let user = self.user.clone();
            let stderr_lines = self.stderr_lines.clone();
            thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    match line {
                        Ok(line) => {
                            if let Ok(mut lines) = stderr_lines.lock() {
                                lines.push(line.clone());
                            }
                            append_external_debug_log(
                                "proot_stderr",
                                &format!("user={} command={} line={}", user, command, line),
                            );
                            eprintln!("{}", line);
                        }
                        Err(e) => {
                            append_external_debug_log(
                                "proot_stderr",
                                &format!(
                                    "user={} command={} stderr read error={}",
                                    user, command, e
                                ),
                            );
                            break;
                        }
                    }
                }
            });
        }

        self.process.replace(child);
        self
    }

    pub fn exec(command: &str) -> Self {
        ArchProcess {
            command: command.to_string(),
            user: "root".to_string(),
            process: None,
            stderr_lines: Arc::new(Mutex::new(Vec::new())),
            used_no_seccomp: Self::is_no_seccomp_enabled(),
        }
        .spawn()
    }

    pub fn exec_as(command: &str, user: &str) -> Self {
        ArchProcess {
            command: command.to_string(),
            user: user.to_string(),
            process: None,
            stderr_lines: Arc::new(Mutex::new(Vec::new())),
            used_no_seccomp: Self::is_no_seccomp_enabled(),
        }
        .spawn()
    }

    pub fn with_log(self, mut log: impl FnMut(String)) {
        let mut current = Some(self);
        let mut retried = false;

        while let Some(this) = current.take() {
            let retry_command = this.command.clone();
            let retry_user = this.user.clone();
            let used_no_seccomp = this.used_no_seccomp;
            let stderr_lines = this.stderr_lines.clone();

            if let Some(mut child) = this.process {
                let reader = BufReader::new(child.stdout.take().unwrap());
                for line in reader.lines() {
                    let line = line.unwrap();
                    log(line);
                }

                let status = child.wait();
                let stderr_text = stderr_lines
                    .lock()
                    .map(|lines| lines.join("\n"))
                    .unwrap_or_default();
                append_external_debug_log(
                    "proot_spawn",
                    &format!(
                        "completed user={} command={} status={:?} used_no_seccomp={}",
                        retry_user, retry_command, status, used_no_seccomp
                    ),
                );

                if !retried
                    && !used_no_seccomp
                    && Self::is_execve_enosys_proot_fatal(&stderr_text)
                {
                    Self::enable_no_seccomp_fallback(
                        "spawn_execve_enosys",
                        Some(&retry_command),
                        Some(&stderr_text),
                    );
                    append_external_debug_log(
                        "proot_spawn",
                        &format!("retrying with PROOT_NO_SECCOMP=1 command={}", retry_command),
                    );
                    retried = true;
                    current = Some(ArchProcess::exec_as(&retry_command, &retry_user));
                }
            }
        }
    }

    pub fn exec_with_panic_on_error(command: &str) {
        append_external_debug_log("proot_exec", &format!("exec_with_panic_on_error command={}", command));
        let mut retried = false;
        loop {
            let mut process = Self::setup_base_command();
            process = Self::with_args(process);
            process = Self::with_env_vars(process, "root");
            process = Self::with_user_shell(process, "root");

            let output = process
                .arg("-c")
                .arg(command)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .pb_expect("Failed to run command");

            append_external_debug_log(
                "proot_exec",
                &format!(
                    "status={:?} stdout=\"{}\" stderr=\"{}\" no_seccomp={} retried={}",
                    output.status,
                    String::from_utf8_lossy(&output.stdout).replace('\n', "\\n"),
                    String::from_utf8_lossy(&output.stderr).replace('\n', "\\n"),
                    Self::is_no_seccomp_enabled(),
                    retried
                ),
            );

            let error_output = String::from_utf8_lossy(&output.stderr);
            if !retried
                && !Self::is_no_seccomp_enabled()
                && Self::is_execve_enosys_proot_fatal(&error_output)
            {
                Self::enable_no_seccomp_fallback(
                    "exec_with_panic_on_error_execve_enosys",
                    Some(command),
                    Some(&error_output),
                );
                retried = true;
                continue;
            }

            if error_output.contains("fatal error: see `libproot.so --help`") {
                append_external_debug_log(
                    "proot_exec",
                    "fatal proot error detected in exec_with_panic_on_error",
                );
                sentry::with_scope(
                    |scope| {
                        scope.set_tag("component", "proot");
                        scope.set_tag("path", "exec_with_panic_on_error");
                        scope.set_extra("command", Value::String(command.to_string()));
                        scope.set_extra(
                            "stderr",
                            Value::String(error_output.chars().take(3000).collect()),
                        );
                    },
                    || sentry::capture_message("Fatal PRoot error in exec_with_panic_on_error", Level::Error),
                );
                panic!("PRoot error: {}", error_output);
            }
            break;
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
        let ArchProcess {
            command,
            user: _,
            process,
            stderr_lines,
            used_no_seccomp,
        } = self;

        if let Some(mut child) = process {
            let status = child.wait();
            let stderr = stderr_lines
                .lock()
                .map(|lines| lines.join("\n"))
                .unwrap_or_default();
            if !used_no_seccomp && Self::is_execve_enosys_proot_fatal(&stderr) {
                Self::enable_no_seccomp_fallback("wait_execve_enosys", Some(&command), Some(&stderr));
            }
            status
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "Process not spawned",
            ))
        }
    }
}
