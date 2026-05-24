use super::process::ArchProcess;
use crate::{
    android::{
        app::build::PolarBearBackend,
        backend::{
            wayland::{Compositor, WaylandBackend},
            webview::{ErrorVariant, WebviewBackend},
        },
        utils::application_context::get_application_context,
        utils::ndk::run_in_jvm,
    },
    core::config::{CommandConfig, ARCH_FS_ARCHIVE, ARCH_FS_ROOT},
};
use jni::objects::JObject;
use jni::sys::_jobject;
use pathdiff::diff_paths;
use smithay::utils::Clock;
use std::{
    fs::{self, File},
    io::{Read, Write},
    os::unix::fs::{symlink, PermissionsExt},
    path::{Path, PathBuf},
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
                        .expect("Failed to send log message");

                    let response = reqwest::blocking::get(ARCH_FS_ARCHIVE)
                        .expect("Failed to download Arch Linux FS");

                    let total_size = response.content_length().unwrap_or(0);
                    let mut file = File::create(&temp_file)
                        .expect("Failed to create temp file for Arch Linux FS");

                    let mut downloaded = 0u64;
                    let mut buffer = [0u8; 8192];
                    let mut reader = response;
                    let mut last_percent = 0;

                    loop {
                        let n = reader
                            .read(&mut buffer)
                            .expect("Failed to read from response");
                        if n == 0 {
                            break;
                        }
                        file.write_all(&buffer[..n])
                            .expect("Failed to write to file");
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
                    .expect("Failed to send log message");

                // Ensure the extracted directory is clean
                let _ = fs::remove_dir_all(&extracted_dir);

                // Extract tar file directly to the final destination
                let tar_file =
                    File::open(&temp_file).expect("Failed to open downloaded Arch Linux FS file");
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
                .expect("Failed to rename extracted files to final destination");

            // Clean up the temporary file
            fs::remove_file(&temp_file).expect("Failed to remove temporary file");
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
"#;

    let _ = fs::write(format!("{}/autoconfig.js", pref_dir), autoconfig_js)
        .expect("Failed to write Firefox autoconfig.js");

    // Create localdesktop.cfg in the Firefox root directory
    let firefox_cfg = r#"// Auto updated by Local Desktop on each startup, do not edit manually
defaultPref("media.cubeb.sandbox", false);
defaultPref("security.sandbox.content.level", 0);
"#; // It is required that the first line of this file is a comment, even if you have nothing to comment. Docs: https://support.mozilla.org/en-US/kb/customizing-firefox-using-autoconfig

    let _ = fs::write(format!("{}/localdesktop.cfg", firefox_root), firefox_cfg)
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

fn chroot_home_dir(fs_root: &Path, username: &str) -> PathBuf {
    if username == "root" {
        fs_root.join("root")
    } else {
        fs_root.join(format!("home/{username}"))
    }
}

fn write_executable(path: &Path, contents: &str) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(path, contents).expect("Failed to write executable script");
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
        .expect("Failed to mark executable script");
}

fn read_android_density_dpi(android_app: AndroidApp) -> i32 {
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
                .expect("Failed to call getResources")
                .l()
                .expect("Failed to read getResources result");
            let metrics = env
                .call_method(
                    resources,
                    "getDisplayMetrics",
                    "()Landroid/util/DisplayMetrics;",
                    &[],
                )
                .expect("Failed to call getDisplayMetrics")
                .l()
                .expect("Failed to read getDisplayMetrics result");
            density_dpi = env
                .get_field(&metrics, "densityDpi", "I")
                .expect("Failed to read densityDpi")
                .i()
                .expect("Failed to convert densityDpi");
        },
        android_app,
    );
    density_dpi
}

/// Map Android density to a whole-number UI scale factor (same baseline as the old LXQt setup).
fn android_ui_scale(density_dpi: i32) -> i32 {
    ((density_dpi as f32) / 160.0 * 1.1).max(1.0).round() as i32
}

