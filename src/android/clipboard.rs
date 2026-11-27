//! Shares the clipboard between Android and the Linux desktop.
//!
//! labwc is nested on our compositor through wlroots' Wayland backend, which doesn't pass the
//! selection on to its parent, so the guest-side `localdesktop-clipboard` script (started from
//! labwc's autostart) bridges it with `wl-clipboard`, through files in [`DIR`]:
//!
//! - Linux to Android: `wl-paste --watch` saves each new text selection to `out.tmp` and renames
//!   it to [`OUTGOING`]. inotify tells us about the rename, and we put the text on the Android
//!   clipboard.
//! - Android to Linux: Android 10+ only lets the focused app read the clipboard, so we read it when
//!   our window gains focus, and write it to the [`INCOMING`] FIFO, where `wl-copy` waits for it.
//!   If the desktop isn't up yet, the text waits until inotify sees the guest create the FIFO.
//!
//! Nothing polls: the thread here sleeps in inotify, and the guest in `wl-paste` and `wl-copy`.
//! Both directions remember the last text they synced, so a change doesn't bounce back.

use crate::{android::utils::ndk::run_in_jvm, core::config};
use jni::{
    objects::{JObject, JString},
    sys::jobject,
    JNIEnv,
};
use smithay::reexports::rustix::{
    fs::{
        inotify::{self, CreateFlags, ReadFlags, WatchFlags},
        OFlags,
    },
    io::Errno,
};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    mem::MaybeUninit,
    os::unix::fs::{FileTypeExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::{Mutex, Once},
    thread,
    time::{Duration, Instant},
};
use winit::platform::android::activity::AndroidApp;

/// Shared with the guest, which sees it as `/tmp/localdesktop-clipboard`.
const DIR: &str = "tmp/localdesktop-clipboard";
/// FIFO the guest reads with `wl-copy`: what was copied on Android.
const INCOMING: &str = "in";
/// File the guest writes with `wl-paste --watch`: what was copied on Linux.
const OUTGOING: &str = "out";
/// Larger clips are skipped: a binder transaction is limited to about 1 MB.
const MAX_BYTES: usize = 512 * 1024;
/// How long to wait for `wl-copy` to open the FIFO: it reopens it after each paste, and right
/// after the guest creates it.
const READER_WAIT: Duration = Duration::from_secs(3);
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Default)]
struct Shared {
    /// The text both sides had when they were last synced.
    last: Option<String>,
    /// Android text that the guest hasn't taken yet, e.g. because the desktop is still starting.
    pending: Option<String>,
}

static SHARED: Mutex<Shared> = Mutex::new(Shared {
    last: None,
    pending: None,
});
/// Only one writer on the FIFO at a time, or two clips could interleave.
static WRITING: Mutex<()> = Mutex::new(());

fn dir() -> PathBuf {
    PathBuf::from(config::arch_fs_root()).join(DIR)
}

fn usable(text: &str) -> bool {
    !text.is_empty() && text.len() <= MAX_BYTES
}

/// Starts watching the guest clipboard. Safe to call on every resume.
pub fn start(android_app: AndroidApp) {
    static START: Once = Once::new();
    START.call_once(|| {
        thread::Builder::new()
            .name("clipboard".into())
            .spawn(move || {
                if let Err(error) = watch(android_app) {
                    log::warn!("Stopped sharing the clipboard with Linux: {error}");
                }
            })
            .expect("Failed to spawn the clipboard thread");
    });
}

/// Our window gained focus: the only time Android lets us read its clipboard.
pub fn on_focus(android_app: AndroidApp) {
    thread::spawn(move || {
        let Some(text) = run_in_jvm(read_android_clipboard, android_app) else {
            return;
        };
        if !usable(&text) {
            return;
        }
        {
            let mut shared = SHARED.lock().unwrap();
            if shared.last.as_deref() == Some(text.as_str()) {
                return;
            }
            log::info!("Clipboard: Android to Linux, {} bytes", text.len());
            shared.last = Some(text.clone());
            shared.pending = Some(text);
        }
        send_pending();
    });
}

/// Blocks in inotify, and wakes up only when something changes in [`DIR`].
fn watch(android_app: AndroidApp) -> io::Result<()> {
    let dir = dir();
    let inotify = inotify::init(CreateFlags::CLOEXEC)?;
    // Watch the directory rather than the files: the guest replaces both of them.
    let add_watch = || -> io::Result<()> {
        fs::create_dir_all(&dir)?;
        inotify::add_watch(
            &inotify,
            &dir,
            WatchFlags::CREATE | WatchFlags::MOVED_TO | WatchFlags::DELETE_SELF,
        )?;
        Ok(())
    };
    add_watch()?;

    let mut buffer = [MaybeUninit::<u8>::uninit(); 4096];
    let mut events = inotify::Reader::new(&inotify, &mut buffer);
    loop {
        let event = match events.next() {
            Ok(event) => event,
            Err(Errno::INTR) => continue,
            Err(error) => return Err(error.into()),
        };
        let name = event.file_name().and_then(|it| it.to_str().ok());
        let flags = event.events();
        if flags.contains(ReadFlags::MOVED_TO) && name == Some(OUTGOING) {
            on_linux_copy(&android_app, &dir.join(OUTGOING));
        } else if flags.contains(ReadFlags::CREATE) && name == Some(INCOMING) {
            // The desktop (re)started: hand it what was copied on Android meanwhile.
            thread::spawn(send_pending);
        } else if flags.intersects(ReadFlags::DELETE_SELF | ReadFlags::IGNORED) {
            add_watch()?;
        }
    }
}

