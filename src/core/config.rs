use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Android application id of this fork. Distinct from upstream's `app.polarbear`
/// so both can be installed side by side (each keeps its own rootfs).
/// The Java classes keep the `app.polarbear` package; only the application id changes.
macro_rules! android_package {
    () => {
        "app.polarbear.fold"
    };
}
pub const ANDROID_PACKAGE: &str = android_package!();

#[cfg(not(test))]
pub const ARCH_FS_ROOT: &str = concat!("/data/data/", android_package!(), "/files/arch");
#[cfg(test)]
pub const ARCH_FS_ROOT: &str = "/data/local/tmp/arch";

pub const ARCH_FS_ARCHIVE: &str = "https://github.com/termux/proot-distro/releases/download/v4.29.0/archlinux-aarch64-pd-v4.29.0.tar.xz";

/// A file the setup downloads. The bytes are only used when they match `sha256`/`size`,
/// whatever the server returns. Tried in order; later URLs are mirrors of the same file.
#[derive(Debug, Clone, Copy)]
pub struct PinnedAsset {
    pub name: &'static str,
    pub urls: &'static [&'static str],
    pub sha256: &'static str,
    pub size: u64,
}

/// proot-distro Arch Linux ARM rootfs (see `ARCH_FS_ARCHIVE`). Hash and size were computed from
/// a download of the release asset and match the digest GitHub publishes for it.
pub const ARCH_FS_ARCHIVE_ASSET: PinnedAsset = PinnedAsset {
    name: "Arch Linux FS",
    urls: &[ARCH_FS_ARCHIVE],
    sha256: "08d74365213e647c558e561b0a2a7afb6fa3dfe345a1994c62ccac5af1a1cdc6",
    size: 151_744_988,
};

/// Release tag of `MESA_KGSL_ASSET`; also the install marker content in the guest.
pub const MESA_KGSL_RELEASE: &str = "mesa-26.3.0-devel-20260824";

/// lfdevs/mesa-for-android-container, Arch Linux arm64 build (Mesa 26.3.0-devel with the
/// Freedreno/Turnip KGSL backend, Adreno 8xx included). An outer tar of pacman packages;
/// the setup unpacks `mesa` and `vulkan-freedreno` into its own prefix, not into `/usr`.
pub const MESA_KGSL_ASSET: PinnedAsset = PinnedAsset {
    name: "Mesa KGSL (Adreno)",
    urls: &["https://github.com/lfdevs/mesa-for-android-container/releases/download/mesa-26.3.0-devel-20260824/mesa-for-android-container_26.3.0-devel-20260824_archlinux_arm64.tar"],
    sha256: "75b7638829b211c20c26b6110e525ca23ab28980ce58af824ab16c8e7afcfa26",
    size: 14_018_560,
};

/// Prefix inside the guest the KGSL Mesa build is installed to.
pub const MESA_KGSL_PREFIX: &str = "/opt/localdesktop-mesa";

/// Box64 0.4.4 for aarch64 glibc, built by the archlinuxcn repository (signed there; we pin the
/// SHA-256 of the package instead of trusting a repository key). Installed with `pacman -U`.
pub const BOX64_PACKAGE_ASSET: PinnedAsset = PinnedAsset {
    name: "Box64 0.4.4",
    urls: &[
        "https://repo.archlinuxcn.org/aarch64/box64-0.4.4-1-aarch64.pkg.tar.zst",
        "https://mirrors.tuna.tsinghua.edu.cn/archlinuxcn/aarch64/box64-0.4.4-1-aarch64.pkg.tar.zst",
    ],
    sha256: "da7ef70d9b4fa9e11ac62a13b617ef5ee870470f8b6db8e352df3042d0a69632",
    size: 23_365_884,
};

/// Version of `BOX64_PACKAGE_ASSET` as pacman reports it; the install marker.
pub const BOX64_PACKAGE_VERSION: &str = "0.4.4-1";