fn setup_xfce_wayland(options: &SetupOptions) -> StageOutput {
    let fs_root = Path::new(ARCH_FS_ROOT);
    let username = get_application_context().local_config.user.username;
    let home_dir = chroot_home_dir(fs_root, &username);
    let labwc_dir = home_dir.join(".config/xfce4/labwc");

    let density_dpi = read_android_density_dpi(options.android_app.clone());
    let ui_scale = android_ui_scale(density_dpi);
    // Xft uses 96 as the default logical DPI; multiply by scale for HiDPI fonts.
    let xft_dpi = ui_scale * 96;

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
    write_executable(
        &fs_root.join("usr/local/bin/startxfce4-localdesktop"),
        r#"#!/bin/sh
exec startxfce4 --wayland "$@"
"#,
    );

    // Runs from ~/.config/autostart once xfsettingsd is up; reinforces pre-seeded /Xft/DPI.
    write_executable(
        &fs_root.join("usr/local/bin/localdesktop-xfce-session-init"),
        &format!(
            r#"#!/bin/sh
for _ in $(seq 1 50); do
    xfconf-query -c xsettings -lv >/dev/null 2>&1 && break
    sleep 0.1
done

xfconf-query -c xsettings -p /Xft/DPI -n -t int -s {xft_dpi} 2>/dev/null || \
xfconf-query -c xsettings -p /Xft/DPI -t int -s {xft_dpi}
"#
        ),
    );

    let autostart_dir = home_dir.join(".config/autostart");
    let _ = fs::create_dir_all(&autostart_dir);

    fs::write(
        autostart_dir.join("localdesktop-xfce-session-init.desktop"),
        r#"[Desktop Entry]
Version=1.0
Type=Application
Name=Local Desktop Xfce Session Init
Comment=Apply HiDPI font scaling via xfsettings
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

    // labwc runs wlr-randr from its autostart script once the compositor owns the output
    // (labwc-config.5). Xfce stores labwc config under ~/.config/xfce4/labwc/.
    write_executable(
        &fs_root.join("usr/local/bin/localdesktop-wlroots-output"),
        &format!(
            r#"#!/bin/sh
# Keep labwc's wlroots output aligned with the Android host window when possible.
state_file="/tmp/localdesktop-output"
lock_file="/tmp/localdesktop-wlroots-output.pid"
fallback_mode="1280x720"
fallback_scale="{ui_scale}"

if [ -r "$lock_file" ]; then
    old_pid=$(cat "$lock_file" 2>/dev/null)
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
        exit 0
    fi
fi
echo "$$" > "$lock_file"
trap 'rm -f "$lock_file"' EXIT INT TERM

first_output() {{
    wlr-randr 2>/dev/null | awk 'NF > 0 && $1 !~ /^Modes:/ && $1 !~ /^Current:/ && $1 !~ /^Position:/ && $1 !~ /^Transform:/ && $1 !~ /^Scale:/ {{ print $1; exit }}'
}}

read_output_state() {{
    target_mode="$fallback_mode"
    target_scale="$fallback_scale"
    if [ -r "$state_file" ]; then
        . "$state_file"
        target_mode="${{LOCALDESKTOP_OUTPUT_MODE:-$target_mode}}"
        target_scale="${{LOCALDESKTOP_OUTPUT_SCALE:-$target_scale}}"
    fi
    case "$target_mode" in
        *x*) ;;
        *) target_mode="$fallback_mode" ;;
    esac
    case "$target_scale" in
        ''|*[!0-9]*) target_scale="$fallback_scale" ;;
    esac
}}

apply_output() {{
    output="$1"
    wlr-randr --output "$output" --custom-mode "${{target_mode}}@60Hz" --scale "$target_scale" >/dev/null 2>&1 && return 0
    wlr-randr --output "$output" --custom-mode "$target_mode" --scale "$target_scale" >/dev/null 2>&1 && return 0
    wlr-randr --output "$output" --mode "$target_mode" --scale "$target_scale" >/dev/null 2>&1 && return 0
    wlr-randr --output "$output" --scale "$target_scale" >/dev/null 2>&1 && return 0
    return 1
}}

last_config=""
while true; do
    read_output_state
    output=$(first_output)
    if [ -n "$output" ]; then
        config="$output $target_mode $target_scale"
        if [ "$config" != "$last_config" ] && apply_output "$output"; then
            last_config="$config"
        fi
    fi
    sleep 1
done
"#
        ),
    );

    let _ = fs::create_dir_all(&labwc_dir);
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
        android_app,
        mpsc_sender: sender.clone(),
    };

    let stages: Vec<SetupStage> = vec![
        Box::new(setup_arch_fs),                // Step 1. Setup Arch FS (extract)
        Box::new(simulate_linux_sysdata_stage), // Step 2. Simulate Linux system data
        Box::new(install_dependencies),         // Step 3. Install dependencies
        Box::new(setup_firefox_config),         // Step 4. Setup Firefox config
        Box::new(setup_fake_bwrap), // Step 5. Replace bwrap with a no-sandbox shim (Android has no user namespaces)
        Box::new(setup_onboard_signal_fix), // Step 6. Wrap Onboard to survive proot fstat/signal.set_wakeup_fd failure
        Box::new(setup_xfce_wayland),       // Step 7. Setup Xfce Wayland launch and HiDPI scaling
        Box::new(fix_xkb_symlink),          // Step 8. Fix xkb symlink (last)
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
        PolarBearBackend::Wayland(WaylandBackend {
            compositor: Compositor::build().expect("Failed to build compositor"),
            graphic_renderer: None,
            clock: Clock::new(),
            key_counter: 0,
            scale_factor: 1.0,
            touch_points: std::collections::HashMap::new(),
            scroll_centroid: None,
        })
    } else {
        PolarBearBackend::WebView(WebviewBackend::build(receiver, progress))
    }
}
