//! A plain log file: `<data>/logs/server.log`.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

pub struct Log {
    file: Mutex<Option<File>>,
}

impl Log {
    pub fn open(data: &Path) -> Log {
        let dir = data.join("logs");
        let file = fs::create_dir_all(&dir).ok().and_then(|_| {
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("server.log"))
                .ok()
        });
        Log {
            file: Mutex::new(file),
        }
    }

    pub fn line(&self, msg: &str) {
        let now = crate::now_unix();
        if let Ok(mut f) = self.file.lock()
            && let Some(f) = f.as_mut()
        {
            let _ = writeln!(f, "{now} {msg}");
        }
    }
}