fn on_linux_copy(android_app: &AndroidApp, path: &Path) {
    let Some(text) = fs::read(path)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .filter(|text| usable(text))
    else {
        return;
    };
    {
        let mut shared = SHARED.lock().unwrap();
        if shared.last.as_deref() == Some(text.as_str()) {
            return;
        }
        shared.last = Some(text.clone());
        // Copied on Linux after it: the Android text is out of date.
        shared.pending = None;
    }
    log::info!("Clipboard: Linux to Android, {} bytes", text.len());
    run_in_jvm(
        |env, app| write_android_clipboard(env, app, &text),
        android_app.clone(),
    );
}

/// Hands the pending Android text to the guest, or keeps it for when the guest creates the FIFO.
fn send_pending() {
    let _writing = WRITING.lock().unwrap();
    let Some(text) = SHARED.lock().unwrap().pending.take() else {
        return;
    };
    let path = dir().join(INCOMING);
    let deadline = Instant::now() + READER_WAIT;
    loop {
        match write_incoming(&path, &text) {
            Ok(()) => return,
            Err(error) if not_ready(&error) && Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(50));
            }
            Err(error) => {
                if !not_ready(&error) {
                    log::warn!("Failed to paste the Android clipboard in Linux: {error}");
                }
                // Unless something newer was copied meanwhile.
                SHARED.lock().unwrap().pending.get_or_insert(text);
                return;
            }
        }
    }
}

/// No FIFO yet, or nobody reading it.
fn not_ready(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound
        || error.raw_os_error() == Some(Errno::NXIO.raw_os_error())
}

/// Hands `text` to the guest's `wl-copy`, which reads the FIFO until we close it.
fn write_incoming(path: &Path, text: &str) -> io::Result<()> {
    if !fs::metadata(path)?.file_type().is_fifo() {
        return Err(io::ErrorKind::NotFound.into());
    }
    // Non-blocking, so opening fails with ENXIO instead of hanging when nobody reads it.
    let mut fifo = OpenOptions::new()
        .write(true)
        .custom_flags(OFlags::NONBLOCK.bits() as i32)
        .open(path)?;
    let deadline = Instant::now() + WRITE_TIMEOUT;
    let mut bytes = text.as_bytes();
    while !bytes.is_empty() {
        match fifo.write(bytes) {
            Ok(written) => bytes = &bytes[written..],
            // The pipe buffer is full until wl-copy reads it.
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if Instant::now() > deadline {
                    return Err(io::ErrorKind::TimedOut.into());
                }
                thread::sleep(Duration::from_millis(5));
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn clipboard_manager<'local>(
    env: &mut JNIEnv<'local>,
    activity: &JObject,
) -> jni::errors::Result<JObject<'local>> {
    let name = env.new_string("clipboard")?;
    env.call_method(
        activity,
        "getSystemService",
        "(Ljava/lang/String;)Ljava/lang/Object;",
        &[(&name).into()],
    )?
    .l()
}

fn read_android_clipboard(env: &mut JNIEnv, android_app: &AndroidApp) -> Option<String> {
    let activity = unsafe { JObject::from_raw(android_app.activity_as_ptr() as jobject) };
    let result = (|| -> jni::errors::Result<Option<String>> {
        let manager = clipboard_manager(env, &activity)?;
        if manager.is_null() {
            return Ok(None);
        }
        let clip = env
            .call_method(
                &manager,
                "getPrimaryClip",
                "()Landroid/content/ClipData;",
                &[],
            )?
            .l()?;
        if clip.is_null() || env.call_method(&clip, "getItemCount", "()I", &[])?.i()? < 1 {
            return Ok(None);
        }
        let item = env
            .call_method(
                &clip,
                "getItemAt",
                "(I)Landroid/content/ClipData$Item;",
                &[0.into()],
            )?
            .l()?;
        // Text as is; HTML, links and intents as text, the way Android pastes them in a text field.
        let text = env
            .call_method(
                &item,
                "coerceToText",
                "(Landroid/content/Context;)Ljava/lang/CharSequence;",
                &[(&activity).into()],
            )?
            .l()?;
        if text.is_null() {
            return Ok(None);
        }
        let text = JString::from(
            env.call_method(&text, "toString", "()Ljava/lang/String;", &[])?
                .l()?,
        );
        let text: String = env.get_string(&text)?.into();
        Ok(Some(text))
    })();
    result.unwrap_or_else(|error| {
        log::warn!("Failed to read the Android clipboard: {error}");
        let _ = env.exception_clear();
        None
    })
}

fn write_android_clipboard(env: &mut JNIEnv, android_app: &AndroidApp, text: &str) {
    let activity = unsafe { JObject::from_raw(android_app.activity_as_ptr() as jobject) };
    let result = (|| -> jni::errors::Result<()> {
        let manager = clipboard_manager(env, &activity)?;
        if manager.is_null() {
            return Ok(());
        }
        let label = env.new_string("Local Desktop")?;
        let text = env.new_string(text)?;
        let clip = env
            .call_static_method(
                "android/content/ClipData",
                "newPlainText",
                "(Ljava/lang/CharSequence;Ljava/lang/CharSequence;)Landroid/content/ClipData;",
                &[(&label).into(), (&text).into()],
            )?
            .l()?;
        env.call_method(
            &manager,
            "setPrimaryClip",
            "(Landroid/content/ClipData;)V",
            &[(&clip).into()],
        )?;
        Ok(())
    })();
    if let Err(error) = result {
        log::warn!("Failed to write the Android clipboard: {error}");
        let _ = env.exception_clear();
    }
}
