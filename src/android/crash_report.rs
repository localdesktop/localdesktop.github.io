//! Local-only logging and crash reporting. Nothing in here touches the network.
//!
//! * `init` installs a logger that tees every record to logcat (`android_logger`), an
//!   in-memory ring buffer of the last [`RING_CAPACITY`] lines and a size-capped rotating
//!   session log (`session.log`, `session.1.log`, `session.2.log`).
//! * A panic hook writes `crash-<UTC timestamp>.txt` (message, location, thread, backtrace,
//!   app/device info, last log lines) into every report directory.
//! * On startup `ApplicationExitInfo` entries (native crashes, ANRs, low-memory kills, ...) are
//!   appended to `exit-reasons.txt`, skipping lines that were already recorded.
//!
//! Report directories (each is written independently, failures are ignored):
//! 1. `<files dir>/crash-reports/` (app private)
//! 2. `<external files dir>/crash-reports/`, i.e. `/sdcard/Android/data/<package>/files/crash-reports`
//!    (readable with `adb pull`)
//! 3. `<ARCH_FS_ROOT>/var/log/localdesktop/` (visible from inside the Linux guest as
//!    `/var/log/localdesktop/`), only once the rootfs exists.

use crate::{
    android::utils::host_bridge,
    core::config::{ANDROID_PACKAGE, ARCH_FS_ROOT, VERSION},
};
use jni::{
    objects::{JObject, JString, JValue},
    JNIEnv, JavaVM,
};
use log::{Level, LevelFilter, Log, Metadata, Record};
use std::{
    backtrace::Backtrace,
    collections::{HashSet, VecDeque},
    ffi::{c_char, c_int, CString},
    fmt::Write as _,
    fs::{self, File, OpenOptions},
    io::Write as _,
    panic::PanicHookInfo,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, Once, OnceLock,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use winit::platform::android::activity::AndroidApp;

const RING_CAPACITY: usize = 1000;
/// Longer records are cut so one huge message cannot blow up the ring buffer.
const MAX_LINE_BYTES: usize = 4096;
const SESSION_LOG_MAX_BYTES: u64 = 1024 * 1024;
/// `session.log` plus this many rotated files (`session.1.log`, ...).
const SESSION_LOG_ROTATED_FILES: usize = 2;
const CRASH_LOG_TAIL_LINES: usize = 500;
const MAX_CRASH_FILES: usize = 30;
const EXIT_REASONS_MAX_LINES: usize = 200;
const CRASH_DIR_NAME: &str = "crash-reports";
const SESSION_LOG: &str = "session.log";
const PREVIOUS_SESSION_LOG: &str = "previous-session.log";
const EXIT_REASONS_FILE: &str = "exit-reasons.txt";

static INIT: Once = Once::new();
static IN_PANIC_HOOK: AtomicBool = AtomicBool::new(false);
static RING: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());
static SESSION: Mutex<SessionLog> = Mutex::new(SessionLog::closed());
static EXTERNAL_DIR: OnceLock<PathBuf> = OnceLock::new();

// Bionic system properties (`sys/system_properties.h`).
extern "C" {
    fn __system_property_get(name: *const c_char, value: *mut c_char) -> c_int;
}

/// Install the logger, the panic hook, then export the previous session and the
/// `ApplicationExitInfo` history. Safe to call more than once; only the first call does work.
pub fn init(android_app: &AndroidApp) {
    INIT.call_once(|| {
        install_logger();
        install_panic_hook();
        log::info!(
            "Local Desktop {} ({}) starting, Android API {}, device {}",
            VERSION,
            ANDROID_PACKAGE,
            system_property("ro.build.version.sdk"),
            device_model()
        );

        if let Some(dir) = external_files_dir(android_app) {
            let _ = EXTERNAL_DIR.set(dir.join(CRASH_DIR_NAME));
        }
        export_previous_session();
        record_exit_reasons(android_app);
        log::info!("Crash reports are written to {:?}", report_dirs());
    });
}

/// Directories that receive crash reports, in write order. The guest directory is only listed
/// once the rootfs exists.
pub fn report_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![primary_dir()];
    dirs.push(
        EXTERNAL_DIR
            .get()
            .cloned()
            .unwrap_or_else(|| fallback_external_dir()),
    );
    if let Some(guest) = guest_dir() {
        dirs.push(guest);
    }
    dirs
}

fn primary_dir() -> PathBuf {
    let files_dir = Path::new(ARCH_FS_ROOT)
        .parent()
        .unwrap_or_else(|| Path::new(ARCH_FS_ROOT));
    files_dir.join(CRASH_DIR_NAME)
}

