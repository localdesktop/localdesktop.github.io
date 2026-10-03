use jni::JNIEnv;
use winit::platform::android::activity::AndroidApp;

use crate::android::utils::host_bridge;

// `set_window_flags(FULLSCREEN)` alone is not enough to hide the system bars:
// https://github.com/rust-mobile/android-activity/issues/95
// `HostBridge` uses `WindowInsetsController` (API 30+) or the legacy system UI flags and also
// sets the display cutout mode. Signatures keep the `run_in_jvm` callback shape; the bridge
// attaches the calling thread itself, so the provided `JNIEnv` is not used.
pub fn enable_fullscreen_immersive_mode(_env: &mut JNIEnv, android_app: &AndroidApp) {
    host_bridge::apply_immersive(android_app);
}

pub fn keep_screen_on(_env: &mut JNIEnv, android_app: &AndroidApp) {
    host_bridge::set_keep_screen_on(android_app, true);
}
