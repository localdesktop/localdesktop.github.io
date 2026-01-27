use super::ptrace;
use crate::android::utils::application_context::get_application_context;
use crate::core::config;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

pub type Log = Box<dyn Fn(String)>;

pub struct ArchProcess {
    pub command: String,
    pub user: Option<String>,
    pub log: Option<Log>,
}

impl ArchProcess {
    /// Runs the process inside the proot environment.
    /// Returns true if the process exited with code 0, false otherwise.
    pub fn run(self) -> bool {
        let mut binds: Vec<(String, String)> = Vec::new();
        binds.push((config::ARCH_FS_ROOT.to_string(), "/".to_string()));
        binds.push(("/dev".to_string(), "/dev".to_string()));
        binds.push(("/proc".to_string(), "/proc".to_string()));
        binds.push(("/sys".to_string(), "/sys".to_string()));
        binds.push((
            format!("{}/tmp", config::ARCH_FS_ROOT),
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
        binds.push((
            format!("{}/proc/.loadavg", config::ARCH_FS_ROOT),
            "/proc/loadavg".to_string(),
        ));
        binds.push((
            format!("{}/proc/.stat", config::ARCH_FS_ROOT),
            "/proc/stat".to_string(),
        ));
        binds.push((
            format!("{}/proc/.uptime", config::ARCH_FS_ROOT),
            "/proc/uptime".to_string(),
        ));
        binds.push((
            format!("{}/proc/.version", config::ARCH_FS_ROOT),
            "/proc/version".to_string(),
        ));
        binds.push((
            format!("{}/proc/.vmstat", config::ARCH_FS_ROOT),
            "/proc/vmstat".to_string(),
        ));
        binds.push((
            format!("{}/proc/.sysctl_entry_cap_last_cap", config::ARCH_FS_ROOT),
            "/proc/sys/kernel/cap_last_cap".to_string(),
        ));
        binds.push((
            format!(
                "{}/proc/.sysctl_inotify_max_user_watches",
                config::ARCH_FS_ROOT
            ),
            "/proc/sys/fs/inotify/max_user_watches".to_string(),
        ));
        binds.push((
            format!("{}/sys/.empty", config::ARCH_FS_ROOT),
            "/sys/fs/selinux".to_string(),
        ));

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

        println!("Running command in arch proot: {}", &self.command);
        println!("As user: {}", &user);
        println!("With binds: {:?}", &binds);

        let mut child = match ptrace::spawn_traced(process, binds) {
            Ok(child) => child,
            Err(_) => return false,
        };

        if let Some(log) = &self.log {
            if let Some(stdout) = child.take_stdout() {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    if let Ok(line) = line {
                        log(line);
                    }
                }
            }
        }

        match child.wait() {
            Ok(code) => code == 0,
            Err(_) => false,
        }
    }
}
