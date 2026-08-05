//! Experimental PipeWire standalone-client AAudio backend.
//!
//! This proof of concept runs a PipeWire daemon in the Android app context,
//! exposes its native socket to the proot guest, and bridges playback through a
//! separate normal PipeWire client that registers an AAudio-backed `Audio/Sink`.
//!
//! The important distinction is that this is not a PipeWire/SPA plugin or
//! module. It is a standalone client process, so the POC can avoid PipeWire's
//! plugin ABI while still testing the end-to-end timing path. This is the only
//! built-in audio backend; Local Desktop no longer starts or configures a
//! separate legacy audio server.

use std::ffi::CString;
use std::fs;
use std::io::{BufRead, BufReader, Cursor, Read};
use std::net::Shutdown;
use std::os::raw::c_int;
use std::os::unix::fs as unix_fs;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use winit::platform::android::activity::AndroidApp;

use crate::android::utils::application_context::get_application_context;
use crate::core::config;

macro_rules! pw_info {
    ($step:expr, $($arg:tt)*) => {
        log::info!("[PipeWireAAudio] {}: {}", $step, format!($($arg)*))
    };
}
macro_rules! pw_debug {
    ($step:expr, $($arg:tt)*) => {
        log::debug!("[PipeWireAAudio] {}: {}", $step, format!($($arg)*))
    };
}
macro_rules! pw_warn {
    ($step:expr, $($arg:tt)*) => {
        log::warn!("[PipeWireAAudio] {}: {}", $step, format!($($arg)*))
    };
}
macro_rules! pw_error {
    ($step:expr, $($arg:tt)*) => {
        log::error!("[PipeWireAAudio] {}: {}", $step, format!($($arg)*))
    };
}

const PIPEWIRE_DAEMON_LIB: &str = "libpipewire_exec.so";
const PIPEWIRE_PULSE_DAEMON_LIB: &str = "libpipewire_pulse_exec.so";
const WIREPLUMBER_DAEMON_LIB: &str = "libwireplumber_exec.so";
const AAUDIO_SINK_LIB: &str = "liblocaldesktop_pipewire_aaudio_sink.so";
const PIPEWIRE_SOCKET_NAME: &str = "pipewire-0";
const PULSE_SOCKET_NAME: &str = "pulse/native";
const MIN_PIPEWIRE_API_LEVEL: c_int = 30;
const WIREPLUMBER_SHARE_TAR_ASSET: &str = "wireplumber-share.tar";

#[link(name = "android")]
extern "C" {
    fn android_get_device_api_level() -> c_int;
}

static AAUDIO_CHILDREN: Mutex<Option<PipewireAaudioChildren>> = Mutex::new(None);
static AAUDIO_START_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

struct PipewireAaudioChildren {
    pipewire: Child,
    pulse: Option<Child>,
    wireplumber: Option<Child>,
    sink: Child,
}

struct PipewireAaudioEnv {
    home_dir: PathBuf,
    runtime_dir: PathBuf,
    config_dir: PathBuf,
    module_dir: PathBuf,
    spa_dir: PathBuf,
    pulse_dir: PathBuf,
    wireplumber_share_dir: PathBuf,
    wireplumber_module_dir: PathBuf,
    ld_library_path: String,
}

/// Start the experimental PipeWire/AAudio bridge after the compositor is ready.
pub fn spawn_after_ready(android_app: AndroidApp) {
    if AAUDIO_START_IN_PROGRESS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        pw_debug!("server", "PipeWire/AAudio start already in progress");
        return;
    }

    pw_info!(
        "server",
        "scheduling standalone-client PipeWire/AAudio backend"
    );
    thread::spawn(move || {
        let started = phase_begin("ensure_pipewire_aaudio");
        let result = ensure_running(&android_app);
        AAUDIO_START_IN_PROGRESS.store(false, Ordering::SeqCst);
        match &result {
            Ok(()) => pw_info!(
                "server",
                "standalone-client PipeWire/AAudio ready or intentionally disabled"
            ),
            Err(e) => pw_error!("server", "standalone-client PipeWire/AAudio failed: {e}"),
        }
        phase_end("ensure_pipewire_aaudio", started);
    });
}

