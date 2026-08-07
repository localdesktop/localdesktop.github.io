//! Local Desktop PipeWire standalone-client AAudio proof-of-concept sink.
//!
//! This is the native half of the standalone-client PipeWire/AAudio experiment:
//! a normal PipeWire client process, not a PipeWire/SPA plugin. It registers an
//! `Audio/Sink` node and writes received F32 interleaved audio to Android AAudio.
//!
//! Android-only, and behind the `pipewire-sink` feature because it needs an
//! Android PipeWire sysroot the normal APK build does not. Build it with
//! `scripts/build-pipewire-aaudio-sink.sh`, which cross-compiles it and installs
//! the result as `assets/libs/arm64-v8a/liblocaldesktop_pipewire_aaudio_sink.so`.
//! `src/android/backend/pipewire_standalone_aaudio.rs` supervises it at runtime.
//!
//! The ring buffer and argument parsing below build on any host, so
//! `cargo test --features pipewire-sink --bin localdesktop_pipewire_aaudio_sink`
//! covers them without an Android sysroot.

use std::cell::UnsafeCell;
use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU32, AtomicU64, Ordering};

const DEFAULT_NODE_NAME: &str = "localdesktop-aaudio-sink";
const DEFAULT_RATE: u32 = 48000;
const DEFAULT_CHANNELS: u32 = 2;
const DEFAULT_BUFFER_MS: u32 = 120;

macro_rules! note {
    ($($arg:tt)*) => {
        eprintln!("[pipewire-aaudio-sink] {}", format_args!($($arg)*))
    };
}

// ----------------------------------------------------------------------------
// Ring buffer shared between the AAudio callback thread and the PipeWire loop
// ----------------------------------------------------------------------------

/// Single-producer (PipeWire `process`) / single-consumer (AAudio callback)
/// float ring. One `UnsafeCell` per sample: the two threads only ever touch
/// disjoint slots, so no sample is ever aliased mutably.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
struct Sink {
    rate: u32,
    channels: usize,
    ring_frames: u64,
    ring: Vec<UnsafeCell<f32>>,
    read_frame: AtomicU64,
    write_frame: AtomicU64,
    underrun_frames: AtomicU64,
    dropped_frames: AtomicU64,
    drive_enabled: AtomicBool,
    process_pending: AtomicBool,
    pipewire_buffer_frames: AtomicU32,
    /// The `pw_stream` this sink drives, or null before it is connected.
    stream: AtomicPtr<std::ffi::c_void>,
}

unsafe impl Send for Sink {}
unsafe impl Sync for Sink {}

impl Sink {
    fn new(rate: u32, channels: u32, buffer_ms: u32) -> Sink {
        let ring_frames = ((rate as u64 * buffer_ms as u64) / 1000).max(256);
        let channels = channels as usize;
        Sink {
            rate,
            channels,
            ring_frames,
            ring: (0..ring_frames as usize * channels)
                .map(|_| UnsafeCell::new(0.0))
                .collect(),
            read_frame: AtomicU64::new(0),
            write_frame: AtomicU64::new(0),
            underrun_frames: AtomicU64::new(0),
            dropped_frames: AtomicU64::new(0),
            drive_enabled: AtomicBool::new(false),
            process_pending: AtomicBool::new(false),
            pipewire_buffer_frames: AtomicU32::new(rate / 50),
            stream: AtomicPtr::new(std::ptr::null_mut()),
        }
    }

    fn frame_bytes(&self) -> u32 {
        (std::mem::size_of::<f32>() * self.channels) as u32
    }

    fn buffered_frames(&self) -> u64 {
        let read = self.read_frame.load(Ordering::Acquire);
        let write = self.write_frame.load(Ordering::Acquire);
        write.saturating_sub(read)
    }

    fn clear(&self) {
        let write = self.write_frame.load(Ordering::Acquire);
        self.read_frame.store(write, Ordering::Release);
    }

