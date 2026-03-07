use jni::sys::JNIInvokeInterface_;
use jni::{JNIEnv, JavaVM};
use winit::platform::android::activity::AndroidApp;

/// A higher-order function to run a provided JNI function within the JVM context.
pub fn run_in_jvm<F, T>(jni_function: F, android_app: AndroidApp) -> T
where
    F: FnOnce(&mut JNIEnv, &AndroidApp) -> T,
{
    // Set up JNI and gather the JavaVM
    let vm =
        unsafe { JavaVM::from_raw(android_app.vm_as_ptr() as *mut *const JNIInvokeInterface_) }
            .expect("Failed to get JavaVM");

    let mut env = vm.attach_current_thread().expect("Failed to attach thread");

    // Call the provided JNI function
    let res = jni_function(&mut env, &android_app);

    // Detach the current thread from the JVM
    unsafe { vm.detach_current_thread() };

    res
}
