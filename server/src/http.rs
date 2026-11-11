//! Requests in, answers out: the router shared by the loopback and LAN listeners, and static files.

use crate::{App, admin, game, now_unix};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::Read;
use std::net::{IpAddr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub const MAX_BODY: u64 = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Via {
    Loopback,
    /// The network listener, from an address of the local network.
    Lan,
    /// The network listener, from any other address: only wars open to the internet answer.
    Internet,
}

pub struct Req {
    pub method: String,
    pub path: String,
    pub query: HashMap<String, String>,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Req {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

pub struct Resp {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
    pub headers: Vec<(&'static str, String)>,
}

impl Resp {
    pub fn json(status: u16, v: &Value) -> Resp {
        Resp {
            status,
            content_type: "application/json",
            body: serde_json::to_vec(v).unwrap_or_default(),
            headers: vec![("Cache-Control", "no-store".into())],
        }
    }
    pub fn error(status: u16, msg: &str) -> Resp {
        Resp::json(status, &json!({"error": msg}))
    }
    pub fn not_found() -> Resp {
        Resp::error(404, "not found")
    }
}

/// Wakes a tiny_http accept thread after the server was dropped.
pub fn unblock_accept(addr: SocketAddr) {
    if let Ok(s) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) {
        let _ = s.shutdown(std::net::Shutdown::Both);
    }
}

pub fn serve(app: &Arc<App>, server: &tiny_http::Server, via: Via, stop: &AtomicBool) {
    while !stop.load(Ordering::SeqCst) {
        match server.recv_timeout(Duration::from_millis(250)) {
            Ok(Some(req)) => handle(app, req, via),
            Ok(None) => {}
            Err(_) => break,
        }
    }
}

fn split_url(url: &str) -> (String, HashMap<String, String>) {
    let (path, query) = url.split_once('?').unwrap_or((url, ""));
    let query = form_urlencoded::parse(query.as_bytes())
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    (path.to_string(), query)
}

/// Whether the LAN listener answers `ip`: loopback, the private and link-local ranges, and the
/// ranges VPN tools hand out (100.64.0.0/10, 25.0.0.0/8). An address from the open internet gets
/// nothing, so a forwarded port or a public network does not expose a war.
pub fn lan_source_ok(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || (o[0] == 100 && (64..128).contains(&o[1]))
                || o[0] == 25
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return lan_source_ok(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            v6.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
    }
}

/// Whether a `Host` header names this server the way a local caller does: an address, a name
/// without dots, or a `.local` name. A page from a public site that was pointed at this server by
/// DNS carries the site name, and is refused.
pub fn host_ok(host: Option<&str>) -> bool {
    let Some(host) = host.map(str::trim).filter(|h| !h.is_empty()) else {
        return true;
    };
    if host.starts_with('[') {
        return host
            .split_once(']')
            .is_some_and(|(a, _)| a[1..].parse::<IpAddr>().is_ok());
    }
    let name = host
        .rsplit_once(':')
        .filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit()))
        .map_or(host, |(n, _)| n);
    let name = name.to_ascii_lowercase();
    name.parse::<IpAddr>().is_ok() || !name.contains('.') || name.ends_with(".local")
}

fn refuse(raw: tiny_http::Request, status: u16, msg: &str) {
    let body = serde_json::to_vec(&json!({"error": msg})).unwrap_or_default();
    let _ = raw.respond(tiny_http::Response::from_data(body).with_status_code(status));
}

fn handle(app: &Arc<App>, mut raw: tiny_http::Request, via: Via) {
    let mut via = via;
    if via == Via::Lan
        && !app.cfg.lan_any_source
        && !raw.remote_addr().is_some_and(|a| lan_source_ok(a.ip()))
    {
        // From outside the local network: only while some war is open to the internet.
        if !app.wars().values().any(|s| s.reachable(Via::Internet)) {
            return refuse(raw, 403, "local network only");
        }
        via = Via::Internet;
    }
    let host = raw
        .headers()
        .iter()
        .find(|h| h.field.equiv("Host"))
        .map(|h| h.value.as_str().to_string());
    if !host_ok(host.as_deref()) {
        return refuse(raw, 403, "unknown host name");
    }
    let (path, query) = split_url(raw.url());
    let headers = raw
        .headers()
        .iter()
        .map(|h| {
            (
                h.field.as_str().as_str().to_string(),
                h.value.as_str().to_string(),
            )
        })
        .collect();
    let mut body = Vec::new();
    let too_big = raw
        .as_reader()
        .take(MAX_BODY + 1)
        .read_to_end(&mut body)
        .is_err()
        || body.len() as u64 > MAX_BODY;
    let req = Req {
        method: raw.method().as_str().to_ascii_uppercase(),
        path,
        query,
        headers,
        body,
    };
    let resp = if too_big {
        Resp::error(413, "request too large")
    } else {
        route(app, &req, via)
    };
    let mut r = tiny_http::Response::from_data(resp.body).with_status_code(resp.status);
    if let Ok(h) = tiny_http::Header::from_bytes("Content-Type", resp.content_type) {
        r.add_header(h);
    }
    for (k, v) in resp.headers {
        if let Ok(h) = tiny_http::Header::from_bytes(k, v.as_bytes()) {
            r.add_header(h);
        }
    }
    let _ = raw.respond(r);
}

pub fn route(app: &Arc<App>, req: &Req, via: Via) -> Resp {
    if let Some(rest) = req.path.strip_prefix("/w/") {
        return game_route(app, req, via, rest);
    }
    if req.path == "/api" || req.path.starts_with("/api/") {
        return admin::route(app, req, via);
    }
    if req.method == "GET" || req.method == "HEAD" {
        return static_route(app, req, via);
    }
    Resp::not_found()
}

fn clean_player(raw: Option<&str>) -> String {
    raw.map(str::trim)
        .filter(|p| {
            !p.is_empty()
                && p.len() <= 64
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        })
        .map(str::to_string)
        .unwrap_or_else(|| "local".into())
}

/// `/w/<id>/1.0/`, and `/w/<id>/evolved/...` for the Evolved War Engine mod.
fn game_route(app: &Arc<App>, req: &Req, via: Via, rest: &str) -> Resp {
    let rest = rest.trim_end_matches('/');
    if let Some((id, tail)) = rest.split_once('/')
        && let Some(what) = tail.strip_prefix("evolved")
    {
        return evolved_route(app, req, via, id, what.trim_start_matches('/'));
    }
    let Some((id, "1.0")) = rest.split_once('/') else {
        return Resp::not_found();
    };
    if req.method != "POST" {
        return Resp::error(405, "POST only");
    }
    let now = now_unix();
    let fields = game::parse_form(&req.body);
    let player = clean_player(req.header("X-Commander-Player"));
    let name = req
        .header("X-Commander-Name")
        .map(|n| percent_decode(n).unwrap_or_else(|| n.to_string()));
    let mut wars = app.wars();
    let Some(slot) = wars.get_mut(id) else {
        return Resp::not_found();
    };
    if !slot.reachable(via) {
        return Resp::not_found();
    }
    if !slot.war.has_room(&player) {
        return Resp::error(403, "this war has no room for more players");
    }
    let (answer, out) = game::handle(slot, &fields, &player, name.as_deref(), now);
    let action = fields.get("action").map(String::as_str).unwrap_or("");
    if !action.starts_with("get_") {
        app.log.line(&format!(
            "war {id}: {action} from {player} -> error_code {}",
            answer["error_code"]
        ));
    }
    app.commit(slot, out, now);
    Resp::json(200, &answer)
}

/// The Evolved War Engine mod reaches these through the Obsidian relay: `GET state` (the war as
/// the mod draws it), `POST report` (a mission result, JSON) and `GET galaxy` (the map data).
fn evolved_route(app: &Arc<App>, req: &Req, via: Via, id: &str, what: &str) -> Resp {
    let now = now_unix();
    let mut wars = app.wars();
    let Some(slot) = wars.get_mut(id) else {
        return Resp::not_found();
    };
    if !slot.reachable(via) {
        return Resp::not_found();
    }
    if !slot.war.is_evolved() {
        return Resp::error(404, "not an Evolved war");
    }
    match (req.method.as_str(), what) {
        ("GET", "galaxy") => Resp {
            status: 200,
            content_type: "application/json",
            body: crate::evolved::GALAXY_JSON.as_bytes().to_vec(),
            headers: vec![("Cache-Control", "max-age=3600".into())],
        },
        ("GET", "state") => {
            let w = &slot.war;
            let Some(e) = w.evolved.as_ref() else {
                return Resp::not_found();
            };
            let mut v = e.view(w.war_time, w.speed);
            v["war"] = json!({"id": w.id, "name": w.name, "season": w.shown_season(), "state": w.state.as_str(),
                              "war_time": w.war_time, "speed": w.speed, "server_time": now});
            Resp::json(200, &v)
        }
        ("POST", "report") => {
            let report: crate::evolved::Report = match serde_json::from_slice(&req.body) {
                Ok(r) => r,
                Err(e) => return Resp::error(400, &format!("bad report: {e}")),
            };
            let player = clean_player(req.header("X-Commander-Player"));
            if !slot.war.has_room(&player) {
                return Resp::error(403, "this war has no room for more players");
            }
            let name = req
                .header("X-Commander-Name")
                .map(|n| percent_decode(n).unwrap_or_else(|| n.to_string()));
            let mut out = crate::rules::Out::default();
            let war_time = slot.war.war_time;
            let answer = {
                let mut dice = app.dice.lock().unwrap_or_else(|e| e.into_inner());
                let Some(e) = slot.war.evolved.as_mut() else {
                    return Resp::not_found();
                };
                e.report(&player, &report, war_time, now, &mut *dice, &mut out)
            };
            slot.war
                .touch_member(&player, name.as_deref(), now, &mut out);
            app.log.line(&format!(
                "war {id}: evolved report from {player} campaign {} operation {} mission {} success {} -> {}",
                report.campaign, report.operation, report.mission, report.success, answer
            ));
            app.commit(slot, out, now);
            Resp::json(200, &answer)
        }
        _ => Resp::not_found(),
    }
}

// ---------------------------------------------------------------- static files

pub fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

pub fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("wasm") => "application/wasm",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// The file under `root` that a URL path names, refusing anything that climbs out.
fn safe_join(root: &Path, url_path: &str) -> Option<PathBuf> {
    let decoded = percent_decode(url_path)?;
    let mut p = root.to_path_buf();
    for seg in decoded.split('/').filter(|s| !s.is_empty()) {
        if seg == "." || seg == ".." || seg.contains(['\\', ':', '\0']) {
            return None;
        }
        p.push(seg);
    }
    Some(p)
}

fn file_resp(path: &Path) -> Option<Resp> {
    if !path.is_file() {
        return None;
    }
    let body = std::fs::read(path).ok()?;
    let html = path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("html"));
    Some(Resp {
        status: 200,
        content_type: content_type(path),
        body,
        headers: if html {
            vec![("Cache-Control", "no-cache".into())]
        } else {
            vec![]
        },
    })
}