fn fallback_external_dir() -> PathBuf {
    PathBuf::from(format!(
        "/sdcard/Android/data/{ANDROID_PACKAGE}/files/{CRASH_DIR_NAME}"
    ))
}

fn guest_dir() -> Option<PathBuf> {
    let root = Path::new(ARCH_FS_ROOT);
    root.join("etc")
        .is_dir()
        .then(|| root.join("var/log/localdesktop"))
}

// ---------------------------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------------------------

struct TeeLogger {
    android: android_logger::AndroidLogger,
}

impl Log for TeeLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        self.android.enabled(metadata)
    }

    fn log(&self, record: &Record) {
        self.android.log(record);
        let line = format_line(record);
        lock(&SESSION).append(&line);
        let mut ring = lock(&RING);
        if ring.len() >= RING_CAPACITY {
            ring.pop_front();
        }
        ring.push_back(line);
    }

    fn flush(&self) {}
}

fn install_logger() {
    #[cfg(debug_assertions)] // Verbose logging in debug builds
    let log_level = LevelFilter::Trace;
    #[cfg(not(debug_assertions))]
    let log_level = LevelFilter::Info;

    lock(&SESSION).open(&primary_dir());

    let logger = TeeLogger {
        android: android_logger::AndroidLogger::default(),
    };
    if log::set_boxed_logger(Box::new(logger)).is_ok() {
        log::set_max_level(log_level);
    } else {
        // Someone else already installed a logger: fall back to logcat only.
        android_logger::init_once(android_logger::Config::default().with_max_level(log_level));
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn format_line(record: &Record) -> String {
    let level = match record.level() {
        Level::Error => 'E',
        Level::Warn => 'W',
        Level::Info => 'I',
        Level::Debug => 'D',
        Level::Trace => 'T',
    };
    let mut line = String::with_capacity(96);
    let _ = write!(
        line,
        "{} {} {}: {}",
        Utc::now().log_stamp(),
        level,
        record.target(),
        record.args()
    );
    truncate_to_boundary(&mut line, MAX_LINE_BYTES);
    line
}

fn truncate_to_boundary(text: &mut String, max_bytes: usize) {
    if text.len() > max_bytes {
        let mut end = max_bytes;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("...");
    }
}

/// Size-capped rotating log file. `session.log` is the live file; on rotation it becomes
/// `session.1.log`, then `session.2.log`, and the oldest file is dropped.
struct SessionLog {
    dir: Option<PathBuf>,
    file: Option<File>,
    size: u64,
}

impl SessionLog {
    const fn closed() -> Self {
        Self {
            dir: None,
            file: None,
            size: 0,
        }
    }

    /// Start a new session: previous files are rotated so the last session stays available.
    fn open(&mut self, dir: &Path) {
        let _ = fs::create_dir_all(dir);
        self.dir = Some(dir.to_path_buf());
        self.rotate();
    }

    fn append(&mut self, line: &str) {
        if self.dir.is_none() {
            return;
        }
        let needed = line.len() as u64 + 1;
        if self.size + needed > SESSION_LOG_MAX_BYTES {
            self.rotate();
        }
        if let Some(file) = self.file.as_mut() {
            // One write per line (no userspace buffer) so a native crash loses nothing.
            let mut bytes = Vec::with_capacity(line.len() + 1);
            bytes.extend_from_slice(line.as_bytes());
            bytes.push(b'\n');
            if file.write_all(&bytes).is_ok() {
                self.size += needed;
            }
        }
    }

    fn rotate(&mut self) {
        let Some(dir) = self.dir.as_ref() else { return };
        self.file = None;
        self.size = 0;
        let rotated = |index: usize| dir.join(format!("session.{index}.log"));
        let _ = fs::remove_file(rotated(SESSION_LOG_ROTATED_FILES));
        for index in (1..SESSION_LOG_ROTATED_FILES).rev() {
            let _ = fs::rename(rotated(index), rotated(index + 1));
        }
        let _ = fs::rename(dir.join(SESSION_LOG), rotated(1));
        self.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(SESSION_LOG))
            .ok();
    }
}

// ---------------------------------------------------------------------------------------------
// Panic hook
// ---------------------------------------------------------------------------------------------

fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // A panic inside the hook itself must not recurse.
        if !IN_PANIC_HOOK.swap(true, Ordering::SeqCst) {
            write_crash_report(info);
            IN_PANIC_HOOK.store(false, Ordering::SeqCst);
        }
        previous(info);
    }));
}