/// x86_64/i386 library bundle published with Box64 v0.4.4 (extracted over `/usr/lib/box64-*`).
pub const BOX64_X86_LIBS_ASSET: PinnedAsset = PinnedAsset {
    name: "Box64 x86 libraries",
    urls: &["https://github.com/ptitSeb/box64/releases/download/v0.4.4/box64-bundle-x86-libs-v0.4.4.tar.gz"],
    sha256: "1d4a8787a8a92267c1be673ec194c69e3bb33d14c800575d94131084142fcff0",
    size: 34_368_070,
};

/// Kron4ek Wine-Builds 11.18, x86_64 with WoW64 (runs 32-bit programs without 32-bit libraries).
pub const WINE_ASSET: PinnedAsset = PinnedAsset {
    name: "Wine 11.18",
    urls: &["https://github.com/Kron4ek/Wine-Builds/releases/download/11.18/wine-11.18-amd64-wow64.tar.xz"],
    sha256: "f899879b8c37e0b20adca19d147cf77436f3f1a37bf16d08d27fa7137a52b9ba",
    size: 99_305_644,
};

/// Version of `WINE_ASSET`; the install marker.
pub const WINE_VERSION: &str = "11.18";

/// HTTPS Arch Linux ARM mirrors (verified to serve `aarch64/core/core.db` over TLS with a valid
/// certificate). The geo-redirector `mirror.archlinuxarm.org` is excluded: its certificate does not
/// cover that host name.
pub const PACMAN_MIRRORS: &[&str] = &[
    "https://de3.mirror.archlinuxarm.org/$arch/$repo",
    "https://fl.us.mirror.archlinuxarm.org/$arch/$repo",
    "https://ca.us.mirror.archlinuxarm.org/$arch/$repo",
];

/// Project homepage, also the online documentation entry point.
pub const DOCS_HOME_URL: &str = "https://localdesktop.github.io/";

/// Download URL for the offline User Manual PDF matching the running version.
/// The release asset is dot-free/hyphenated (GitHub turns spaces into dots).
pub fn user_manual_url() -> String {
    format!(
        "https://github.com/localdesktop/localdesktop.github.io/releases/download/v{VERSION}/Local-Desktop-v{VERSION}-User-Manual.pdf"
    )
}

pub const WAYLAND_SOCKET_NAME: &str = "wayland-0";

pub const MAX_PANEL_LOG_ENTRIES: usize = 100;

/// PipeWire runtime path as seen from inside the proot guest.
pub const PIPEWIRE_GUEST_RUNTIME_DIR: &str = "/tmp";

/// PipeWire-Pulse socket as seen from inside the proot guest.
pub const PULSE_GUEST_SERVER: &str = "unix:/tmp/pulse/native";

/// Make sure the config keys are all lowercase, and config values are single-line. Use \n for multi-line config values if needed
/// If a key exists multiple time, the first entry is applied
/// If a `try_` config exsists multiple time, the last entry is applied
/// But in general, it is **invalid** to have duplicated config keys inside a TOML file
pub const CONFIG_FILE: &str = "/etc/localdesktop/localdesktop.toml";

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
pub struct LocalConfig {
    #[serde(default)]
    pub user: UserConfig,

    /// What happens if we don't assign this `#[serde(default)]` attribute?
    /// The answer: If the user omits the `[command]` group, the WHOLE config fails to parse
    /// => The default `[user]` group is applied (with `username=root`) even if the `[user]` settings are completely valid.
    /// => So make sure that every config group has a `#[serde(default)]` attribute to avoid invalid sections breaking unrelated parts of the config.
    #[serde(default)]
    pub command: CommandConfig,

    #[serde(default)]
    pub display: DisplayConfig,

    #[serde(default)]
    pub input: InputConfig,

    #[serde(default)]
    pub gpu: GpuConfig,

    #[serde(default)]
    pub x86: X86Config,

    #[serde(default)]
    pub session: SessionConfig,
}

/// How the hinge splits the screen when the device is half-folded (Flex mode).
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum LaptopMode {
    /// Split into desktop (top) + touchpad (bottom) only while the hinge sensor reports half-open.
    #[default]
    Auto,
    /// Always split while the window is landscape.
    On,
    /// Never split.
    Off,
}