fn static_route(app: &App, req: &Req, via: Via) -> Resp {
    let root = &app.cfg.ui;
    let index = || {
        file_resp(&root.join("index.html"))
            .unwrap_or_else(|| Resp::error(404, "the interface folder has no index.html"))
    };
    let path = req.path.as_str();
    if path == "/" || path == "/index.html" {
        return index();
    }
    let is_asset = path.starts_with("/assets/");
    if via != Via::Loopback && !is_asset {
        return Resp::not_found();
    }
    let Some(file) = safe_join(root, path) else {
        return Resp::not_found();
    };
    if let Some(r) = file_resp(&file) {
        return r;
    }
    // SPA fallback: routes without a file extension get the interface.
    let last = path.rsplit('/').next().unwrap_or("");
    if !is_asset && !last.contains('.') {
        return index();
    }
    Resp::not_found()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lan_listener_answers_local_addresses_only() {
        for ok in [
            "127.0.0.1",
            "192.168.0.7",
            "10.1.2.3",
            "172.16.0.9",
            "172.31.255.1",
            "169.254.10.10",
            "100.64.0.1",
            "100.127.255.254",
            "25.1.2.3",
            "::1",
            "fd12:3456::1",
            "fe80::1",
            "::ffff:192.168.1.5",
        ] {
            assert!(lan_source_ok(ok.parse().unwrap()), "{ok}");
        }
        for no in [
            "8.8.8.8",
            "172.32.0.1",
            "100.128.0.1",
            "192.169.0.1",
            "2001:4860::1",
            "::ffff:8.8.8.8",
        ] {
            assert!(!lan_source_ok(no.parse().unwrap()), "{no}");
        }
    }

    #[test]
    fn a_host_header_from_a_public_site_is_refused() {
        for ok in [
            None,
            Some(""),
            Some("127.0.0.1:17494"),
            Some("192.168.0.7"),
            Some("localhost:5173"),
            Some("DESK"),
            Some("desk.local:17494"),
            Some("[::1]:17494"),
            Some("[fe80::1]"),
        ] {
            assert!(host_ok(ok), "{ok:?}");
        }
        for no in [
            Some("example.com"),
            Some("rebind.example.com:17494"),
            Some("192.168.0.7.example.com"),
            Some("[not an address]:80"),
        ] {
            assert!(!host_ok(no), "{no:?}");
        }
    }
}
