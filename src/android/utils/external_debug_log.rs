use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

const LOG_FILE_NAME: &str = "localdesktop_debug.log";

fn candidate_paths() -> Vec<PathBuf> {
    let mut paths = vec![
        PathBuf::from("/sdcard/Download").join(LOG_FILE_NAME),
        PathBuf::from("/storage/emulated/0/Download").join(LOG_FILE_NAME),
    ];

    if let Ok(home) = std::env::var("HOME") {
        paths.push(PathBuf::from(home).join("storage/downloads").join(LOG_FILE_NAME));
    }

    paths
}

pub fn append_external_debug_log(tag: &str, message: &str) {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("[{}] [{}] {}\n", ts, tag, message);

    for path in candidate_paths() {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }

        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
            let _ = file.write_all(line.as_bytes());
            let _ = file.flush();
            return;
        }
    }
}

