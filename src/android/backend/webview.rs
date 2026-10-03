use crate::android::proot::setup::SetupMessage;
use serde_json::json;
use std::fs::File;
use std::io::Read;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, LazyLock, Mutex};
use std::thread;
use std::time::Duration;
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::http::{header, HeaderValue, StatusCode};
use tungstenite::{Message, WebSocket};

/// The only WebSocket subprotocol the installer page offers.
const SUBPROTOCOL: &str = "rust-websocket";
/// A client has this long to finish the HTTP upgrade, so a stalled client cannot hold a thread forever.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// Writes to the installer page must not block the setup message pump indefinitely.
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// Connections being handshaken at the same time; more are dropped immediately.
const MAX_PENDING_HANDSHAKES: usize = 8;

type ProgressSocket = WebSocket<TcpStream>;

/// Per-run secret shared with the installer page through the WebView URL.
static INSTALLER_TOKEN: LazyLock<String> = LazyLock::new(generate_token);

pub enum ErrorVariant {
    None,
    Unsupported,
}

pub struct WebviewBackend {
    pub socket_port: u16,
    pub progress: Arc<Mutex<u16>>, // 0-100
    pub error: ErrorVariant,
}

/// URL of the installer page for the server listening on `port`. The page connects back to
/// `ws://127.0.0.1:<port>/?token=<token>`; the server rejects any client without the token.
pub fn installer_url(port: u16) -> String {
    format!(
        "file:///android_asset/setup-progress.html?port={}&token={}",
        port, *INSTALLER_TOKEN
    )
}

/// 128 random bits from the kernel, hex encoded.
fn generate_token() -> String {
    let mut bytes = [0u8; 16];
    File::open("/dev/urandom")
        .and_then(|mut urandom| urandom.read_exact(&mut bytes))
        .expect("Failed to read /dev/urandom for the installer token");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn forbidden() -> ErrorResponse {
    let mut response = ErrorResponse::new(Some("forbidden".to_string()));
    *response.status_mut() = StatusCode::FORBIDDEN;
    response
}

/// Accept only the installer page: right token in the query, `Origin` absent or `null`
/// (what a `file://` page sends), and the expected subprotocol.
fn authenticate(request: &Request, mut response: Response) -> Result<Response, ErrorResponse> {
    let origin_ok = request
        .headers()
        .get(header::ORIGIN)
        .map_or(true, |origin| origin.as_bytes() == b"null");

    let token_ok = request
        .uri()
        .query()
        .into_iter()
        .flat_map(|query| query.split('&'))
        .filter_map(|pair| pair.strip_prefix("token="))
        .any(|token| constant_time_eq(token.as_bytes(), INSTALLER_TOKEN.as_bytes()));

    let protocol_ok = request
        .headers()
        .get_all(header::SEC_WEBSOCKET_PROTOCOL)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|protocol| protocol.trim() == SUBPROTOCOL);

    if !(origin_ok && token_ok && protocol_ok) {
        return Err(forbidden());
    }
    response.headers_mut().insert(
        header::SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_static(SUBPROTOCOL),
    );
    Ok(response)
}

/// Whether the peer of an established connection is still there. Never blocks: a non-blocking
/// peek sees EOF (`Ok(0)`) once the page closed or was reloaded.
fn is_alive(client: &ProgressSocket) -> bool {
    let stream = client.get_ref();
    if stream.set_nonblocking(true).is_err() {
        return false;
    }
    let alive = match stream.peek(&mut [0u8; 1]) {
        Ok(0) => false,
        Ok(_) => true,
        Err(error) => error.kind() == std::io::ErrorKind::WouldBlock,
    };
    alive && stream.set_nonblocking(false).is_ok()
}

fn serve_client(
    stream: TcpStream,
    active_client: &Mutex<Option<ProgressSocket>>,
    progress: &Mutex<u16>,
) {
    if stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).is_err()
        || stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT)).is_err()
    {
        return;
    }
    let mut client = match tungstenite::accept_hdr(stream, authenticate) {
        Ok(client) => client,
        Err(error) => {
            log::warn!("Rejected setup progress client: {error}");
            return;
        }
    };
    // The server never reads from the page: drop the handshake read timeout, keep a write timeout.
    let stream = client.get_ref();
    if stream.set_read_timeout(None).is_err() || stream.set_write_timeout(Some(WRITE_TIMEOUT)).is_err()
    {
        return;
    }

    // An authenticated client is never displaced by another one; a replacement is only taken
    // over once the existing connection is gone (e.g. the page was reloaded).
    let mut active_client = active_client.lock().unwrap_or_else(|e| e.into_inner());
    if active_client.as_ref().is_some_and(is_alive) {
        log::warn!("Rejected extra setup progress client: one is already connected");
        let _ = client.close(None);
        return;
    }

    let progress = *progress.lock().unwrap_or_else(|e| e.into_inner());
    let message = Message::text(
        json!({
            "progress": progress,
            "message": "Connected to installer",
        })
        .to_string(),
    );
    if client.send(message).is_err() {
        log::info!("Setup progress client disconnected during initial update");
        return;
    }
    log::info!("Setup progress client connected");
    *active_client = Some(client);
}

impl WebviewBackend {
    /// Start accepting connections and listening for messages
    pub fn build(receiver: Receiver<SetupMessage>, progress: Arc<Mutex<u16>>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("Failed to bind socket");
        let socket_port = listener.local_addr().unwrap().port();
        // Generate the token before any client can connect.
        LazyLock::force(&INSTALLER_TOKEN);

        let active_client: Arc<Mutex<Option<ProgressSocket>>> = Arc::new(Mutex::new(None));

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

                let message = Message::text(json_message.to_string());
                let mut active_client = active_client_clone
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());

                if let Some(writer) = active_client.as_mut() {
                    if writer.send(message).is_err() {
                        log::info!("Setup progress client disconnected");
                        *active_client = None;
                    }
                }
            }
        });

        let active_client_clone = active_client.clone();
        let progress_clone = progress.clone();
        thread::spawn(move || {
            let pending = Arc::new(AtomicUsize::new(0));
            for stream in listener.incoming().filter_map(Result::ok) {
                // Every handshake runs on its own thread so one stalled client cannot block the others.
                if pending.fetch_add(1, Ordering::SeqCst) >= MAX_PENDING_HANDSHAKES {
                    pending.fetch_sub(1, Ordering::SeqCst);
                    log::warn!("Too many pending setup progress handshakes, dropping a connection");
                    continue;
                }
                let pending = pending.clone();
                let active_client = active_client_clone.clone();
                let progress = progress_clone.clone();
                let spawned = thread::Builder::new()
                    .name("installer-ws".to_string())
                    .spawn({
                        let pending = pending.clone();
                        move || {
                            serve_client(stream, &active_client, &progress);
                            pending.fetch_sub(1, Ordering::SeqCst);
                        }
                    });
                if spawned.is_err() {
                    pending.fetch_sub(1, Ordering::SeqCst);
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