/// How single-finger touches on the desktop area are interpreted.
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum TouchInputMode {
    /// The pointer jumps to the finger (tablet-like). Upstream behaviour.
    #[default]
    Direct,
    /// The whole screen acts as a laptop touchpad (relative pointer movement).
    Touchpad,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct DisplayConfig {
    /// Fraction of physical pixels the guest renders at (0.5..=1.0). Lower = faster, blurrier.
    pub render_scale: f32,
    /// Guest UI scale. 0 = derive from the Android density on every display change.
    /// Fractional values (e.g. 2.5) are passed to labwc as-is.
    pub ui_scale: f32,
    pub laptop_mode: LaptopMode,
    /// Preferred refresh rate hint in Hz. 0 = highest the display offers.
    pub refresh_rate: u32,
    pub keep_screen_on: bool,
}

impl Default for DisplayConfig {
    fn default() -> Self {
        Self {
            render_scale: 1.0,
            ui_scale: 0.0,
            laptop_mode: LaptopMode::Auto,
            refresh_rate: 0,
            keep_screen_on: true,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct InputConfig {
    pub touch_mode: TouchInputMode,
    /// Capture an external mouse/touchpad (DeX, Bluetooth) so the guest gets relative motion.
    pub pointer_capture: bool,
    pub key_repeat_delay_ms: i32,
    /// Repeats per second.
    pub key_repeat_rate: i32,
}

impl Default for InputConfig {
    fn default() -> Self {
        Self {
            touch_mode: TouchInputMode::Direct,
            pointer_capture: false,
            key_repeat_delay_ms: 400,
            key_repeat_rate: 30,
        }
    }
}

/// Experimental hardware acceleration (Mesa Turnip/Freedreno on KGSL). Off by default.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct GpuConfig {
    pub enabled: bool,
    /// `freedreno` (GL via Freedreno-on-KGSL) or `zink` (GL via Zink on Turnip).
    pub driver: String,
}

impl Default for GpuConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            driver: "freedreno".to_string(),
        }
    }
}