fn write_crash_report(info: &PanicHookInfo<'_>) {
    let backtrace = Backtrace::force_capture();
    let thread = std::thread::current();
    let thread_name = thread.name().unwrap_or("<unnamed>");
    let location = info
        .location()
        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
        .unwrap_or_else(|| "<unknown>".to_string());
    let payload = info.payload();
    let message = payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "<non-string panic payload>".to_string());

    log::error!("panic on thread '{thread_name}' at {location}: {message}");

    let now = Utc::now();
    let mut report = String::with_capacity(64 * 1024);
    let _ = writeln!(report, "Local Desktop crash report");
    let _ = writeln!(report, "time_utc: {}", now.iso());
    let _ = writeln!(report, "app_version: {VERSION}");
    let _ = writeln!(report, "package: {ANDROID_PACKAGE}");
    let _ = writeln!(
        report,
        "android_api: {}",
        system_property("ro.build.version.sdk")
    );
    let _ = writeln!(
        report,
        "android_release: {}",
        system_property("ro.build.version.release")
    );
    let one_ui = system_property("ro.build.version.oneui");
    if !one_ui.is_empty() {
        let _ = writeln!(report, "one_ui: {one_ui}");
    }
    let _ = writeln!(report, "device: {}", device_model());
    let _ = writeln!(
        report,
        "fingerprint: {}",
        system_property("ro.build.fingerprint")
    );
    let _ = writeln!(report, "abi: {}", system_property("ro.product.cpu.abi"));
    let _ = writeln!(report, "pid: {}", std::process::id());
    let _ = writeln!(report, "thread: {} ({:?})", thread_name, thread.id());
    let _ = writeln!(report, "location: {location}");
    let _ = writeln!(report, "message: {message}");
    let _ = writeln!(report, "\n--- backtrace ---\n{backtrace}");
    let _ = writeln!(
        report,
        "\n--- native module mappings (for offline symbolication) ---"
    );
    report.push_str(&native_module_mappings());
    let _ = writeln!(report, "\n--- last log lines ---");
    {
        let ring = lock(&RING);
        let skip = ring.len().saturating_sub(CRASH_LOG_TAIL_LINES);
        for line in ring.iter().skip(skip) {
            report.push_str(line);
            report.push('\n');
        }
    }

    let dirs = report_dirs();
    let name = unique_crash_name(&dirs[0], &now);
    for dir in &dirs {
        if fs::create_dir_all(dir).is_ok() {
            let _ = fs::write(dir.join(&name), report.as_bytes());
            prune_crash_files(dir);
        }
    }
}

fn unique_crash_name(primary: &Path, now: &Utc) -> String {
    let stamp = now.file_stamp();
    let mut name = format!("crash-{stamp}.txt");
    let mut counter = 1;
    while primary.join(&name).exists() {
        name = format!("crash-{stamp}-{counter}.txt");
        counter += 1;
    }
    name
}

/// Keep the newest [`MAX_CRASH_FILES`] crash reports; the timestamped names sort chronologically.
fn prune_crash_files(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.starts_with("crash-") && name.ends_with(".txt"))
        .collect();
    if names.len() <= MAX_CRASH_FILES {
        return;
    }
    names.sort();
    for stale in &names[..names.len() - MAX_CRASH_FILES] {
        let _ = fs::remove_file(dir.join(stale));
    }
}

