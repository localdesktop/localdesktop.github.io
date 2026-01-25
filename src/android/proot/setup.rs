use super::process::ArchProcess;
use crate::{
    android::{
        app::build::PolarBearBackend,
        backend::{
            wayland::{Compositor, WaylandBackend},
            webview::WebviewBackend,
        },
        utils::application_context::get_application_context,
        utils::ndk::run_in_jvm,
    },
    core::{
        config::{CommandConfig, ARCH_FS_ARCHIVE, ARCH_FS_ROOT},
        logging::PolarBearExpectation,
    },
};
use jni::objects::JObject;
use jni::sys::_jobject;
use pathdiff::diff_paths;
use smithay::utils::Clock;
use std::{
    fs::{self, File},
    io::{Read, Write},
    os::unix::fs::{symlink, PermissionsExt},
    path::Path,
    sync::{
        mpsc::{self, Sender},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
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
type StageOutput = Option<JoinHandle<()>>;

fn setup_arch_fs(options: &SetupOptions) -> StageOutput {
    let context = get_application_context();
    let temp_file = context.data_dir.join("archlinux-fs.tar.xz");
    let fs_root = Path::new(ARCH_FS_ROOT);
    let extracted_dir = context.data_dir.join("archlinux-aarch64");
    let mpsc_sender = options.mpsc_sender.clone();

    // Only run if the fs_root is missing or empty
    // TODO: Setup integration test to make sure on clean install, the fs_root is either non existent or empty
    let need_setup = fs_root.read_dir().map_or(true, |mut d| d.next().is_none());
    if need_setup {
        return Some(thread::spawn(move || {
            // Download if the archive doesn't exist
            loop {
                if !temp_file.exists() {
                    mpsc_sender
                        .send(SetupMessage::Progress(
                            "Downloading Arch Linux FS...".to_string(),
                        ))
                        .pb_expect("Failed to send log message");

                    let response = reqwest::blocking::get(ARCH_FS_ARCHIVE)
                        .pb_expect("Failed to download Arch Linux FS");

                    let total_size = response.content_length().unwrap_or(0);
                    let mut file = File::create(&temp_file)
                        .pb_expect("Failed to create temp file for Arch Linux FS");

                    let mut downloaded = 0u64;
                    let mut buffer = [0u8; 8192];
                    let mut reader = response;
                    let mut last_percent = 0;

                    loop {
                        let n = reader
                            .read(&mut buffer)
                            .pb_expect("Failed to read from response");
                        if n == 0 {
                            break;
                        }
                        file.write_all(&buffer[..n])
                            .pb_expect("Failed to write to file");
                        downloaded += n as u64;
                        if total_size > 0 {
                            let percent = (downloaded * 100 / total_size).min(100) as u8;
                            if percent != last_percent {
                                let downloaded_mb = downloaded as f64 / 1024.0 / 1024.0;
                                let total_mb = total_size as f64 / 1024.0 / 1024.0;
                                mpsc_sender
                                    .send(SetupMessage::Progress(format!(
                                        "Downloading Arch Linux FS... {}% ({:.2} MB / {:.2} MB)",
                                        percent, downloaded_mb, total_mb
                                    )))
                                    .unwrap_or(());
                                last_percent = percent;
                            }
                        }
                    }
                }

                mpsc_sender
                    .send(SetupMessage::Progress(
                        "Extracting Arch Linux FS...".to_string(),
                    ))
                    .pb_expect("Failed to send log message");

                // Ensure the extracted directory is clean
                let _ = fs::remove_dir_all(&extracted_dir);

                // Extract tar file directly to the final destination
                let tar_file = File::open(&temp_file)
                    .pb_expect("Failed to open downloaded Arch Linux FS file");
                let tar = XzDecoder::new(tar_file);
                let mut archive = Archive::new(tar);

                // Try to extract, if it fails, remove temp file and restart download
                if let Err(e) = archive.unpack(context.data_dir.clone()) {
                    // Clean up the failed extraction
                    let _ = fs::remove_dir_all(&extracted_dir);
                    let _ = fs::remove_file(&temp_file);

                    mpsc_sender
                        .send(SetupMessage::Error(format!(
                            "Failed to extract Arch Linux FS: {}. Restarting download...",
                            e
                        )))
                        .unwrap_or(());

                    // Continue the outer loop to retry the download
                    continue;
                }

                // If we get here, extraction was successful
                break;
            }

            // Move the extracted files to the final destination
            fs::rename(&extracted_dir, fs_root)
                .pb_expect("Failed to rename extracted files to final destination");

            // Clean up the temporary file
            fs::remove_file(&temp_file).pb_expect("Failed to remove temporary file");
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
                .pb_expect(&format!("Failed to send log message"));

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
                    .pb_expect(&format!("Permission denied while writing to {}", path));
            }
        }));
    }
    None
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

    let check_command = check.clone();
    let installed = move || {
        ArchProcess {
            command: check_command.clone(),
            user: None,
            log: None,
        }
        .run()
    };

    if installed() {
        return None;
    }

    let mpsc_sender = mpsc_sender.clone();
    return Some(thread::spawn(move || {
        // Install dependencies until `check` succeed
        loop {
            ArchProcess {
                command: "rm -f /var/lib/pacman/db.lck".to_string(),
                user: None,
                log: None,
            }
            .run();
            let log_sender = mpsc_sender.clone();
            ArchProcess {
                command: install.clone(),
                user: None,
                log: Some(Box::new(move |it| {
                    log_sender
                        .send(SetupMessage::Progress(it))
                        .pb_expect("Failed to send log message");
                })),
            }
            .run();
            if installed() {
                break;
            }
        }
    }));
}

fn setup_firefox_config(_: &SetupOptions) -> StageOutput {
    // Create the Firefox root directory if it doesn't exist
    let firefox_root = format!("{}/usr/lib/firefox", ARCH_FS_ROOT);
    let _ = fs::create_dir_all(&firefox_root).pb_expect("Failed to create Firefox root directory");

    // Create the defaults/pref directory
    let pref_dir = format!("{}/defaults/pref", firefox_root);
    let _ = fs::create_dir_all(&pref_dir).pb_expect("Failed to create Firefox pref directory");

    // Create autoconfig.js in defaults/pref
    let autoconfig_js = r#"pref("general.config.filename", "localdesktop.cfg");
pref("general.config.obscure_value", 0);
"#;

    let _ = fs::write(format!("{}/autoconfig.js", pref_dir), autoconfig_js)
        .pb_expect("Failed to write Firefox autoconfig.js");

    // Create localdesktop.cfg in the Firefox root directory
    let firefox_cfg = r#"// Auto updated by Local Desktop on each startup, do not edit manually
defaultPref("media.cubeb.sandbox", false);
defaultPref("security.sandbox.content.level", 0);
"#; // It is required that the first line of this file is a comment, even if you have nothing to comment. Docs: https://support.mozilla.org/en-US/kb/customizing-firefox-using-autoconfig

    let _ = fs::write(format!("{}/localdesktop.cfg", firefox_root), firefox_cfg)
        .pb_expect("Failed to write Firefox configuration");

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
    fs::write(path, content).pb_expect("Failed to write key/value file");
}

fn update_ini_section(content: &str, section: &str, updates: &[(&str, String)]) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut in_section = false;
    let mut seen_section = false;
    let mut seen_keys = vec![false; updates.len()];

    for raw_line in content.lines() {
        let trimmed = raw_line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if in_section {
                for (idx, (key, value)) in updates.iter().enumerate() {
                    if !seen_keys[idx] {
                        out.push(format!("{}={}", key, value));
                    }
                }
            }
            let name = trimmed[1..trimmed.len() - 1].trim();
            in_section = name.eq_ignore_ascii_case(section);
            if in_section {
                seen_section = true;
            }
            out.push(raw_line.to_string());
            continue;
        }

        if in_section
            && !trimmed.is_empty()
            && !trimmed.starts_with('#')
            && !trimmed.starts_with(';')
            && raw_line.contains('=')
        {
            if let Some((left, _)) = raw_line.split_once('=') {
                let key = left.trim();
                let mut replaced = false;
                for (idx, (target_key, value)) in updates.iter().enumerate() {
                    if key.eq_ignore_ascii_case(target_key) {
                        let indent: String =
                            raw_line.chars().take_while(|c| c.is_whitespace()).collect();
                        out.push(format!("{}{}={}", indent, key, value));
                        seen_keys[idx] = true;
                        replaced = true;
                        break;
                    }
                }
                if replaced {
                    continue;
                }
            }
        }

        out.push(raw_line.to_string());
    }

    if in_section {
        for (idx, (key, value)) in updates.iter().enumerate() {
            if !seen_keys[idx] {
                out.push(format!("{}={}", key, value));
            }
        }
    } else if !seen_section {
        if !out.is_empty() {
            out.push(String::new());
        }
        out.push(format!("[{}]", section));
        for (key, value) in updates {
            out.push(format!("{}={}", key, value));
        }
    }

    let mut content = out.join("\n");
    content.push('\n');
    content
}