/// Stop the proof-of-concept processes, if they were started.
pub fn shutdown() {
    let children = if let Ok(mut slot) = AAUDIO_CHILDREN.lock() {
        slot.take()
    } else {
        None
    };

    if let Some(children) = children {
        stop_children(children);
    }

    let runtime_dir = PathBuf::from(config::ARCH_FS_ROOT).join("tmp");
    cleanup_socket(&runtime_dir);
}

fn ensure_running(android_app: &AndroidApp) -> Result<(), String> {
    let stale_children = {
        let mut slot = AAUDIO_CHILDREN
            .lock()
            .map_err(|e| format!("pipewire aaudio child lock: {e}"))?;
        if let Some(children) = slot.as_mut() {
            if let Some(reason) = poll_child_exit(children)? {
                pw_warn!(
                    "server",
                    "discarding stale PipeWire/AAudio children: {reason}"
                );
                slot.take()
            } else {
                pw_debug!("server", "reuse running PipeWire/AAudio children");
                return Ok(());
            }
        } else {
            None
        }
    };

    if let Some(children) = stale_children {
        stop_children(children);
        let runtime_dir = PathBuf::from(config::ARCH_FS_ROOT).join("tmp");
        cleanup_socket(&runtime_dir);
    }

    let api_level = device_api_level();
    if api_level < MIN_PIPEWIRE_API_LEVEL {
        pw_info!(
            "server",
            "disabled; bundled Termux PipeWire requires Android API {MIN_PIPEWIRE_API_LEVEL}+ (device API {api_level})"
        );
        return Ok(());
    }

    let ctx = get_application_context();
    let lib_dir = ctx.native_library_dir.clone();
    let pipewire_bin = lib_dir.join(PIPEWIRE_DAEMON_LIB);
    let pulse_bin = lib_dir.join(PIPEWIRE_PULSE_DAEMON_LIB);
    let sink_bin = lib_dir.join(AAUDIO_SINK_LIB);
    let wireplumber_bin = lib_dir.join(WIREPLUMBER_DAEMON_LIB);

    if !pipewire_bin.exists() || !sink_bin.exists() {
        pw_info!(
            "server",
            "disabled; bundle {} and {} in nativeLibraryDir to enable",
            PIPEWIRE_DAEMON_LIB,
            AAUDIO_SINK_LIB
        );
        return Ok(());
    }

    let env = build_pipewire_env(&ctx.data_dir, &lib_dir)?;
    fs::create_dir_all(&env.runtime_dir)
        .map_err(|e| format!("mkdir {}: {e}", env.runtime_dir.display()))?;
    fs::create_dir_all(&env.config_dir)
        .map_err(|e| format!("mkdir {}: {e}", env.config_dir.display()))?;
    fs::create_dir_all(&env.pulse_dir)
        .map_err(|e| format!("mkdir {}: {e}", env.pulse_dir.display()))?;
    prepare_spa_plugin_layout(&env, &lib_dir)?;
    if wireplumber_bin.exists() {
        prepare_wireplumber_share(android_app, &env)?;
    }
    cleanup_socket(&env.runtime_dir);

    let config = write_pipewire_config(&env.config_dir, !wireplumber_bin.exists())?;
    let mut pipewire = spawn_pipewire_daemon(&pipewire_bin, &config, &env)?;
    if let Err(e) = wait_for_socket(
        "pipewire",
        &mut pipewire,
        &env.runtime_dir.join(PIPEWIRE_SOCKET_NAME),
    ) {
        kill_child("pipewire", &mut pipewire);
        return Err(e);
    }

    let mut wireplumber = if wireplumber_bin.exists() {
        match spawn_wireplumber(&wireplumber_bin, &env) {
            Ok(child) => Some(child),
            Err(e) => {
                kill_child("pipewire", &mut pipewire);
                return Err(e);
            }
        }
    } else {
        pw_info!(
            "policy",
            "{} missing; using PipeWire's built-in session-manager module if available",
            WIREPLUMBER_DAEMON_LIB
        );
        None
    };

    let mut sink = match spawn_aaudio_sink(&sink_bin, &env) {
        Ok(child) => child,
        Err(e) => {
            if let Some(child) = wireplumber.as_mut() {
                kill_child("wireplumber", child);
            }
            kill_child("pipewire", &mut pipewire);
            return Err(e);
        }
    };
    if let Err(e) = verify_child_still_running("aaudio-sink", &mut sink, Duration::from_millis(300))
    {
        kill_child("aaudio-sink", &mut sink);
        if let Some(child) = wireplumber.as_mut() {
            kill_child("wireplumber", child);
        }
        kill_child("pipewire", &mut pipewire);
        return Err(e);
    }

    let pulse = if pulse_bin.exists() {
        let config = write_pipewire_pulse_config(&env.config_dir, &env)?;
        let mut child = match spawn_pipewire_pulse(&pulse_bin, &config, &env) {
            Ok(child) => child,
            Err(e) => {
                kill_child("aaudio-sink", &mut sink);
                if let Some(child) = wireplumber.as_mut() {
                    kill_child("wireplumber", child);
                }
                kill_child("pipewire", &mut pipewire);
                return Err(e);
            }
        };
        if let Err(e) = wait_for_socket(
            "pipewire-pulse",
            &mut child,
            &env.runtime_dir.join(PULSE_SOCKET_NAME),
        ) {
            kill_child("pipewire-pulse", &mut child);
            kill_child("aaudio-sink", &mut sink);
            if let Some(child) = wireplumber.as_mut() {
                kill_child("wireplumber", child);
            }
            kill_child("pipewire", &mut pipewire);
            return Err(e);
        }
        Some(child)
    } else {
        pw_info!(
            "pulse",
            "{} missing; PulseAudio-compatible clients such as Firefox will not have audio",
            PIPEWIRE_PULSE_DAEMON_LIB
        );
        None
    };

    *AAUDIO_CHILDREN
        .lock()
        .map_err(|e| format!("pipewire aaudio child lock: {e}"))? = Some(PipewireAaudioChildren {
        pipewire,
        pulse,
        wireplumber,
        sink,
    });
    spawn_child_monitor(env.runtime_dir.clone());

    pw_info!(
        "server",
        "guest: export PIPEWIRE_RUNTIME_DIR={} PULSE_SERVER={} XDG_RUNTIME_DIR={}",
        config::PIPEWIRE_GUEST_RUNTIME_DIR,
        config::PULSE_GUEST_SERVER,
        config::PIPEWIRE_GUEST_RUNTIME_DIR
    );
    Ok(())
}

