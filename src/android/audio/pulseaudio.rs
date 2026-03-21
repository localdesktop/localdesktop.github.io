use crate::android::utils::application_context::get_application_context;
use anyhow::{anyhow, bail, Context, Result};
use flate2::read::GzDecoder;
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Cursor, Read},
    os::unix::fs::{symlink, PermissionsExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::Duration,
};
use tar::{Archive, EntryType};
use xz2::read::XzDecoder;

const TERMUX_REPO_BASE: &str = "https://packages.termux.dev/apt/termux-main";
const TERMUX_PACKAGES_PREFIX: &str = "/data/data/com.termux/files/usr";
const PULSE_SERVER_ADDR: &str = "tcp:127.0.0.1:4713";
const PULSE_SERVER_ENV_VALUE: &str = "127.0.0.1";
const AUDIO_MARKER_FILENAME: &str = ".localdesktop-pulseaudio-ready";

const HOST_AUDIO_PACKAGES: &[&str] = &[
    "abseil-cpp",
    "dbus",
    "libandroid-execinfo",
    "libandroid-glob",
    "libandroid-support",
    "libc++",
    "libexpat",
    "libflac",
    "libiconv",
    "libltdl",
    "libmp3lame",
    "libogg",
    "libopus",
    "libsndfile",
    "libsoxr",
    "libvorbis",
    "libwebrtc-audio-processing",
    "libx11",
    "libxau",
    "libxcb",
    "libxdmcp",
    "pulseaudio",
    "speexdsp",
];

static PULSEAUDIO_CHILD: Mutex<Option<Child>> = Mutex::new(None);

#[derive(Debug)]
struct AudioPaths {
    runtime_root: PathBuf,
    home_dir: PathBuf,
    cache_dir: PathBuf,
    runtime_dir: PathBuf,
    relocated_prefix: String,
}

#[derive(Debug)]
struct TermuxPackageRecord {
    filename: String,
}

fn build_audio_paths() -> Result<AudioPaths> {
    let context = get_application_context();
    let app_data_root = context
        .data_dir
        .parent()
        .context("Android app data root is missing")?;
    let package_name = app_data_root
        .file_name()
        .context("Android package name is missing")?
        .to_string_lossy();

    let runtime_root = app_data_root.join("u");
    let mut relocated_prefix = format!("/data/data/{}/u", package_name);
    if relocated_prefix.len() > TERMUX_PACKAGES_PREFIX.len() {
        bail!(
            "Audio runtime prefix '{}' is too long to relocate Termux binaries",
            relocated_prefix
        );
    }

    let diff = TERMUX_PACKAGES_PREFIX.len() - relocated_prefix.len();
    relocated_prefix.push_str(&"/.".repeat(diff / 2));
    if diff % 2 == 1 {
        relocated_prefix.push('/');
    }

    if relocated_prefix.len() != TERMUX_PACKAGES_PREFIX.len() {
        bail!("Relocated PulseAudio prefix length mismatch");
    }

    Ok(AudioPaths {
        runtime_root,
        home_dir: context.data_dir.join("pulse-home"),
        cache_dir: context.cache_dir.join("pulseaudio"),
        runtime_dir: context.data_dir.join("pulse-runtime"),
        relocated_prefix,
    })
}

fn package_index_url(termux_arch: &str) -> String {
    format!(
        "{}/dists/stable/main/binary-{}/Packages.gz",
        TERMUX_REPO_BASE, termux_arch
    )
}

fn termux_arch() -> Result<&'static str> {
    match std::env::consts::ARCH {
        "aarch64" => Ok("aarch64"),
        "arm" => Ok("arm"),
        "x86_64" => Ok("x86_64"),
        "x86" => Ok("i686"),
        other => bail!(
            "Unsupported Android architecture '{}' for PulseAudio",
            other
        ),
    }
}

fn marker_path(paths: &AudioPaths) -> PathBuf {
    paths.runtime_root.join(AUDIO_MARKER_FILENAME)
}

fn runtime_installed(paths: &AudioPaths) -> bool {
    marker_path(paths).exists()
        && paths.runtime_root.join("bin/pulseaudio").exists()
        && paths.runtime_root.join("bin/pactl").exists()
}

pub fn host_runtime_installed() -> Result<bool> {
    Ok(runtime_installed(&build_audio_paths()?))
}