    /// Append interleaved frames, dropping the oldest when the ring is full.
    fn write(&self, src: &[f32]) {
        let ch = self.channels;
        let mut read = self.read_frame.load(Ordering::Acquire);
        let mut write = self.write_frame.load(Ordering::Relaxed);

        for frame in src.chunks_exact(ch) {
            if write - read >= self.ring_frames {
                read += 1;
                self.dropped_frames.fetch_add(1, Ordering::Relaxed);
                self.read_frame.store(read, Ordering::Release);
            }

            let slot = (write % self.ring_frames) as usize * ch;
            for (c, sample) in frame.iter().enumerate() {
                unsafe { *self.ring[slot + c].get() = *sample };
            }
            write += 1;
        }

        self.write_frame.store(write, Ordering::Release);
    }

    /// Fill `dst` with interleaved frames, padding with silence on underrun.
    fn read(&self, dst: &mut [f32]) {
        let ch = self.channels;
        let mut read = self.read_frame.load(Ordering::Relaxed);
        let write = self.write_frame.load(Ordering::Acquire);

        for frame in dst.chunks_exact_mut(ch) {
            if read < write {
                let slot = (read % self.ring_frames) as usize * ch;
                for (c, sample) in frame.iter_mut().enumerate() {
                    *sample = unsafe { *self.ring[slot + c].get() };
                }
                read += 1;
            } else {
                frame.fill(0.0);
                self.underrun_frames.fetch_add(1, Ordering::Relaxed);
            }
        }

        self.read_frame.store(read, Ordering::Release);
    }
}

// ----------------------------------------------------------------------------
// Arguments
// ----------------------------------------------------------------------------

struct Args {
    node_name: String,
    rate: u32,
    channels: u32,
    buffer_ms: u32,
}

enum Parsed {
    Run(Args),
    Help,
}

fn usage() {
    eprintln!(
        "Usage: localdesktop-pipewire-aaudio-sink [--node-name NAME] [--rate HZ] [--channels N] [--buffer-ms MS]"
    );
}

fn parse_args(argv: &[String]) -> Result<Parsed, String> {
    let mut args = Args {
        node_name: DEFAULT_NODE_NAME.to_string(),
        rate: DEFAULT_RATE,
        channels: DEFAULT_CHANNELS,
        buffer_ms: DEFAULT_BUFFER_MS,
    };

    let mut i = 0;
    while i < argv.len() {
        if argv[i] == "--help" || argv[i] == "-h" {
            return Ok(Parsed::Help);
        }
        let raw = argv
            .get(i + 1)
            .ok_or_else(|| format!("{} needs a value", argv[i]))?;
        let number = || -> Result<u32, String> {
            raw.parse::<u32>()
                .ok()
                .filter(|&n| n != 0)
                .ok_or_else(|| format!("invalid value for {}: {raw}", argv[i]))
        };

        match argv[i].as_str() {
            "--node-name" => args.node_name = raw.clone(),
            "--rate" => args.rate = number()?,
            "--channels" => args.channels = number()?,
            "--buffer-ms" => args.buffer_ms = number()?,
            other => return Err(format!("unknown argument {other}")),
        }
        i += 2;
    }

    Ok(Parsed::Run(args))
}

// ----------------------------------------------------------------------------
// Android: AAudio output and the PipeWire client
// ----------------------------------------------------------------------------

#[cfg(target_os = "android")]
mod android {
    use super::*;

    use std::ffi::{c_char, c_void, CStr};
    use std::io::Cursor;
    use std::sync::atomic::AtomicUsize;
    use std::sync::OnceLock;

    use libloading::Library;
    use pipewire as pw;
    use pw::spa;

    static AAUDIO: OnceLock<aaudio::Api> = OnceLock::new();
    static SINK: OnceLock<Sink> = OnceLock::new();
    /// Channel count of the opened AAudio stream, published before the stream
    /// starts so the data callback can emit silence until `SINK` exists.
    static AAUDIO_CHANNELS: AtomicUsize = AtomicUsize::new(0);