fn spawn_child_monitor(runtime_dir: PathBuf) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(1));

        let exited_children = {
            let mut slot = match AAUDIO_CHILDREN.lock() {
                Ok(slot) => slot,
                Err(e) => {
                    pw_error!("monitor", "pipewire aaudio child lock: {e}");
                    return;
                }
            };

            let Some(children) = slot.as_mut() else {
                return;
            };

            match poll_child_exit(children) {
                Ok(Some(reason)) => {
                    pw_warn!(
                        "monitor",
                        "{reason}; stopping PipeWire/AAudio backend and cleaning socket"
                    );
                    slot.take()
                }
                Ok(None) => None,
                Err(e) => {
                    pw_error!("monitor", "failed to poll child state: {e}");
                    None
                }
            }
        };

        if let Some(children) = exited_children {
            stop_children(children);
            cleanup_socket(&runtime_dir);
            return;
        }
    });
}

fn poll_child_exit(children: &mut PipewireAaudioChildren) -> Result<Option<String>, String> {
    if let Some(status) = children
        .pipewire
        .try_wait()
        .map_err(|e| format!("pipewire try_wait: {e}"))?
    {
        return Ok(Some(format!(
            "pipewire pid={} exited (status {status})",
            children.pipewire.id()
        )));
    }

    if let Some(wireplumber) = children.wireplumber.as_mut() {
        if let Some(status) = wireplumber
            .try_wait()
            .map_err(|e| format!("wireplumber try_wait: {e}"))?
        {
            return Ok(Some(format!(
                "wireplumber pid={} exited (status {status})",
                wireplumber.id()
            )));
        }
    }

    if let Some(pulse) = children.pulse.as_mut() {
        if let Some(status) = pulse
            .try_wait()
            .map_err(|e| format!("pipewire-pulse try_wait: {e}"))?
        {
            return Ok(Some(format!(
                "pipewire-pulse pid={} exited (status {status})",
                pulse.id()
            )));
        }
    }

    if let Some(status) = children
        .sink
        .try_wait()
        .map_err(|e| format!("aaudio-sink try_wait: {e}"))?
    {
        return Ok(Some(format!(
            "aaudio-sink pid={} exited (status {status})",
            children.sink.id()
        )));
    }

    Ok(None)
}

