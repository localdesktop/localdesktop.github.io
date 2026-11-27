//! Shares the clipboard (text and images) between Android and the Linux desktop.
//!
//! labwc is nested on our compositor through wlroots' Wayland backend, which doesn't pass the
//! selection on to its parent, so the guest-side `localdesktop-clipboard` script (started from
//! labwc's autostart) bridges it with `wl-clipboard`, through files in [`DIR`]:
//!
//! - Linux to Android: `wl-paste --watch` writes the MIME type to `out.mime`, the payload to
//!   `out.tmp`, and renames `out.tmp` to [`OUTGOING`]. inotify tells us about the rename, and we
//!   put the text or image URI (served by `ClipboardProvider`) on the Android clipboard.
//! - Android to Linux: Android 10+ only lets the focused app read the clipboard, so we read it when
//!   our window gains focus, write the MIME type to [`INCOMING_MIME`], and stream the payload to
//!   the [`INCOMING`] FIFO, where `wl-copy` waits for it. If the desktop isn't up yet, the clip
//!   waits until inotify sees the guest create the FIFO.
//!
//! Nothing polls: the thread here sleeps in inotify, and the guest in `wl-paste` and `wl-copy`.
//! Both directions remember the last item they synced, so a change doesn't bounce back.

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
/// MIME type for the next payload written to [`INCOMING`].
const INCOMING_MIME: &str = "in.mime";
/// File the guest writes with `wl-paste --watch`: what was copied on Linux.
const OUTGOING: &str = "out";
/// MIME type of [`OUTGOING`].
const OUTGOING_MIME: &str = "out.mime";
/// Maximum text size: a binder transaction is limited to about 1 MB.
const MAX_TEXT_BYTES: usize = 512 * 1024;
/// Maximum image size synced through `ClipboardProvider` / `ContentResolver` (32 MB).
const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;
/// How long to wait for `wl-copy` to open the FIFO: it reopens it after each paste, and right
/// after the guest creates it.
const READER_WAIT: Duration = Duration::from_secs(3);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, PartialEq, Eq)]
struct ClipItem {
    mime: String,
    bytes: Vec<u8>,
}

impl ClipItem {
    fn is_image(&self) -> bool {
        is_supported_image_mime(&self.mime)
    }

    fn usable(&self) -> bool {
        if self.bytes.is_empty() {
            return false;
        }
        if self.is_image() {
            self.bytes.len() <= MAX_IMAGE_BYTES
        } else {
            self.mime.starts_with("text/")
                && self.bytes.len() <= MAX_TEXT_BYTES
                && std::str::from_utf8(&self.bytes).is_ok()
        }
    }
}

fn is_supported_image_mime(mime: &str) -> bool {
    matches!(
        mime,
        "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "image/bmp" | "image/svg+xml"
    )
}

fn extension_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        _ => "bin",
    }
}

#[derive(Default)]
struct Shared {
    /// The item both sides had when they were last synced.
    last: Option<ClipItem>,
    /// Android item that the guest hasn't taken yet, e.g. because the desktop is still starting.
    pending: Option<ClipItem>,
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
        let Some(item) = run_in_jvm(read_android_clipboard, android_app) else {
            return;
        };
        if !item.usable() {
            return;
        }
        {
            let mut shared = SHARED.lock().unwrap();
            if shared.last.as_ref() == Some(&item) {
                return;
            }
            log::info!(
                "Clipboard: Android to Linux ({}, {} bytes)",
                item.mime,
                item.bytes.len()
            );
            shared.last = Some(item.clone());
            shared.pending = Some(item);
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
            on_linux_copy(&android_app, &dir);
        } else if flags.contains(ReadFlags::CREATE) && name == Some(INCOMING) {
            // The desktop (re)started: hand it what was copied on Android meanwhile.
            thread::spawn(send_pending);
        } else if flags.intersects(ReadFlags::DELETE_SELF | ReadFlags::IGNORED) {
            add_watch()?;
        }
    }
}