    impl Sink {
        /// Ask the graph for another quantum once the ring runs low. Called
        /// from the AAudio callback thread, exactly like the C original.
        fn maybe_trigger_process(&self) {
            let stream = self.stream.load(Ordering::Acquire);
            if !self.drive_enabled.load(Ordering::Acquire) || stream.is_null() {
                return;
            }

            let mut pw_frames = self.pipewire_buffer_frames.load(Ordering::Acquire);
            if pw_frames == 0 {
                pw_frames = self.rate / 50;
            }
            if self.buffered_frames() > (pw_frames / 2).max(256) as u64 {
                return;
            }

            if self
                .process_pending
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                unsafe { pw::sys::pw_stream_trigger_process(stream.cast()) };
            }
        }
    }

    // -- AAudio, loaded at runtime like the C original (no -laaudio link) -----

    mod aaudio {
        use super::*;

        pub type Res = i32;
        pub enum Builder {}
        pub enum Stream {}

        pub const OK: Res = 0;
        pub const DIRECTION_OUTPUT: i32 = 0;
        pub const FORMAT_PCM_FLOAT: i32 = 2;
        pub const PERFORMANCE_MODE_LOW_LATENCY: i32 = 12;
        pub const SHARING_MODE_SHARED: i32 = 1;
        pub const CALLBACK_RESULT_CONTINUE: i32 = 0;

        pub type DataCallback =
            unsafe extern "C" fn(*mut Stream, *mut c_void, *mut c_void, i32) -> i32;
        pub type ErrorCallback = unsafe extern "C" fn(*mut Stream, *mut c_void, Res);

        pub struct Api {
            _lib: Library,
            pub result_text: unsafe extern "C" fn(Res) -> *const c_char,
            pub create_builder: unsafe extern "C" fn(*mut *mut Builder) -> Res,
            pub builder_delete: unsafe extern "C" fn(*mut Builder),
            pub set_direction: unsafe extern "C" fn(*mut Builder, i32),
            pub set_format: unsafe extern "C" fn(*mut Builder, i32),
            pub set_performance_mode: unsafe extern "C" fn(*mut Builder, i32),
            pub set_sharing_mode: unsafe extern "C" fn(*mut Builder, i32),
            pub set_sample_rate: unsafe extern "C" fn(*mut Builder, i32),
            pub set_channel_count: unsafe extern "C" fn(*mut Builder, i32),
            pub set_data_callback: unsafe extern "C" fn(*mut Builder, DataCallback, *mut c_void),
            pub set_error_callback: unsafe extern "C" fn(*mut Builder, ErrorCallback, *mut c_void),
            pub open_stream: unsafe extern "C" fn(*mut Builder, *mut *mut Stream) -> Res,
            pub sample_rate: unsafe extern "C" fn(*mut Stream) -> i32,
            pub channel_count: unsafe extern "C" fn(*mut Stream) -> i32,
            pub buffer_size_in_frames: unsafe extern "C" fn(*mut Stream) -> i32,
            pub request_start: unsafe extern "C" fn(*mut Stream) -> Res,
            pub request_stop: unsafe extern "C" fn(*mut Stream) -> Res,
            pub close: unsafe extern "C" fn(*mut Stream) -> Res,
        }

        unsafe fn sym<T: Copy>(lib: &Library, name: &[u8]) -> Result<T, String> {
            lib.get::<T>(name).map(|s| *s).map_err(|e| {
                format!(
                    "missing AAudio symbol {}: {e}",
                    String::from_utf8_lossy(&name[..name.len() - 1])
                )
            })
        }

        impl Api {
            pub fn load() -> Result<Api, String> {
                unsafe {
                    let lib = Library::new("libaaudio.so")
                        .map_err(|e| format!("failed to dlopen libaaudio.so: {e}"))?;
                    Ok(Api {
                        result_text: sym(&lib, b"AAudio_convertResultToText\0")?,
                        create_builder: sym(&lib, b"AAudio_createStreamBuilder\0")?,
                        builder_delete: sym(&lib, b"AAudioStreamBuilder_delete\0")?,
                        set_direction: sym(&lib, b"AAudioStreamBuilder_setDirection\0")?,
                        set_format: sym(&lib, b"AAudioStreamBuilder_setFormat\0")?,
                        set_performance_mode: sym(
                            &lib,
                            b"AAudioStreamBuilder_setPerformanceMode\0",
                        )?,
                        set_sharing_mode: sym(&lib, b"AAudioStreamBuilder_setSharingMode\0")?,
                        set_sample_rate: sym(&lib, b"AAudioStreamBuilder_setSampleRate\0")?,
                        set_channel_count: sym(&lib, b"AAudioStreamBuilder_setChannelCount\0")?,
                        set_data_callback: sym(&lib, b"AAudioStreamBuilder_setDataCallback\0")?,
                        set_error_callback: sym(&lib, b"AAudioStreamBuilder_setErrorCallback\0")?,
                        open_stream: sym(&lib, b"AAudioStreamBuilder_openStream\0")?,
                        sample_rate: sym(&lib, b"AAudioStream_getSampleRate\0")?,
                        channel_count: sym(&lib, b"AAudioStream_getChannelCount\0")?,
                        buffer_size_in_frames: sym(&lib, b"AAudioStream_getBufferSizeInFrames\0")?,
                        request_start: sym(&lib, b"AAudioStream_requestStart\0")?,
                        request_stop: sym(&lib, b"AAudioStream_requestStop\0")?,
                        close: sym(&lib, b"AAudioStream_close\0")?,
                        _lib: lib,
                    })
                }
            }
        }
    }

    unsafe extern "C" fn aaudio_data_callback(
        _stream: *mut aaudio::Stream,
        _userdata: *mut c_void,
        audio_data: *mut c_void,
        num_frames: i32,
    ) -> i32 {
        let frames = num_frames.max(0) as usize;
        let channels = AAUDIO_CHANNELS.load(Ordering::Acquire);
        let dst = std::slice::from_raw_parts_mut(audio_data as *mut f32, frames * channels);

        match SINK.get() {
            // The stream starts before the ring exists; play silence until then.
            None => dst.fill(0.0),
            Some(sink) => {
                sink.read(dst);
                sink.maybe_trigger_process();
            }
        }

        aaudio::CALLBACK_RESULT_CONTINUE
    }

    unsafe extern "C" fn aaudio_error_callback(
        _stream: *mut aaudio::Stream,
        _userdata: *mut c_void,
        error: aaudio::Res,
    ) {
        let text = match AAUDIO.get() {
            Some(api) => CStr::from_ptr((api.result_text)(error))
                .to_string_lossy()
                .into_owned(),
            None => "unknown".to_string(),
        };
        note!("AAudio error: {text}");
    }

    /// Open and start an AAudio output stream, returning it together with the
    /// rate and channel count it actually negotiated.
    fn open_aaudio(rate: u32, channels: u32) -> Result<(*mut aaudio::Stream, u32, u32), String> {
        let api = match AAUDIO.get() {
            Some(api) => api,
            None => {
                let _ = AAUDIO.set(aaudio::Api::load()?);
                AAUDIO.get().unwrap()
            }
        };

        unsafe {
            let mut builder: *mut aaudio::Builder = std::ptr::null_mut();
            if (api.create_builder)(&mut builder) != aaudio::OK {
                return Err("AAudio_createStreamBuilder failed".into());
            }

            (api.set_direction)(builder, aaudio::DIRECTION_OUTPUT);
            (api.set_format)(builder, aaudio::FORMAT_PCM_FLOAT);
            (api.set_performance_mode)(builder, aaudio::PERFORMANCE_MODE_LOW_LATENCY);
            (api.set_sharing_mode)(builder, aaudio::SHARING_MODE_SHARED);
            (api.set_sample_rate)(builder, rate as i32);
            (api.set_channel_count)(builder, channels as i32);
            (api.set_data_callback)(builder, aaudio_data_callback, std::ptr::null_mut());
            (api.set_error_callback)(builder, aaudio_error_callback, std::ptr::null_mut());

            let mut stream: *mut aaudio::Stream = std::ptr::null_mut();
            let res = (api.open_stream)(builder, &mut stream);
            (api.builder_delete)(builder);
            if res != aaudio::OK {
                return Err("AAudioStreamBuilder_openStream failed".into());
            }

            let rate = (api.sample_rate)(stream) as u32;
            let channels = (api.channel_count)(stream) as u32;
            AAUDIO_CHANNELS.store(channels as usize, Ordering::Release);

            note!(
                "opened AAudio stream: rate={rate} channels={channels} buffer_frames={}",
                (api.buffer_size_in_frames)(stream)
            );

            if (api.request_start)(stream) != aaudio::OK {
                (api.close)(stream);
                return Err("AAudioStream_requestStart failed".into());
            }

            Ok((stream, rate, channels))
        }
    }

    fn close_aaudio(stream: *mut aaudio::Stream) {
        if let (Some(api), false) = (AAUDIO.get(), stream.is_null()) {
            unsafe {
                (api.request_stop)(stream);
                (api.close)(stream);
            }
        }
    }

    // -- SPA pods ------------------------------------------------------------

    fn pod_bytes(value: &spa::pod::Value) -> Vec<u8> {
        spa::pod::serialize::PodSerializer::serialize(Cursor::new(Vec::new()), value)
            .expect("serialize pod")
            .0
            .into_inner()
    }

    fn prop(key: u32, value: spa::pod::Value) -> spa::pod::Property {
        spa::pod::Property {
            key,
            flags: spa::pod::PropertyFlags::empty(),
            value,
        }
    }

    fn int_range(default: i32, min: i32, max: i32) -> spa::pod::Value {
        spa::pod::Value::Choice(spa::pod::ChoiceValue::Int(spa::utils::Choice(
            spa::utils::ChoiceFlags::empty(),
            spa::utils::ChoiceEnum::Range { default, min, max },
        )))
    }

    fn enum_format_pod(rate: u32, channels: u32) -> Vec<u8> {
        let mut info = spa::param::audio::AudioInfoRaw::new();
        info.set_format(spa::param::audio::AudioFormat::F32LE);
        info.set_rate(rate);
        info.set_channels(channels);

        pod_bytes(&spa::pod::Value::Object(spa::pod::Object {
            type_: spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
            id: spa::param::ParamType::EnumFormat.as_raw(),
            properties: info.into(),
        }))
    }

    fn buffers_pod(rate: u32, frame_bytes: u32) -> Vec<u8> {
        let buffer_bytes = ((rate / 100).max(256) * frame_bytes) as i32;
        let frame_bytes = frame_bytes as i32;

        pod_bytes(&spa::pod::Value::Object(spa::pod::Object {
            type_: spa::utils::SpaTypes::ObjectParamBuffers.as_raw(),
            id: spa::param::ParamType::Buffers.as_raw(),
            properties: vec![
                prop(spa::sys::SPA_PARAM_BUFFERS_buffers, int_range(8, 2, 16)),
                prop(spa::sys::SPA_PARAM_BUFFERS_blocks, spa::pod::Value::Int(1)),
                prop(
                    spa::sys::SPA_PARAM_BUFFERS_size,
                    int_range(buffer_bytes, frame_bytes * 256, frame_bytes * 8192),
                ),
                prop(
                    spa::sys::SPA_PARAM_BUFFERS_stride,
                    spa::pod::Value::Int(frame_bytes),
                ),
                prop(spa::sys::SPA_PARAM_BUFFERS_align, spa::pod::Value::Int(16)),
                prop(
                    spa::sys::SPA_PARAM_BUFFERS_dataType,
                    spa::pod::Value::Choice(spa::pod::ChoiceValue::Int(spa::utils::Choice(
                        spa::utils::ChoiceFlags::empty(),
                        spa::utils::ChoiceEnum::Flags {
                            default: 1 << spa::sys::SPA_DATA_MemPtr,
                            flags: Vec::new(),
                        },
                    ))),
                ),
            ],
        }))
    }

    fn meta_pod() -> Vec<u8> {
        pod_bytes(&spa::pod::Value::Object(spa::pod::Object {
            type_: spa::utils::SpaTypes::ObjectParamMeta.as_raw(),
            id: spa::param::ParamType::Meta.as_raw(),
            properties: vec![
                prop(
                    spa::sys::SPA_PARAM_META_type,
                    spa::pod::Value::Id(spa::utils::Id(spa::sys::SPA_META_Header)),
                ),
                prop(
                    spa::sys::SPA_PARAM_META_size,
                    spa::pod::Value::Int(std::mem::size_of::<spa::sys::spa_meta_header>() as i32),
                ),
            ],
        }))
    }

    // -- Stream events -------------------------------------------------------

    fn on_state_changed(
        _stream: &pw::stream::Stream,
        sink: &mut &'static Sink,
        old: pw::stream::StreamState,
        new: pw::stream::StreamState,
    ) {
        if new == pw::stream::StreamState::Streaming {
            sink.clear();
            sink.process_pending.store(false, Ordering::Release);
            sink.drive_enabled.store(true, Ordering::Release);
            sink.maybe_trigger_process();
        } else {
            sink.drive_enabled.store(false, Ordering::Release);
            sink.process_pending.store(false, Ordering::Release);
        }
        note!("stream state {old:?} -> {new:?}");
    }

    fn on_param_changed(
        stream: &pw::stream::Stream,
        sink: &mut &'static Sink,
        id: u32,
        param: Option<&spa::pod::Pod>,
    ) {
        let Some(param) = param else { return };
        if id != spa::param::ParamType::Format.as_raw() {
            return;
        }
        let Ok((media_type, media_subtype)) = spa::param::format_utils::parse_format(param) else {
            return;
        };
        if media_type != spa::param::format::MediaType::Audio
            || media_subtype != spa::param::format::MediaSubtype::Raw
        {
            return;
        }
        let mut info = spa::param::audio::AudioInfoRaw::new();
        if info.parse(param).is_err() {
            return;
        }

        note!(
            "negotiated PipeWire format: rate={} channels={} format={:?}",
            info.rate(),
            info.channels(),
            info.format()
        );
        if info.rate() != sink.rate || info.channels() != sink.channels as u32 {
            note!("warning: negotiated format differs from AAudio stream");
        }

        let buffers = buffers_pod(sink.rate, sink.frame_bytes());
        let meta = meta_pod();
        let (Some(buffers), Some(meta)) = (
            spa::pod::Pod::from_bytes(&buffers),
            spa::pod::Pod::from_bytes(&meta),
        ) else {
            return;
        };

        if let Err(e) = stream.update_params(&mut [buffers, meta]) {
            note!("failed to update stream params: {e}");
        }
    }

    fn on_process(stream: &pw::stream::Stream, sink: &mut &'static Sink) {
        let Some(mut buffer) = stream.dequeue_buffer() else {
            note!("out of buffers");
            return;
        };

        let frame_bytes = sink.frame_bytes() as usize;
        if let Some(data) = buffer.datas_mut().first_mut() {
            let offset = data.chunk().offset() as usize;
            let size = data.chunk().size() as usize;
            if let Some(bytes) = data.data() {
                let offset = offset.min(bytes.len());
                let size = size.min(bytes.len() - offset);
                let frames = size / frame_bytes;
                if frames > 0 {
                    sink.pipewire_buffer_frames
                        .store(frames as u32, Ordering::Release);
                    // MAP_BUFFERS memory holds F32 interleaved samples.
                    let samples = unsafe {
                        std::slice::from_raw_parts(
                            bytes[offset..].as_ptr() as *const f32,
                            frames * sink.channels,
                        )
                    };
                    sink.write(samples);
                }
            }
        }

        drop(buffer);
        sink.process_pending.store(false, Ordering::Release);
    }

    // -- Entry point ---------------------------------------------------------

    fn run_pipewire(sink: &'static Sink, node_name: &str) -> Result<(), String> {
        let mainloop = pw::main_loop::MainLoopRc::new(None)
            .map_err(|e| format!("failed to create PipeWire main loop: {e}"))?;

        let quit = {
            let mainloop = mainloop.clone();
            move || mainloop.quit()
        };
        let _sigint = mainloop
            .loop_()
            .add_signal_local(pw::loop_::Signal::INT, quit.clone());
        let _sigterm = mainloop
            .loop_()
            .add_signal_local(pw::loop_::Signal::TERM, quit);

        let context = pw::context::ContextRc::new(&mainloop, None)
            .map_err(|e| format!("failed to create PipeWire context: {e}"))?;
        let core = context
            .connect_rc(None)
            .map_err(|e| format!("failed to connect to PipeWire: {e}"))?;

        let props = pw::properties::properties! {
            *pw::keys::MEDIA_CLASS => "Audio/Sink",
            *pw::keys::NODE_NAME => node_name,
            *pw::keys::NODE_DESCRIPTION => "Local Desktop AAudio Output",
            *pw::keys::NODE_DRIVER => "true",
            *pw::keys::NODE_SUSPEND_ON_IDLE => "false",
            *pw::keys::AUDIO_RATE => sink.rate.to_string(),
            *pw::keys::AUDIO_CHANNELS => sink.channels.to_string(),
        };

        let stream = pw::stream::StreamRc::new(core, node_name, props)
            .map_err(|e| format!("failed to create PipeWire stream: {e}"))?;

        let _listener = stream
            .add_local_listener_with_user_data(sink)
            .state_changed(on_state_changed)
            .param_changed(on_param_changed)
            .process(on_process)
            .register()
            .map_err(|e| format!("failed to register stream listener: {e}"))?;

        let format = enum_format_pod(sink.rate, sink.channels as u32);
        let mut params = [spa::pod::Pod::from_bytes(&format).ok_or("bad EnumFormat pod")?];
        stream
            .connect(
                spa::utils::Direction::Input,
                None,
                pw::stream::StreamFlags::AUTOCONNECT
                    | pw::stream::StreamFlags::MAP_BUFFERS
                    | pw::stream::StreamFlags::DRIVER
                    | pw::stream::StreamFlags::RT_PROCESS,
                &mut params,
            )
            .map_err(|e| format!("failed to connect PipeWire stream: {e}"))?;

        sink.stream
            .store(stream.as_raw_ptr().cast(), Ordering::Release);

        note!(
            "running node={node_name} rate={} channels={} ring_frames={}",
            sink.rate,
            sink.channels,
            sink.ring_frames
        );
        mainloop.run();
        Ok(())
    }

    pub fn run(args: Args) -> Result<(), String> {
        pw::init();

        let result = (|| {
            let (aaudio_stream, rate, channels) = open_aaudio(args.rate, args.channels)?;
            let sink = match SINK.get() {
                Some(sink) => sink,
                None => {
                    let _ = SINK.set(Sink::new(rate, channels, args.buffer_ms));
                    SINK.get().unwrap()
                }
            };

            let result = run_pipewire(sink, &args.node_name);

            sink.drive_enabled.store(false, Ordering::Release);
            sink.process_pending.store(false, Ordering::Release);
            sink.stream.store(std::ptr::null_mut(), Ordering::Release);
            close_aaudio(aaudio_stream);

            note!(
                "stopped underrun_frames={} dropped_frames={}",
                sink.underrun_frames.load(Ordering::Relaxed),
                sink.dropped_frames.load(Ordering::Relaxed)
            );
            result
        })();

        unsafe { pw::deinit() };
        result
    }
}

