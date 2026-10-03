//! Opt-in setup stages: the experimental Adreno GPU path (`[gpu] enabled`) and the x86 layers
//! (`[x86] box64` / `[x86] wine`). Each stage does nothing at all while its flag is off, and is
//! idempotent once its marker file in the guest matches the pinned release.
//!
//! Every download is pinned by SHA-256 (`core::config::PinnedAsset`). A failed install is
//! reported to the setup UI and retried on the next start, at most `MAX_ATTEMPTS` times in total
//! (delete `/etc/localdesktop/state/<stage>.failures` in the guest to try again).

use super::{
    download::download_verified,
    process::ArchProcess,
    setup::{chroot_home_dir, write_executable, write_if_changed, SetupMessage, SetupOptions},
};
use crate::{
    android::utils::application_context::get_application_context,
    core::{
        config::{
            ARCH_FS_ROOT, BOX64_PACKAGE_ASSET, BOX64_PACKAGE_VERSION, BOX64_X86_LIBS_ASSET,
            MESA_KGSL_ASSET, MESA_KGSL_PREFIX, MESA_KGSL_RELEASE, WINE_ASSET, WINE_VERSION,
        },
        guest,
    },
};
use std::{
    fs::{self, File},
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{mpsc::Sender, Arc},
    thread::{self, JoinHandle},
};
use tar::Archive;
use xz2::read::XzDecoder;

type StageOutput = Option<JoinHandle<()>>;

const MAX_ATTEMPTS: u32 = 3;
/// Where downloads are staged; inside the guest so `pacman -U` and `tar` can read them.
const CACHE_DIR_IN_GUEST: &str = "var/cache/localdesktop";

fn fs_root() -> &'static Path {
    Path::new(ARCH_FS_ROOT)
}

fn state_dir() -> PathBuf {
    fs_root().join("etc/localdesktop/state")
}

fn failures(stage: &str) -> u32 {
    fs::read_to_string(state_dir().join(format!("{stage}.failures")))
        .ok()
        .and_then(|content| content.trim().parse().ok())
        .unwrap_or(0)
}

fn record_failure(stage: &str) {
    let _ = fs::create_dir_all(state_dir());
    let _ = fs::write(
        state_dir().join(format!("{stage}.failures")),
        (failures(stage) + 1).to_string(),
    );
}

fn clear_failures(stage: &str) {
    let _ = fs::remove_file(state_dir().join(format!("{stage}.failures")));
}

/// Runs `command` in the guest as root, streaming its output to the setup UI.
fn guest_run(command: &str, sender: &Sender<SetupMessage>) -> Result<(), String> {
    let sender = sender.clone();
    let output = ArchProcess {
        command: command.to_string(),
        user: None,
        log: Some(Arc::new(move |line| {
            let _ = sender.send(SetupMessage::Progress(line));
        })),
    }
    .run();
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "`{}` failed ({})",
            command.split_whitespace().take(3).collect::<Vec<_>>().join(" "),
            output
                .status
                .code()
                .map_or("killed by a signal".to_string(), |code| format!("exit {code}"))
        ))
    }
}

fn progress(sender: &Sender<SetupMessage>) -> impl Fn(String) + '_ {
    move |message| {
        let _ = sender.send(SetupMessage::Progress(message));
    }
}

/// Common frame of an optional stage's thread: reports the outcome and keeps failures
/// from aborting the remaining setup stages.
fn run_stage(
    name: &'static str,
    label: &'static str,
    sender: Sender<SetupMessage>,
    install: impl FnOnce(&Sender<SetupMessage>) -> Result<(), String> + Send + 'static,
) -> StageOutput {
    Some(thread::spawn(move || {
        let _ = sender.send(SetupMessage::Progress(format!("Setting up {label}...")));
        match install(&sender) {
            Ok(()) => {
                clear_failures(name);
                let _ = sender.send(SetupMessage::Progress(format!("{label} is ready.")));
            }
            Err(error) => {
                record_failure(name);
                log::error!("{label} setup failed: {error}");
                let _ = sender.send(SetupMessage::Error(format!(
                    "{label} could not be installed: {error}. It stays disabled and is retried on the next start ({}/{MAX_ATTEMPTS} attempts used).",
                    failures(name)
                )));
            }
        }
    }))
}

