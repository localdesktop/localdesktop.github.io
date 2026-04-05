/// One-shot utility: download Android SDK build-tools;34.0.0 into ANDROID_HOME.
/// Usage: cargo run --bin download_sdk
use std::path::PathBuf;

fn main() {
    let android_home = std::env::var("ANDROID_HOME")
        .unwrap_or_else(|_| format!("{}/.cache/x/Android.sdk", std::env::var("HOME").unwrap()));
    let sdk_dir = PathBuf::from(&android_home);
    let build_tools_dir = sdk_dir.join("build-tools").join("34.0.0");

    if build_tools_dir.exists() {
        println!("build-tools;34.0.0 already present at {}", build_tools_dir.display());
        return;
    }

    println!("Downloading build-tools;34.0.0 into {}...", android_home);
    android_sdkmanager::download_and_extract_packages(
        &android_home,
        android_sdkmanager::HostOs::Linux,
        &["build-tools;34.0.0"],
        None,
    );

    println!("Done. build-tools are at {}", build_tools_dir.display());
}