fn fetch_package_index(termux_arch: &str) -> Result<HashMap<String, TermuxPackageRecord>> {
    let response = reqwest::blocking::get(package_index_url(termux_arch))
        .context("Failed to download Termux package index")?
        .error_for_status()
        .context("Termux package index request failed")?;

    let mut packages = HashMap::new();
    let mut content = String::new();
    GzDecoder::new(Cursor::new(
        response
            .bytes()
            .context("Failed to read Termux package index body")?,
    ))
    .read_to_string(&mut content)
    .context("Failed to decompress Termux package index")?;

    for block in content.split("\n\n") {
        let mut package_name: Option<String> = None;
        let mut filename: Option<String> = None;

        for line in block.lines() {
            if let Some(value) = line.strip_prefix("Package: ") {
                package_name = Some(value.trim().to_string());
            } else if let Some(value) = line.strip_prefix("Filename: ") {
                filename = Some(value.trim().to_string());
            }
        }

        if let (Some(package_name), Some(filename)) = (package_name, filename) {
            packages.insert(package_name, TermuxPackageRecord { filename });
        }
    }

    Ok(packages)
}

fn fetch_package_bytes(filename: &str) -> Result<Vec<u8>> {
    let url = format!("{}/{}", TERMUX_REPO_BASE, filename);
    let response = reqwest::blocking::get(&url)
        .with_context(|| format!("Failed to download '{}'", url))?
        .error_for_status()
        .with_context(|| format!("Request for '{}' failed", url))?;

    response
        .bytes()
        .context("Failed to read Termux package bytes")
        .map(|bytes| bytes.to_vec())
}

fn read_ar_data_member<'a>(package_name: &str, deb: &'a [u8]) -> Result<(&'a str, &'a [u8])> {
    if !deb.starts_with(b"!<arch>\n") {
        bail!("'{}' is not a valid .deb archive", package_name);
    }

    let mut cursor = 8usize;
    while cursor + 60 <= deb.len() {
        let header = &deb[cursor..cursor + 60];
        let member_name = std::str::from_utf8(&header[..16])
            .context("Invalid ar member name")?
            .trim()
            .trim_end_matches('/');
        let member_size = std::str::from_utf8(&header[48..58])
            .context("Invalid ar member size")?
            .trim()
            .parse::<usize>()
            .context("Invalid ar member size value")?;

        cursor += 60;
        if cursor + member_size > deb.len() {
            bail!("'{}' has a truncated ar member", package_name);
        }

        let member_data = &deb[cursor..cursor + member_size];
        if member_name.starts_with("data.tar") {
            return Ok((member_name, member_data));
        }

        cursor += member_size;
        if member_size % 2 == 1 {
            cursor += 1;
        }
    }

    bail!("'{}' does not contain a data.tar member", package_name)
}

fn archive_relative_path(path: &Path) -> Option<PathBuf> {
    let raw = path.to_string_lossy();
    let trimmed = raw.strip_prefix("./").unwrap_or(&raw);
    if trimmed == "data/data/com.termux/files/usr" {
        return Some(PathBuf::new());
    }

    trimmed
        .strip_prefix("data/data/com.termux/files/usr/")
        .map(PathBuf::from)
}

fn rewrite_termux_prefix(bytes: &mut [u8], replacement_prefix: &[u8]) {
    let original = TERMUX_PACKAGES_PREFIX.as_bytes();
    debug_assert_eq!(original.len(), replacement_prefix.len());

    let mut offset = 0usize;
    while let Some(pos) = bytes[offset..]
        .windows(original.len())
        .position(|window| window == original)
    {
        let start = offset + pos;
        let end = start + original.len();
        bytes[start..end].copy_from_slice(replacement_prefix);
        offset = end;
    }
}

fn extract_tar_reader<R: Read>(
    reader: R,
    runtime_root: &Path,
    replacement_prefix: &str,
) -> Result<()> {
    let replacement_prefix_bytes = replacement_prefix.as_bytes();
    let mut archive = Archive::new(reader);

    for entry in archive
        .entries()
        .context("Failed to enumerate package entries")?
    {
        let mut entry = entry.context("Failed to read package entry")?;
        let entry_path = entry
            .path()
            .context("Failed to read package path")?
            .into_owned();
        let Some(relative_path) = archive_relative_path(&entry_path) else {
            continue;
        };

        let entry_type = entry.header().entry_type();
        let destination = if relative_path.as_os_str().is_empty() {
            runtime_root.to_path_buf()
        } else {
            runtime_root.join(&relative_path)
        };

        match entry_type {
            EntryType::Directory => {
                fs::create_dir_all(&destination)
                    .with_context(|| format!("Failed to create '{}'", destination.display()))?;
            }
            EntryType::Symlink => {
                let target = entry
                    .link_name()
                    .context("Failed to read symlink target")?
                    .context("Package symlink target missing")?;
                let mut target = target.to_string_lossy().to_string();
                if target.starts_with(TERMUX_PACKAGES_PREFIX) {
                    target = target.replacen(TERMUX_PACKAGES_PREFIX, replacement_prefix, 1);
                }

                if let Some(parent) = destination.parent() {
                    fs::create_dir_all(parent)
                        .with_context(|| format!("Failed to create '{}'", parent.display()))?;
                }

                let _ = fs::remove_file(&destination);
                let _ = fs::remove_dir_all(&destination);
                symlink(&target, &destination).with_context(|| {
                    format!(
                        "Failed to create symlink '{}' -> '{}'",
                        destination.display(),
                        target
                    )
                })?;
            }
            EntryType::Regular => {
                if let Some(parent) = destination.parent() {
                    fs::create_dir_all(parent)
                        .with_context(|| format!("Failed to create '{}'", parent.display()))?;
                }

                let mut bytes = Vec::new();
                entry
                    .read_to_end(&mut bytes)
                    .with_context(|| format!("Failed to read '{}'", entry_path.display()))?;
                rewrite_termux_prefix(&mut bytes, replacement_prefix_bytes);
                fs::write(&destination, &bytes)
                    .with_context(|| format!("Failed to write '{}'", destination.display()))?;

                if let Ok(mode) = entry.header().mode() {
                    let _ = fs::set_permissions(&destination, fs::Permissions::from_mode(mode));
                }
            }
            _ => {}
        }
    }

    Ok(())
}

