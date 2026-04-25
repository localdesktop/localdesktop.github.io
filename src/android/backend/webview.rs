use crate::android::proot::setup::SetupMessage;
use serde_json::json;
use std::net::TcpStream;
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::thread;
use websocket::sync::{Client, Server};
use websocket::OwnedMessage;

pub enum ErrorVariant {
    None,
    Unsupported,
}

pub struct WebviewBackend {
    pub socket_port: u16,
    pub progress: Arc<Mutex<u16>>, // 0-100
    pub error: ErrorVariant,
}

impl WebviewBackend {
    /// Start accepting connections and listening for messages
    pub fn build(receiver: Receiver<SetupMessage>, progress: Arc<Mutex<u16>>) -> Self {
        let socket = Server::bind("127.0.0.1:0").expect("Failed to bind socket");
        let socket_port = socket.local_addr().unwrap().port();

        let active_client: Arc<Mutex<Option<Client<TcpStream>>>> = Arc::new(Mutex::new(None));

        let active_client_clone = active_client.clone();
        let progress_clone = progress.clone();
        thread::spawn(move || {
            for message in receiver {
                let progress = *progress_clone.lock().unwrap();
                let json_message = match message {
                    SetupMessage::Progress(msg) => json!({
                        "progress": progress,
                        "message": msg,
                    }),
                    SetupMessage::Error(msg) => {
                        log::info!("Setup error [{}%]: {}", progress, msg);
                        json!({
                            "progress": progress,
                            "message": msg,
                            "isError": true
                        })
                    }
                };

                let message = OwnedMessage::Text(json_message.to_string());
                let mut active_client = active_client_clone.lock().unwrap();

                if let Some(writer) = active_client.as_mut() {
                    if writer.send_message(&message).is_err() {
                        log::info!("Setup progress client disconnected");
                        *active_client = None;
                    }
                }
            }
        });

        let active_client_clone = active_client.clone();
        let progress_clone = progress.clone();
        thread::spawn(move || {
            for request in socket.filter_map(Result::ok) {
                if !request.protocols().contains(&"rust-websocket".to_string()) {
                    if let Err(error) = request.reject() {
                        log::warn!("Failed to reject setup progress client: {error:?}");
                    }
                    continue;
                }

                let mut client = match request.use_protocol("rust-websocket").accept() {
                    Ok(client) => client,
                    Err(error) => {
                        log::warn!("Failed to accept setup progress client: {error:?}");
                        continue;
                    }
                };
                match client.peer_addr() {
                    Ok(ip) => log::info!("Setup progress connection from {}", ip),
                    Err(error) => {
                        log::warn!("Failed to read setup progress client address: {error}")
                    }
                }

                let progress = *progress_clone.lock().unwrap();
                let message = OwnedMessage::Text(
                    json!({
                        "progress": progress,
                        "message": "Connected to installer",
                    })
                    .to_string(),
                );
                if client.send_message(&message).is_err() {
                    log::info!("Setup progress client disconnected during initial update");
                    continue;
                }

                let mut active_client = active_client_clone.lock().unwrap();
                if active_client.replace(client).is_some() {
                    log::info!("Replaced stale setup progress client");
                }
            }
        });

        Self {
            socket_port,
            progress,
            error: ErrorVariant::None,
        }
    }
}