/// `/proc/self/maps` lines of the app's own native libraries, so unsymbolised frame addresses in a
/// backtrace can be resolved against the matching unstripped build.
fn native_module_mappings() -> String {
    let maps = fs::read_to_string("/proc/self/maps").unwrap_or_default();
    let mut out = String::new();
    for line in maps.lines().filter(|l| l.contains("liblocaldesktop")) {
        out.push_str(line);
        out.push('\n');
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Startup export: previous session log + ApplicationExitInfo
// ---------------------------------------------------------------------------------------------

/// Copy the log of the previous session next to the crash reports so it survives a native crash
/// or a kill by the system, and is reachable with `adb pull` / from the guest.
fn export_previous_session() {
    let primary = primary_dir();
    let Ok(previous) = fs::read(primary.join("session.1.log")) else {
        return;
    };
    for dir in report_dirs().iter().skip(1) {
        if fs::create_dir_all(dir).is_ok() {
            let _ = fs::write(dir.join(PREVIOUS_SESSION_LOG), &previous);
        }
    }
}

/// Append `ApplicationExitInfo` lines that are not yet in `exit-reasons.txt` (oldest first), then
/// mirror the file into every report directory.
fn record_exit_reasons(android_app: &AndroidApp) {
    let reasons = host_bridge::collect_exit_reasons(android_app);
    let primary = primary_dir();
    let path = primary.join(EXIT_REASONS_FILE);
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<String> = existing.lines().map(str::to_owned).collect();
    let known: HashSet<String> = lines.iter().cloned().collect();

    // `collect_exit_reasons` is most recent first; the file is chronological.
    let mut fresh: Vec<String> = Vec::new();
    for reason in reasons.into_iter().rev() {
        let reason = reason.replace(['\r', '\n'], " ");
        if !reason.is_empty() && !known.contains(&reason) && !fresh.contains(&reason) {
            fresh.push(reason);
        }
    }
    if fresh.is_empty() && path.exists() {
        return;
    }
    log::info!("Recorded {} new process exit reason(s)", fresh.len());
    lines.extend(fresh);
    let excess = lines.len().saturating_sub(EXIT_REASONS_MAX_LINES);
    let mut content = lines[excess..].join("\n");
    if !content.is_empty() {
        content.push('\n');
    }
    for dir in report_dirs() {
        if fs::create_dir_all(&dir).is_ok() {
            let _ = fs::write(dir.join(EXIT_REASONS_FILE), content.as_bytes());
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Android helpers
// ---------------------------------------------------------------------------------------------

fn system_property(name: &str) -> String {
    let Ok(cname) = CString::new(name) else {
        return String::new();
    };
    // PROP_VALUE_MAX is 92 including the terminating NUL.
    let mut buffer = [0 as c_char; 92];
    let len = unsafe { __system_property_get(cname.as_ptr(), buffer.as_mut_ptr()) };
    if len <= 0 {
        return String::new();
    }
    let bytes: Vec<u8> = buffer[..len as usize].iter().map(|&c| c as u8).collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

fn device_model() -> String {
    let manufacturer = system_property("ro.product.manufacturer");
    let model = system_property("ro.product.model");
    format!("{manufacturer} {model}").trim().to_string()
}

/// `Context.getExternalFilesDir(null)`; creates `/sdcard/Android/data/<package>/files`.
fn external_files_dir(android_app: &AndroidApp) -> Option<PathBuf> {
    let vm = unsafe { JavaVM::from_raw(android_app.vm_as_ptr() as *mut _) }.ok()?;
    let mut env = vm.attach_current_thread().ok()?;
    let activity = unsafe { JObject::from_raw(android_app.activity_as_ptr() as *mut _) };
    let result = external_files_dir_jni(&mut env, &activity);
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_clear();
    }
    result
}

fn external_files_dir_jni(env: &mut JNIEnv, activity: &JObject) -> Option<PathBuf> {
    let file = env
        .call_method(
            activity,
            "getExternalFilesDir",
            "(Ljava/lang/String;)Ljava/io/File;",
            &[JValue::Object(&JObject::null())],
        )
        .ok()?
        .l()
        .ok()?;
    if file.is_null() {
        return None;
    }
    let path = env
        .call_method(&file, "getAbsolutePath", "()Ljava/lang/String;", &[])
        .ok()?
        .l()
        .ok()?;
    let path: String = env.get_string(&JString::from(path)).ok()?.into();
    Some(PathBuf::from(path))
}

// ---------------------------------------------------------------------------------------------
// UTC time formatting (no time crate on Android builds)
// ---------------------------------------------------------------------------------------------

struct Utc {
    year: i64,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
    millis: u32,
}

impl Utc {
    fn now() -> Self {
        let since_epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        let secs = since_epoch.as_secs() as i64;
        let days = secs.div_euclid(86_400);
        let rem = secs.rem_euclid(86_400) as u32;
        // Civil-from-days (H. Hinnant), proleptic Gregorian calendar.
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
        let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
        let year = yoe + era * 400 + i64::from(month <= 2);
        Self {
            year,
            month,
            day,
            hour: rem / 3_600,
            minute: rem % 3_600 / 60,
            second: rem % 60,
            millis: since_epoch.subsec_millis(),
        }
    }

    fn log_stamp(&self) -> String {
        format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
            self.year, self.month, self.day, self.hour, self.minute, self.second, self.millis
        )
    }

    fn iso(&self) -> String {
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            self.year, self.month, self.day, self.hour, self.minute, self.second, self.millis
        )
    }

    fn file_stamp(&self) -> String {
        format!(
            "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
            self.year, self.month, self.day, self.hour, self.minute, self.second
        )
    }
}