fn extract_termux_package(
    package_name: &str,
    deb: &[u8],
    runtime_root: &Path,
    replacement_prefix: &str,
) -> Result<()> {
    let (data_member_name, data_member) = read_ar_data_member(package_name, deb)?;

    if data_member_name.ends_with(".xz") {
        extract_tar_reader(
            XzDecoder::new(Cursor::new(data_member)),
            runtime_root,
            replacement_prefix,
        )
    } else if data_member_name.ends_with(".gz") {
        extract_tar_reader(
            GzDecoder::new(Cursor::new(data_member)),
            runtime_root,
            replacement_prefix,
        )
    } else if data_member_name.ends_with(".tar") {
        extract_tar_reader(Cursor::new(data_member), runtime_root, replacement_prefix)
    } else {
        bail!(
            "Unsupported archive member '{}' in '{}'",
            data_member_name,
            package_name
        )
    }
}

fn write_pulseaudio_overrides(paths: &AudioPaths, runtime_root: &Path) -> Result<()> {
    let override_dir = runtime_root.join("etc/pulse/default.pa.d");
    fs::create_dir_all(&override_dir)
        .with_context(|| format!("Failed to create '{}'", override_dir.display()))?;
    fs::write(
        override_dir.join("localdesktop.pa"),
        "load-module module-native-protocol-tcp listen=127.0.0.1 port=4713 auth-ip-acl=127.0.0.1 auth-anonymous=true\n",
    )
    .context("Failed to write PulseAudio TCP override")?;

    let marker = runtime_root.join(AUDIO_MARKER_FILENAME);
    fs::write(&marker, format!("prefix={}\n", paths.relocated_prefix))
        .with_context(|| format!("Failed to write '{}'", marker.display()))?;

    Ok(())
}

fn prepare_runtime_dirs(paths: &AudioPaths) -> Result<()> {
    for directory in [
        &paths.home_dir,
        &paths.cache_dir,
        &paths.runtime_dir,
        &paths.home_dir.join(".config"),
        &paths.home_dir.join(".cache"),
        &paths.runtime_dir.join("pulse"),
        &paths.cache_dir.join("tmp"),
    ] {
        fs::create_dir_all(directory)
            .with_context(|| format!("Failed to create '{}'", directory.display()))?;
    }

    let _ = fs::set_permissions(&paths.runtime_dir, fs::Permissions::from_mode(0o700));
    let _ = fs::set_permissions(
        paths.runtime_dir.join("pulse"),
        fs::Permissions::from_mode(0o700),
    );

    Ok(())
}

fn clear_stale_runtime_state(paths: &AudioPaths) {
    for path in [
        paths.runtime_dir.join("pulse/native"),
        paths.runtime_dir.join("pulse/pid"),
    ] {
        let _ = fs::remove_file(path);
    }
}

fn configure_runtime_env(command: &mut Command, paths: &AudioPaths) {
    let library_path = runtime_library_path(paths);

    command
        .env("HOME", &paths.home_dir)
        .env("TMPDIR", paths.cache_dir.join("tmp"))
        .env("XDG_CACHE_HOME", paths.home_dir.join(".cache"))
        .env("XDG_CONFIG_HOME", paths.home_dir.join(".config"))
        .env("XDG_RUNTIME_DIR", &paths.runtime_dir)
        .env("PULSE_RUNTIME_PATH", paths.runtime_dir.join("pulse"))
        .env("LD_LIBRARY_PATH", library_path)
        .env(
            "PATH",
            format!(
                "{}:/system/bin:/system/xbin",
                paths.runtime_root.join("bin").display()
            ),
        );
}

