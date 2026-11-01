use std::{fs, path::Path, sync::OnceLock};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

static ARCH_FS_ROOT: OnceLock<String> = OnceLock::new();

/// Decide where the Arch Linux FS lives, from the app's files dir (`Context.getFilesDir()`).
///
/// `/data/data/<package>` only points at the owner's (user 0) storage, so in a secondary user
/// or Private Space the FS must live under the files dir Android gives that user instead.
/// When `/data/data/<package>/files` is this user's files dir, keep that historical path as is,
/// because PRoot bakes absolute host paths into the FS (e.g. link2symlink).
pub fn init_arch_fs_root(files_dir: &Path) {
    let root = files_dir
        .parent()
        .and_then(|app_dir| app_dir.file_name())
        .map(|package| Path::new("/data/data").join(package).join("files"))
        .filter(|legacy_files_dir| {
            match (
                fs::canonicalize(legacy_files_dir),
                fs::canonicalize(files_dir),
            ) {
                (Ok(legacy), Ok(current)) => legacy == current,
                _ => false,
            }
        })
        .unwrap_or_else(|| files_dir.to_path_buf())
        .join("arch");
    // Only the first call wins, the FS must not move while the app is running
    let _ = ARCH_FS_ROOT.set(root.to_string_lossy().into_owned());
}

/// Absolute host path of the Arch Linux FS, set once at startup by [`init_arch_fs_root`].
#[cfg(not(test))]
pub fn arch_fs_root() -> &'static str {
    ARCH_FS_ROOT
        .get()
        .expect("Arch FS root is not initialized. Please make sure `ApplicationContext::build(&android_app);` is called in `android_main`.")
}
#[cfg(test)]
pub fn arch_fs_root() -> &'static str {
    ARCH_FS_ROOT.get_or_init(|| "/data/local/tmp/arch".to_string())
}

pub const ARCH_FS_ARCHIVE: &str = "https://github.com/termux/proot-distro/releases/download/v4.29.0/archlinux-aarch64-pd-v4.29.0.tar.xz";

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

pub const SENTRY_DSN: &str = "https://d8af27f864ade027ff81ecadea91b02e@o4509548388417536.ingest.de.sentry.io/4509548392480848";

/// PipeWire runtime path as seen from inside the proot guest.
pub const PIPEWIRE_GUEST_RUNTIME_DIR: &str = "/tmp";

/// PipeWire-Pulse socket as seen from inside the proot guest.
pub const PULSE_GUEST_SERVER: &str = "unix:/tmp/pulse/native";

/// Settings from "Additional settings in the app" in Android's App info (see `utils::settings`).
#[derive(Debug, Clone)]
pub struct LocalConfig {
    pub user: UserConfig,
    pub command: CommandConfig,
    /// The Android keyboard types into the desktop, instead of Squeekboard.
    pub android_keyboard: bool,
}

impl Default for LocalConfig {
    fn default() -> Self {
        Self {
            user: UserConfig::default(),
            command: CommandConfig::default(),
            android_keyboard: true,
        }
    }
}

#[derive(Debug, Clone)]
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

#[derive(Debug, Clone)]
pub struct CommandConfig {
    pub check: String,
    pub install: String,
    pub launch: String,
}

fn default_check() -> String {
    "pacman -Q noto-fonts && pacman -Q xfce4-session && pacman -Q xfce4-panel && pacman -Q xfce4-settings && pacman -Q xfce4-terminal && pacman -Q thunar && pacman -Q xfdesktop && pacman -Q xfconf && pacman -Q labwc && pacman -Q wlr-randr && pacman -Q xorg-xwayland && pacman -Q xdg-desktop-portal && pacman -Q xdg-desktop-portal-gtk && pacman -Q squeekboard && pacman -Q firefox && pacman -Q evince && pacman -Q pipewire && pacman -Q pipewire-audio && pacman -Q pipewire-alsa"
        .to_string()
}

fn default_install() -> String {
    "stdbuf -oL pacman -Syu --needed --noconfirm --noprogressbar noto-fonts xfce4 labwc wlr-randr xorg-xwayland xdg-desktop-portal xdg-desktop-portal-gtk squeekboard firefox evince pipewire pipewire-audio pipewire-alsa"
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