/// Unpacks a tar stream below `dest`, dropping the first `strip` path components and every
/// entry for which `skip` returns true. Paths that would leave `dest` are rejected.
fn unpack_stripped(
    reader: impl Read,
    dest: &Path,
    strip: usize,
    skip: impl Fn(&Path) -> bool,
) -> Result<(), String> {
    let mut archive = Archive::new(reader);
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
        let relative: PathBuf = path
            .components()
            .filter(|c| !matches!(c, Component::CurDir))
            .skip(strip)
            .collect();
        if relative.as_os_str().is_empty() || skip(&relative) {
            continue;
        }
        if relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err(format!("unsafe path in archive: {}", path.display()));
        }
        // Android forbids hard links in app data; none of the pinned archives contain any.
        if entry.header().entry_type().is_hard_link() {
            return Err(format!("unexpected hard link in archive: {}", path.display()));
        }
        let target = dest.join(&relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        entry
            .unpack(&target)
            .map_err(|e| format!("{}: {e}", target.display()))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// GPU
// ---------------------------------------------------------------------------------------------

/// Guest packages the KGSL Mesa build links against (the build itself comes from the pinned
/// archive), plus the tools `localdesktop-gpu-probe` uses.
const GPU_GUEST_PACKAGES: &str = "vulkan-icd-loader libdisplay-info llvm-libs spirv-tools lm_sensors libxshmfence vulkan-tools mesa-utils wayland-utils glmark2";

/// Unpacks the `mesa` and `vulkan-freedreno` packages of the lfdevs archive into `prefix`
/// (not into `/usr`, so the stock Mesa is untouched) and points the ICD and EGL vendor files at it.
fn install_mesa_kgsl(archive: &Path, prefix: &Path) -> Result<(), String> {
    let _ = fs::remove_dir_all(prefix);
    fs::create_dir_all(prefix).map_err(|e| format!("{}: {e}", prefix.display()))?;

    let mut outer = Archive::new(File::open(archive).map_err(|e| e.to_string())?);
    let mut found = (false, false);
    for entry in outer.entries().map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry
            .path()
            .map_err(|e| e.to_string())?
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let is_mesa = name.starts_with("mesa-") && !name.starts_with("mesa-docs-");
        let is_turnip = name.starts_with("vulkan-freedreno-");
        if !(is_mesa || is_turnip) || !name.ends_with(".pkg.tar.xz") {
            continue;
        }
        found.0 |= is_mesa;
        found.1 |= is_turnip;
        // Package metadata (.PKGINFO, .MTREE, ...) is skipped; header files are not needed.
        unpack_stripped(XzDecoder::new(entry), prefix, 0, |relative| {
            relative
                .components()
                .next()
                .map_or(true, |c| c.as_os_str().to_string_lossy().starts_with('.'))
                || relative.starts_with("usr/include")
                || relative.starts_with("usr/share/licenses")
        })
        .map_err(|e| format!("{name}: {e}"))?;
    }
    if found != (true, true) {
        return Err("the Mesa archive does not contain the expected packages".to_string());
    }

    // The packages hard-code /usr/lib; rewrite the two loader files to the new prefix.
    let icd = prefix.join("usr/share/vulkan/icd.d/freedreno_icd.aarch64.json");
    let egl = prefix.join("usr/share/glvnd/egl_vendor.d/50_mesa.json");
    for (file, from, to) in [
        (
            &icd,
            "\"/usr/lib/libvulkan_freedreno.so\"",
            format!("\"{MESA_KGSL_PREFIX}/usr/lib/libvulkan_freedreno.so\""),
        ),
        (
            &egl,
            "\"libEGL_mesa.so.0\"",
            format!("\"{MESA_KGSL_PREFIX}/usr/lib/libEGL_mesa.so.0\""),
        ),
    ] {
        let content = fs::read_to_string(file).map_err(|e| format!("{}: {e}", file.display()))?;
        if !content.contains(from) {
            return Err(format!("{} has an unexpected format", file.display()));
        }
        fs::write(file, content.replace(from, &to))
            .map_err(|e| format!("{}: {e}", file.display()))?;
    }

    fs::write(prefix.join(".release"), format!("{MESA_KGSL_RELEASE}\n")).map_err(|e| e.to_string())
}