fn on_linux_copy(android_app: &AndroidApp, dir: &Path) {
    let mime = fs::read_to_string(dir.join(OUTGOING_MIME))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "text/plain;charset=utf-8".to_string());
    let Ok(bytes) = fs::read(dir.join(OUTGOING)) else {
        return;
    };
    let item = ClipItem { mime, bytes };
    if !item.usable() {
        return;
    }
    {
        let mut shared = SHARED.lock().unwrap();
        if shared.last.as_ref() == Some(&item) {
            return;
        }
        shared.last = Some(item.clone());
        // Copied on Linux after it: the Android item is out of date.
        shared.pending = None;
    }
    log::info!(
        "Clipboard: Linux to Android ({}, {} bytes)",
        item.mime,
        item.bytes.len()
    );
    run_in_jvm(
        |env, app| write_android_clipboard(env, app, &item),
        android_app.clone(),
    );
}

/// Hands the pending Android item to the guest, or keeps it for when the guest creates the FIFO.
fn send_pending() {
    let _writing = WRITING.lock().unwrap();
    let Some(item) = SHARED.lock().unwrap().pending.take() else {
        return;
    };
    let dir = dir();
    let deadline = Instant::now() + READER_WAIT;
    loop {
        match write_incoming(&dir, &item) {
            Ok(()) => return,
            Err(error) if not_ready(&error) && Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(50));
            }
            Err(error) => {
                if !not_ready(&error) {
                    log::warn!("Failed to paste the Android clipboard in Linux: {error}");
                }
                // Unless something newer was copied meanwhile.
                SHARED.lock().unwrap().pending.get_or_insert(item);
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

/// Writes the MIME type and hands the bytes to the guest's `wl-copy`, which reads the FIFO until
/// we close it.
fn write_incoming(dir: &Path, item: &ClipItem) -> io::Result<()> {
    let fifo_path = dir.join(INCOMING);
    if !fs::metadata(&fifo_path)?.file_type().is_fifo() {
        return Err(io::ErrorKind::NotFound.into());
    }
    fs::write(dir.join(INCOMING_MIME), format!("{}\n", item.mime))?;
    // Non-blocking, so opening fails with ENXIO instead of hanging when nobody reads it.
    let mut fifo = OpenOptions::new()
        .write(true)
        .custom_flags(OFlags::NONBLOCK.bits() as i32)
        .open(&fifo_path)?;
    let deadline = Instant::now() + WRITE_TIMEOUT;
    let mut bytes = item.bytes.as_slice();
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

fn read_android_clipboard(env: &mut JNIEnv, android_app: &AndroidApp) -> Option<ClipItem> {
    let activity = unsafe { JObject::from_raw(android_app.activity_as_ptr() as jobject) };
    let result = (|| -> jni::errors::Result<Option<ClipItem>> {
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

        // Check for a content:// image URI first before falling back to text.
        let uri = env
            .call_method(&item, "getUri", "()Landroid/net/Uri;", &[])?
            .l()?;
        if !uri.is_null() {
            if let Some(image_item) = read_uri_image(env, &activity, &uri)? {
                return Ok(Some(image_item));
            }
        }

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
        Ok(Some(ClipItem {
            mime: "text/plain;charset=utf-8".to_string(),
            bytes: text.into_bytes(),
        }))
    })();
    result.unwrap_or_else(|error| {
        log::warn!("Failed to read the Android clipboard: {error}");
        let _ = env.exception_clear();
        None
    })
}

fn read_uri_image(
    env: &mut JNIEnv,
    activity: &JObject,
    uri: &JObject,
) -> jni::errors::Result<Option<ClipItem>> {
    let resolver = env
        .call_method(
            activity,
            "getContentResolver",
            "()Landroid/content/ContentResolver;",
            &[],
        )?
        .l()?;
    if resolver.is_null() {
        return Ok(None);
    }
    let mime_obj = env
        .call_method(
            &resolver,
            "getType",
            "(Landroid/net/Uri;)Ljava/lang/String;",
            &[uri.into()],
        )?
        .l()?;
    if mime_obj.is_null() {
        return Ok(None);
    }
    let mime_jstr = JString::from(mime_obj);
    let mime: String = env.get_string(&mime_jstr)?.into();
    if !is_supported_image_mime(&mime) {
        return Ok(None);
    }
    let stream = match env.call_method(
        &resolver,
        "openInputStream",
        "(Landroid/net/Uri;)Ljava/io/InputStream;",
        &[uri.into()],
    ) {
        Ok(val) => val.l()?,
        Err(_) => {
            let _ = env.exception_clear();
            return Ok(None);
        }
    };
    if stream.is_null() {
        return Ok(None);
    }
    let jbuf = env.new_byte_array(16384)?;
    let mut host_buf = vec![0i8; 16384];
    let mut bytes = Vec::new();
    let read_res = (|| -> jni::errors::Result<Option<Vec<u8>>> {
        loop {
            let n = env
                .call_method(&stream, "read", "([B)I", &[(&jbuf).into()])?
                .i()?;
            if n < 0 {
                break;
            }
            let n = n as usize;
            if n == 0 {
                continue;
            }
            if bytes.len() + n > MAX_IMAGE_BYTES {
                return Ok(None);
            }
            env.get_byte_array_region(&jbuf, 0, &mut host_buf[..n])?;
            bytes.extend(host_buf[..n].iter().map(|&b| b as u8));
        }
        Ok(Some(bytes))
    })();
    let _ = env.call_method(&stream, "close", "()V", &[]);
    let _ = env.exception_clear();
    Ok(read_res?.map(|bytes| ClipItem { mime, bytes }))
}

fn write_android_clipboard(env: &mut JNIEnv, android_app: &AndroidApp, item: &ClipItem) {
    let activity = unsafe { JObject::from_raw(android_app.activity_as_ptr() as jobject) };
    let result = (|| -> jni::errors::Result<()> {
        let manager = clipboard_manager(env, &activity)?;
        if manager.is_null() {
            return Ok(());
        }
        let label = env.new_string("Local Desktop")?;
        let clip = if item.is_image() {
            let resolver = env
                .call_method(
                    &activity,
                    "getContentResolver",
                    "()Landroid/content/ContentResolver;",
                    &[],
                )?
                .l()?;
            let pkg_obj = env
                .call_method(&activity, "getPackageName", "()Ljava/lang/String;", &[])?
                .l()?;
            let pkg: String = env.get_string(&JString::from(pkg_obj))?.into();
            let ext = extension_for_mime(&item.mime);
            let uri_str = env.new_string(format!("content://{pkg}.clipboard/clipboard.{ext}"))?;
            let uri = env
                .call_static_method(
                    "android/net/Uri",
                    "parse",
                    "(Ljava/lang/String;)Landroid/net/Uri;",
                    &[(&uri_str).into()],
                )?
                .l()?;
            // Notify listeners on the URI that the underlying clipboard file was replaced.
            let null_observer = JObject::null();
            let _ = env.call_method(
                &resolver,
                "notifyChange",
                "(Landroid/net/Uri;Landroid/database/ContentObserver;)V",
                &[(&uri).into(), (&null_observer).into()],
            );
            env.call_static_method(
                "android/content/ClipData",
                "newUri",
                "(Landroid/content/ContentResolver;Ljava/lang/CharSequence;Landroid/net/Uri;)Landroid/content/ClipData;",
                &[(&resolver).into(), (&label).into(), (&uri).into()],
            )?
            .l()?
        } else {
            let Ok(text) = std::str::from_utf8(&item.bytes) else {
                return Ok(());
            };
            let text = env.new_string(text)?;
            env.call_static_method(
                "android/content/ClipData",
                "newPlainText",
                "(Ljava/lang/CharSequence;Ljava/lang/CharSequence;)Landroid/content/ClipData;",
                &[(&label).into(), (&text).into()],
            )?
            .l()?
        };
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
