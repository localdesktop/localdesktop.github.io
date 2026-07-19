//! Experimental PipeWire standalone-client AAudio backend.
//!
//! This proof of concept runs a PipeWire daemon in the Android app context,
//! exposes its native socket to the proot guest, and bridges playback through a
//! separate normal PipeWire client that registers an AAudio-backed `Audio/Sink`.
//!
//! The important distinction is that this is not a PipeWire/SPA plugin or
//! module. It is a standalone client process, so the POC can avoid PipeWire's
//! plugin ABI while still testing the end-to-end timing path. If the
//! experimental native executables are not bundled, this module logs a no-op
//! and leaves the existing PulseAudio path untouched.

use std::fs;
use std::io::{BufRead, BufReader};
use std::net::Shutdown;
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
const WIREPLUMBER_DAEMON_LIB: &str = "libwireplumber_exec.so";
const AAUDIO_SINK_LIB: &str = "liblocaldesktop_pipewire_aaudio_sink.so";
const PIPEWIRE_SOCKET_NAME: &str = "pipewire-0";

static AAUDIO_CHILDREN: Mutex<Option<PipewireAaudioChildren>> = Mutex::new(None);
static AAUDIO_START_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

struct PipewireAaudioChildren {
    pipewire: Child,
    wireplumber: Option<Child>,
    sink: Child,
}

struct PipewireAaudioEnv {
    home_dir: PathBuf,
    runtime_dir: PathBuf,
    config_dir: PathBuf,
    module_dir: PathBuf,
    spa_dir: PathBuf,
    ld_library_path: String,
}

/// Start the experimental PipeWire/AAudio bridge after the compositor is ready.
pub fn spawn_after_ready(_android_app: AndroidApp) {
    if AAUDIO_START_IN_PROGRESS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        pw_debug!("server", "PipeWire/AAudio start already in progress");
        return;
    }

    pw_info!("server", "scheduling standalone-client PipeWire/AAudio backend");
    thread::spawn(move || {
        let started = phase_begin("ensure_pipewire_aaudio");
        let result = ensure_running();
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
    if let Ok(mut slot) = AAUDIO_CHILDREN.lock() {
        if let Some(mut children) = slot.take() {
            kill_child("aaudio-sink", &mut children.sink);
            if let Some(mut wireplumber) = children.wireplumber.take() {
                kill_child("wireplumber", &mut wireplumber);
            }
            kill_child("pipewire", &mut children.pipewire);
        }
    }

    let runtime_dir = PathBuf::from(config::ARCH_FS_ROOT).join("tmp");
    cleanup_socket(&runtime_dir);
}

fn ensure_running() -> Result<(), String> {
    if AAUDIO_CHILDREN
        .lock()
        .map_err(|e| format!("pipewire aaudio child lock: {e}"))?
        .is_some()
    {
        pw_debug!("server", "reuse running PipeWire/AAudio children");
        return Ok(());
    }

    let ctx = get_application_context();
    let lib_dir = ctx.native_library_dir.clone();
    let pipewire_bin = lib_dir.join(PIPEWIRE_DAEMON_LIB);
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
    cleanup_socket(&env.runtime_dir);

    let config = write_pipewire_config(&env.config_dir, !wireplumber_bin.exists())?;
    let mut pipewire = spawn_pipewire_daemon(&pipewire_bin, &config, &env)?;
    wait_for_socket(&mut pipewire, &env.runtime_dir.join(PIPEWIRE_SOCKET_NAME))?;

    let wireplumber = if wireplumber_bin.exists() {
        Some(spawn_wireplumber(&wireplumber_bin, &env)?)
    } else {
        pw_info!(
            "policy",
            "{} missing; using PipeWire's built-in session-manager module if available",
            WIREPLUMBER_DAEMON_LIB
        );
        None
    };

    let sink = spawn_aaudio_sink(&sink_bin, &env)?;

    *AAUDIO_CHILDREN
        .lock()
        .map_err(|e| format!("pipewire aaudio child lock: {e}"))? = Some(PipewireAaudioChildren {
        pipewire,
        wireplumber,
        sink,
    });

    pw_info!(
        "server",
        "guest: export PIPEWIRE_RUNTIME_DIR={} XDG_RUNTIME_DIR={}",
        config::PIPEWIRE_GUEST_RUNTIME_DIR,
        config::PIPEWIRE_GUEST_RUNTIME_DIR
    );
    Ok(())
}

fn build_pipewire_env(data_dir: &Path, lib_dir: &Path) -> Result<PipewireAaudioEnv, String> {
    let runtime_dir = PathBuf::from(config::ARCH_FS_ROOT).join("tmp");
    let config_dir = data_dir.join("pipewire-standalone-aaudio/config");
    // Local Desktop's APK packagers extract top-level `.so` files from
    // `assets/libs/<abi>` into nativeLibraryDir. Keep PipeWire modules and SPA
    // plugins flat there for this experiment instead of relying on subdirectories.
    let module_dir = lib_dir.to_path_buf();
    let spa_dir = lib_dir.to_path_buf();
    let ld_library_path = lib_dir.display().to_string();

    Ok(PipewireAaudioEnv {
        home_dir: data_dir.to_path_buf(),
        runtime_dir,
        config_dir,
        module_dir,
        spa_dir,
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

context.spa-libs = {{
    support.* = libspa-support
    audio.convert.* = libspa-audioconvert
    audio.adapt = libspa-audioconvert
    audio.mixer.* = libspa-audiomixer
}}

context.modules = [
    {{ name = libpipewire-module-rt flags = [ ifexists nofail ] }}
    {{ name = libpipewire-module-protocol-native }}
    {{ name = libpipewire-module-profiler flags = [ ifexists nofail ] }}
    {{ name = libpipewire-module-metadata }}
    {{ name = libpipewire-module-spa-node-factory }}
    {{ name = libpipewire-module-client-node }}
    {{ name = libpipewire-module-adapter }}
    {{ name = libpipewire-module-link-factory }}
{policy}]
"#
    );

    let path = config_dir.join("localdesktop-pipewire.conf");
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
    apply_pipewire_env(&mut command, env);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    spawn_logged(command, "wireplumber")
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

fn stream_child_lines(name: &'static str, stream: &'static str, pipe: impl std::io::Read) {
    for line in BufReader::new(pipe).lines().map_while(Result::ok) {
        pw_info!("daemon", "[{name}:{stream}] {line}");
    }
    pw_debug!("daemon", "[{name}:{stream}] stream closed");
}

fn wait_for_socket(child: &mut Child, socket: &Path) -> Result<(), String> {
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
            .map_err(|e| format!("pipewire try_wait: {e}"))?
        {
            phase_end("wait_socket", started);
            return Err(format!(
                "pipewire exited before socket {} (status {status})",
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
    for name in [PIPEWIRE_SOCKET_NAME, "pipewire-0.lock"] {
        let path = runtime_dir.join(name);
        if path.exists() {
            if let Err(e) = fs::remove_file(&path) {
                pw_warn!("cleanup", "remove {}: {e}", path.display());
            }
        }
    }
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