/// `[gpu] enabled = true`: installs the Mesa KGSL build into `/opt/localdesktop-mesa`.
/// `session-env.sh`/`gpu-env.sh` (written by the guest tuning stage) select it at session start.
pub fn setup_gpu(options: &SetupOptions) -> StageOutput {
    if !get_application_context().local_config.gpu.enabled {
        return None;
    }

    let prefix = fs_root().join(MESA_KGSL_PREFIX.trim_start_matches('/'));
    let installed = fs::read_to_string(prefix.join(".release"))
        .map_or(false, |release| release.trim() == MESA_KGSL_RELEASE);
    if installed {
        return None;
    }
    if failures("gpu") >= MAX_ATTEMPTS {
        log::warn!("GPU setup failed {MAX_ATTEMPTS} times; skipping it until the failure counter is reset");
        return None;
    }

    let data_dir = get_application_context().data_dir;
    run_stage(
        "gpu",
        "the experimental GPU driver",
        options.mpsc_sender.clone(),
        move |sender| {
            guest_run(
                &format!("rm -f /var/lib/pacman/db.lck; stdbuf -oL pacman -Syu --needed --noconfirm --noprogressbar {GPU_GUEST_PACKAGES}"),
                sender,
            )?;
            let archive = data_dir.join("mesa-kgsl.tar");
            download_verified(&MESA_KGSL_ASSET, &archive, &progress(sender))?;
            let result = install_mesa_kgsl(&archive, &prefix);
            let _ = fs::remove_file(&archive);
            result
        },
    )
}

// ---------------------------------------------------------------------------------------------
// x86: Box64 and Wine
// ---------------------------------------------------------------------------------------------

fn box64_installed() -> bool {
    fs::read_to_string(state_dir().join("box64.version"))
        .map_or(false, |v| v.trim() == BOX64_PACKAGE_VERSION)
        && fs_root().join("usr/bin/box64").exists()
}

fn wine_installed() -> bool {
    fs::read_to_string(fs_root().join("opt/wine/.version"))
        .map_or(false, |v| v.trim() == WINE_VERSION)
        && fs_root().join("opt/wine/bin/wine").exists()
}

/// Wrappers, rc file and launchers; cheap, rewritten when they differ.
fn write_x86_files(wine: bool) {
    let root = fs_root();
    let bin = root.join("usr/local/bin");
    write_if_changed(&bin.join("box64-preset"), guest::BOX64_PRESET_SCRIPT, 0o755);
    write_if_changed(&bin.join("box64"), guest::BOX64_WRAPPER, 0o755);
    write_if_changed(&bin.join("x64"), guest::X64_WRAPPER, 0o755);

    // Per-program overrides are the user's to edit: create only.
    let rc = root.join("etc/box64.box64rc");
    if !rc.exists() {
        let _ = fs::write(&rc, guest::BOX64_RC);
    }

    if wine {
        write_if_changed(&bin.join("wine"), guest::WINE_WRAPPER, 0o755);
        write_if_changed(&bin.join("wine64"), guest::WINE_WRAPPER, 0o755);
        write_if_changed(&bin.join("wineserver"), guest::WINESERVER_WRAPPER, 0o755);
        for tool in guest::WINE_TOOLS {
            write_if_changed(&bin.join(tool), &guest::wine_tool_wrapper(tool), 0o755);
        }

        let applications = root.join("usr/local/share/applications");
        write_if_changed(
            &applications.join("localdesktop-wine-config.desktop"),
            &guest::wine_config_desktop_entry(),
            0o644,
        );
        write_if_changed(
            &applications.join("localdesktop-wine-loader.desktop"),
            &guest::wine_loader_desktop_entry(),
            0o644,
        );

        // Desktop icon for the configuration tool, created once.
        let username = get_application_context().local_config.user.username;
        let desktop = chroot_home_dir(root, &username).join("Desktop");
        let icon = desktop.join("localdesktop-wine-config.desktop");
        if desktop.is_dir() && !icon.exists() {
            write_executable(&icon, &guest::wine_config_desktop_entry());
        }
    }
}

