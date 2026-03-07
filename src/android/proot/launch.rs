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

        ArchProcess::exec_as(&full_launch_command, &username).with_log(|it| {
            log::trace!("{}", it);
        });
    });
}