/// Optional x86 compatibility layers, installed on demand by setup.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct X86Config {
    /// Install Box64 so x86_64 Linux programs run.
    pub box64: bool,
    /// Install x86_64 Wine (runs under Box64; implies `box64`).
    pub wine: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct SessionConfig {
    /// Keep a foreground service (ongoing notification) so Android does not kill the session in the background.
    pub foreground_service: bool,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            foreground_service: true,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserConfig {
    pub username: String,
}

impl Default for UserConfig {
    fn default() -> Self {
        Self {
            username: "root".to_string(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CommandConfig {
    #[serde(default = "default_check")]
    pub check: String,
    #[serde(default = "default_install")]
    pub install: String,
    #[serde(default = "default_launch")]
    pub launch: String,
}

/// Packages the default desktop needs, in the order `default_check` queries them.
/// `xfce4` (a group) is installed by `default_install`; the check names the members that matter.
const DEFAULT_CHECK_PACKAGES: &[&str] = &[
    "noto-fonts",
    "xfce4-session",
    "xfce4-panel",
    "xfce4-settings",
    "xfce4-terminal",
    "thunar",
    "xfdesktop",
    "xfconf",
    "labwc",
    "wlr-randr",
    "xorg-xwayland",
    "xdg-desktop-portal",
    "xdg-desktop-portal-gtk",
    "onboard",
    "firefox",
    "evince",
    "pipewire",
    "pipewire-audio",
    "pipewire-alsa",
    // GUI editor for the "Local Desktop Settings" launcher.
    "mousepad",
];

/// One `pacman -Q` for all packages: it exits non-zero when any of them is missing, which is
/// what the former chain of 19 `pacman -Q x && pacman -Q y …` calls did, minus 18 proot execs.
fn default_check() -> String {
    format!("pacman -Q {}", DEFAULT_CHECK_PACKAGES.join(" "))
}

fn default_install() -> String {
    "stdbuf -oL pacman -Syu --needed --noconfirm --noprogressbar noto-fonts xfce4 labwc wlr-randr xorg-xwayland xdg-desktop-portal xdg-desktop-portal-gtk onboard firefox evince pipewire pipewire-audio pipewire-alsa mousepad"
        .to_string()
}
/// Direct the desktop session to the compositor and the host PipeWire socket.
fn default_launch() -> String {
    format!("export PIPEWIRE_RUNTIME_DIR={PIPEWIRE_GUEST_RUNTIME_DIR} PULSE_SERVER={PULSE_GUEST_SERVER}; XDG_RUNTIME_DIR=/tmp WAYLAND_DISPLAY=wayland-0 XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=XFCE /usr/local/bin/startxfce4-localdesktop 2>&1")
        .to_string()
}

impl Default for CommandConfig {
    fn default() -> Self {
        Self {
            check: default_check(),
            install: default_install(),
            launch: default_launch(),
        }
    }
}

/// Header of a freshly generated settings file.
const SETTINGS_FILE_HEADER: &str = r#"## Local Desktop settings
##
## Every option below is commented out and shows its default value. To change one, remove
## the leading `#` of the option (and of its `[section]` line). Changes apply the next time
## the app starts: close it from the recents screen and open it again.
##
## Prefix a key with `try_` (for example `try_ui_scale = 2.0`) to test a value once: the
## prefixed line is applied on the next start and then commented out automatically.
"#;

/// Commented documentation blocks, one per settings section, in file order. Option lines are
/// written as `#key = value` (no space) and documentation lines as `## text`, so a test can
/// uncomment exactly the options and check them against the real defaults.
fn settings_sections() -> Vec<(&'static str, String)> {
    let default_command = CommandConfig::default();
    vec![
        (
            "user",
            r#"#[user]
## Account the desktop runs as. root is the default: inside the guest it is only emulated
## root (it has no Android privileges), but a browser or Wine exploit running as root can
## rewrite the whole guest system. For an unprivileged desktop create the account first
## (`useradd -m -G wheel NAME`, then `passwd NAME`) and put its name here.
#username = "root"
"#
            .to_string(),
        ),
        (
            "command",
            format!(
                r#"#[command]
## Shell commands run inside the guest. Leave them alone unless you know what you change.
## check:   exits 0 when the desktop packages are installed (a single `pacman -Q`)
## install: installs them when `check` fails
## launch:  starts the desktop session
#check = {check:?}
#install = {install:?}
#launch = {launch:?}
"#,
                check = default_command.check,
                install = default_command.install,
                launch = default_command.launch,
            ),
        ),
        (
            "display",
            r#"#[display]
## Fraction of the physical pixels the guest renders at (0.5 - 1.0). Lower is faster but blurrier.
#render_scale = 1.0
## Guest UI scale. 0 = derive it from the screen density on every display change (fold, unfold,
## DeX). Fractional values such as 1.75 or 2.5 are supported.
#ui_scale = 0.0
## Half-folded "laptop" layout (desktop above the hinge, touchpad below): "auto" only while the
## hinge is half open, "on" whenever the window is landscape, "off" never.
#laptop_mode = "auto"
## Preferred refresh rate in Hz. 0 = the highest rate the display offers.
#refresh_rate = 0
## Keep the screen on while the desktop is shown.
#keep_screen_on = true
"#
            .to_string(),
        ),
        (
            "input",
            r#"#[input]
## "direct": the pointer jumps to your finger (tablet style).
## "touchpad": the whole screen acts as a laptop touchpad (relative pointer movement).
#touch_mode = "direct"
## Capture an external mouse or touchpad (DeX, Bluetooth) so the desktop receives relative motion.
#pointer_capture = false
## Hardware keyboard auto-repeat: delay before repeating in milliseconds, then repeats per second.
#key_repeat_delay_ms = 400
#key_repeat_rate = 30
"#
            .to_string(),
        ),
        (
            "gpu",
            r#"#[gpu]
## EXPERIMENTAL GPU acceleration for the Adreno GPU (Mesa with the KGSL backend). Off by default.
## Turning it on downloads a pinned Mesa build into /opt/localdesktop-mesa on the next start;
## turning it off again restores the stock Mesa software renderer. Diagnose with
## `localdesktop-gpu-probe` (report in /var/log/localdesktop/gpu-probe.txt).
#enabled = false
## "freedreno": OpenGL straight on Freedreno/KGSL. "zink": OpenGL on top of the Turnip Vulkan driver.
#driver = "freedreno"
"#
            .to_string(),
        ),
        (
            "x86",
            r#"#[x86]
## Run x86_64 Linux programs through Box64 (installed on the next start, about 60 MB).
## Start them with `box64 PROGRAM` or `x64 PROGRAM`; `box64-preset performance PROGRAM` picks a speed/compatibility preset.
#box64 = false
## Run Windows programs with Wine (x86_64 build under Box64; implies box64, about 400 MB).
## Use the `wine` and `winecfg` commands or the "Wine Configuration" launcher.
#wine = false
"#
            .to_string(),
        ),
        (
            "session",
            r#"#[session]
## Keep a foreground service (ongoing notification) so Android does not stop the desktop in the background.
#foreground_service = true
"#
            .to_string(),
        ),
    ]
}

/// The complete commented settings template written on first setup.
pub fn settings_template() -> String {
    let mut template = String::from(SETTINGS_FILE_HEADER);
    for (_, block) in settings_sections() {
        template.push('\n');
        template.push_str(&block);
    }
    template
}

/// Adds the documentation of every settings section the file does not mention yet.
///
/// Existing text is never modified: a section counts as present when the file has its
/// `[name]` header, commented (`#[name]` / `# [name]`) or not. An empty file gets the whole
/// template. Idempotent.
pub fn merge_settings_template(existing: &str) -> String {
    if existing.trim().is_empty() {
        return settings_template();
    }

    let mentions = |name: &str| {
        let header = format!("[{name}]");
        existing.lines().any(|line| {
            let line = line.trim();
            line == header || line.strip_prefix('#').map_or(false, |rest| rest.trim() == header)
        })
    };

    let mut merged = existing.to_string();
    for (name, block) in settings_sections() {
        if mentions(name) {
            continue;
        }
        if !merged.ends_with('\n') {
            merged.push('\n');
        }
        merged.push('\n');
        merged.push_str(&block);
    }
    merged
}

/// This function does 2 major tasks:
/// - Read config from `CONFIG_FILE`, and override configs with their `try_*` versions, and return the configs line by line
/// - Write back to the config file, with `try_*` configs commented out
///
/// **Important**: As each call to this function will comment out the `try_*` config, it is **non-idempotent**.
fn process_config_file(full_config_path: String) -> Vec<String> {
    let mut write_back_lines: Vec<String> = vec![];
    let mut effective_config: Vec<String> = vec![];

    if let Ok(content) = fs::read_to_string(&full_config_path) {
        for line in content.lines() {
            let trimmed = line.trim();

            if let Some((key, value)) = trimmed.split_once('=') {
                let key = key.trim();
                let value = value.trim();

                if key.starts_with("try_") {
                    // Comment out the `try_*` configs
                    write_back_lines.push(format!("# {}", trimmed));

                    // Prefer the `try_*` configs
                    let actual_key = key.trim_start_matches("try_");
                    if let Some(line_index) = effective_config
                        .iter()
                        .position(|line| line.starts_with(&format!("{}=", actual_key)))
                    {
                        // Config exists, overriding
                        effective_config[line_index] = format!("{}={}", actual_key, value);
                    } else {
                        // Config does not exist, appending
                        effective_config.push(format!("{}={}", actual_key, value));
                        // Make sure there are no spaces around = so that the check existing key logic works
                    }
                } else {
                    // Keep the config as is
                    write_back_lines.push(trimmed.to_string());

                    if effective_config
                        .iter()
                        .any(|line| line.starts_with(&format!("{}=", key)))
                    {
                        // If already overridden by try_ version, skip inserting
                    } else {
                        // Config does not exist, appending
                        effective_config.push(format!("{}={}", key, value)); // Make sure there are no spaces around = so that the check existing key logic works
                    }
                }
            } else {
                // Keep the line as is
                write_back_lines.push(trimmed.to_string());
                effective_config.push(trimmed.to_string());
            }
        }

        // Rewrite config with try_* lines commented out
        let _ = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&full_config_path)
            .and_then(|mut file| {
                for line in &write_back_lines {
                    writeln!(file, "{}", line)?;
                }
                Ok(())
            });
    }

    // Convert effective config back to lines
    effective_config
}

pub fn parse_config(full_config_path: String) -> LocalConfig {
    let lines = process_config_file(full_config_path);
    let content = lines.join("\n");
    if let Ok(config) = toml::from_str::<LocalConfig>(&content) {
        return config;
    }
    // Config malformed, use the default config and the user can modify it again
    let default_config = LocalConfig::default();
    default_config
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn with_config_file(content: &str, f: impl Fn(String)) -> () {
        let dir = tempdir().unwrap();
        let base_dir = dir.path().to_str().unwrap();
        let path = format!("{}/etc/localdesktop", base_dir);
        fs::create_dir_all(&path).unwrap();
        let file_path = format!("{}/localdesktop.toml", path);
        fs::write(&file_path, content).unwrap();
        f(file_path)
    }

    #[test]
    fn should_handle_configs_without_try() {
        with_config_file(
            r#"
                [user]
                username = "alice"

                [command]
                check = "check-cmd"
                install = "install-cmd"
                launch = "launch-cmd"
            "#,
            |full_config_path| {
                let config = parse_config(full_config_path);
                assert_eq!(config.user.username, "alice");
                assert_eq!(config.command.check, "check-cmd");
                assert_eq!(config.command.install, "install-cmd");
                assert_eq!(config.command.launch, "launch-cmd");
            },
        );
    }

    #[test]
    fn should_handle_configs_with_try() {
        with_config_file(
            r#"
                [user]
                username = "root"
                try_username = "testuser"

                [command]
                check = "check-cmd"
                try_check = "try-check"
                install = "install-cmd"
                launch = "launch-cmd"
            "#,
            |full_config_path| {
                let config = parse_config(full_config_path);
                assert_eq!(config.user.username, "testuser");
                assert_eq!(config.command.check, "try-check");
                assert_eq!(config.command.install, "install-cmd")
            },
        );
    }

    #[test]
    fn should_comment_out_try_configs() {
        with_config_file(
            r#"
                username = "root"
                try_username = "commented"

                check = "normal"
                try_check = "try"
            "#,
            |full_config_path| {
                let _ = parse_config(full_config_path.clone()); // This triggers rewriting the config file
                let content = fs::read_to_string(full_config_path).unwrap();

                assert!(
                    content.contains("# try_username = \"commented\""),
                    "❌ `try_username` is not commented out after being applied"
                );
                assert!(
                    content.contains("# try_check = \"try\""),
                    "❌ `try_check` is not commented out after being  applied"
                );
            },
        );
    }

    /// Uncommenting every option of the generated template must yield exactly the defaults,
    /// so the documented values can never drift from the real ones.
    #[test]
    fn settings_template_documents_the_defaults() {
        let template = settings_template();
        let uncommented: String = template
            .lines()
            .map(|line| match line.strip_prefix('#') {
                Some(rest)
                    if rest
                        .chars()
                        .next()
                        .map_or(false, |c| c.is_ascii_alphabetic() || c == '[') =>
                {
                    rest
                }
                _ => line,
            })
            .collect::<Vec<_>>()
            .join("\n");

        let parsed: LocalConfig =
            toml::from_str(&uncommented).expect("template must be valid TOML");
        let default = LocalConfig::default();
        assert_eq!(parsed.user.username, default.user.username);
        assert_eq!(parsed.command.check, default.command.check);
        assert_eq!(parsed.command.install, default.command.install);
        assert_eq!(parsed.command.launch, default.command.launch);
        assert_eq!(parsed.display.render_scale, default.display.render_scale);
        assert_eq!(parsed.display.ui_scale, default.display.ui_scale);
        assert_eq!(parsed.display.laptop_mode, default.display.laptop_mode);
        assert_eq!(parsed.display.refresh_rate, default.display.refresh_rate);
        assert_eq!(
            parsed.display.keep_screen_on,
            default.display.keep_screen_on
        );
        assert_eq!(parsed.input.touch_mode, default.input.touch_mode);
        assert_eq!(parsed.input.pointer_capture, default.input.pointer_capture);
        assert_eq!(
            parsed.input.key_repeat_delay_ms,
            default.input.key_repeat_delay_ms
        );
        assert_eq!(parsed.input.key_repeat_rate, default.input.key_repeat_rate);
        assert_eq!(parsed.gpu.enabled, default.gpu.enabled);
        assert_eq!(parsed.gpu.driver, default.gpu.driver);
        assert_eq!(parsed.x86.box64, default.x86.box64);
        assert_eq!(parsed.x86.wine, default.x86.wine);
        assert_eq!(
            parsed.session.foreground_service,
            default.session.foreground_service
        );
    }

    #[test]
    fn settings_template_is_inert_until_edited() {
        with_config_file(&settings_template(), |full_config_path| {
            let config = parse_config(full_config_path.clone());
            assert_eq!(config.user.username, "root");
            assert!(!config.gpu.enabled);
            assert!(!config.x86.wine);
            // Reading the config must not rewrite the template.
            assert_eq!(
                fs::read_to_string(full_config_path).unwrap().trim_end(),
                settings_template().trim_end()
            );
        });
    }

    #[test]
    fn merge_settings_template_keeps_existing_content_and_is_idempotent() {
        let existing = "[user]\nusername = \"alice\"\n\n[gpu]\nenabled = true\n";
        let merged = merge_settings_template(existing);
        assert!(
            merged.starts_with(existing),
            "existing text must stay untouched"
        );
        assert_eq!(merged.matches("[user]").count(), 1);
        assert_eq!(merged.matches("[gpu]").count(), 1);
        assert!(merged.contains("#[display]"));
        assert!(merged.contains("#[x86]"));
        assert_eq!(merge_settings_template(&merged), merged);

        let parsed: LocalConfig = toml::from_str(&merged).unwrap();
        assert_eq!(parsed.user.username, "alice");
        assert!(parsed.gpu.enabled);
    }

    #[test]
    fn merge_settings_template_creates_the_full_file_when_missing() {
        assert_eq!(merge_settings_template(""), settings_template());
        assert_eq!(merge_settings_template("\n  \n"), settings_template());
    }

    #[test]
    fn pinned_downloads_are_well_formed() {
        for asset in [
            &ARCH_FS_ARCHIVE_ASSET,
            &MESA_KGSL_ASSET,
            &BOX64_PACKAGE_ASSET,
            &BOX64_X86_LIBS_ASSET,
            &WINE_ASSET,
        ] {
            assert_eq!(asset.sha256.len(), 64, "{}", asset.name);
            assert!(
                asset
                    .sha256
                    .chars()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                "{}",
                asset.name
            );
            assert!(asset.size > 0, "{}", asset.name);
            assert!(!asset.urls.is_empty(), "{}", asset.name);
            assert!(
                asset.urls.iter().all(|u| u.starts_with("https://")),
                "{}",
                asset.name
            );
        }
        assert_eq!(ARCH_FS_ARCHIVE_ASSET.urls[0], ARCH_FS_ARCHIVE);
        assert_eq!(ARCH_FS_ARCHIVE_ASSET.size, 151_744_988);
    }

    #[test]
    fn default_check_is_a_single_pacman_query() {
        let check = default_check();
        let install = default_install();
        assert_eq!(check.matches("pacman").count(), 1);
        assert!(check.starts_with("pacman -Q "));
        for package in DEFAULT_CHECK_PACKAGES {
            assert!(check.contains(package), "{package} missing from check");
        }
        // The check names members of the `xfce4` group; every other package is installed by name.
        for package in DEFAULT_CHECK_PACKAGES
            .iter()
            .filter(|p| !p.starts_with("xfce4-") && !matches!(**p, "thunar" | "xfdesktop" | "xfconf"))
        {
            assert!(install.contains(package), "{package} missing from install");
        }
    }

    #[test]
    fn pacman_mirrors_are_https_only() {
        assert!(!PACMAN_MIRRORS.is_empty());
        assert!(PACMAN_MIRRORS
            .iter()
            .all(|m| m.starts_with("https://") && m.ends_with("/$arch/$repo")));
    }
}