/// Box64 from the pinned archlinuxcn package (installed with `pacman -U`, so it is a normal
/// registered package) plus the pinned x86 library bundle.
fn install_box64(sender: &Sender<SetupMessage>) -> Result<(), String> {
    let cache = fs_root().join(CACHE_DIR_IN_GUEST);
    fs::create_dir_all(&cache).map_err(|e| format!("{}: {e}", cache.display()))?;

    let package = cache.join("box64-0.4.4-1-aarch64.pkg.tar.zst");
    download_verified(&BOX64_PACKAGE_ASSET, &package, &progress(sender))?;
    let result = guest_run(
        &format!(
            "rm -f /var/lib/pacman/db.lck; pacman -U --noconfirm --noprogressbar --needed /{CACHE_DIR_IN_GUEST}/box64-0.4.4-1-aarch64.pkg.tar.zst"
        ),
        sender,
    );
    let _ = fs::remove_file(&package);
    result?;

    let libs = cache.join("box64-bundle-x86-libs.tar.gz");
    download_verified(&BOX64_X86_LIBS_ASSET, &libs, &progress(sender))?;
    let result = guest_run(
        &format!(
            "tar -xzf /{CACHE_DIR_IN_GUEST}/box64-bundle-x86-libs.tar.gz -C / --no-overwrite-dir --no-same-owner"
        ),
        sender,
    );
    let _ = fs::remove_file(&libs);
    result?;

    if !fs_root().join("usr/bin/box64").exists() {
        return Err("the Box64 package did not install /usr/bin/box64".to_string());
    }
    fs::create_dir_all(state_dir()).map_err(|e| e.to_string())?;
    fs::write(
        state_dir().join("box64.version"),
        format!("{BOX64_PACKAGE_VERSION}\n"),
    )
    .map_err(|e| e.to_string())
}

/// x86_64 Wine (WoW64 build) into `/opt/wine`. Unpacked from the host side: the archive holds
/// about 4000 files, and creating them through proot's ptrace would be many times slower.
fn install_wine(sender: &Sender<SetupMessage>) -> Result<(), String> {
    let cache = fs_root().join(CACHE_DIR_IN_GUEST);
    fs::create_dir_all(&cache).map_err(|e| format!("{}: {e}", cache.display()))?;

    let archive = cache.join("wine.tar.xz");
    download_verified(&WINE_ASSET, &archive, &progress(sender))?;

    let _ = sender.send(SetupMessage::Progress("Unpacking Wine...".to_string()));
    let staging = fs_root().join("opt/wine.new");
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|e| format!("{}: {e}", staging.display()))?;
    let result = File::open(&archive)
        .map_err(|e| e.to_string())
        .and_then(|file| {
            unpack_stripped(XzDecoder::new(file), &staging, 1, |relative| {
                relative.starts_with("include")
            })
        });
    let _ = fs::remove_file(&archive);
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    if !staging.join("bin/wine").exists() {
        let _ = fs::remove_dir_all(&staging);
        return Err("the Wine archive does not contain bin/wine".to_string());
    }
    fs::write(staging.join(".version"), format!("{WINE_VERSION}\n")).map_err(|e| e.to_string())?;

    let target = fs_root().join("opt/wine");
    let _ = fs::remove_dir_all(&target);
    fs::rename(&staging, &target).map_err(|e| format!("cannot move Wine into place: {e}"))
}

/// `[x86] box64` / `[x86] wine`: Box64 from a pinned package, optionally the pinned x86_64 Wine
/// build, wrappers that run it through Box64, and launchers. Skipped entirely when both flags are off.
pub fn setup_x86(options: &SetupOptions) -> StageOutput {
    let x86 = get_application_context().local_config.x86;
    let wine = x86.wine;
    let box64 = x86.box64 || wine; // Wine runs through Box64.
    if !box64 {
        return None;
    }

    let need_box64 = !box64_installed();
    let need_wine = wine && !wine_installed();
    if !need_box64 && !need_wine {
        write_x86_files(wine);
        return None;
    }
    if failures("x86") >= MAX_ATTEMPTS {
        log::warn!("x86 setup failed {MAX_ATTEMPTS} times; skipping it until the failure counter is reset");
        return None;
    }

    run_stage(
        "x86",
        if wine { "Box64 and Wine" } else { "Box64" },
        options.mpsc_sender.clone(),
        move |sender| {
            if need_box64 {
                install_box64(sender)?;
            }
            if need_wine {
                install_wine(sender)?;
            }
            write_x86_files(wine);
            Ok(())
        },
    )
}
