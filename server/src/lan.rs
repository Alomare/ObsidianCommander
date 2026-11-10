//! The LAN listener (`0.0.0.0:<lan port>`, only while a war is open to LAN) and UDP discovery.

use crate::http::{self, Via};
use crate::{App, VERSION};
use serde_json::json;
use std::net::{SocketAddr, UdpSocket};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const LAN_WORKERS: usize = 4;
const PORT_TRIES: u16 = 20;

/// One open or close at a time.
static SYNC: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub struct LanListener {
    pub port: u16,
    server: Arc<tiny_http::Server>,
    stop: Arc<AtomicBool>,
    workers: Vec<JoinHandle<()>>,
}

fn bind(first: u16) -> Option<tiny_http::Server> {
    if first == 0 {
        return tiny_http::Server::http(("0.0.0.0", 0)).ok();
    }
    (0..PORT_TRIES)
        .filter_map(|i| first.checked_add(i))
        .find_map(|p| tiny_http::Server::http(("0.0.0.0", p)).ok())
}

/// Opens or closes the LAN listener so it runs exactly while some war is open to LAN.
pub fn sync(app: &Arc<App>) -> Result<(), String> {
    let _one = SYNC.lock().unwrap_or_else(|e| e.into_inner());
    let wanted = app.wars().values().any(|s| s.lan_open);
    let running = app.lan.lock().map(|l| l.is_some()).unwrap_or(false);
    if wanted && !running {
        let server = bind(app.cfg.lan_port).ok_or("no free port for the LAN listener")?;
        let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
        let server = Arc::new(server);
        let stop = Arc::new(AtomicBool::new(false));
        let workers = (0..LAN_WORKERS)
            .map(|_| {
                let (app, server, stop) = (app.clone(), server.clone(), stop.clone());
                thread::spawn(move || http::serve(&app, &server, Via::Lan, &stop))
            })
            .collect();
        app.log
            .line(&format!("LAN listener open on 0.0.0.0:{port}"));
        *app.lan.lock().map_err(|_| "lock")? = Some(LanListener {
            port,
            server,
            stop,
            workers,
        });
    } else if !wanted && running {
        close(app);
    }
    Ok(())
}

pub fn close(app: &App) {
    let taken = app.lan.lock().ok().and_then(|mut l| l.take());
    if let Some(l) = taken {
        l.stop.store(true, Ordering::SeqCst);
        for w in l.workers {
            let _ = w.join();
        }
        let port = l.port;
        drop(l.server);
        // tiny_http wakes its accept thread by connecting to the listen address, which fails for
        // 0.0.0.0 on Windows: connect on loopback instead.
        http::unblock_accept(SocketAddr::from(([127, 0, 0, 1], port)));
        app.log.line(&format!("LAN listener on port {port} closed"));
    }
}

fn host_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "commander".into())
}

/// Every 3 seconds, one broadcast per war open to LAN.
pub fn discovery_loop(app: &Arc<App>) {
    let socket = UdpSocket::bind(("0.0.0.0", 0)).ok();
    if let Some(s) = &socket {
        let _ = s.set_broadcast(true);
    }
    let host = host_name();
    let target = SocketAddr::from(([255, 255, 255, 255], app.cfg.discovery_port));
    let mut waited = 3.0;
    while !app.stop.load(Ordering::SeqCst) {
        if waited >= 3.0 {
            waited = 0.0;
            if let (Some(sock), Some(port)) = (&socket, app.lan_port()) {
                let now = crate::now_unix();
                let packets: Vec<Vec<u8>> = app
                    .wars()
                    .values()
                    .filter(|s| s.lan_open)
                    .map(|s| {
                        let w = &s.war;
                        serde_json::to_vec(&json!({"commander": 1, "war": w.id, "name": w.name, "model": w.model,
                            "season": w.season, "port": port, "host": host, "players": w.recent_players(now),
                            "version": VERSION}))
                        .unwrap_or_default()
                    })
                    .collect();
                for p in packets {
                    let _ = sock.send_to(&p, target);
                }
            }
        }
        thread::sleep(Duration::from_millis(250));
        waited += 0.25;
    }
}
