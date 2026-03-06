use super::process::ArchProcess;
use crate::android::utils::application_context::get_application_context;
use std::thread;

pub fn launch() {
    thread::spawn(move || {
        // Clean up potential leftover files for display :1
        ArchProcess::exec("rm -f /tmp/.X1-lock");
        ArchProcess::exec("rm -f /tmp/.X11-unix/X1");

        let local_config = get_application_context().local_config;
        let username = local_config.user.username;

        let full_launch_command = local_config.command.launch;
        let run_launch = |saw_execve_enosys: &mut bool| {
            ArchProcess::exec_as(&full_launch_command, &username).with_log(|it| {
                if ArchProcess::is_execve_enosys(&it) {
                    *saw_execve_enosys = true;
                }
                log::trace!("{}", it);
            })
        };

        let mut saw_execve_enosys = false;
        match run_launch(&mut saw_execve_enosys) {
            Ok(status) if !status.success() => {
                log::warn!("Desktop launch command exited with status: {:?}", status.code());
                if saw_execve_enosys && !ArchProcess::no_seccomp_enabled() {
                    ArchProcess::enable_no_seccomp_fallback("desktop launch execve ENOSYS");
                    log::warn!(
                        "Retrying desktop launch with PROOT_NO_SECCOMP=1 after ENOSYS failure"
                    );
                    let mut saw_retry_execve_enosys = false;
                    match run_launch(&mut saw_retry_execve_enosys) {
                        Ok(retry_status) if !retry_status.success() => {
                            log::error!(
                                "Desktop launch retry exited with status: {:?}",
                                retry_status.code()
                            );
                        }
                        Ok(_) => {}
                        Err(retry_err) => {
                            log::error!(
                                "Failed to run desktop launch retry command: {}",
                                retry_err
                            );
                        }
                    }
                }
            }
            Ok(_) => {}
            Err(err) => {
                log::warn!("Failed to run desktop launch command: {}", err);
            }
        }
    });
}
