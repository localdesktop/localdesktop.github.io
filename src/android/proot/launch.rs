use super::process::ArchProcess;
use crate::android::utils::application_context::get_application_context;
use std::thread;

pub fn launch() {
    thread::spawn(move || {
        // Clean up potential leftover files for display :1
        ArchProcess {
            command: "rm -f /tmp/.X1-lock".to_string(),
            user: None,
            log: None,
        }
        .run();
        ArchProcess {
            command: "rm -f /tmp/.X11-unix/X1".to_string(),
            user: None,
            log: None,
        }
        .run();

        let local_config = get_application_context().local_config;
        let username = local_config.user.username;

        let full_launch_command = local_config.command.launch;

        ArchProcess {
            command: full_launch_command,
            user: Some(username),
            log: Some(Box::new(|it| {
                log::info!("{}", it);
            })),
        }
        .run();
    });
}