fn device_api_level() -> c_int {
    unsafe { android_get_device_api_level() }
}

fn build_pipewire_env(data_dir: &Path, lib_dir: &Path) -> Result<PipewireAaudioEnv, String> {
    let runtime_dir = PathBuf::from(config::ARCH_FS_ROOT).join("tmp");
    let config_dir = data_dir.join("pipewire-standalone-aaudio/config");
    // Local Desktop's APK packagers extract top-level `.so` files from
    // `assets/libs/<abi>` into nativeLibraryDir. PipeWire modules can stay flat
    // there, but SPA factory names resolve through the normal subdirectory
    // layout below SPA_PLUGIN_DIR, for example support/libspa-support.
    let module_dir = lib_dir.to_path_buf();
    let spa_dir = data_dir.join("pipewire-standalone-aaudio/spa-0.2");
    let pulse_dir = runtime_dir.join("pulse");
    let wireplumber_share_dir = data_dir.join("pipewire-standalone-aaudio/share");
    let wireplumber_module_dir = lib_dir.to_path_buf();
    let ld_library_path = lib_dir.display().to_string();

    Ok(PipewireAaudioEnv {
        home_dir: data_dir.to_path_buf(),
        runtime_dir,
        config_dir,
        module_dir,
        spa_dir,
        pulse_dir,
        wireplumber_share_dir,
        wireplumber_module_dir,
        ld_library_path,
    })
}

fn apply_pipewire_env(command: &mut Command, env: &PipewireAaudioEnv) {
    command
        .env("HOME", &env.home_dir)
        .env("XDG_RUNTIME_DIR", &env.runtime_dir)
        .env("PIPEWIRE_RUNTIME_DIR", &env.runtime_dir)
        .env("PIPEWIRE_CONFIG_DIR", &env.config_dir)
        .env("PIPEWIRE_MODULE_DIR", &env.module_dir)
        .env("SPA_PLUGIN_DIR", &env.spa_dir)
        .env("LD_LIBRARY_PATH", &env.ld_library_path);

    pw_debug!("env", "XDG_RUNTIME_DIR={}", env.runtime_dir.display());
    pw_debug!("env", "PIPEWIRE_MODULE_DIR={}", env.module_dir.display());
    pw_debug!("env", "SPA_PLUGIN_DIR={}", env.spa_dir.display());
    pw_debug!("env", "LD_LIBRARY_PATH={}", env.ld_library_path);
}

fn apply_wireplumber_env(command: &mut Command, env: &PipewireAaudioEnv) {
    apply_pipewire_env(command, env);
    command
        .env(
            "WIREPLUMBER_CONFIG_DIR",
            env.wireplumber_share_dir.join("wireplumber"),
        )
        .env("WIREPLUMBER_MODULE_DIR", &env.wireplumber_module_dir)
        .env("XDG_DATA_DIRS", &env.wireplumber_share_dir);

    pw_debug!(
        "env",
        "WIREPLUMBER_CONFIG_DIR={}",
        env.wireplumber_share_dir.join("wireplumber").display()
    );
    pw_debug!(
        "env",
        "WIREPLUMBER_MODULE_DIR={}",
        env.wireplumber_module_dir.display()
    );
    pw_debug!(
        "env",
        "XDG_DATA_DIRS={}",
        env.wireplumber_share_dir.display()
    );
}

