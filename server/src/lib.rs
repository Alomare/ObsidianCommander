//! Obsidian Commander server: hosts custom Galactic Wars for HELLDIVERS 1.
//!
//! See docs/spec-m1.md (sections 2 to 5) for the contract this follows.

pub mod admin;
pub mod evolved;
pub mod game;
pub mod http;
pub mod lan;
pub mod log;
pub mod rules;
pub mod store;

use rules::{Dice, Out, SplitMix};
use std::collections::BTreeMap;
use std::io;
use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use store::WarSlot;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PROTOCOL: u32 = 1;
pub const DEFAULT_LAN_PORT: u16 = 17494;
pub const DISCOVERY_PORT: u16 = 17493;
const LOOPBACK_WORKERS: usize = 4;

pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Clone, Debug)]
pub struct Config {
    pub data: PathBuf,
    pub port: u16,
    pub token: String,
    pub ui: PathBuf,
    /// First port tried for the LAN listener (0: the OS chooses).
    pub lan_port: u16,
    /// The address the LAN listener binds. Tests bind loopback, so no firewall prompt appears.
    pub lan_bind: IpAddr,
    /// Whether the LAN listener answers addresses outside the private ranges.
    pub lan_any_source: bool,
    /// Where discovery packets go (0: no discovery).
    pub discovery_port: u16,
    /// Seconds between ticks (0: no tick thread; tests tick by hand).
    pub tick_seconds: f64,
}

impl Config {
    pub fn new(data: PathBuf, port: u16, token: String, ui: PathBuf) -> Self {
        Config {
            data,
            port,
            token,
            ui,
            lan_port: DEFAULT_LAN_PORT,
            lan_bind: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            lan_any_source: false,
            discovery_port: DISCOVERY_PORT,
            tick_seconds: 5.0,
        }
    }
}

pub struct App {
    pub cfg: Config,
    pub wars: Mutex<BTreeMap<String, WarSlot>>,
    pub lan: Mutex<Option<lan::LanListener>>,
    pub dice: Mutex<SplitMix>,
    pub log: log::Log,
    pub stop: Arc<AtomicBool>,
    last_tick: Mutex<Instant>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl App {
    pub fn wars(&self) -> MutexGuard<'_, BTreeMap<String, WarSlot>> {
        lock(&self.wars)
    }

    pub fn wars_dir(&self) -> PathBuf {
        self.cfg.data.join("wars")
    }

    pub fn roll(&self) -> f64 {
        lock(&self.dice).next_f64()
    }

    pub fn lan_port(&self) -> Option<u16> {
        lock(&self.lan).as_ref().map(|l| l.port)
    }

    /// Records rules call effects; a failed write goes to the log.
    pub fn commit(&self, slot: &mut WarSlot, out: Out, now: i64) {
        if let Err(e) = slot.commit(out, now) {
            self.log
                .line(&format!("war {}: write failed: {e}", slot.war.id));
        }
    }

    /// Advances every war by the real time since the last tick.
    pub fn tick(&self) {
        let real = {
            let mut last = lock(&self.last_tick);
            let dt = last.elapsed().as_secs_f64();
            *last = Instant::now();
            dt
        };
        self.tick_by(real);
    }

    /// Advances every war by `real_seconds` (still capped at 60 per tick by the rules).
    pub fn tick_by(&self, real_seconds: f64) {
        let now = now_unix();
        let mut wars = self.wars();
        let mut dice = lock(&self.dice);
        for slot in wars.values_mut() {
            let mut out = Out::default();
            slot.war.tick(now, real_seconds, &mut *dice, &mut out);
            for f in &out.feed {
                if f.kind == "event" || f.kind == "season" {
                    self.log
                        .line(&format!("war {}: {}", slot.war.id, f.text_key));
                }
            }
            self.commit(slot, out, now);
        }
    }

    pub fn save_all(&self) {
        for slot in self.wars().values() {
            if let Err(e) = slot.save() {
                self.log
                    .line(&format!("war {}: save failed: {e}", slot.war.id));
            }
        }
    }
}

/// A running server.
pub struct Handle {
    pub port: u16,
    pub app: Arc<App>,
    threads: Vec<JoinHandle<()>>,
    server: Arc<tiny_http::Server>,
}

impl Handle {
    /// Stops every thread, closes the listeners and saves the wars.
    pub fn shutdown(self) {
        self.app.stop.store(true, Ordering::SeqCst);
        for t in self.threads {
            let _ = t.join();
        }
        lan::close(&self.app);
        self.app.save_all();
        self.app.log.line("stopped");
        drop(self.server);
        http::unblock_accept(std::net::SocketAddr::from(([127, 0, 0, 1], self.port)));
    }
}

pub fn start(cfg: Config) -> io::Result<Handle> {
    std::fs::create_dir_all(cfg.data.join("wars"))?;
    let log = log::Log::open(&cfg.data);
    let server = tiny_http::Server::http(("127.0.0.1", cfg.port))
        .map_err(|e| io::Error::other(e.to_string()))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .unwrap_or(cfg.port);
    let server = Arc::new(server);

    let mut wars = BTreeMap::new();
    for slot in store::load_all(&cfg.data.join("wars"), |p, e| {
        log.line(&format!("skipped {}: {e}", p.display()))
    }) {
        wars.insert(slot.war.id.clone(), slot);
    }
    log.line(&format!(
        "started on 127.0.0.1:{port}, version {VERSION}, {} wars",
        wars.len()
    ));

    let app = Arc::new(App {
        cfg: cfg.clone(),
        wars: Mutex::new(wars),
        lan: Mutex::new(None),
        dice: Mutex::new(SplitMix::from_entropy()),
        log,
        stop: Arc::new(AtomicBool::new(false)),
        last_tick: Mutex::new(Instant::now()),
    });

    let mut threads = vec![];
    for _ in 0..LOOPBACK_WORKERS {
        let (app, server, stop) = (app.clone(), server.clone(), app.stop.clone());
        threads.push(thread::spawn(move || {
            http::serve(&app, &server, http::Via::Loopback, &stop)
        }));
    }
    if cfg.tick_seconds > 0.0 {
        let app2 = app.clone();
        threads.push(thread::spawn(move || {
            let step = Duration::from_millis(250);
            let mut waited = 0.0;
            while !app2.stop.load(Ordering::SeqCst) {
                thread::sleep(step);
                waited += step.as_secs_f64();
                if waited >= app2.cfg.tick_seconds {
                    waited = 0.0;
                    app2.tick();
                }
            }
        }));
    }
    if cfg.discovery_port != 0 {
        let app2 = app.clone();
        threads.push(thread::spawn(move || lan::discovery_loop(&app2)));
    }
    Ok(Handle {
        port,
        app,
        threads,
        server,
    })
}
