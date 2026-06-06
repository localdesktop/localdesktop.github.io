//! Host-side PulseAudio for proot guest audio (proot-distro model).
//!
//! - **Daemon** — `nativeLibraryDir/libpulseaudio_exec.so` (Termux `pulseaudio`, like `libproot.so`).
//! - **Guest protocol** — `module-native-protocol-tcp` on `127.0.0.1:14713` (not 4713, avoids Termux/proot-distro).
//! - **Output** — `module-aaudio-sink`

use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::net::{SocketAddr, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use winit::platform::android::activity::AndroidApp;

use crate::android::utils::application_context::get_application_context;

macro_rules! pulse_info {
    ($step:expr, $($arg:tt)*) => {
        log::info!("[Pulse] {}: {}", $step, format!($($arg)*))
    };
}
macro_rules! pulse_debug {
    ($step:expr, $($arg:tt)*) => {
        log::debug!("[Pulse] {}: {}", $step, format!($($arg)*))
    };
}
macro_rules! pulse_warn {
    ($step:expr, $($arg:tt)*) => {
        log::warn!("[Pulse] {}: {}", $step, format!($($arg)*))
    };
}
macro_rules! pulse_error {
    ($step:expr, $($arg:tt)*) => {
        log::error!("[Pulse] {}: {}", $step, format!($($arg)*))
    };
}

/// TCP port for guest `PULSE_SERVER` (Termux/proot-distro use default 4713).
pub const PULSE_TCP_PORT: u16 = 14713;

const PULSE_TCP_ADDR: &str = "127.0.0.1";

/// Termux `bin/pulseaudio` in `assets/libs/arm64-v8a/`.
const PULSE_DAEMON_LIB: &str = "libpulseaudio_exec.so";
const PULSEAUDIO_FILES_BIN: &str = "pulseaudio";
const ASSET_PULSEAUDIO: &str = "pulseaudio";
const ASSET_AAUDIO_MODULE: &str = "module-aaudio-sink.so";
const ASSET_AAUDIO_MODULE_ALT: &str = "pulse-module-aaudio-sink.so";
const ASSET_SLES_MODULE: &str = "module-sles-sink.so";
const ASSET_SLES_MODULE_ALT: &str = "pulse-module-sles-sink.so";
const ASSET_PROTOCOL_MODULE: &str = "module-native-protocol-tcp.so";
const PROTOCOL_MODULE_FILE: &str = "module-native-protocol-tcp.so";
/// Same helper as Unix native protocol (`module-native-protocol-tcp` links `libprotocol_native`).
const PROTOCOL_HELPER_LIB: &str = "libprotocol-native.so";

static PULSE_CHILD: Mutex<Option<Child>> = Mutex::new(None);
static PULSE_READY: Mutex<Option<Result<(), String>>> = Mutex::new(None);
static HOST_START_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

fn pulse_tcp_addr() -> SocketAddr {
    format!("{PULSE_TCP_ADDR}:{PULSE_TCP_PORT}")
        .parse()
        .expect("valid pulse tcp addr")
}

fn phase_begin(name: &str) -> Instant {
    pulse_info!("phase", "begin {name}");
    Instant::now()
}

fn phase_end(name: &str, started: Instant) {
    pulse_info!(
        "phase",
        "end {name} ({:.1} ms)",
        started.elapsed().as_secs_f64() * 1000.0
    );
}

fn log_path_meta(step: &str, path: &Path) {
    match fs::metadata(path) {
        Ok(meta) => {
            let mode = format!("{:o}", meta.permissions().mode() & 0o777);
            pulse_debug!(
                "{step}",
                "{} — exists, size={} bytes, mode={mode}, readonly={}",
                path.display(),
                meta.len(),
                meta.permissions().readonly()
            );
        }
        Err(e) => pulse_warn!("{step}", "{} — not accessible: {e}", path.display()),
    }
}

/// Start the host PulseAudio daemon if not already running in this process.
pub fn ensure_running(android_app: &AndroidApp) -> Result<(), String> {
    let mut cache = PULSE_READY
        .lock()
        .map_err(|e| format!("pulse ready lock: {e}"))?;
    if let Some(result) = cache.as_ref() {
        match result {
            Ok(()) => pulse_debug!("server", "reuse running host PulseAudio"),
            Err(e) => pulse_error!("server", "cached failure: {e}"),
        }
        return result.clone();
    }

    pulse_info!("server", "first start in this process");
    let result = start_pulseaudio(android_app);
    if result.is_ok() {
        log_guest_hint();
    }
    *cache = Some(result.clone());
    result
}

/// Start host PulseAudio on a background thread (after UI/backend resume).
pub fn spawn_after_ready(android_app: AndroidApp) {
    if HOST_START_IN_PROGRESS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        pulse_debug!("server", "host PulseAudio start already in progress");
        return;
    }

    pulse_info!("server", "scheduling host PulseAudio (background thread)");
    thread::spawn(move || {
        let t0 = phase_begin("ensure_pulse_host");
        let result = ensure_running(&android_app);
        HOST_START_IN_PROGRESS.store(false, Ordering::SeqCst);
        match &result {
            Ok(()) => pulse_info!("server", "host PulseAudio ready for guest"),
            Err(e) => pulse_error!("server", "host PulseAudio failed: {e}"),
        }
        phase_end("ensure_pulse_host", t0);
    });
}