fn prepare_spa_plugin_layout(env: &PipewireAaudioEnv, lib_dir: &Path) -> Result<(), String> {
    for (subdir, lib) in [
        ("support", "libspa-support.so"),
        ("audioconvert", "libspa-audioconvert.so"),
        ("audiomixer", "libspa-audiomixer.so"),
    ] {
        let source = lib_dir.join(lib);
        if !source.exists() {
            return Err(format!("missing SPA plugin {}", source.display()));
        }

        let dir = env.spa_dir.join(subdir);
        fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;

        let dest = dir.join(lib);
        let _ = fs::remove_file(&dest);
        unix_fs::symlink(&source, &dest)
            .or_else(|_| fs::copy(&source, &dest).map(|_| ()))
            .map_err(|e| format!("link {} -> {}: {e}", dest.display(), source.display()))?;
    }

    Ok(())
}

fn prepare_wireplumber_share(
    android_app: &AndroidApp,
    env: &PipewireAaudioEnv,
) -> Result<(), String> {
    let bytes = read_android_asset(android_app, WIREPLUMBER_SHARE_TAR_ASSET)?;
    fs::create_dir_all(&env.wireplumber_share_dir)
        .map_err(|e| format!("mkdir {}: {e}", env.wireplumber_share_dir.display()))?;

    let mut archive = tar::Archive::new(Cursor::new(bytes));
    archive.unpack(&env.wireplumber_share_dir).map_err(|e| {
        format!(
            "unpack {WIREPLUMBER_SHARE_TAR_ASSET} to {}: {e}",
            env.wireplumber_share_dir.display()
        )
    })?;

    pw_info!(
        "policy",
        "prepared WirePlumber assets under {}",
        env.wireplumber_share_dir.join("wireplumber").display()
    );
    Ok(())
}

fn read_android_asset(android_app: &AndroidApp, asset_name: &str) -> Result<Vec<u8>, String> {
    let c_name = CString::new(asset_name).map_err(|e| format!("asset name {asset_name}: {e}"))?;
    let mut asset = android_app
        .asset_manager()
        .open(&c_name)
        .ok_or_else(|| format!("missing Android asset {asset_name}"))?;

    let mut bytes = Vec::with_capacity(asset.length());
    asset
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read Android asset {asset_name}: {e}"))?;
    Ok(bytes)
}

fn spa_libs_config() -> &'static str {
    r#"context.spa-libs = {
    support.* = support/libspa-support
    audio.convert.* = audioconvert/libspa-audioconvert
    audio.adapt = audioconvert/libspa-audioconvert
    audio.mixer.* = audiomixer/libspa-audiomixer
}
"#
}

fn write_pipewire_config(config_dir: &Path, use_embedded_policy: bool) -> Result<PathBuf, String> {
    let policy = if use_embedded_policy {
        "    { name = libpipewire-module-session-manager flags = [ ifexists nofail ] }\n"
    } else {
        ""
    };

    let body = format!(
        r#"# Local Desktop PipeWire standalone-client AAudio sink POC.
#
# This config intentionally does not load a Local Desktop PipeWire/SPA plugin.
# Runtime shape:
#   guest PipeWire clients -> exposed PipeWire socket -> Android-side PipeWire
#   daemon -> standalone PipeWire client with an AAudio-backed Audio/Sink.
context.properties = {{
    core.daemon = true
    core.name = pipewire-0
    default.clock.rate = 48000
    default.clock.allowed-rates = [ 48000 ]
    default.clock.quantum = 1024
    link.max-buffers = 16
    mem.warn-mlock = false
}}

{}

context.modules = [
    {{ name = libpipewire-module-rt flags = [ ifexists nofail ] }}
    {{ name = libpipewire-module-protocol-native }}
    {{ name = libpipewire-module-profiler flags = [ ifexists nofail ] }}
    {{ name = libpipewire-module-metadata }}
    {{ name = libpipewire-module-spa-device-factory }}
    {{ name = libpipewire-module-spa-node-factory }}
    {{ name = libpipewire-module-client-node }}
    {{ name = libpipewire-module-client-device }}
    {{ name = libpipewire-module-access args = {{
        access.socket = {{
            pipewire-0 = "unrestricted"
            pipewire-0-manager = "unrestricted"
        }}
    }} }}
    {{ name = libpipewire-module-adapter }}
    {{ name = libpipewire-module-link-factory }}
{policy}]

context.objects = [
    {{ factory = spa-node-factory
        args = {{
            factory.name = support.node.driver
            node.name = Dummy-Driver
            node.group = pipewire.dummy
            node.sync-group = sync.dummy
            priority.driver = 200000
        }}
    }}
    {{ factory = spa-node-factory
        args = {{
            factory.name = support.node.driver
            node.name = Freewheel-Driver
            priority.driver = 190000
            node.group = pipewire.freewheel
            node.sync-group = sync.dummy
            node.freewheel = true
        }}
    }}
]
"#,
        spa_libs_config()
    );

    let path = config_dir.join("localdesktop-pipewire.conf");
    fs::write(&path, body).map_err(|e| format!("write {}: {e}", path.display()))?;

    let client_config = format!(
        r#"# Local Desktop PipeWire client config for the standalone AAudio sink.
context.properties = {{
    application.name = localdesktop-pipewire-aaudio-sink
}}

{}

context.modules = [
    {{ name = libpipewire-module-protocol-native }}
    {{ name = libpipewire-module-client-node }}
    {{ name = libpipewire-module-adapter }}
]
"#,
        spa_libs_config()
    );
    let client_path = config_dir.join("client.conf");
    fs::write(&client_path, client_config)
        .map_err(|e| format!("write {}: {e}", client_path.display()))?;

    Ok(path)
}

