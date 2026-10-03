use super::download::download_verified;
use super::optional::{setup_gpu, setup_x86};
use super::process::ArchProcess;
use crate::{
    android::{
        app::build::PolarBearBackend,
        backend::{
            wayland::WaylandBackend,
            webview::{ErrorVariant, WebviewBackend},
        },
        utils::application_context::get_application_context,
        utils::ndk::density_dpi,
    },
    core::{
        config::{
            merge_settings_template, CommandConfig, ARCH_FS_ARCHIVE_ASSET, ARCH_FS_ROOT,
            CONFIG_FILE, DOCS_HOME_URL,
        },
        guest,
    },
};
use pathdiff::diff_paths;
use std::{
    fs::{self, File},
    io::ErrorKind,
    os::unix::fs::{symlink, PermissionsExt},
    path::{Path, PathBuf},
    process,
    sync::{
        mpsc::{self, Sender},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{SystemTime, UNIX_EPOCH},
};
use tar::Archive;
use winit::platform::android::activity::AndroidApp;
use xz2::read::XzDecoder;

#[derive(Debug)]
pub enum SetupMessage {
    Progress(String),
    Error(String),
}

pub struct SetupOptions {
    pub android_app: AndroidApp,
    pub mpsc_sender: Sender<SetupMessage>,
}

/// Setup is a process that should be done **only once** when the user installed the app.
/// The setup process consists of several stages.
/// Each stage is a function that takes the `SetupOptions` and returns a `StageOutput`.
type SetupStage = Box<dyn Fn(&SetupOptions) -> StageOutput + Send>;

/// Each stage should indicate whether the associated task is done previously or not.
/// Thus, it should return a finished status if the task is done, so that the setup process can move on to the next stage.
/// Otherwise, it should return a `JoinHandle`, so that the setup process can wait for the task to finish, but not block the main thread so that the setup progress can be reported to the user.
///
/// For coding agents: READ THIS BEFORE ADDING WORK HERE.
/// - Heavy/long work belongs inside the spawned thread of a returned `Some(JoinHandle)`, so it runs once at install and surfaces as setup progress.
/// - Simple/light tasks or important settings that must be run every launch (e.g. the Firefox config) can be done inline on the `None` path.
type StageOutput = Option<JoinHandle<()>>;

const PIPEWIRE_GUEST_LOCK_PACKAGES: &[&str] = &[
    "libpipewire",
    "pipewire",
    "pipewire-alsa",
    "pipewire-audio",
    "pipewire-jack",
    "pipewire-pulse",
    "pipewire-v4l2",
    "pipewire-zeroconf",
    "gst-plugin-pipewire",
    "wireplumber",
];

fn setup_arch_fs(options: &SetupOptions) -> StageOutput {
    const MAX_EXTRACT_ATTEMPTS: usize = 3;

    let context = get_application_context();
    let temp_file = context.data_dir.join("archlinux-fs.tar.xz");
    let fs_root = Path::new(ARCH_FS_ROOT);
    let data_dir = context.data_dir.clone();
    let extracted_dir = context.data_dir.join("archlinux-aarch64");
    let mpsc_sender = options.mpsc_sender.clone();

    // Only run if the fs_root is missing or empty
    // TODO: Setup integration test to make sure on clean install, the fs_root is either non existent or empty
    let need_setup = fs_root.read_dir().map_or(true, |mut d| d.next().is_none());
    if need_setup {
        return Some(thread::spawn(move || {
            let progress = |message: String| {
                mpsc_sender.send(SetupMessage::Progress(message)).unwrap_or(());
            };

            let mut extracted = false;
            for attempt in 1..=MAX_EXTRACT_ATTEMPTS {
                // Download, or re-verify a file left by an earlier run. The archive is only
                // accepted when size and SHA-256 match the pinned release; the error of a
                // failed download is surfaced to the setup UI by the stage failure handler.
                if let Err(error) = download_verified(&ARCH_FS_ARCHIVE_ASSET, &temp_file, &progress)
                {
                    panic!("{error}");
                }

                progress("Extracting Arch Linux FS...".to_string());

                // Ensure the extracted directory is clean
                let _ = fs::remove_dir_all(&extracted_dir);

                // Extract tar file directly to the final destination
                let result = File::open(&temp_file)
                    .map_err(|e| format!("cannot open the downloaded archive: {e}"))
                    .and_then(|tar_file| {
                        Archive::new(XzDecoder::new(tar_file))
                            .unpack(&data_dir)
                            .map_err(|e| e.to_string())
                    });

                match result {
                    Ok(()) => {
                        extracted = true;
                        break;
                    }
                    Err(error) => {
                        // The archive passed its checksum, so this is a local problem (disk full,
                        // storage error). Clean up and try again, a bounded number of times.
                        let _ = fs::remove_dir_all(&extracted_dir);
                        let _ = fs::remove_file(&temp_file);
                        mpsc_sender
                            .send(SetupMessage::Error(format!(
                                "Failed to extract Arch Linux FS: {error} (attempt {attempt}/{MAX_EXTRACT_ATTEMPTS})"
                            )))
                            .unwrap_or(());
                    }
                }
            }
            if !extracted {
                panic!(
                    "Could not extract the Arch Linux FS after {MAX_EXTRACT_ATTEMPTS} attempts. Check the free storage space and restart the app."
                );
            }

            // Move the extracted files to the final destination
            fs::rename(&extracted_dir, fs_root)
                .expect("Failed to rename extracted files to final destination");

            // Clean up the temporary file
            let _ = fs::remove_file(&temp_file);
        }));
    }
    None
}

fn simulate_linux_sysdata_stage(options: &SetupOptions) -> StageOutput {
    let fs_root = Path::new(ARCH_FS_ROOT);
    let mpsc_sender = options.mpsc_sender.clone();

    if !fs_root.join("proc/.version").exists() {
        return Some(thread::spawn(move || {
            mpsc_sender
                .send(SetupMessage::Progress(
                    "Simulating Linux system data...".to_string(),
                ))
                .expect(&format!("Failed to send log message"));

            // Create necessary directories - don't fail if they already exist
            let _ = fs::create_dir_all(fs_root.join("proc"));
            let _ = fs::create_dir_all(fs_root.join("sys"));
            let _ = fs::create_dir_all(fs_root.join("sys/.empty"));

            // Set permissions - only try to set permissions if we're on Unix and have the capability
            #[cfg(unix)]
            {
                // Try to set permissions, but don't fail if we can't
                let _ =
                    fs::set_permissions(fs_root.join("proc"), fs::Permissions::from_mode(0o700));
                let _ = fs::set_permissions(fs_root.join("sys"), fs::Permissions::from_mode(0o700));
                let _ = fs::set_permissions(
                    fs_root.join("sys/.empty"),
                    fs::Permissions::from_mode(0o700),
                );
            }

            // Create fake proc files
            let proc_files = [
                    ("proc/.loadavg", "0.12 0.07 0.02 2/165 765\n"),
                    ("proc/.stat", "cpu  1957 0 2877 93280 262 342 254 87 0 0\ncpu0 31 0 226 12027 82 10 4 9 0 0\n"),
                    ("proc/.uptime", "124.08 932.80\n"),
                    ("proc/.version", "Linux version 6.2.1 (proot@termux) (gcc (GCC) 12.2.1 20230201, GNU ld (GNU Binutils) 2.40) #1 SMP PREEMPT_DYNAMIC Wed, 01 Mar 2023 00:00:00 +0000\n"),
                    ("proc/.vmstat", "nr_free_pages 1743136\nnr_zone_inactive_anon 179281\nnr_zone_active_anon 7183\n"),
                    ("proc/.sysctl_entry_cap_last_cap", "40\n"),
                    ("proc/.sysctl_inotify_max_user_watches", "4096\n"),
                ];

            for (path, content) in proc_files {
                let _ = fs::write(fs_root.join(path), content)
                    .expect(&format!("Permission denied while writing to {}", path));
            }
        }));
    }
    None
}

fn setup_machine_id(_: &SetupOptions) -> StageOutput {
    let fs_root = Path::new(ARCH_FS_ROOT);
    let machine_id = fs_root.join("etc/machine-id");

    let existing = fs::read_to_string(&machine_id).unwrap_or_default();
    if !is_valid_machine_id(&existing) {
        if let Some(parent) = machine_id.parent() {
            fs::create_dir_all(parent).expect("Failed to create /etc for machine-id");
        }

        let _ = fs::set_permissions(&machine_id, fs::Permissions::from_mode(0o644));
        fs::write(&machine_id, format!("{}\n", generate_machine_id()))
            .expect("Failed to write machine-id");
        let _ = fs::set_permissions(&machine_id, fs::Permissions::from_mode(0o444));
        log::info!("Seeded guest /etc/machine-id");
    }

    let dbus_dir = fs_root.join("var/lib/dbus");
    fs::create_dir_all(&dbus_dir).expect("Failed to create /var/lib/dbus");
    let dbus_machine_id = dbus_dir.join("machine-id");
    match fs::symlink_metadata(&dbus_machine_id) {
        Ok(_) => {}
        Err(err) if err.kind() == ErrorKind::NotFound => {
            symlink("/etc/machine-id", &dbus_machine_id)
                .expect("Failed to symlink /var/lib/dbus/machine-id");
        }
        Err(err) => panic!("Failed to inspect /var/lib/dbus/machine-id: {}", err),
    }

    None
}

fn is_valid_machine_id(value: &str) -> bool {
    let value = value.trim();
    value.len() == 32
        && value.chars().all(|c| c.is_ascii_hexdigit())
        && value.chars().any(|c| c != '0')
}

fn generate_machine_id() -> String {
    if let Ok(uuid) = fs::read_to_string("/proc/sys/kernel/random/uuid") {
        let id = uuid.trim().replace('-', "").to_ascii_lowercase();
        if is_valid_machine_id(&id) {
            return id;
        }
    }

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{:016x}{:016x}", nanos as u64, process::id() as u64)
}

fn install_dependencies(options: &SetupOptions) -> StageOutput {
    let SetupOptions {
        mpsc_sender,
        android_app: _,
    } = options;

    let context = get_application_context();
    let CommandConfig {
        check,
        install,
        launch: _,
    } = context.local_config.command;

    let installed = move || {
        ArchProcess {
            command: check.clone(),
            user: None,
            log: None,
        }
        .run()
        .status
        .success()
    };

    if installed() {
        return None;
    }

    clear_pipewire_package_lock_for_install();

    let mpsc_sender = mpsc_sender.clone();
    return Some(thread::spawn(move || {
        const MAX_INSTALL_ATTEMPTS: usize = 10;

        // Install dependencies until `check` succeeds.
        for attempt in 1..=MAX_INSTALL_ATTEMPTS {
            let output = ArchProcess {
                command: "rm -f /var/lib/pacman/db.lck".into(),
                user: None,
                log: None,
            }
            .run();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let sender = mpsc_sender.clone();
            ArchProcess {
                command: install.clone(),
                user: None,
                log: Some(Arc::new(move |it| {
                    sender
                        .send(SetupMessage::Progress(it))
                        .expect("Failed to send log message");
                })),
            }
            .run();

            if installed() {
                download_user_manual();
                return;
            }
            mpsc_sender
                .send(SetupMessage::Progress(format!(
                    "Retrying installation... (attempt {}/{})",
                    attempt, MAX_INSTALL_ATTEMPTS
                )))
                .expect("Failed to send dependency install progress");

            if attempt == MAX_INSTALL_ATTEMPTS {
                let error_message = format!(
                    "Failed to install desktop dependencies after {} attempts. Please check your net connection and try restarting the app.",
                    MAX_INSTALL_ATTEMPTS
                );
                mpsc_sender
                    .send(SetupMessage::Error(error_message.clone()))
                    .unwrap_or(());
                panic!("{}", error_message);
            }
        }
    }));
}

/// Drop the offline User Manual for this app version onto the guest desktop.
///
/// The filename carries no version so an update overwrites the previous copy instead of landing
/// beside it. Called once a fresh install or update has just succeeded — the only moment the
/// manual on disk can be out of date — and best-effort: a failed download is not worth a retry.
fn download_user_manual() {
    let username = get_application_context().local_config.user.username;
    let desktop_dir = chroot_home_dir(Path::new(ARCH_FS_ROOT), &username).join("Desktop");
    if fs::create_dir_all(&desktop_dir).is_err() {
        return;
    }

    let url = crate::core::config::user_manual_url();
    let response = reqwest::blocking::get(&url).and_then(|it| it.error_for_status());
    if let Ok(bytes) = response.and_then(|it| it.bytes()) {
        let _ = fs::write(desktop_dir.join("Local Desktop - User Manual.pdf"), &bytes);
    }
}

fn clear_pipewire_package_lock_for_install() {
    let pacman_conf = Path::new(ARCH_FS_ROOT).join("etc/pacman.conf");
    let content = match fs::read_to_string(&pacman_conf) {
        Ok(content) => content,
        Err(error) => {
            log::warn!(
                "Skipping PipeWire pacman unlock before install; failed to read {}: {error}",
                pacman_conf.display()
            );
            return;
        }
    };

    let updated = remove_pacman_ignore_pkg(&content, PIPEWIRE_GUEST_LOCK_PACKAGES);
    if updated != content {
        fs::write(&pacman_conf, updated)
            .expect("Failed to clear PipeWire pacman lock before install");
        log::info!("Temporarily cleared guest PipeWire package lock before dependency install");
    }
}

fn setup_pipewire_package_lock(_: &SetupOptions) -> StageOutput {
    let pacman_conf = Path::new(ARCH_FS_ROOT).join("etc/pacman.conf");
    let content = match fs::read_to_string(&pacman_conf) {
        Ok(content) => content,
        Err(error) => {
            log::warn!(
                "Skipping PipeWire pacman lock; failed to read {}: {error}",
                pacman_conf.display()
            );
            return None;
        }
    };

    let updated = ensure_pacman_ignore_pkg(&content, PIPEWIRE_GUEST_LOCK_PACKAGES);
    if updated != content {
        fs::write(&pacman_conf, updated).expect("Failed to write PipeWire pacman lock");
        log::info!(
            "Locked guest PipeWire packages in {}: {}",
            pacman_conf.display(),
            PIPEWIRE_GUEST_LOCK_PACKAGES.join(" ")
        );
    }

    None
}

/// Switches pacman to HTTPS mirrors. The mirror list shipped in the rootfs archive uses plain
/// HTTP (packages are signature-checked, but the transport leaked what is installed and let
/// a network attacker withhold updates). Rewritten only while it still has plain-HTTP servers,
/// so a list the user edited to HTTPS mirrors is left alone.
fn setup_pacman_mirrors(_: &SetupOptions) -> StageOutput {
    let mirrorlist = Path::new(ARCH_FS_ROOT).join("etc/pacman.d/mirrorlist");
    let Ok(content) = fs::read_to_string(&mirrorlist) else {
        log::warn!("Skipping the HTTPS mirror switch; cannot read {}", mirrorlist.display());
        return None;
    };

    if guest::mirrorlist_has_plain_http(&content) {
        let backup = mirrorlist.with_extension("localdesktop-http.bak");
        if !backup.exists() {
            let _ = fs::write(&backup, &content);
        }
        fs::write(&mirrorlist, guest::managed_mirrorlist())
            .expect("Failed to write the HTTPS pacman mirror list");
        log::info!("Switched the pacman mirror list to HTTPS mirrors");
    }
    None
}

/// The rootfs archive ships a pacman signing key pair that is identical on every installation.
/// Replace it once by a freshly generated one (see `keyring-regen.sh`: built aside and swapped
/// in only when complete, so a failure keeps the working keyring).
fn setup_pacman_keyring(options: &SetupOptions) -> StageOutput {
    const MAX_ATTEMPTS: u32 = 3;
    let fs_root = Path::new(ARCH_FS_ROOT);
    let marker = fs_root.join("etc/pacman.d/.localdesktop-keyring");

    if !fs_root.join("usr/bin/pacman-key").exists() {
        return None;
    }
    let state = fs::read_to_string(&marker).unwrap_or_default();
    let failed_attempts = state
        .trim()
        .strip_prefix("failed-")
        .and_then(|n| n.parse::<u32>().ok())
        .unwrap_or(0);
    if state.trim() == "ok" || failed_attempts >= MAX_ATTEMPTS {
        return None;
    }

    let mpsc_sender = options.mpsc_sender.clone();
    Some(thread::spawn(move || {
        let _ = mpsc_sender.send(SetupMessage::Progress(
            "Generating a fresh pacman signing key (one time)...".to_string(),
        ));

        let script = Path::new(ARCH_FS_ROOT).join("tmp/localdesktop-keyring-regen.sh");
        write_executable(&script, guest::KEYRING_REGEN_SCRIPT);
        let sender = mpsc_sender.clone();
        let output = ArchProcess {
            command: "sh /tmp/localdesktop-keyring-regen.sh 2>&1".into(),
            user: None,
            log: Some(Arc::new(move |line| {
                let _ = sender.send(SetupMessage::Progress(line));
            })),
        }
        .run();
        let _ = fs::remove_file(&script);

        if output.status.success() {
            let _ = fs::write(&marker, "ok\n");
        } else {
            let attempts = failed_attempts + 1;
            let _ = fs::write(&marker, format!("failed-{attempts}\n"));
            log::warn!("pacman keyring regeneration failed ({attempts}/{MAX_ATTEMPTS}); the shipped keyring stays in use");
            let _ = mpsc_sender.send(SetupMessage::Progress(format!(
                "Could not generate a fresh pacman key (attempt {attempts}/{MAX_ATTEMPTS}); keeping the existing keyring."
            )));
        }
    }))
}

/// Per-start guest tuning: parallel `makepkg`, and the session environment file that
/// `startxfce4-localdesktop` sources (llvmpipe threads, software-rendering defaults, or the
/// opt-in GPU environment). Cheap, so it runs on every start and always follows the config.
fn setup_guest_tuning(_: &SetupOptions) -> StageOutput {
    let fs_root = Path::new(ARCH_FS_ROOT);
    let config = get_application_context().local_config;

    let makepkg_conf = fs_root.join("etc/makepkg.conf");
    if let Ok(content) = fs::read_to_string(&makepkg_conf) {
        if let Some(updated) = guest::ensure_makeflags(&content) {
            match fs::write(&makepkg_conf, updated) {
                Ok(()) => log::info!("Enabled parallel builds in makepkg.conf"),
                Err(error) => log::warn!("Could not update makepkg.conf: {error}"),
            }
        }
    }

    let cpus = thread::available_parallelism().map_or(1, |n| n.get());
    let guest_path = |path: &str| fs_root.join(path.trim_start_matches('/'));
    write_if_changed(
        &guest_path(guest::SESSION_ENV_PATH),
        &guest::session_env(&config, cpus),
        0o644,
    );
    let gpu_env = guest_path(guest::GPU_ENV_PATH);
    if config.gpu.enabled {
        write_if_changed(&gpu_env, &guest::gpu_env(&config.gpu), 0o644);
    } else {
        let _ = fs::remove_file(&gpu_env);
    }
    None
}

/// Settings discoverability and the opt-in update path: a commented template of every key in
/// `localdesktop.toml` (an existing file only gets missing commented sections appended), the
/// `localdesktop-update` and `localdesktop-gpu-probe` commands, and their menu launchers.
fn setup_settings(_: &SetupOptions) -> StageOutput {
    let fs_root = Path::new(ARCH_FS_ROOT);
    let config = get_application_context().local_config;

    let config_path = fs_root.join(CONFIG_FILE.trim_start_matches('/'));
    let existing = match fs::read_to_string(&config_path) {
        Ok(content) => Some(content),
        Err(error) if error.kind() == ErrorKind::NotFound => Some(String::new()),
        Err(error) => {
            log::warn!("Leaving {} alone: {error}", config_path.display());
            None
        }
    };
    if let Some(existing) = existing {
        let merged = merge_settings_template(&existing);
        if merged != existing {
            if let Some(parent) = config_path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            fs::write(&config_path, merged).expect("Failed to write the settings template");
        }
    }

    let bin = fs_root.join("usr/local/bin");
    write_if_changed(&bin.join("localdesktop-update"), guest::UPDATE_SCRIPT, 0o755);
    write_if_changed(
        &bin.join("localdesktop-gpu-probe"),
        &guest::render_gpu_probe(),
        0o755,
    );

    // Menu entries are managed (rewritten when they differ); desktop icons are seeded elsewhere.
    let applications = fs_root.join("usr/local/share/applications");
    write_if_changed(
        &applications.join("localdesktop-settings.desktop"),
        &guest::settings_desktop_entry(),
        0o644,
    );
    write_if_changed(
        &applications.join("localdesktop-update.desktop"),
        &guest::update_desktop_entry(),
        0o644,
    );
    let gpu_probe_entry = applications.join("localdesktop-gpu-probe.desktop");
    if config.gpu.enabled {
        write_if_changed(&gpu_probe_entry, &guest::gpu_probe_desktop_entry(), 0o644);
    } else {
        let _ = fs::remove_file(&gpu_probe_entry);
    }
    None
}

fn setup_firefox_config(_: &SetupOptions) -> StageOutput {
    // Create the Firefox root directory if it doesn't exist
    let firefox_root = format!("{}/usr/lib/firefox", ARCH_FS_ROOT);
    let _ = fs::create_dir_all(&firefox_root).expect("Failed to create Firefox root directory");

    // Create the defaults/pref directory
    let pref_dir = format!("{}/defaults/pref", firefox_root);
    let _ = fs::create_dir_all(&pref_dir).expect("Failed to create Firefox pref directory");

    // Create autoconfig.js in defaults/pref
    let autoconfig_js = r#"pref("general.config.filename", "localdesktop.cfg");
pref("general.config.obscure_value", 0);
pref("general.config.sandbox_enabled", false);
"#;

    let _ = fs::write(format!("{}/autoconfig.js", pref_dir), autoconfig_js)
        .expect("Failed to write Firefox autoconfig.js");

    // Create localdesktop.cfg in the Firefox root directory: the sandbox preferences proot
    // needs, plus CPU-rendering preferences while the GPU option is off.
    let gpu_enabled = get_application_context().local_config.gpu.enabled;
    let _ = fs::write(
        format!("{}/localdesktop.cfg", firefox_root),
        guest::firefox_autoconfig(gpu_enabled),
    )
    .expect("Failed to write Firefox configuration");

    None
}

#[derive(Debug)]
enum KvLine {
    Entry {
        key: String,
        value: String,
        prefix: String,
        delimiter: char,
    },
    Other(String),
}

fn parse_kv_lines(content: &str, delimiter: char) -> Vec<KvLine> {
    content
        .lines()
        .map(|line| {
            let trimmed = line.trim_start();
            if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('!') {
                return KvLine::Other(line.to_string());
            }
            if let Some((left, right)) = line.split_once(delimiter) {
                let key = left.trim().to_string();
                if key.is_empty() {
                    return KvLine::Other(line.to_string());
                }
                let prefix_len = line.len() - trimmed.len();
                let prefix = line[..prefix_len].to_string();
                let value = right.trim().to_string();
                KvLine::Entry {
                    key,
                    value,
                    prefix,
                    delimiter,
                }
            } else {
                KvLine::Other(line.to_string())
            }
        })
        .collect()
}

fn set_kv_value(lines: &mut Vec<KvLine>, key: &str, value: &str, delimiter: char) {
    let mut updated = false;
    for line in lines.iter_mut() {
        if let KvLine::Entry {
            key: entry_key,
            value: entry_value,
            ..
        } = line
        {
            if entry_key == key {
                *entry_value = value.to_string();
                updated = true;
            }
        }
    }
    if !updated {
        lines.push(KvLine::Entry {
            key: key.to_string(),
            value: value.to_string(),
            prefix: String::new(),
            delimiter,
        });
    }
}

fn render_kv_lines(lines: &[KvLine]) -> String {
    let mut out: Vec<String> = Vec::new();
    for line in lines {
        match line {
            KvLine::Entry {
                key,
                value,
                prefix,
                delimiter,
            } => out.push(format!("{}{}{} {}", prefix, key, delimiter, value)),
            KvLine::Other(raw) => out.push(raw.to_string()),
        }
    }
    let mut content = out.join("\n");
    content.push('\n');
    content
}

fn upsert_kv_file(path: &Path, delimiter: char, updates: &[(&str, String)]) {
    let content = fs::read_to_string(path).unwrap_or_default();
    let mut lines = parse_kv_lines(&content, delimiter);
    for (key, value) in updates {
        set_kv_value(&mut lines, key, value, delimiter);
    }
    let content = render_kv_lines(&lines);
    fs::write(path, content).expect("Failed to write key/value file");
}

fn ensure_pacman_ignore_pkg(content: &str, packages: &[&str]) -> String {
    let mut lines: Vec<String> = content.lines().map(str::to_string).collect();
    let value = packages.join(" ");

    let Some(options_start) = lines.iter().position(|line| line.trim() == "[options]") else {
        if !lines.is_empty() {
            lines.push(String::new());
        }
        lines.push("[options]".to_string());
        lines.push(format!("IgnorePkg   = {value}"));
        let mut out = lines.join("\n");
        out.push('\n');
        return out;
    };

    let options_end = lines
        .iter()
        .enumerate()
        .skip(options_start + 1)
        .find(|(_, line)| {
            let trimmed = line.trim();
            trimmed.starts_with('[') && trimmed.ends_with(']')
        })
        .map(|(index, _)| index)
        .unwrap_or(lines.len());

    let mut insert_after_comment = None;
    for index in options_start + 1..options_end {
        let trimmed = lines[index].trim_start();
        let active = !trimmed.starts_with('#');
        let candidate = if active {
            trimmed
        } else {
            trimmed.trim_start_matches('#').trim_start()
        };

        let Some((key, existing)) = candidate.split_once('=') else {
            continue;
        };
        if key.trim() != "IgnorePkg" {
            continue;
        }

        if active {
            let merged = merge_pacman_list(existing, packages);
            lines[index] = format!("IgnorePkg   = {merged}");
            let mut out = lines.join("\n");
            out.push('\n');
            return out;
        }

        insert_after_comment = Some(index + 1);
    }

    lines.insert(
        insert_after_comment.unwrap_or(options_start + 1),
        format!("IgnorePkg   = {value}"),
    );

    let mut out = lines.join("\n");
    out.push('\n');
    out
}

fn merge_pacman_list(existing: &str, packages: &[&str]) -> String {
    let mut values: Vec<String> = existing.split_whitespace().map(str::to_string).collect();
    for package in packages {
        if !values.iter().any(|value| value == package) {
            values.push((*package).to_string());
        }
    }
    values.join(" ")
}

fn remove_pacman_ignore_pkg(content: &str, packages: &[&str]) -> String {
    let mut lines: Vec<String> = content.lines().map(str::to_string).collect();

    let Some(options_start) = lines.iter().position(|line| line.trim() == "[options]") else {
        let mut out = lines.join("\n");
        out.push('\n');
        return out;
    };

    let options_end = lines
        .iter()
        .enumerate()
        .skip(options_start + 1)
        .find(|(_, line)| {
            let trimmed = line.trim();
            trimmed.starts_with('[') && trimmed.ends_with(']')
        })
        .map(|(index, _)| index)
        .unwrap_or(lines.len());

    for line in lines.iter_mut().take(options_end).skip(options_start + 1) {
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') {
            continue;
        }

        let Some((key, existing)) = trimmed.split_once('=') else {
            continue;
        };
        if key.trim() != "IgnorePkg" {
            continue;
        }

        let remaining = existing
            .split_whitespace()
            .filter(|value| !packages.iter().any(|package| package == value))
            .collect::<Vec<_>>()
            .join(" ");
        *line = if remaining.is_empty() {
            "IgnorePkg   =".to_string()
        } else {
            format!("IgnorePkg   = {remaining}")
        };
    }

    let mut out = lines.join("\n");
    out.push('\n');
    out
}

