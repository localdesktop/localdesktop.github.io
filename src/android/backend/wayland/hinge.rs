//! Hinge angle from the NDK sensor API (`ASENSOR_TYPE_HINGE_ANGLE`, API 30+), used to detect the
//! half-open "laptop" posture of a foldable.
//!
//! Everything in libandroid is resolved at runtime, so the app still loads where the symbols are
//! missing; without the sensor [`HingeSensor::start`] returns `None` and the posture is simply
//! never reported.

use crate::android::accessibility::{send_user_event, AppUserEvent};
use crate::core::config::ANDROID_PACKAGE;
use libloading::Library;
use std::{
    ffi::{c_char, c_int, c_void, CString},
    ptr,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

const ASENSOR_TYPE_HINGE_ANGLE: c_int = 36;
const ALOOPER_PREPARE_ALLOW_NON_CALLBACKS: c_int = 1;
/// Identifier of the sensor queue inside the thread's own looper (must be >= 0).
const SENSOR_LOOPER_IDENT: c_int = 3;
/// Requested sampling period: the sensor reports on change, this only bounds the rate.
const SAMPLING_PERIOD_US: i32 = 100_000;
/// How long the looper may block before the stop flag is rechecked.
const POLL_TIMEOUT_MS: c_int = 1000;

/// Posture thresholds: half-open between these angles (degrees; 180 is flat, 0 closed).
pub const HALF_OPEN_MIN_DEGREES: f32 = 30.0;
pub const HALF_OPEN_MAX_DEGREES: f32 = 150.0;
/// A reading must move this far past a threshold before the posture flips, to avoid flapping.
const HYSTERESIS_DEGREES: f32 = 4.0;

/// `ASensorEvent` from `<android/sensor.h>` (104 bytes).
#[repr(C)]
struct SensorEvent {
    version: i32,
    sensor: i32,
    kind: i32,
    reserved0: i32,
    timestamp: i64,
    data: [f32; 16],
    flags: u32,
    reserved1: [i32; 3],
}

type GetInstanceForPackage = unsafe extern "C" fn(*const c_char) -> *mut c_void;
type GetDefaultSensor = unsafe extern "C" fn(*mut c_void, c_int) -> *const c_void;
type CreateEventQueue =
    unsafe extern "C" fn(*mut c_void, *mut c_void, c_int, *const c_void, *mut c_void) -> *mut c_void;
type EnableSensor = unsafe extern "C" fn(*mut c_void, *const c_void) -> c_int;
type SetEventRate = unsafe extern "C" fn(*mut c_void, *const c_void, i32) -> c_int;
type GetEvents = unsafe extern "C" fn(*mut c_void, *mut SensorEvent, usize) -> isize;
type DestroyEventQueue = unsafe extern "C" fn(*mut c_void, *mut c_void) -> c_int;
type LooperPrepare = unsafe extern "C" fn(c_int) -> *mut c_void;
type LooperPollOnce =
    unsafe extern "C" fn(c_int, *mut c_int, *mut c_int, *mut *mut c_void) -> c_int;
type LooperWake = unsafe extern "C" fn(*mut c_void);

/// Whether `angle` is in the half-open range, given the previous classification (for hysteresis).
pub fn is_half_open(angle: f32, was_half_open: bool) -> bool {
    let margin = if was_half_open { -HYSTERESIS_DEGREES } else { HYSTERESIS_DEGREES };
    angle >= HALF_OPEN_MIN_DEGREES + margin && angle <= HALF_OPEN_MAX_DEGREES - margin
}

/// Handle of the sensor thread; dropping it stops the thread.
pub struct HingeSensor {
    stop: Arc<AtomicBool>,
    looper: Arc<AtomicUsize>,
    wake: Option<LooperWake>,
    thread: Option<JoinHandle<()>>,
}

impl HingeSensor {
    /// Starts listening on a dedicated thread with its own `ALooper`. Posts
    /// [`AppUserEvent::HingeAngle`] for the first reading and whenever the half-open
    /// classification changes. Returns `None` when the device has no hinge angle sensor.
    pub fn start() -> Option<HingeSensor> {
        let library = unsafe { Library::new("libandroid.so") }.ok()?;
        // Fail early, on the calling thread, if the API is missing or the device has no sensor.
        let manager = sensor_manager(&library)?;
        let present = unsafe {
            let get_default: GetDefaultSensor =
                *library.get::<GetDefaultSensor>(b"ASensorManager_getDefaultSensor\0").ok()?;
            !get_default(manager, ASENSOR_TYPE_HINGE_ANGLE).is_null()
        };
        if !present {
            log::info!("No hinge angle sensor: laptop mode stays off in auto mode");
            return None;
        }
        let wake: LooperWake = unsafe { *library.get::<LooperWake>(b"ALooper_wake\0").ok()? };

        let stop = Arc::new(AtomicBool::new(false));
        let looper = Arc::new(AtomicUsize::new(0));
        let thread = {
            let stop = stop.clone();
            let looper = looper.clone();
            thread::Builder::new()
                .name("hinge-sensor".into())
                .spawn(move || {
                    if let Err(error) = run(&library, &stop, &looper) {
                        log::warn!("Hinge angle sensor stopped: {error}");
                    }
                })
                .ok()?
        };

        Some(HingeSensor {
            stop,
            looper,
            wake: Some(wake),
            thread: Some(thread),
        })
    }
}

impl Drop for HingeSensor {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let looper = self.looper.load(Ordering::Acquire);
        if let (Some(wake), true) = (self.wake, looper != 0) {
            unsafe { wake(looper as *mut c_void) };
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn sensor_manager(library: &Library) -> Option<*mut c_void> {
    let package = CString::new(ANDROID_PACKAGE).ok()?;
    let get_instance: GetInstanceForPackage = unsafe {
        *library
            .get::<GetInstanceForPackage>(b"ASensorManager_getInstanceForPackage\0")
            .ok()?
    };
    let manager = unsafe { get_instance(package.as_ptr()) };
    (!manager.is_null()).then_some(manager)
}

fn run(library: &Library, stop: &AtomicBool, looper_slot: &AtomicUsize) -> Result<(), String> {
    macro_rules! symbol {
        ($ty:ty, $name:literal) => {
            *unsafe { library.get::<$ty>(concat!($name, "\0").as_bytes()) }
                .map_err(|error| format!("{}: {error}", $name))?
        };
    }
    let looper_prepare: LooperPrepare = symbol!(LooperPrepare, "ALooper_prepare");
    let looper_poll_once: LooperPollOnce = symbol!(LooperPollOnce, "ALooper_pollOnce");
    let get_default: GetDefaultSensor = symbol!(GetDefaultSensor, "ASensorManager_getDefaultSensor");
    let create_queue: CreateEventQueue = symbol!(CreateEventQueue, "ASensorManager_createEventQueue");
    let destroy_queue: DestroyEventQueue =
        symbol!(DestroyEventQueue, "ASensorManager_destroyEventQueue");
    let enable: EnableSensor = symbol!(EnableSensor, "ASensorEventQueue_enableSensor");
    let set_rate: SetEventRate = symbol!(SetEventRate, "ASensorEventQueue_setEventRate");
    let get_events: GetEvents = symbol!(GetEvents, "ASensorEventQueue_getEvents");

    let manager = sensor_manager(library).ok_or("no sensor manager")?;
    let sensor = unsafe { get_default(manager, ASENSOR_TYPE_HINGE_ANGLE) };
    if sensor.is_null() {
        return Err("no hinge angle sensor".into());
    }

    let looper = unsafe { looper_prepare(ALOOPER_PREPARE_ALLOW_NON_CALLBACKS) };
    if looper.is_null() {
        return Err("cannot create a looper".into());
    }
    looper_slot.store(looper as usize, Ordering::Release);

    let queue = unsafe {
        create_queue(manager, looper, SENSOR_LOOPER_IDENT, ptr::null(), ptr::null_mut())
    };
    if queue.is_null() {
        return Err("cannot create the sensor event queue".into());
    }

    let result = (|| {
        if unsafe { enable(queue, sensor) } < 0 {
            return Err("cannot enable the hinge angle sensor".to_string());
        }
        unsafe { set_rate(queue, sensor, SAMPLING_PERIOD_US) };

        let mut half_open: Option<bool> = None;
        // SAFETY: `SensorEvent` is plain old data.
        let mut events: [SensorEvent; 8] = unsafe { std::mem::zeroed() };
        while !stop.load(Ordering::Acquire) {
            let mut fd: c_int = 0;
            let mut poll_events: c_int = 0;
            let mut data: *mut c_void = ptr::null_mut();
            let ident = unsafe {
                looper_poll_once(POLL_TIMEOUT_MS, &mut fd, &mut poll_events, &mut data)
            };
            if ident != SENSOR_LOOPER_IDENT {
                // Timeout, wake-up (stop requested) or an unrelated source.
                continue;
            }
            loop {
                let count = unsafe { get_events(queue, events.as_mut_ptr(), events.len()) };
                if count <= 0 {
                    break;
                }
                for event in &events[..count as usize] {
                    if event.kind != ASENSOR_TYPE_HINGE_ANGLE {
                        continue;
                    }
                    let angle = event.data[0];
                    let now = is_half_open(angle, half_open.unwrap_or(false));
                    if half_open != Some(now) {
                        half_open = Some(now);
                        log::info!("Hinge angle {angle:.0}° half_open={now}");
                        while !send_user_event(AppUserEvent::HingeAngle(angle)) {
                            // The event loop is not registered yet, or is gone.
                            if stop.load(Ordering::Acquire) {
                                return Ok(());
                            }
                            thread::sleep(Duration::from_millis(100));
                        }
                    }
                }
            }
        }
        Ok(())
    })();

    unsafe { destroy_queue(manager, queue) };
    looper_slot.store(0, Ordering::Release);
    result
}