fn write_pipewire_pulse_config(
    config_dir: &Path,
    env: &PipewireAaudioEnv,
) -> Result<PathBuf, String> {
    let pulse_socket = env.runtime_dir.join(PULSE_SOCKET_NAME);
    let body = format!(
        r#"# Local Desktop PipeWire Pulse compatibility service.
#
# This is not the PulseAudio daemon. It is PipeWire's PulseAudio-compatible
# protocol front door for applications such as Firefox that still use libpulse.
context.properties = {{
    mem.warn-mlock = false
}}

{}

context.modules = [
    {{ name = libpipewire-module-rt flags = [ ifexists nofail ] }}
    {{ name = libpipewire-module-protocol-native }}
    {{ name = libpipewire-module-client-node }}
    {{ name = libpipewire-module-adapter }}
    {{ name = libpipewire-module-metadata }}
    {{ name = libpipewire-module-protocol-pulse }}
]

pulse.properties = {{
    server.address = [ "unix:{}" ]
    pulse.allow-module-loading = false
    pulse.min.req = 256/48000
    pulse.default.req = 960/48000
    pulse.min.quantum = 256/48000
    pulse.idle.timeout = 0
}}

stream.properties = {{
    node.autoconnect = true
    resample.quality = 4
}}

pulse.cmd = [ ]
pulse.rules = [ ]
"#,
        spa_libs_config(),
        pulse_socket.display()
    );

    let path = config_dir.join("localdesktop-pipewire-pulse.conf");
    fs::write(&path, body).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(path)
}

fn spawn_pipewire_daemon(
    binary: &Path,
    config: &Path,
    env: &PipewireAaudioEnv,
) -> Result<Child, String> {
    pw_info!("spawn", "exec {} -c {}", binary.display(), config.display());
    let mut command = Command::new(binary);
    apply_pipewire_env(&mut command, env);
    command
        .arg("-c")
        .arg(config)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    spawn_logged(command, "pipewire")
}

fn spawn_wireplumber(binary: &Path, env: &PipewireAaudioEnv) -> Result<Child, String> {
    pw_info!("spawn", "exec {}", binary.display());
    let mut command = Command::new(binary);
    apply_wireplumber_env(&mut command, env);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    spawn_logged(command, "wireplumber")
}

fn spawn_pipewire_pulse(
    binary: &Path,
    config: &Path,
    env: &PipewireAaudioEnv,
) -> Result<Child, String> {
    pw_info!("spawn", "exec {} -c {}", binary.display(), config.display());
    let mut command = Command::new(binary);
    apply_pipewire_env(&mut command, env);
    command
        .arg("-c")
        .arg(config)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    spawn_logged(command, "pipewire-pulse")
}