fn setup_fake_bwrap(_: &SetupOptions) -> StageOutput {
    let fs_root = Path::new(ARCH_FS_ROOT);
    let wrapper_path = fs_root.join("usr/local/bin/bwrap");

    // bwrap (Bubblewrap) requires Linux user namespaces (CLONE_NEWUSER) which are
    // blocked by Android SELinux. We replace it with a shim that strips all
    // namespace/sandbox flags and directly exec's the target binary.
    // This unblocks glycin-svg (used by Onboard) which sandbox-loads SVG files via bwrap.
    let wrapper = r#"#!/bin/sh
# bwrap shim for proot/Android: namespaces are unavailable, exec directly.
# Strips all bwrap sandbox/namespace/bind flags, then exec's the target binary.
while [ $# -gt 0 ]; do
    case "$1" in
        # Three-argument flags (flag + src/key + dest/value)
        --ro-bind|--bind|--dev-bind|--bind-try|--ro-bind-try|--dev-bind-try|\
        --file|--bind-data|--ro-bind-data|--symlink|\
        --setenv|--chmod) shift 3 ;;
        # Two-argument flags (flag + single arg)
        --tmpfs|--proc|--dir|\
        --unsetenv|--perms|--cap-add|--cap-drop|\
        --seccomp|--add-seccomp-fd|--info-fd|--json-status-fd|\
        --block-fd|--userns-block-fd|--userns|--userns2|\
        --pidns|--chdir|--dev|--mqueue) shift 2 ;;
        # Zero-argument flags
        --unshare-all|--unshare-user|--unshare-user-try|--unshare-pid|\
        --unshare-ipc|--unshare-net|--unshare-uts|--unshare-cgroup|\
        --unshare-cgroup-try|--share-net|--remount-ro|\
        --as-pid-1|--die-with-parent|--new-session|--clearenv) shift ;;
        --) shift; break ;;
        *) break ;;
    esac
