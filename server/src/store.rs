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

/// A war with feed and history, and the folder they live in.
pub struct WarSlot {
    pub war: War,
    pub feed: Vec<FeedEntry>,
    pub history: Vec<Snapshot>,
    pub dir: PathBuf,
    pub lan_open: bool,
    /// Whether callers from outside the local network reach the war too. Only with `lan_open`.
    pub internet_open: bool,
    /// The invite code a caller from outside the local network has to give. Made the first time
    /// the war opens to the internet and kept in `invite.txt`, so friends keep the one they got.
    pub invite: String,
}

/// The letters of an invite code: no 0, 1, I or O, which read alike.
const INVITE_LETTERS: &[u8; 32] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/// A new invite code from the system random source: ten letters, 50 bits, written `XXXXX-XXXXX`.
pub fn new_invite() -> io::Result<String> {
    let mut raw = [0u8; 10];
    getrandom::fill(&mut raw).map_err(|e| io::Error::other(e.to_string()))?;
    let code: String = raw
        .iter()
        .map(|b| INVITE_LETTERS[(b & 31) as usize] as char)
        .collect();
    Ok(format!("{}-{}", &code[..5], &code[5..]))
}

/// An invite code as typed, for comparing: letters and digits only, upper case.
pub fn plain_invite(code: &str) -> String {
    code.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_uppercase())
        .collect()
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
    /// Whether a request that came `via` this way, with this invite code, gets the war. A caller
    /// from outside the local network needs the code; the comparison takes the same time whatever
    /// part of it matches.
    pub fn admits(&self, via: crate::http::Via, key: Option<&str>) -> bool {
        if via != crate::http::Via::Internet {
            return self.reachable(via);
        }
        let (given, want) = (plain_invite(key.unwrap_or("")), plain_invite(&self.invite));
        self.reachable(via)
            && !want.is_empty()
            && given.len() == want.len()
            && given
                .bytes()
                .zip(want.bytes())
                .fold(0u8, |acc, (a, b)| acc | (a ^ b))
                == 0
    }

    /// Gives the war an invite code if it has none, or a new one when `fresh`, and keeps it on disk.
    pub fn ensure_invite(&mut self, fresh: bool) -> io::Result<()> {
        if fresh || plain_invite(&self.invite).is_empty() {
            self.invite = new_invite()?;
            fs::create_dir_all(&self.dir)?;
            fs::write(self.dir.join("invite.txt"), &self.invite)?;
        }
        Ok(())
    }

    /// Whether a request that came `via` this way gets the war.
    pub fn reachable(&self, via: crate::http::Via) -> bool {
        match via {
            crate::http::Via::Loopback => true,
            crate::http::Via::Lan => self.lan_open,
            crate::http::Via::Internet => self.lan_open && self.internet_open,
        }
    }

    pub fn new(war: War, wars_dir: &Path) -> Self {
        let dir = wars_dir.join(&war.id);
        WarSlot {
            war,
            feed: vec![],
            history: vec![],
            dir,
            lan_open: false,
            internet_open: false,
            invite: String::new(),
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
            internet_open: false,
            invite: fs::read_to_string(dir.join("invite.txt"))
                .map(|t| t.trim().to_string())
                .unwrap_or_default(),
        })
    }

    pub fn save(&self) -> io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let bytes = serde_json::to_vec_pretty(&self.war).map_err(io::Error::other)?;
        write_atomic(&self.dir.join("war.json"), &bytes)
    }

    /// Writes a whole new war: war.json plus the feed and history files.
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

    /// The war, the feed and the history in one JSON document.
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