/// Stop the daemon and clear runtime so the next `ensure_running` starts fresh.
pub fn shutdown() {
    if let Ok(mut child_slot) = PULSE_CHILD.lock() {
        if let Some(mut child) = child_slot.take() {
            pulse_info!("shutdown", "stopping pulseaudio pid={}", child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    let runtime_dir = get_application_context().data_dir.join("pulse/runtime");
    if let Err(e) = cleanup_pulse_runtime(&runtime_dir) {
        pulse_warn!("shutdown", "runtime cleanup: {e}");
    }

    if let Ok(mut cache) = PULSE_READY.lock() {
        *cache = None;
    }
}

fn log_guest_hint() {
    pulse_info!(
        "server",
        "guest: export PULSE_SERVER=tcp:{PULSE_TCP_ADDR}:{PULSE_TCP_PORT}"
    );
    pulse_info!(
        "server",
        "guest: (alternate) PULSE_SERVER={PULSE_TCP_ADDR}:{PULSE_TCP_PORT}"
    );
}

fn start_pulseaudio(android_app: &AndroidApp) -> Result<(), String> {
    let t0 = phase_begin("start_pulseaudio");

    let ctx = get_application_context();
    let data_dir = ctx.data_dir.clone();
    let lib_dir = ctx.native_library_dir.clone();

    pulse_info!("paths", "data_dir={}", data_dir.display());
    pulse_info!("paths", "nativeLibraryDir={}", lib_dir.display());

    let binary = resolve_pulse_daemon(&lib_dir, &data_dir, android_app)?;
    ensure_pulse_server_libs(&lib_dir)?;
    ensure_pulse_modules(android_app, &data_dir)?;

    let config_dir = data_dir.join("pulse/config");
    let runtime_dir = data_dir.join("pulse/runtime");
    let state_dir = data_dir.join("pulse/state");
    let modules_dir = data_dir.join("pulse/modules");
    for dir in [&config_dir, &runtime_dir, &state_dir, &modules_dir] {
        fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
        pulse_debug!("mkdir", "{}", dir.display());
    }

    let default_pa = write_default_pa(&config_dir, &modules_dir)?;
    write_client_conf(&config_dir, &binary)?;
    write_daemon_conf(&config_dir, &modules_dir)?;

    let dl_search_path = modules_dir.display().to_string();

    let home = data_dir.display().to_string();
    let runtime = runtime_dir.display().to_string();
    let state = state_dir.display().to_string();
    let config = config_dir.display().to_string();
    let ld_library_path = format!("{}:{}", lib_dir.display(), modules_dir.display());

    for (key, value) in [
        ("HOME", home.as_str()),
        ("PULSE_RUNTIME_PATH", runtime.as_str()),
        ("PULSE_STATE_PATH", state.as_str()),
        ("PULSE_CONFIG_PATH", config.as_str()),
        ("LD_LIBRARY_PATH", ld_library_path.as_str()),
    ] {
        pulse_debug!("spawn-env", "{key}={value}");
    }

    let default_pa_arg = format!("--file={}", default_pa.display());
    pulse_info!(
        "spawn",
        "exec {} -n --verbose --exit-idle-time=-1 {} --dl-search-path={dl_search_path}",
        binary.display(),
        default_pa_arg
    );
    log_path_meta("spawn", &binary);

    cleanup_pulse_runtime(&runtime_dir)?;

    let mut child = Command::new(&binary)
        .arg("-n")
        .arg("--verbose")
        .arg("--exit-idle-time=-1")
        .arg(&default_pa_arg)
        .arg(format!("--dl-search-path={dl_search_path}"))
        .env("HOME", &data_dir)
        .env("PULSE_RUNTIME_PATH", &runtime_dir)
        .env("PULSE_STATE_PATH", &state_dir)
        .env("PULSE_CONFIG_PATH", &config_dir)
        .env("LD_LIBRARY_PATH", &ld_library_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            pulse_error!("spawn", "failed: {e}");
            format!("spawn {}: {e}", binary.display())
        })?;

    let pid = child.id();
    pulse_info!("spawn", "pulseaudio child pid={pid}");

    if let Some(stderr) = child.stderr.take() {
        thread::spawn(|| stream_daemon_lines("stderr", stderr));
    }
    if let Some(stdout) = child.stdout.take() {
        thread::spawn(|| stream_daemon_lines("stdout", stdout));
    }

    wait_for_tcp(&mut child)?;

    *PULSE_CHILD
        .lock()
        .map_err(|e| format!("pulse child lock: {e}"))? = Some(child);

    pulse_info!(
        "server",
        "ready — TCP {PULSE_TCP_ADDR}:{PULSE_TCP_PORT} (pid {pid})"
    );

    phase_end("start_pulseaudio", t0);
    Ok(())
}

fn stream_daemon_lines(stream: &'static str, pipe: impl Read + Send + 'static) {
    for line in BufReader::new(pipe).lines().map_while(Result::ok) {
        pulse_info!("daemon", "[{stream}] {line}");
    }
    pulse_debug!("daemon", "[{stream}] stream closed");
}

fn cleanup_pulse_runtime(runtime_dir: &Path) -> Result<(), String> {
    if runtime_dir.exists() {
        pulse_info!("cleanup", "removing {}", runtime_dir.display());
        fs::remove_dir_all(runtime_dir)
            .map_err(|e| format!("remove {}: {e}", runtime_dir.display()))?;
    }
    fs::create_dir_all(runtime_dir).map_err(|e| format!("mkdir {}: {e}", runtime_dir.display()))?;
    pulse_debug!("cleanup", "empty runtime at {}", runtime_dir.display());
    Ok(())
}

fn pulse_tcp_connectable() -> bool {
    TcpStream::connect_timeout(&pulse_tcp_addr(), Duration::from_millis(200)).is_ok()
}

fn wait_for_tcp(child: &mut Child) -> Result<(), String> {
    let t0 = phase_begin("wait_tcp");
    let addr = pulse_tcp_addr();
    pulse_info!("wait_tcp", "polling until connectable: {addr}");

    for attempt in 1..=80 {
        if pulse_tcp_connectable() {
            pulse_info!(
                "wait_tcp",
                "TCP connectable after {attempt} attempt(s) (~{} ms)",
                attempt * 100
            );
            phase_end("wait_tcp", t0);
            return Ok(());
        }

        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("pulseaudio try_wait: {e}"))?
        {
            pulse_error!(
                "wait_tcp",
                "pulseaudio exited before TCP listen (status {status}, attempt {attempt})"
            );
            phase_end("wait_tcp", t0);
            return Err(format!(
                "pulseaudio exited before TCP {addr} (status {status})"
            ));
        }

        if attempt == 1 || attempt % 10 == 0 {
            pulse_debug!("wait_tcp", "attempt {attempt}/80 — still waiting");
        }
        thread::sleep(Duration::from_millis(100));
    }

    pulse_error!("wait_tcp", "timed out after 8s");
    phase_end("wait_tcp", t0);
    Err(format!("timed out waiting for Pulse TCP {addr}"))
}

fn write_default_pa(config_dir: &Path, modules_dir: &Path) -> Result<PathBuf, String> {
    let protocol = modules_dir.join(PROTOCOL_MODULE_FILE);
    if !protocol.exists() {
        pulse_error!(
            "config",
            "missing {} — copy from Termux $PREFIX/lib/pulse-17.0/modules/ \
             or add APK asset `{ASSET_PROTOCOL_MODULE}`",
            protocol.display()
        );
        return Err(format!(
            "missing {} in {}",
            PROTOCOL_MODULE_FILE,
            modules_dir.display()
        ));
    }
    log_path_meta("config", &protocol);

    let aaudio = modules_dir.join("module-aaudio-sink.so");
    let sles = modules_dir.join("module-sles-sink.so");
    let (sink_load, sink_name) = if aaudio.exists() {
        log_path_meta("sink", &aaudio);
        (
            "load-module module-aaudio-sink".to_string(),
            "module-aaudio-sink",
        )
    } else if sles.exists() {
        log_path_meta("sink", &sles);
        (
            "load-module module-sles-sink".to_string(),
            "module-sles-sink",
        )
    } else {
        pulse_error!(
            "sink",
            "no module-aaudio-sink.so or module-sles-sink.so in {}",
            modules_dir.display()
        );
        return Err(format!(
            "no Android sink module in {} — add assets/module-aaudio-sink.so",
            modules_dir.display()
        ));
    };

    pulse_info!(
        "config",
        "default.pa: {PROTOCOL_MODULE_FILE} on {PULSE_TCP_ADDR}:{PULSE_TCP_PORT}, {sink_name}"
    );

    let body = format!(
        r#"# Local Desktop — host PulseAudio for proot guest (TCP, not Termux 4713)
.fail

load-module module-native-protocol-tcp port={port} listen={listen} auth-anonymous=1 auth-ip-acl=127.0.0.1
{sink_load}
"#,
        port = PULSE_TCP_PORT,
        listen = PULSE_TCP_ADDR,
    );

    let path = config_dir.join("default.pa");
    fs::write(&path, &body).map_err(|e| format!("write {}: {e}", path.display()))?;
    pulse_debug!("config", "wrote {}", path.display());
    Ok(path)
}

fn write_client_conf(config_dir: &Path, binary: &Path) -> Result<(), String> {
    let body = format!(
        r#"autospawn = no
daemon-binary = {}
"#,
        binary.display()
    );
    let path = config_dir.join("client.conf");
    fs::write(&path, body).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}

fn resolve_pulse_daemon(
    lib_dir: &Path,
    data_dir: &Path,
    android_app: &AndroidApp,
) -> Result<PathBuf, String> {
    let lib_exe = lib_dir.join(PULSE_DAEMON_LIB);
    if lib_exe.exists() {
        pulse_info!(
            "daemon",
            "using {} in nativeLibraryDir (same exec model as libproot.so)",
            lib_exe.display()
        );
        log_path_meta("daemon", &lib_exe);
        return Ok(lib_exe);
    }

    pulse_warn!(
        "daemon",
        "{PULSE_DAEMON_LIB} not in nativeLibraryDir — copy Termux pulseaudio to assets/libs/arm64-v8a/ and rebuild"
    );

    let files_exe = data_dir.join(PULSEAUDIO_FILES_BIN);
    ensure_pulseaudio_binary(android_app, &files_exe)?;
    pulse_warn!(
        "daemon",
        "using files/pulseaudio — Android 10+ typically denies exec from app data (EACCES)"
    );
    Ok(files_exe)
}

fn ensure_pulse_server_libs(lib_dir: &Path) -> Result<(), String> {
    const REQUIRED: &[&str] = &[PROTOCOL_HELPER_LIB];
    let mut missing = Vec::new();
    for name in REQUIRED {
        let path = lib_dir.join(name);
        if path.exists() {
            log_path_meta("server-libs", &path);
        } else {
            pulse_error!("server-libs", "missing {}", path.display());
            missing.push(*name);
        }
    }
    if missing.is_empty() {
        return Ok(());
    }
    Err(format!(
        "missing in {}: {} — copy from Termux $PREFIX/lib/ (same pulse 17.0 as libpulsecore), rebuild APK",
        lib_dir.display(),
        missing.join(", ")
    ))
}

fn write_daemon_conf(config_dir: &Path, modules_dir: &Path) -> Result<(), String> {
    let body = format!(
        r#"daemonize = no
exit-idle-time = -1
flat-volumes = yes
log-level = debug
log-target = stderr
dl-search-path = {modules}
"#,
        modules = modules_dir.display()
    );
    let path = config_dir.join("daemon.conf");
    fs::write(&path, body).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}

fn ensure_pulseaudio_binary(android_app: &AndroidApp, dest: &Path) -> Result<(), String> {
    pulse_info!("extract", "server binary -> {}", dest.display());
    ensure_asset_extracted(android_app, ASSET_PULSEAUDIO, dest, true)?;
    if dest.exists() {
        log_path_meta("extract", dest);
        return Ok(());
    }
    pulse_error!("extract", "missing {ASSET_PULSEAUDIO} APK asset");
    Err(format!(
        "missing PulseAudio server at {} — add assets/pulseaudio to manifest.yaml android.assets",
        dest.display()
    ))
}

fn ensure_pulse_modules(android_app: &AndroidApp, data_dir: &Path) -> Result<(), String> {
    let modules_dir = data_dir.join("pulse/modules");
    fs::create_dir_all(&modules_dir)
        .map_err(|e| format!("mkdir {}: {e}", modules_dir.display()))?;

    let aaudio = modules_dir.join("module-aaudio-sink.so");
    let sles = modules_dir.join("module-sles-sink.so");
    let protocol = modules_dir.join(PROTOCOL_MODULE_FILE);

    pulse_info!("extract", "Pulse modules -> {}", modules_dir.display());

    if !protocol.exists() {
        let _ = ensure_asset_extracted(android_app, ASSET_PROTOCOL_MODULE, &protocol, false);
    }
    if !protocol.exists() {
        pulse_error!(
            "extract",
            "missing {PROTOCOL_MODULE_FILE} — add asset `{ASSET_PROTOCOL_MODULE}` from \
             $PREFIX/lib/pulse-17.0/modules/"
        );
        return Err(format!(
            "missing {PROTOCOL_MODULE_FILE} in {}",
            modules_dir.display()
        ));
    }
    log_path_meta("extract", &protocol);

    let mut have_sink = false;
    if try_ensure_sink_module(
        android_app,
        &aaudio,
        &[ASSET_AAUDIO_MODULE, ASSET_AAUDIO_MODULE_ALT],
    )
    .is_ok()
    {
        pulse_info!("extract", "AAudio sink module ready");
        log_path_meta("extract", &aaudio);
        have_sink = true;
    } else if try_ensure_sink_module(
        android_app,
        &sles,
        &[ASSET_SLES_MODULE, ASSET_SLES_MODULE_ALT],
    )
    .is_ok()
    {
        pulse_info!("extract", "OpenSL ES sink module ready");
        log_path_meta("extract", &sles);
        have_sink = true;
    } else if aaudio.exists() || sles.exists() {
        pulse_warn!("extract", "using pre-existing sink module on disk");
        log_path_meta("extract", if aaudio.exists() { &aaudio } else { &sles });
        have_sink = true;
    }

    if !have_sink {
        pulse_error!("extract", "no sink module on disk or in APK");
        return Err(format!(
            "no Pulse sink module in {} — add assets/module-aaudio-sink.so to manifest.yaml",
            modules_dir.display()
        ));
    }

    chmod_modules_dir(&modules_dir)?;
    Ok(())
}

fn chmod_modules_dir(modules_dir: &Path) -> Result<(), String> {
    let entries =
        fs::read_dir(modules_dir).map_err(|e| format!("read {}: {e}", modules_dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("read dir entry: {e}"))?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("so") {
            continue;
        }
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("chmod {}: {e}", path.display()))?;
        pulse_debug!("extract", "chmod 755 {}", path.display());
    }
    Ok(())
}