#[cfg(not(target_os = "android"))]
mod android {
    use super::Args;

    pub fn run(_args: Args) -> Result<(), String> {
        Err("pipewire_aaudio_sink only runs on Android".into())
    }
}

fn main() -> std::process::ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    match parse_args(&argv) {
        Err(e) => {
            note!("{e}");
            usage();
            std::process::ExitCode::from(2)
        }
        Ok(Parsed::Help) => {
            usage();
            std::process::ExitCode::SUCCESS
        }
        Ok(Parsed::Run(args)) => match android::run(args) {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(e) => {
                note!("{e}");
                std::process::ExitCode::FAILURE
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(argv: &[&str]) -> Args {
        let argv: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
        match parse_args(&argv) {
            Ok(Parsed::Run(args)) => args,
            _ => panic!("expected parsed args"),
        }
    }

    #[test]
    fn defaults_and_overrides_parse() {
        let d = args(&[]);
        assert_eq!(
            (d.node_name.as_str(), d.rate, d.channels, d.buffer_ms),
            (DEFAULT_NODE_NAME, 48000, 2, 120)
        );

        let a = args(&["--node-name", "x", "--rate", "44100", "--channels", "1"]);
        assert_eq!((a.node_name.as_str(), a.rate, a.channels), ("x", 44100, 1));

        assert!(parse_args(&["--rate".into(), "0".into()]).is_err());
        assert!(parse_args(&["--rate".into()]).is_err());
        assert!(parse_args(&["--nope".into(), "1".into()]).is_err());
        assert!(matches!(parse_args(&["--help".into()]), Ok(Parsed::Help)));
    }

    /// 48 kHz × 120 ms × 2ch, the values the supervisor passes.
    fn sink() -> Sink {
        Sink::new(48000, 2, 120)
    }

    #[test]
    fn ring_sizing_matches_buffer_ms() {
        assert_eq!(sink().ring_frames, 5760);
        assert_eq!(sink().frame_bytes(), 8);
        // Tiny buffers still get the 256-frame floor.
        assert_eq!(Sink::new(48000, 2, 1).ring_frames, 256);
    }

    #[test]
    fn writes_come_back_in_order() {
        let sink = sink();
        let src: Vec<f32> = (0..8).map(|i| i as f32).collect();
        sink.write(&src);
        assert_eq!(sink.buffered_frames(), 4);

        let mut dst = vec![-1.0; 8];
        sink.read(&mut dst);
        assert_eq!(dst, src);
        assert_eq!(sink.buffered_frames(), 0);
        assert_eq!(sink.underrun_frames.load(Ordering::Relaxed), 0);
        assert_eq!(sink.dropped_frames.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn underrun_pads_with_silence() {
        let sink = sink();
        sink.write(&[1.0, 2.0]);

        let mut dst = vec![-1.0; 6];
        sink.read(&mut dst);
        assert_eq!(dst, vec![1.0, 2.0, 0.0, 0.0, 0.0, 0.0]);
        assert_eq!(sink.underrun_frames.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn overflow_drops_the_oldest_frames() {
        let sink = Sink::new(48000, 2, 1); // 256 frames
        let src: Vec<f32> = (0..(300 * 2)).map(|i| i as f32).collect();
        sink.write(&src);

        assert_eq!(sink.dropped_frames.load(Ordering::Relaxed), 44);
        assert_eq!(sink.buffered_frames(), 256);

        let mut dst = vec![-1.0; 256 * 2];
        sink.read(&mut dst);
        // The first 44 frames were dropped, so frame 44 leads.
        assert_eq!(&dst[..2], &[88.0, 89.0]);
        assert_eq!(&dst[dst.len() - 2..], &[598.0, 599.0]);
    }

    #[test]
    fn clear_discards_pending_audio() {
        let sink = sink();
        sink.write(&[1.0, 2.0, 3.0, 4.0]);
        sink.clear();
        assert_eq!(sink.buffered_frames(), 0);
    }
}
