//! Downloads that are only accepted when they match a pinned SHA-256 and size.
//!
//! HTTPS only, bounded retries with resume (`Range`), stall timeouts, and no partial or
//! unverified file is ever left under the destination name.

use crate::core::config::PinnedAsset;
use reqwest::{blocking::Client, header::RANGE, StatusCode};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

const MAX_ATTEMPTS: usize = 5;
/// Time to establish the TCP/TLS connection.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Longest wait for response headers or for the next chunk of the body (reqwest's blocking
/// `timeout` applies to each of those reads, not to the whole transfer).
const STALL_TIMEOUT: Duration = Duration::from_secs(60);
const BUFFER_SIZE: usize = 64 * 1024;

/// Lowercase hex SHA-256 of a file, streamed.
pub fn sha256_file(path: &Path) -> io::Result<String> {
    let mut hasher = Sha256::new();
    hash_reader(&mut File::open(path)?, &mut hasher)?;
    Ok(hex(&hasher.finalize()))
}

fn hash_reader(reader: &mut impl Read, hasher: &mut Sha256) -> io::Result<u64> {
    let mut buffer = vec![0u8; BUFFER_SIZE];
    let mut total = 0;
    loop {
        let n = reader.read(&mut buffer)?;
        if n == 0 {
            return Ok(total);
        }
        hasher.update(&buffer[..n]);
        total += n as u64;
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `Ok(())` when `path` has exactly the pinned size and hash.
pub fn verify_file(path: &Path, asset: &PinnedAsset) -> Result<(), String> {
    let size = fs::metadata(path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?
        .len();
    if size != asset.size {
        return Err(format!(
            "size mismatch for {}: {size} bytes, expected {}",
            asset.name, asset.size
        ));
    }
    let digest = sha256_file(path).map_err(|e| format!("cannot hash {}: {e}", path.display()))?;
    if digest != asset.sha256 {
        return Err(sha_mismatch(asset, &digest));
    }
    Ok(())
}

fn sha_mismatch(asset: &PinnedAsset, got: &str) -> String {
    format!(
        "SHA-256 mismatch for {}: expected {}, got {got}",
        asset.name, asset.sha256
    )
}

fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    dest.with_file_name(name)
}

/// Makes sure `dest` holds the pinned asset: an existing file is re-verified and kept when it
/// matches, otherwise the asset is downloaded (resuming a partial `<dest>.part`), verified
/// and renamed into place. `progress` receives human-readable status lines for the setup UI.
///
/// Returns a descriptive error after `MAX_ATTEMPTS` failed attempts; the destination then
/// does not exist, and a verified-but-wrong or oversized partial file has been deleted.
pub fn download_verified(
    asset: &PinnedAsset,
    dest: &Path,
    progress: &dyn Fn(String),
) -> Result<(), String> {
    if dest.exists() {
        match verify_file(dest, asset) {
            Ok(()) => return Ok(()),
            Err(error) => {
                log::warn!("Discarding existing {}: {error}", dest.display());
                let _ = fs::remove_file(dest);
            }
        }
    }

    let client = Client::builder()
        .https_only(true)
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(STALL_TIMEOUT)
        .build()
        .map_err(|e| format!("cannot create the HTTPS client: {e}"))?;
    let part = part_path(dest);

    let mut last_error = String::new();
    for attempt in 1..=MAX_ATTEMPTS {
        let url = asset.urls[(attempt - 1) % asset.urls.len()];
        match attempt_download(&client, url, &part, asset, progress) {
            Ok(()) => {
                return fs::rename(&part, dest).map_err(|e| {
                    let _ = fs::remove_file(&part);
                    format!("cannot move {} into place: {e}", asset.name)
                });
            }
            Err(error) => {
                log::warn!(
                    "Download of {} from {url} failed (attempt {attempt}/{MAX_ATTEMPTS}): {error}",
                    asset.name
                );
                last_error = error;
                if attempt < MAX_ATTEMPTS {
                    progress(format!(
                        "Download of {} failed ({last_error}). Retrying ({}/{MAX_ATTEMPTS})...",
                        asset.name,
                        attempt + 1
                    ));
                    thread::sleep(Duration::from_secs((2u64 << attempt).min(30)));
                }
            }
        }
    }

    let _ = fs::remove_file(&part);
    Err(format!(
        "Could not download {} after {MAX_ATTEMPTS} attempts: {last_error}. Check your network connection and restart the app.",
        asset.name
    ))
}

/// One download attempt into `part`. Keeps the partial file when it can be resumed, deletes it
/// when it can never become the pinned file.
fn attempt_download(
    client: &Client,
    url: &str,
    part: &Path,
    asset: &PinnedAsset,
    progress: &dyn Fn(String),
) -> Result<(), String> {
    let mut hasher = Sha256::new();
    let mut offset = 0u64;

    if let Ok(meta) = fs::metadata(part) {
        if meta.len() > 0 && meta.len() < asset.size {
            // Resume: the bytes already on disk are hashed first.
            match File::open(part).and_then(|mut f| hash_reader(&mut f, &mut hasher)) {
                Ok(n) => offset = n,
                Err(_) => {
                    hasher = Sha256::new();
                    let _ = fs::remove_file(part);
                }
            }
        } else {
            let _ = fs::remove_file(part);
        }
    }

    let mut request = client.get(url);
    if offset > 0 {
        request = request.header(RANGE, format!("bytes={offset}-"));
    }
    let response = request
        .send()
        .map_err(|e| format!("request to {url} failed: {e}"))?;
    let status = response.status();
    if status == StatusCode::RANGE_NOT_SATISFIABLE {
        let _ = fs::remove_file(part);
        return Err("server rejected the resume request, restarting".to_string());
    }
    let mut response = response
        .error_for_status()
        .map_err(|e| format!("server answered with an error: {e}"))?;

    let opened = if offset > 0 && status == StatusCode::PARTIAL_CONTENT {
        OpenOptions::new().append(true).open(part)
    } else {
        // Fresh download, or the server ignored the Range header and sent everything.
        hasher = Sha256::new();
        offset = 0;
        File::create(part)
    };
    let mut file = opened.map_err(|e| format!("cannot open {}: {e}", part.display()))?;

    let mut received = offset;
    let mut last_percent = u64::MAX;
    let mut buffer = vec![0u8; BUFFER_SIZE];
    loop {
        let n = response
            .read(&mut buffer)
            .map_err(|e| format!("connection interrupted: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
        file.write_all(&buffer[..n])
            .map_err(|e| format!("cannot write {}: {e}", part.display()))?;
        received += n as u64;

        if received > asset.size {
            drop(file);
            let _ = fs::remove_file(part);
            return Err(format!(
                "{url} sent more than the expected {} bytes",
                asset.size
            ));
        }
        let percent = received * 100 / asset.size;
        if percent != last_percent {
            last_percent = percent;
            progress(format!(
                "Downloading {}... {percent}% ({:.2} MB / {:.2} MB)",
                asset.name,
                received as f64 / 1024.0 / 1024.0,
                asset.size as f64 / 1024.0 / 1024.0
            ));
        }
    }
    file.flush()
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("cannot flush {}: {e}", part.display()))?;
    drop(file);

    if received != asset.size {
        // Truncated transfer: keep the bytes, the next attempt resumes.
        return Err(format!(
            "download ended after {received} of {} bytes",
            asset.size
        ));
    }
    let digest = hex(&hasher.finalize());
    if digest != asset.sha256 {
        let _ = fs::remove_file(part);
        return Err(sha_mismatch(asset, &digest));
    }
    Ok(())
}