fn try_ensure_sink_module(
    android_app: &AndroidApp,
    dest: &Path,
    asset_names: &[&str],
) -> Result<(), String> {
    for name in asset_names {
        pulse_debug!("extract", "try APK asset `{name}`");
        if ensure_asset_extracted(android_app, name, dest, false).is_ok() && dest.exists() {
            return Ok(());
        }
    }
    Err("no matching sink asset in APK".to_string())
}

fn ensure_asset_extracted(
    android_app: &AndroidApp,
    asset_name: &str,
    dest: &Path,
    executable: bool,
) -> Result<(), String> {
    use std::ffi::CString;

    let name = CString::new(asset_name).map_err(|e| format!("asset name: {e}"))?;
    let mut asset = android_app
        .asset_manager()
        .open(&name)
        .ok_or_else(|| format!("asset {asset_name} not in APK"))?;
    let asset_len = asset.length() as u64;

    pulse_debug!("extract", "APK asset `{asset_name}` size={asset_len} bytes");

    if dest.exists() {
        if let Ok(meta) = fs::metadata(dest) {
            if meta.len() == asset_len {
                pulse_debug!(
                    "extract",
                    "skip `{asset_name}` — {} already {} bytes",
                    dest.display(),
                    meta.len()
                );
                return Ok(());
            }
            pulse_info!(
                "extract",
                "refresh `{asset_name}` — {} was {} bytes, APK has {asset_len}",
                dest.display(),
                meta.len()
            );
        }
    } else {
        pulse_info!(
            "extract",
            "first extract `{asset_name}` -> {}",
            dest.display()
        );
    }

    let mut bytes = Vec::with_capacity(asset_len as usize);
    asset
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read asset {asset_name}: {e}"))?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    fs::write(dest, &bytes).map_err(|e| format!("write {}: {e}", dest.display()))?;
    if executable {
        fs::set_permissions(dest, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("chmod {}: {e}", dest.display()))?;
        pulse_debug!("extract", "chmod 755 {}", dest.display());
    }
    pulse_info!(
        "extract",
        "wrote {} ({} bytes, executable={executable})",
        dest.display(),
        bytes.len()
    );
    Ok(())
}
