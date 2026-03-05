use crate::android::proot::setup::SetupMessage;
use crate::core::logging::PolarBearExpectation;
use serde_json::json;
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::thread;
use websocket::sync::Server;
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
        let socket = Server::bind("127.0.0.1:0").pb_expect("Failed to bind socket");
        let socket_port = socket.local_addr().unwrap().port();

        let active_client = Arc::new(Mutex::new(None));
        let receiver = Arc::new(Mutex::new(receiver));

        let active_client_clone = active_client.clone();
        let progress_clone = progress.clone();
        thread::spawn(move || {
            for request in socket.filter_map(Result::ok) {
                let mut active_client = active_client_clone.lock().unwrap();

                // Reject new connections if there is already an active client
                if active_client.is_some() {
                    log::info!("Rejecting new connection: already an active client");
                    request.reject().unwrap();
                    continue;
                }

                // Accept the new client
                if !request.protocols().contains(&"rust-websocket".to_string()) {
                    request.reject().unwrap();
                    continue;
                }

                let client = request.use_protocol("rust-websocket").accept().unwrap();
                let ip = client.peer_addr().unwrap();
                log::info!("Connection from {}", ip);

                // Store the new client
                *active_client = Some(client); // Store the writer part of the connection

                // Spawn a thread to handle messages for this client
                let active_client_clone = active_client_clone.clone();
                let receiver_clone = receiver.clone();
                let progress_clone = progress_clone.clone();
                thread::spawn(move || {
                    for message in receiver_clone.lock().unwrap().iter() {
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
                                // If sending fails, disconnect the client
                                log::info!("Client disconnected");
                                *active_client = None;
                                break;
                            }
                        }
                    }
                });
            }
        });

        Self {
            socket_port,
            progress,
            error: ErrorVariant::None,
        }
    }
}