fn extract_attr_value(line: &str, attr: &str) -> Option<String> {
    let needle = format!("{}=\"", attr);
    let start = line.find(&needle)? + needle.len();
    let rest = &line[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn extract_tag_value(line: &str, tag: &str) -> Option<String> {
    let open = format!("<{}>", tag);
    let close = format!("</{}>", tag);
    let start = line.find(&open)? + open.len();
    let end = line.find(&close)?;
    if end < start {
        return None;
    }
    Some(line[start..end].trim().to_string())
}

fn update_openbox_rc(content: &str, scale: i32, font_name: &str) -> (String, Option<String>) {
    let active_size = 10 * scale;
    let menu_size = 11 * scale;
    let mut out: Vec<String> = Vec::new();
    let mut in_font = false;
    let mut in_theme = false;
    let mut font_place: Option<String> = None;
    let mut theme_name: Option<String> = None;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("<theme>") {
            in_theme = true;
            out.push(line.to_string());
            continue;
        }
        if trimmed.starts_with("</theme>") {
            in_theme = false;
            out.push(line.to_string());
            continue;
        }

        if trimmed.starts_with("<font") {
            in_font = true;
            font_place = extract_attr_value(trimmed, "place");
            out.push(line.to_string());
            continue;
        }
        if trimmed.starts_with("</font>") {
            in_font = false;
            font_place = None;
            out.push(line.to_string());
            continue;
        }

        if in_theme && !in_font && theme_name.is_none() {
            if let Some(name) = extract_tag_value(trimmed, "name") {
                theme_name = Some(name);
            }
            out.push(line.to_string());
            continue;
        }

        if in_font {
            if extract_tag_value(trimmed, "name").is_some() {
                let indent: String = line.chars().take_while(|c| c.is_whitespace()).collect();
                out.push(format!("{}<name>{}</name>", indent, font_name));
                continue;
            }
            if extract_tag_value(trimmed, "size").is_some() {
                let indent: String = line.chars().take_while(|c| c.is_whitespace()).collect();
                let size = match font_place.as_deref() {
                    Some("ActiveWindow") | Some("InactiveWindow") => active_size,
                    Some("MenuHeader")
                    | Some("MenuItem")
                    | Some("ActiveOnScreenDisplay")
                    | Some("InactiveOnScreenDisplay") => menu_size,
                    _ => menu_size,
                };
                out.push(format!("{}<size>{}</size>", indent, size));
                continue;
            }
        }

        out.push(line.to_string());
    }

    let mut out = out.join("\n");
    out.push('\n');
    (out, theme_name)
}

fn update_openbox_theme(fs_root: &Path, theme_name: &str, scale: i32) {
    let user_theme = fs_root.join(format!("root/.themes/{}/openbox-3/themerc", theme_name));
    let system_theme = fs_root.join(format!("usr/share/themes/{}/openbox-3/themerc", theme_name));
    let source = if user_theme.exists() {
        user_theme.clone()
    } else if system_theme.exists() {
        system_theme
    } else {
        return;
    };

    let content = fs::read_to_string(&source).unwrap_or_default();
    if content.is_empty() {
        return;
    }

    let button_size = 18 * scale;
    let title_height = 22 * scale;
    let mut lines = parse_kv_lines(&content, ':');
    set_kv_value(&mut lines, "button.width", &button_size.to_string(), ':');
    set_kv_value(&mut lines, "button.height", &button_size.to_string(), ':');
    set_kv_value(&mut lines, "title.height", &title_height.to_string(), ':');

    let content = render_kv_lines(&lines);
    let _ = fs::create_dir_all(
        user_theme
            .parent()
            .pb_expect("Failed to read openbox theme directory"),
    );
    fs::write(&user_theme, content).pb_expect("Failed to write openbox theme file");
}

fn setup_lxqt_scaling(options: &SetupOptions) -> StageOutput {
    let fs_root = Path::new(ARCH_FS_ROOT);
    let android_app = options.android_app.clone();

    let mut density_dpi: i32 = 160;
    run_in_jvm(
        |env, app| {
            let activity = unsafe { JObject::from_raw(app.activity_as_ptr() as *mut _jobject) };
            let resources = env
                .call_method(
                    activity,
                    "getResources",
                    "()Landroid/content/res/Resources;",
                    &[],
                )
                .pb_expect("Failed to call getResources")
                .l()
                .pb_expect("Failed to read getResources result");
            let metrics = env
                .call_method(
                    resources,
                    "getDisplayMetrics",
                    "()Landroid/util/DisplayMetrics;",
                    &[],
                )
                .pb_expect("Failed to call getDisplayMetrics")
                .l()
                .pb_expect("Failed to read getDisplayMetrics result");
            density_dpi = env
                .get_field(metrics, "densityDpi", "I")
                .pb_expect("Failed to read densityDpi")
                .i()
                .pb_expect("Failed to convert densityDpi");
        },
        android_app,
    );

    let scale = ((density_dpi as f32) / 160.0 * 1.1).max(1.0).round() as i32;
    let xft_dpi = scale * 96;

    let xresources_path = fs_root.join("root/.Xresources");
    upsert_kv_file(&xresources_path, ':', &[("Xft.dpi", xft_dpi.to_string())]);

    let session_path = fs_root.join("root/.config/lxqt/session.conf");
    let _ = fs::create_dir_all(
        session_path
            .parent()
            .pb_expect("Failed to read LXQt session.conf parent directory"),
    );

    let session_content = fs::read_to_string(&session_path).unwrap_or_default();
    let session_out = update_ini_section(
        &session_content,
        "Environment",
        &[
            ("GDK_SCALE", scale.to_string()),
            ("QT_SCALE_FACTOR", scale.to_string()),
        ],
    );
    fs::write(&session_path, session_out).pb_expect("Failed to write session.conf");

    let openbox_user_rc = fs_root.join("root/.config/openbox/rc.xml");
    let openbox_system_rc = fs_root.join("etc/xdg/openbox/rc.xml");
    let openbox_source = if openbox_user_rc.exists() {
        openbox_user_rc.clone()
    } else if openbox_system_rc.exists() {
        openbox_system_rc
    } else {
        return None;
    };

    let rc_content = fs::read_to_string(&openbox_source).unwrap_or_default();
    if !rc_content.is_empty() {
        let (rc_out, theme_name) = update_openbox_rc(&rc_content, scale, "DejaVu Sans");
        let _ = fs::create_dir_all(
            openbox_user_rc
                .parent()
                .pb_expect("Failed to read openbox config directory"),
        );
        fs::write(&openbox_user_rc, rc_out).pb_expect("Failed to write openbox rc.xml");

        if let Some(theme_name) = theme_name {
            update_openbox_theme(fs_root, &theme_name, scale);
        }
    }

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

    let options = SetupOptions {
        android_app,
        mpsc_sender: sender.clone(),
    };

    let stages: Vec<SetupStage> = vec![
        Box::new(setup_arch_fs),                // Step 1. Setup Arch FS (extract)
        Box::new(simulate_linux_sysdata_stage), // Step 2. Simulate Linux system data
        Box::new(install_dependencies),         // Step 3. Install dependencies
        Box::new(setup_firefox_config),         // Step 4. Setup Firefox config
        Box::new(setup_lxqt_scaling),           // Step 5. Setup LXQt HiDPI scaling
        Box::new(fix_xkb_symlink),              // Step 6. Fix xkb symlink (last)
    ];

    let handle_stage_error = |e: Box<dyn std::any::Any + Send>, sender: &Sender<SetupMessage>| {
        let error_msg = if let Some(e) = e.downcast_ref::<String>() {
            format!("Stage execution failed: {}", e)
        } else if let Some(e) = e.downcast_ref::<&str>() {
            format!("Stage execution failed: {}", e)
        } else {
            "Stage execution failed: Unknown error".to_string()
        };
        sender.send(SetupMessage::Error(error_msg)).unwrap_or(());
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
                        .pb_expect("Failed to send installation finished message");
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
        PolarBearBackend::Wayland(WaylandBackend {
            compositor: Compositor::build().pb_expect("Failed to build compositor"),
            graphic_renderer: None,
            clock: Clock::new(),
            key_counter: 0,
            scale_factor: 1.0,
        })
    } else {
        PolarBearBackend::WebView(WebviewBackend::build(receiver, progress))
    }
}