done
exec "$@"
"#;

    let _ = fs::create_dir_all(
        wrapper_path
            .parent()
            .expect("Failed to read bwrap wrapper parent directory"),
    );
    fs::write(&wrapper_path, wrapper).expect("Failed to write bwrap wrapper");
    fs::set_permissions(&wrapper_path, fs::Permissions::from_mode(0o755))
        .expect("Failed to mark bwrap wrapper executable");

    None
}

fn setup_chromium_no_sandbox(_: &SetupOptions) -> StageOutput {
    let fs_root = Path::new(ARCH_FS_ROOT);

    // Chromium's sandbox needs CLONE_NEWUSER, which Android SELinux blocks, so every
    // Chromium/Electron app has to be started with --no-sandbox. Electron apps pick that up
    // from ELECTRON_DISABLE_SANDBOX (exported by startxfce4-localdesktop), but Chromium itself
    // only takes the flag, and its desktop entry hardcodes an absolute path that a
    // /usr/local/bin wrapper cannot intercept. So shadow the affected application entries in
    // the user's own XDG directory, re-running every session to catch newly installed apps.
    write_executable(
        &fs_root.join("usr/local/bin/localdesktop-no-sandbox-entries"),
        r#"#!/bin/sh
target_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$target_dir" || exit 0

for src in /usr/share/applications/*.desktop /usr/local/share/applications/*.desktop; do
    [ -f "$src" ] || continue

    prog=$(sed -n 's/^Exec=//p' "$src" | head -n1 | awk '{print $1}')
    [ -n "$prog" ] || continue
    case "$prog" in
        /*) bin="$prog" ;;
        *) bin=$(command -v "$prog" 2>/dev/null) || continue ;;
    esac
    bin=$(readlink -f "$bin" 2>/dev/null)
    [ -n "$bin" ] || continue

    # Every Chromium/Electron build ships the setuid sandbox helper next to its binary,
    # or one level up when the launcher lives in a bin/ subdirectory.
    dir=$(dirname "$bin")
    [ -e "$dir/chrome-sandbox" ] || [ -e "$dir/../chrome-sandbox" ] || continue

    dst="$target_dir/$(basename "$src")"
    # Leave alone anything the user wrote themselves.
    if [ -e "$dst" ] && ! grep -q '^X-LocalDesktop-NoSandbox=' "$dst"; then
        continue
    fi

    awk '
        /^\[Desktop Entry\]/ && !seen { print; print "X-LocalDesktop-NoSandbox=true"; seen = 1; next }
        /^Exec=/ && !/--no-sandbox/ { sub(/^Exec=[^ ]+/, "& --no-sandbox") }
        { print }
    ' "$src" > "$dst"
done
"#,
    );

    // Same flag for terminal launches, following the /usr/local/bin PATH-priority pattern.
    write_executable(
        &fs_root.join("usr/local/bin/chromium"),
        r#"#!/bin/sh
[ -x /usr/bin/chromium ] || { echo "chromium is not installed" >&2; exit 127; }
exec /usr/bin/chromium --no-sandbox "$@"
"#,
    );

    None
}

fn setup_onboard_signal_fix(_: &SetupOptions) -> StageOutput {
    let fs_root = Path::new(ARCH_FS_ROOT);
    let wrapper_path = fs_root.join("usr/local/bin/onboard");

    // proot intercepts fstat() on socket fds and follows /proc/self/fd/N which points
    // to "socket:[inode]" — not a real path. Python 3.14's signal.set_wakeup_fd()
    // calls fstat(fd) to validate the wakeup socket, which fails with ENOENT under proot.
    // We install a wrapper at /usr/local/bin/onboard (higher PATH priority than /usr/sbin)
    // that monkey-patches signal.set_wakeup_fd to swallow OSError before launching the
    // real Onboard binary.
    let wrapper = r#"#!/usr/bin/python3
# Onboard wrapper for proot/Android: patches signal.set_wakeup_fd to handle
# OSError (ENOENT) caused by proot's fstat translation on socket file descriptors.
import signal as _signal
_orig_swf = _signal.set_wakeup_fd
def _safe_swf(fd, **kwargs):
    try:
        return _orig_swf(fd, **kwargs)
    except OSError:
        return -1
_signal.set_wakeup_fd = _safe_swf

import runpy, sys
sys.argv[0] = '/usr/sbin/onboard'
runpy.run_path('/usr/sbin/onboard', run_name='__main__')
"#;

    let _ = fs::create_dir_all(
        wrapper_path
            .parent()
            .expect("Failed to read onboard wrapper parent directory"),
    );
    fs::write(&wrapper_path, wrapper).expect("Failed to write onboard wrapper");
    fs::set_permissions(&wrapper_path, fs::Permissions::from_mode(0o755))
        .expect("Failed to mark onboard wrapper executable");

    None
}

pub(super) fn chroot_home_dir(fs_root: &Path, username: &str) -> PathBuf {
    if username == "root" {
        fs_root.join("root")
    } else {
        fs_root.join(format!("home/{username}"))
    }
}

pub(super) fn write_executable(path: &Path, contents: &str) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(path, contents).expect("Failed to write executable script");
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
        .expect("Failed to mark executable script");
}

/// Writes `contents` with permission bits `mode` unless the file already matches exactly,
/// so a normal start does not rewrite (and re-flush) the same scripts every time.
pub(super) fn write_if_changed(path: &Path, contents: &str, mode: u32) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let same_content = fs::read(path).map_or(false, |existing| existing == contents.as_bytes());
    if !same_content {
        fs::write(path, contents)
            .unwrap_or_else(|error| panic!("Failed to write {}: {error}", path.display()));
    }
    let same_mode = fs::metadata(path).map_or(false, |meta| meta.permissions().mode() & 0o7777 == mode);
    if !same_mode {
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
            .unwrap_or_else(|error| panic!("Failed to set permissions of {}: {error}", path.display()));
    }
}

/// Seeds a launcher on the desktop once: written only when absent, so a user's own edits
/// are never clobbered and deleting it re-seeds it on the next launch.
fn seed_desktop_file(path: &Path, contents: &str) {
    if !path.exists() {
        write_executable(path, contents);
    }
}

fn setup_xfce_wayland(options: &SetupOptions) -> StageOutput {
    let fs_root = Path::new(ARCH_FS_ROOT);
    let config = get_application_context().local_config;
    let home_dir = chroot_home_dir(fs_root, &config.user.username);
    let labwc_dir = home_dir.join(".config/xfce4/labwc");

    // First DPI of the session, used until the host reports its output state. From then on
    // `localdesktop-wlroots-output` and the session init script follow the host's UI scale.
    let ui_scale = guest::effective_ui_scale(&config.display, density_dpi(&options.android_app));
    let xft_dpi = guest::xft_dpi(ui_scale);

    // Still useful for Xwayland clients started by labwc.
    let xresources_path = home_dir.join(".Xresources");
    let _ = fs::create_dir_all(
        xresources_path
            .parent()
            .expect("Failed to read Xresources parent directory"),
    );
    upsert_kv_file(&xresources_path, ':', &[("Xft.dpi", xft_dpi.to_string())]);

    // xfconf is read when xfce4-session starts; agent toggles must exist before launch
    // (https://docs.xfce.org/xfce/xfce4-session/advanced — SSH and GPG Agents).
    let xfconf_dir = home_dir.join(".config/xfce4/xfconf/xfce-perchannel-xml");
    let _ = fs::create_dir_all(&xfconf_dir);
    fs::write(
        xfconf_dir.join("xfce4-session.xml"),
        r#"<?xml version="1.0" encoding="UTF-8"?>

<channel name="xfce4-session" version="1.0">
  <property name="startup" type="empty">
    <property name="ssh-agent" type="empty">
      <property name="enabled" type="bool" value="false"/>
    </property>
    <property name="gpg-agent" type="empty">
      <property name="enabled" type="bool" value="false"/>
    </property>
  </property>
</channel>
"#,
    )
    .expect("Failed to write xfce4-session xfconf defaults");
    fs::write(
        xfconf_dir.join("xsettings.xml"),
        &format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>

<channel name="xsettings" version="1.0">
  <property name="Xft" type="empty">
    <property name="DPI" type="int" value="{xft_dpi}"/>
  </property>
</channel>
"#
        ),
    )
    .expect("Failed to write xsettings xfconf defaults");

    // https://docs.xfce.org/xfce/getting-started — `startxfce4 --wayland` starts the
    // session manager, panel, compositor (labwc), and desktop manager.
    write_if_changed(
        &fs_root.join("usr/local/bin/startxfce4-localdesktop"),
        &guest::render_startxfce4(),
        0o755,
    );

    // Runs from ~/.config/autostart once the Xfce session is starting; applies the host's
    // Xft DPI and refreshes the --no-sandbox application entries when apps changed.
    write_if_changed(
        &fs_root.join("usr/local/bin/localdesktop-xfce-session-init"),
        &guest::render_session_init(xft_dpi),
        0o755,
    );

    let desktop_dir = home_dir.join("Desktop");
    let _ = fs::create_dir_all(&desktop_dir);

    // Desktop items are seeded create-if-missing (the run-once mechanism described
    // on `StageOutput`): write only when absent, so we never clobber the user's
    // edits or re-create on every launch. Deleting an item re-seeds it next launch,
    // same as the rest of the managed environment.
    let online_docs = desktop_dir.join("localdesktop-online-docs.desktop");
    if !online_docs.exists() {
        let _ = fs::write(
            &online_docs,
            format!(
                r#"[Desktop Entry]
Version=1.0
Type=Application
Name=Local Desktop - Online Docs
Comment=Open the Local Desktop documentation website
Exec=firefox {DOCS_HOME_URL}
Icon=firefox
Terminal=false
StartupNotify=true
"#
            ),
        );
    }
    // Remove the launcher's former name so existing installs pick up the rename.
    let _ = fs::remove_file(desktop_dir.join("localdesktop-documentation.desktop"));
    seed_desktop_file(
        &desktop_dir.join("localdesktop-settings.desktop"),
        &guest::settings_desktop_entry(),
    );
    seed_desktop_file(
        &desktop_dir.join("localdesktop-update.desktop"),
        &guest::update_desktop_entry(),
    );

    // Open PDFs (e.g. the manual below) in Evince instead of Firefox. Create-if-missing
    // so we don't stomp a user's own default-app choices.
    let mimeapps = home_dir.join(".config/mimeapps.list");
    if !mimeapps.exists() {
        let _ = fs::write(
            &mimeapps,
            "[Default Applications]\napplication/pdf=org.gnome.Evince.desktop\n",
        );
    }

    let autostart_dir = home_dir.join(".config/autostart");
    let _ = fs::create_dir_all(&autostart_dir);

    fs::write(
        autostart_dir.join("localdesktop-xfce-session-init.desktop"),
        r#"[Desktop Entry]
Version=1.0
Type=Application
Name=Local Desktop Xfce Session Init
Comment=Apply HiDPI font scaling and refresh sandbox-free application entries
Exec=/usr/local/bin/localdesktop-xfce-session-init
Terminal=false
OnlyShowIn=XFCE;
X-GNOME-Autostart-enabled=true
"#,
    )
    .expect("Failed to write Xfce session init autostart entry");

    // xfce4-power-manager expects host power interfaces that proot cannot provide.
    fs::write(
        autostart_dir.join("xfce4-power-manager.desktop"),
        r#"[Desktop Entry]
Type=Application
Name=Power Manager
Hidden=true
OnlyShowIn=XFCE;
"#,
    )
    .expect("Failed to disable xfce4-power-manager autostart");

    let _ = fs::remove_file(autostart_dir.join("localdesktop-xfce-scale.desktop"));
    let _ = fs::remove_file(autostart_dir.join("localdesktop-wlroots-output.desktop"));
    let _ = fs::remove_file(fs_root.join("usr/local/bin/localdesktop-xfce-scale"));

    // labwc runs the output watcher from its autostart script once the compositor owns the
    // output (labwc-config.5). Xfce stores labwc config under ~/.config/xfce4/labwc/.
    //
    // The Android compositor writes /tmp/localdesktop-output (mode, UI scale, refresh rate) and
    // pokes /tmp/localdesktop-output.fifo whenever the host display changes; the watcher blocks
    // on that FIFO instead of polling, and also keeps the Xft DPI of Xwayland clients current.
    write_if_changed(
        &fs_root.join("usr/local/lib/localdesktop/output-lib.sh"),
        guest::OUTPUT_LIB,
        0o644,
    );
    write_if_changed(
        &fs_root.join("usr/local/bin/localdesktop-wlroots-output"),
        guest::OUTPUT_WATCHER,
        0o755,
    );

    let _ = fs::create_dir_all(&labwc_dir);
    // Nested on our compositor: reuse the parent wl_output mode when possible (labwc-config.5).
    fs::write(
        labwc_dir.join("rc.xml"),
        r#"<?xml version="1.0"?>
<labwc_config>
  <core>
    <reuseOutputMode>yes</reuseOutputMode>
  </core>
</labwc_config>
"#,
    )
    .expect("Failed to write labwc rc.xml defaults");
    write_executable(
        &labwc_dir.join("autostart"),
        r#"#!/bin/sh
/usr/local/bin/localdesktop-wlroots-output >/tmp/localdesktop-wlroots-output.log 2>&1 &
"#,
    );

    // Arch wiki: lock prevents startxfce4 from overwriting custom labwc environment.
    // https://wiki.archlinux.org/title/Xfce#Using_labwc_custom_keymaps
    fs::write(
        labwc_dir.join("environment"),
        "XDG_SESSION_TYPE=wayland\nXDG_CURRENT_DESKTOP=XFCE\n",
    )
    .expect("Failed to write labwc environment file");
    fs::write(labwc_dir.join("lock"), "").expect("Failed to write labwc environment lock file");

    let _ = fs::remove_file(home_dir.join(".config/labwc/autostart"));

    None
}
fn fix_xkb_symlink(options: &SetupOptions) -> StageOutput {
    let fs_root = Path::new(ARCH_FS_ROOT);
    let xkb_path = fs_root.join("usr/share/X11/xkb");
    let mpsc_sender = options.mpsc_sender.clone();

    if let Ok(meta) = fs::symlink_metadata(&xkb_path) {
        if meta.file_type().is_symlink() {
            if let Ok(target) = fs::read_link(&xkb_path) {
                if target.is_absolute() {
                    log::info!(
                        "Absolute symlink target detected: {} -> {}. This is a problem because libxkbcommon is loaded in NDK, whose / is not Arch FS root!",
                        xkb_path.display(),
                        target.display()
                    );
                    // Compute the relative path from /usr/share/X11/xkb to /usr/share/xkeyboard-config-2
                    // Both are inside the chroot, so strip the fs_root prefix
                    let xkb_inside = Path::new("/usr/share/X11/xkb");
                    let target_inside = Path::new("/usr/share/xkeyboard-config-2");
                    let rel_target = diff_paths(target_inside, xkb_inside.parent().unwrap())
                        .unwrap_or_else(|| target_inside.to_path_buf());
                    log::info!(
                        "Fixing with new relative symlink: {} -> {}",
                        xkb_path.display(),
                        rel_target.display()
                    );
                    // Remove the old symlink
                    let _ = fs::remove_file(&xkb_path);
                    // Create the new relative symlink
                    if let Err(e) = symlink(&rel_target, &xkb_path) {
                        mpsc_sender
                            .send(SetupMessage::Error(format!(
                                "Failed to create relative symlink for xkb: {}",
                                e
                            )))
                            .unwrap_or(());
                    }
                }
            }
        }
    }
    None
}

pub fn setup(android_app: AndroidApp) -> PolarBearBackend {
    let (sender, receiver) = mpsc::channel();
    let progress = Arc::new(Mutex::new(0));

    if ArchProcess::is_supported(&android_app) {
        sender
            .send(SetupMessage::Progress(
                "✅ Your device is supported!".to_string(),
            ))
            .unwrap_or(());
    } else {
        log::info!("PRoot support check failed, showing Device Unsupported page");
        return PolarBearBackend::WebView(WebviewBackend {
            socket_port: 0,
            progress,
            error: ErrorVariant::Unsupported,
        });
    }

    let options = SetupOptions {
        android_app: android_app.clone(),
        mpsc_sender: sender.clone(),
    };

    let stages: Vec<SetupStage> = vec![
        Box::new(setup_arch_fs),                // Step 1. Setup Arch FS (verified download, extract)
        Box::new(simulate_linux_sysdata_stage), // Step 2. Simulate Linux system data
        Box::new(setup_pacman_mirrors),         // Step 3. HTTPS pacman mirrors
        Box::new(setup_pacman_keyring),         // Step 4. Fresh pacman signing key (one time)
        Box::new(install_dependencies),         // Step 5. Install dependencies
        Box::new(setup_machine_id),             // Step 6. Seed /etc/machine-id for D-Bus clients
        Box::new(setup_pipewire_package_lock), // Step 7. Hold guest PipeWire packages for the Android-side PipeWire POC
        Box::new(setup_guest_tuning), // Step 8. makepkg flags and the performance/GPU session environment
        Box::new(setup_firefox_config), // Step 9. Setup Firefox config
        Box::new(setup_fake_bwrap), // Step 10. Replace bwrap with a no-sandbox shim (Android has no user namespaces)
        Box::new(setup_chromium_no_sandbox), // Step 11. Make Chromium/Electron apps launchable without a terminal
        Box::new(setup_onboard_signal_fix), // Step 12. Wrap Onboard to survive proot fstat/signal.set_wakeup_fd failure
        Box::new(setup_settings), // Step 13. Settings template, update command and launchers
        Box::new(setup_xfce_wayland), // Step 14. Setup Xfce Wayland launch and HiDPI scaling
        Box::new(setup_gpu),      // Step 15. Opt-in: Adreno GPU Mesa build ([gpu] enabled)
        Box::new(setup_x86),      // Step 16. Opt-in: Box64 / Wine ([x86] box64, wine)
        Box::new(fix_xkb_symlink), // Step 17. Fix xkb symlink
    ];

    let handle_stage_error = |e: Box<dyn std::any::Any + Send>, sender: &Sender<SetupMessage>| {
        let error_msg = if let Some(e) = e.downcast_ref::<String>() {
            format!("Stage execution failed: {}", e)
        } else if let Some(e) = e.downcast_ref::<&str>() {
            format!("Stage execution failed: {}", e)
        } else {
            "Stage execution failed: Unknown error".to_string()
        };
        sender
            .send(SetupMessage::Error(error_msg.clone()))
            .unwrap_or(());
    };

    let fully_installed = 'outer: loop {
        for (i, stage) in stages.iter().enumerate() {
            if let Some(handle) = stage(&options) {
                let progress_clone = progress.clone();
                let sender_clone = sender.clone();
                thread::spawn(move || {
                    let progress = progress_clone;
                    let progress_value = ((i) as u16 * 100 / stages.len() as u16) as u16;
                    *progress.lock().unwrap() = progress_value;

                    // Wait for the current stage to finish
                    if let Err(e) = handle.join() {
                        handle_stage_error(e, &sender_clone);
                        return;
                    }

                    // Process the remaining stages in the same loop
                    for (j, next_stage) in stages.iter().enumerate().skip(i + 1) {
                        let progress_value = ((j) as u16 * 100 / stages.len() as u16) as u16;
                        *progress.lock().unwrap() = progress_value;
                        if let Some(next_handle) = next_stage(&options) {
                            if let Err(e) = next_handle.join() {
                                handle_stage_error(e, &sender_clone);
                                return;
                            }

                            // Increment progress and send it
                            let next_progress_value =
                                ((j + 1) as u16 * 100 / stages.len() as u16) as u16;
                            *progress.lock().unwrap() = next_progress_value;
                        }
                    }

                    // All stages are done, we need to replace the WebviewBackend with the WaylandBackend
                    // Or, easier, just restart the whole app
                    *progress.lock().unwrap() = 100;
                    sender_clone
                        .send(SetupMessage::Progress(
                            "Installation finished, please restart the app".to_string(),
                        ))
                        .expect("Failed to send installation finished message");
                });

                // Setup is still running in the background, but we need to return control
                // so that the main thread can continue to report progress to the user
                break 'outer false;
            }
        }

        // All stages were done previously, no need to wait for anything
        break 'outer true;
    };

    if fully_installed {
        PolarBearBackend::Wayland(
            WaylandBackend::new(android_app).expect("Failed to build compositor"),
        )
    } else {
        PolarBearBackend::WebView(WebviewBackend::build(receiver, progress))
    }
}
