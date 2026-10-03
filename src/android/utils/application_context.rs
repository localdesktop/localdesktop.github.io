use crate::{
    android::utils::ndk::run_in_jvm,
    core::config::{parse_config, LocalConfig, ARCH_FS_ROOT, CONFIG_FILE},
};
use jni::{
    objects::{JObject, JString},
    JNIEnv, JavaVM,
};
use std::path::PathBuf;
use std::sync::RwLock;
use winit::platform::android::activity::AndroidApp;

#[derive(Clone)]
pub struct ApplicationContext {
    pub cache_dir: PathBuf,
    pub data_dir: PathBuf,
    pub native_library_dir: PathBuf,
    pub local_config: LocalConfig,
    pub permission_all_files_access: bool,
}

/// `local_config` holds the user name and the shell commands the host runs, so it is deliberately
/// left out: this type must never leak those into logs or crash reports.
impl std::fmt::Debug for ApplicationContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApplicationContext")
            .field("cache_dir", &self.cache_dir)
            .field("data_dir", &self.data_dir)
            .field("native_library_dir", &self.native_library_dir)
            .field("permission_all_files_access", &self.permission_all_files_access)
            .finish_non_exhaustive()
    }
}

impl ApplicationContext {
    pub fn build(android_app: &AndroidApp) {
        let vm = unsafe { JavaVM::from_raw(android_app.vm_as_ptr() as *mut _) }
            .expect("Failed to get JavaVM");
        let mut env = vm
            .attach_current_thread()
            .expect("Failed to attach current thread");

        let activity = unsafe { JObject::from_raw(android_app.activity_as_ptr() as *mut _) };

        let cache_dir = Self::get_path(&mut env, &activity, "getCacheDir");
        let data_dir = Self::get_path(&mut env, &activity, "getFilesDir");
        let native_library_dir = Self::get_native_library_dir(&mut env, &activity);
        let full_config_path = format!("{}{}", ARCH_FS_ROOT, CONFIG_FILE);
        let local_config = parse_config(full_config_path);
        let permission_all_files_access = Self::is_all_files_access_granted(android_app);

        {
            let mut context = APPLICATION_CONTEXT
                .write()
                .expect("Failed to write application context");
            *context = Some(ApplicationContext {
                cache_dir,
                data_dir,
                native_library_dir,
                local_config,
                permission_all_files_access,
            });
            let context = context.as_ref().unwrap();
            let display = &context.local_config.display;
            let input = &context.local_config.input;
            log::info!(
                "ApplicationContext initialized: {:?}; display: render_scale={} ui_scale={} laptop_mode={:?} refresh_rate={} keep_screen_on={}; input: touch_mode={:?} pointer_capture={}; gpu: enabled={}; x86: box64={} wine={}; session: foreground_service={}",
                context,
                display.render_scale,
                display.ui_scale,
                display.laptop_mode,
                display.refresh_rate,
                display.keep_screen_on,
                input.touch_mode,
                input.pointer_capture,
                context.local_config.gpu.enabled,
                context.local_config.x86.box64,
                context.local_config.x86.wine,
                context.local_config.session.foreground_service,
            );
        }
    }

    fn get_path(env: &mut JNIEnv, activity: &JObject, method: &str) -> PathBuf {
        let path_obj = env
            .call_method(activity, method, "()Ljava/io/File;", &[])
            .expect("Failed to call method")
            .l()
            .expect("Failed to get path object");
        let path_str = env
            .call_method(path_obj, "getAbsolutePath", "()Ljava/lang/String;", &[])
            .expect("Failed to get absolute path")
            .l()
            .expect("Failed to get path string");
        let path: String = env
            .get_string(&JString::from(path_str))
            .expect("Failed to convert path to string")
            .into();
        PathBuf::from(path)
    }

    fn get_native_library_dir(env: &mut JNIEnv, activity: &JObject) -> PathBuf {
        let app_info = env
            .call_method(
                activity,
                "getApplicationInfo",
                "()Landroid/content/pm/ApplicationInfo;",
                &[],
            )
            .expect("Failed to get application info")
            .l()
            .expect("Failed to get application info object");
        let native_library_dir = env
            .get_field(app_info, "nativeLibraryDir", "Ljava/lang/String;")
            .expect("Failed to get native library dir field")
            .l()
            .expect("Failed to get native library dir object");
        let path: String = env
            .get_string(&JString::from(native_library_dir))
            .expect("Failed to convert native library dir to string")
            .into();
        PathBuf::from(path)
    }

    fn is_all_files_access_granted(android_app: &AndroidApp) -> bool {
        // To determine whether your app has been granted the MANAGE_EXTERNAL_STORAGE permission, call Environment.isExternalStorageManager().
        // Source: https://developer.android.com/training/data-storage/manage-all-files
        run_in_jvm(
            |env, _| {
                env.call_static_method(
                    "android/os/Environment",
                    "isExternalStorageManager",
                    "()Z",
                    &[],
                )
                .and_then(|value| value.z())
                .unwrap_or(false)
            },
            android_app.clone(),
        )
    }
}

static APPLICATION_CONTEXT: RwLock<Option<ApplicationContext>> = RwLock::new(None);
pub fn get_application_context() -> ApplicationContext {
    return APPLICATION_CONTEXT
        .read()
        .expect("Failed to read application context")
        .clone()
        .expect("ApplicationContext is not initialized. Please make sure `ApplicationContext::build(&android_app);` is called in `android_main`.");
}
