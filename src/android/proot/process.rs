use crate::android::utils::application_context::get_application_context;
use crate::core::{config, logging::PolarBearExpectation};
use std::io::BufRead;
use std::io::BufReader;
use std::path::Path;
use std::process::{Child, Command, Stdio};

pub type Log = Box<dyn Fn(String)>;

pub struct ArchProcess {
    pub command: String,
    pub user: String,
    pub process: Option<Child>,
}

impl ArchProcess {
    fn command_display(process: &Command) -> String {
        let program = process.get_program().to_string_lossy().to_string();
        let args = process
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join(" ");
        if args.is_empty() {
            program
        } else {
            format!("{program} {args}")
        }
    }

    fn setup_base_command() -> Command {
        let context = get_application_context();
        let proot_tmp_dir = context.cache_dir.join("proot-rs-tmp");
        let _ = std::fs::create_dir_all(&proot_tmp_dir);

        let mut process = Command::new(context.native_library_dir.join("libproot-rs.so"));
        process
            .env("TMPDIR", &proot_tmp_dir)
            .env("TMP", &proot_tmp_dir);
        process
    }

    fn with_args(mut process: Command) -> Command {
        let context = get_application_context();

        process
            .arg("--rootfs")
            .arg(config::ARCH_FS_ROOT)
            .arg("--bind")
            .arg("/dev:/dev")
            .arg("--bind")
            .arg("/proc:/proc")
            .arg("--bind")
            .arg("/sys:/sys")
            .arg("--bind")
            .arg(format!("{}/tmp:/dev/shm", config::ARCH_FS_ROOT));

        if context.permission_all_files_access {
            process
                .arg("--bind")
                .arg("/sdcard:/android")
                .arg("--bind")
                .arg("/sdcard:/root/Android");
        }

        process
            .arg("--bind")
            .arg("/dev/urandom:/dev/random")
            .arg("--bind")
            .arg("/proc/self/fd:/dev/fd")
            .arg("--bind")
            .arg("/proc/self/fd/0:/dev/stdin")
            .arg("--bind")
            .arg("/proc/self/fd/1:/dev/stdout")
            .arg("--bind")
            .arg("/proc/self/fd/2:/dev/stderr");

        let add_bind_if_exists = |proc: &mut Command, host: &str, guest: &str| {
            if Path::new(host).exists() {
                proc.arg("--bind").arg(format!("{host}:{guest}"));
            } else {
                log::warn!("Skipping bind because host path is missing: {}", host);
            }
        };

        add_bind_if_exists(
            &mut process,
            &format!("{}/proc/.loadavg", config::ARCH_FS_ROOT),
            "/proc/loadavg",
        );
        add_bind_if_exists(
            &mut process,
            &format!("{}/proc/.stat", config::ARCH_FS_ROOT),
            "/proc/stat",
        );
        add_bind_if_exists(
            &mut process,
            &format!("{}/proc/.uptime", config::ARCH_FS_ROOT),
            "/proc/uptime",
        );
        add_bind_if_exists(
            &mut process,
            &format!("{}/proc/.version", config::ARCH_FS_ROOT),
            "/proc/version",
        );
        add_bind_if_exists(
            &mut process,
            &format!("{}/proc/.vmstat", config::ARCH_FS_ROOT),
            "/proc/vmstat",
        );
        add_bind_if_exists(
            &mut process,
            &format!("{}/proc/.sysctl_entry_cap_last_cap", config::ARCH_FS_ROOT),
            "/proc/sys/kernel/cap_last_cap",
        );
        add_bind_if_exists(
            &mut process,
            &format!(
                "{}/proc/.sysctl_inotify_max_user_watches",
                config::ARCH_FS_ROOT
            ),
            "/proc/sys/fs/inotify/max_user_watches",
        );
        add_bind_if_exists(
            &mut process,
            &format!("{}/sys/.empty", config::ARCH_FS_ROOT),
            "/sys/fs/selinux",
        );
        process
    }

    fn with_command_separator(mut process: Command) -> Command {
        process.arg("--");
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
        let mut process = Self::setup_base_command();
        process
            .arg("--rootfs")
            .arg("/")
            .arg("--")
            .arg("/system/bin/true");

        log::info!(
            "Checking proot-rs support with command: {}",
            Self::command_display(&process)
        );
        match process.output() {
            Ok(res) => {
                if res.status.success() {
                    log::info!("proot-rs support check succeeded");
                    true
                } else {
                    log::error!(
                        "proot-rs support check failed: status={:?}, stderr={}",
                        res.status.code(),
                        String::from_utf8_lossy(&res.stderr)
                    );
                    false
                }
            }
            Err(err) => {
                log::error!("Failed to execute proot-rs support check: {err}");
                false
            }
        }
    }

    /// Run the command inside proot-rs
    pub fn spawn(mut self) -> Self {
        let mut process = Self::setup_base_command();
        process = Self::with_args(process);
        process = Self::with_command_separator(process);
        process = Self::with_env_vars(process, &self.user);
        process = Self::with_user_shell(process, &self.user);

        let child = process
            .arg("-c")
            .arg(&self.command)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn();

        let command = Self::command_display(&process);
        log::info!("Spawning command as {}: {}", self.user, command);
        let child = child
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

    pub fn with_log(self, mut log: impl FnMut(String)) {
        if let Some(child) = self.process {
            let reader = BufReader::new(child.stdout.unwrap());
            for line in reader.lines() {
                let line = line.unwrap();
                log(line);
            }
        }
    }

    pub fn exec_with_panic_on_error(command: &str) {
        let mut process = Self::setup_base_command();
        process = Self::with_args(process);
        process = Self::with_command_separator(process);
        process = Self::with_env_vars(process, "root");
        process = Self::with_user_shell(process, "root");

        let output = process
            .arg("-c")
            .arg(command)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .pb_expect("Failed to run command");

        if !output.status.success() {
            let error_output = String::from_utf8_lossy(&output.stderr);
            panic!("proot-rs error: {}", error_output);
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
