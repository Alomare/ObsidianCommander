//! Wars on disk: `<data>/wars/<id>/war.json` (atomic), `feed.jsonl` and `history.jsonl` (appended).

use crate::rules::{Out, Snapshot, War};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct FeedEntry {
    pub id: u64,
    pub time: i64,
    pub war_time: f64,
    pub kind: String,
    pub front: Option<usize>,
    pub region: Option<i64>,
    pub event_id: Option<u64>,
    pub player: Option<String>,
    pub value: Option<f64>,
    pub text_key: String,
}

/// A war with its feed and history, and the folder they live in.
pub struct WarSlot {
    pub war: War,
    pub feed: Vec<FeedEntry>,
    pub history: Vec<Snapshot>,
    pub dir: PathBuf,
    pub lan_open: bool,
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)
}

fn append_line<T: Serialize>(path: &Path, item: &T) -> io::Result<()> {
    let mut line = serde_json::to_vec(item).map_err(io::Error::other)?;
    line.push(b'\n');
    let mut f = OpenOptions::new().create(true).append(true).open(path)?;
    f.write_all(&line)
}

/// Reads a JSON-lines file, skipping lines that don't parse (a write cut short by a crash).
fn read_lines<T: for<'de> Deserialize<'de>>(path: &Path) -> Vec<T> {
    let Ok(f) = File::open(path) else {
        return vec![];
    };
    BufReader::new(f)
        .lines()
        .map_while(Result::ok)
        .filter_map(|l| serde_json::from_str(l.trim()).ok())
        .collect()
}

impl WarSlot {
    pub fn new(war: War, wars_dir: &Path) -> Self {
        let dir = wars_dir.join(&war.id);
        WarSlot {
            war,
            feed: vec![],
            history: vec![],
            dir,
            lan_open: false,
        }
    }

    pub fn load(dir: &Path) -> io::Result<Self> {
        let text = fs::read(dir.join("war.json"))?;
        let war: War = serde_json::from_slice(&text).map_err(io::Error::other)?;
        Ok(WarSlot {
            war,
            feed: read_lines(&dir.join("feed.jsonl")),
            history: read_lines(&dir.join("history.jsonl")),
            dir: dir.to_path_buf(),
            lan_open: false,
        })
    }

    pub fn save(&self) -> io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let bytes = serde_json::to_vec_pretty(&self.war).map_err(io::Error::other)?;
        write_atomic(&self.dir.join("war.json"), &bytes)
    }

    /// Writes a whole new war: war.json plus its feed and history files.
    pub fn save_all(&self) -> io::Result<()> {
        self.save()?;
        let mut feed = Vec::new();
        for e in &self.feed {
            feed.extend(serde_json::to_vec(e).map_err(io::Error::other)?);
            feed.push(b'\n');
        }
        fs::write(self.dir.join("feed.jsonl"), feed)?;
        let mut hist = Vec::new();
        for s in &self.history {
            hist.extend(serde_json::to_vec(s).map_err(io::Error::other)?);
            hist.push(b'\n');
        }
        fs::write(self.dir.join("history.jsonl"), hist)
    }

    /// Records what a rules call did: feed entries and a snapshot are appended; war.json is
    /// rewritten when anything changed.
    pub fn commit(&mut self, out: Out, now: i64) -> io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        for f in out.feed {
            let entry = FeedEntry {
                id: self.feed.last().map(|e| e.id + 1).unwrap_or(1),
                time: now,
                war_time: self.war.war_time,
                kind: f.kind.to_string(),
                front: f.front,
                region: f.region,
                event_id: f.event_id,
                player: f.player,
                value: f.value,
                text_key: f.text_key,
            };
            append_line(&self.dir.join("feed.jsonl"), &entry)?;
            self.feed.push(entry);
        }
        if out.snapshot {
            let snap = self.war.snapshot(now);
            append_line(&self.dir.join("history.jsonl"), &snap)?;
            self.history.push(snap);
        }
        if out.changed || out.snapshot {
            self.save()?;
        }
        Ok(())
    }

    /// The war, its feed and its history in one JSON document.
    pub fn export(&self) -> Value {
        serde_json::json!({
            "commander_export": 1,
            "war": self.war,
            "feed": self.feed,
            "history": self.history,
        })
    }
}

/// Every war under `<data>/wars`. Folders that don't load are reported and skipped.
pub fn load_all(wars_dir: &Path, mut report: impl FnMut(&Path, &io::Error)) -> Vec<WarSlot> {
    let Ok(rd) = fs::read_dir(wars_dir) else {
        return vec![];
    };
    let mut out = vec![];
    for entry in rd.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        match WarSlot::load(&p) {
            Ok(mut slot) => {
                // The folder name is the id.
                if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                    slot.war.id = name.to_string();
                }
                out.push(slot)
            }
            Err(e) => report(&p, &e),
        }
    }
    out
}
