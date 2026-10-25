use crate::core::config;
use smithay::reexports::wayland_server::ListeningSocket;
use std::{error::Error, path::PathBuf};

pub fn bind_socket() -> Result<ListeningSocket, Box<dyn Error>> {
    let socket_path =
        PathBuf::from(config::arch_fs_root().to_owned() + "/tmp").join(config::WAYLAND_SOCKET_NAME);
    let listener = ListeningSocket::bind_absolute(socket_path)?;
    Ok(listener)
}