fn spawn_aaudio_sink(binary: &Path, env: &PipewireAaudioEnv) -> Result<Child, String> {
    pw_info!("spawn", "exec {}", binary.display());
    let mut command = Command::new(binary);
    apply_pipewire_env(&mut command, env);
    command
        .arg("--node-name")
        .arg("localdesktop-aaudio-sink")
        .arg("--rate")
        .arg("48000")
        .arg("--channels")
        .arg("2")
        .arg("--buffer-ms")
        .arg("120")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    spawn_logged(command, "aaudio-sink")
}

fn spawn_logged(mut command: Command, name: &'static str) -> Result<Child, String> {
    let mut child = command.spawn().map_err(|e| format!("spawn {name}: {e}"))?;
    let pid = child.id();
    pw_info!("spawn", "{name} child pid={pid}");

    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || stream_child_lines(name, "stderr", stderr));
    }
    if let Some(stdout) = child.stdout.take() {
        thread::spawn(move || stream_child_lines(name, "stdout", stdout));
    }

    Ok(child)
}

fn verify_child_still_running(
    name: &str,
    child: &mut Child,
    delay: Duration,
) -> Result<(), String> {
    thread::sleep(delay);
    if let Some(status) = child
        .try_wait()
        .map_err(|e| format!("{name} try_wait: {e}"))?
    {
        return Err(format!("{name} exited during startup (status {status})"));
    }
    Ok(())
}

fn stream_child_lines(name: &'static str, stream: &'static str, pipe: impl std::io::Read) {
    for line in BufReader::new(pipe).lines().map_while(Result::ok) {
        pw_info!("daemon", "[{name}:{stream}] {line}");
    }
    pw_debug!("daemon", "[{name}:{stream}] stream closed");
}

fn wait_for_socket(name: &str, child: &mut Child, socket: &Path) -> Result<(), String> {
    let started = phase_begin("wait_socket");
    pw_info!("wait_socket", "polling {}", socket.display());

    for attempt in 1..=80 {
        if let Ok(stream) = UnixStream::connect(socket) {
            let _ = stream.shutdown(Shutdown::Both);
            pw_info!("wait_socket", "connectable after {attempt} attempt(s)");
            phase_end("wait_socket", started);
            return Ok(());
        }

        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("{name} try_wait: {e}"))?
        {
            phase_end("wait_socket", started);
            return Err(format!(
                "{name} exited before socket {} (status {status})",
                socket.display()
            ));
        }

        if attempt == 1 || attempt % 10 == 0 {
            pw_debug!("wait_socket", "attempt {attempt}/80");
        }
        thread::sleep(Duration::from_millis(100));
    }

    phase_end("wait_socket", started);
    Err(format!("timed out waiting for {}", socket.display()))
}

fn cleanup_socket(runtime_dir: &Path) {
    for name in [
        PIPEWIRE_SOCKET_NAME,
        "pipewire-0.lock",
        "pipewire-0-manager",
        "pipewire-0-manager.lock",
        PULSE_SOCKET_NAME,
        "pulse/native.lock",
    ] {
        let path = runtime_dir.join(name);
        if path.exists() {
            if let Err(e) = fs::remove_file(&path) {
                pw_warn!("cleanup", "remove {}: {e}", path.display());
            }
        }
    }
}

fn stop_children(mut children: PipewireAaudioChildren) {
    if let Some(mut pulse) = children.pulse.take() {
        kill_child("pipewire-pulse", &mut pulse);
    }
    kill_child("aaudio-sink", &mut children.sink);
    if let Some(mut wireplumber) = children.wireplumber.take() {
        kill_child("wireplumber", &mut wireplumber);
    }
    kill_child("pipewire", &mut children.pipewire);
}

fn kill_child(name: &str, child: &mut Child) {
    pw_info!("shutdown", "stopping {name} pid={}", child.id());
    let _ = child.kill();
    let _ = child.wait();
}

fn phase_begin(name: &str) -> Instant {
    pw_info!("phase", "begin {name}");
    Instant::now()
}

fn phase_end(name: &str, started: Instant) {
    pw_info!(
        "phase",
        "end {name} ({:.1} ms)",
        started.elapsed().as_secs_f64() * 1000.0
    );
}
