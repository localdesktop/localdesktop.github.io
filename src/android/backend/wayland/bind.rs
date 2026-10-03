use crate::core::config;
use smithay::reexports::wayland_server::ListeningSocket;
use std::{error::Error, path::PathBuf, thread, time::Duration};

/// How long to wait for a previous compositor in this process to release the socket.
const IN_USE_RETRIES: u32 = 20;
const IN_USE_RETRY_DELAY: Duration = Duration::from_millis(100);

/// Bind the Wayland socket the guest connects to.
///
/// A crashed or recreated activity leaves `wayland-0` behind. `ListeningSocket` removes a socket
/// file that nobody holds the lock of, but when the activity is re-created inside the same process
/// the previous compositor may still hold it for a moment while it shuts down, so wait briefly for
/// it before giving up.
pub fn bind_socket() -> Result<ListeningSocket, Box<dyn Error>> {
    let socket_path =
        PathBuf::from(config::ARCH_FS_ROOT.to_owned() + "/tmp").join(config::WAYLAND_SOCKET_NAME);

    let mut attempt = 0;
    loop {
        match ListeningSocket::bind_absolute(socket_path.clone()) {
            Ok(listener) => return Ok(listener),
            // `BindError` is not exported by wayland-server; its debug name is the only handle.
            Err(error)
                if attempt < IN_USE_RETRIES && format!("{error:?}").contains("AlreadyInUse") =>
            {
                attempt += 1;
                log::warn!(
                    "Wayland socket {} is still in use, retrying ({attempt}/{IN_USE_RETRIES})",
                    socket_path.display()
                );
                thread::sleep(IN_USE_RETRY_DELAY);
            }
            Err(error) => return Err(Box::new(error)),
        }
    }
}