fn runtime_library_path(paths: &AudioPaths) -> String {
    format!(
        "{}:{}:{}",
        paths.runtime_root.join("lib").display(),
        paths.runtime_root.join("lib/pulseaudio").display(),
        paths.runtime_root.join("lib/pulseaudio/modules").display()
    )
}

fn runtime_binary_command(binary_name: &str, paths: &AudioPaths) -> Command {
    let context = get_application_context();
    let binary_path = paths.runtime_root.join("bin").join(binary_name);
    let loader_path = context.data_dir.join("ld-linux-aarch64.so.1");

    let mut command = if loader_path.exists() {
        let mut command = Command::new(loader_path);
        command
            .arg("--library-path")
            .arg(runtime_library_path(paths))
            .arg(&binary_path);
        command
    } else {
        Command::new(&binary_path)
    };

    configure_runtime_env(&mut command, paths);
    command
}

fn audio_client_command(binary_name: &str, paths: &AudioPaths) -> Command {
    let mut command = runtime_binary_command(binary_name, paths);
    command.env("PULSE_SERVER", PULSE_SERVER_ADDR);
    command
}

fn server_responding(paths: &AudioPaths) -> bool {
    audio_client_command("pactl", paths)
        .arg("info")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

pub fn pulse_server_env_value() -> &'static str {
    PULSE_SERVER_ENV_VALUE
}

pub fn install_host_runtime_with_progress<F>(mut progress: F) -> Result<()>
where
    F: FnMut(String),
{
    let paths = build_audio_paths()?;
    if runtime_installed(&paths) {
        return Ok(());
    }

    let termux_arch = termux_arch()?;
    let package_index = fetch_package_index(termux_arch)?;
    let staging_root = paths.runtime_root.with_extension("new");

    let _ = fs::remove_dir_all(&staging_root);
    fs::create_dir_all(&staging_root)
        .with_context(|| format!("Failed to create '{}'", staging_root.display()))?;

    progress("Installing Android audio runtime...".to_string());
    for (index, package_name) in HOST_AUDIO_PACKAGES.iter().enumerate() {
        let Some(record) = package_index.get(*package_name) else {
            bail!(
                "Termux package '{}' is missing from the repository index",
                package_name
            );
        };

        progress(format!(
            "Installing Android audio runtime... ({}/{})",
            index + 1,
            HOST_AUDIO_PACKAGES.len()
        ));
        let deb = fetch_package_bytes(&record.filename)?;
        extract_termux_package(package_name, &deb, &staging_root, &paths.relocated_prefix)?;
    }

    write_pulseaudio_overrides(&paths, &staging_root)?;

    let _ = fs::remove_dir_all(&paths.runtime_root);
    fs::rename(&staging_root, &paths.runtime_root).with_context(|| {
        format!(
            "Failed to move '{}' to '{}'",
            staging_root.display(),
            paths.runtime_root.display()
        )
    })?;

    Ok(())
}

pub fn ensure_host_runtime_installed() -> Result<()> {
    install_host_runtime_with_progress(|_| {})
}

pub fn ensure_started() -> Result<()> {
    ensure_host_runtime_installed()?;
    let paths = build_audio_paths()?;
    prepare_runtime_dirs(&paths)?;

    if server_responding(&paths) {
        return Ok(());
    }

    let mut child_guard = PULSEAUDIO_CHILD
        .lock()
        .map_err(|_| anyhow!("PulseAudio process mutex was poisoned"))?;

    if let Some(child) = child_guard.as_mut() {
        match child.try_wait() {
            Ok(None) => {
                for _ in 0..20 {
                    if server_responding(&paths) {
                        return Ok(());
                    }
                    thread::sleep(Duration::from_millis(250));
                }
                bail!("PulseAudio is running but never became reachable");
            }
            Ok(Some(status)) => {
                log::info!("PulseAudio exited before reuse with status {:?}", status);
                *child_guard = None;
            }
            Err(err) => {
                log::info!("Failed to query PulseAudio child status: {}", err);
                *child_guard = None;
            }
        }
    }

    clear_stale_runtime_state(&paths);

    let mut command = runtime_binary_command("pulseaudio", &paths);
    command
        .arg("--daemonize=no")
        .arg("--exit-idle-time=-1")
        .arg("--use-pid-file=no")
        .arg("--system=false")
        .arg("-n")
        .arg("-F")
        .arg(paths.runtime_root.join("etc/pulse/default.pa"))
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = command.spawn().context("Failed to start PulseAudio")?;
    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                log::info!("pulseaudio: {}", line);
            }
        });
    }
    *child_guard = Some(child);
    drop(child_guard);

    for _ in 0..20 {
        if server_responding(&paths) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }

    bail!("PulseAudio did not become reachable after startup")
}
