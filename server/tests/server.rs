//! Starts the server on port 0 and drives it with real HTTP, shaped like docs/protocol.md's samples.

use commander::{Config, Handle};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

const TOKEN: &str = "test-token-123";
const PLAYER: &str = "110000100000001";

fn temp_dir(tag: &str) -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    let d = std::env::temp_dir().join(format!(
        "commander-test-{tag}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn start(data: &Path, ui: &Path) -> Handle {
    let mut cfg = Config::new(data.to_path_buf(), 0, TOKEN.into(), ui.to_path_buf());
    cfg.lan_port = 0;
    cfg.discovery_port = 0;
    cfg.tick_seconds = 0.0;
    commander::start(cfg).expect("server starts")
}

struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|e| panic!("not JSON ({e}): {}", String::from_utf8_lossy(&self.body)))
    }
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

fn http(port: u16, method: &str, path: &str, headers: &[(&str, &str)], body: &[u8]) -> Reply {
    let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    s.write_all(head.as_bytes()).unwrap();
    s.write_all(body).unwrap();
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).unwrap();
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("header end");
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let mut lines = head.lines();
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect();
    Reply {
        status,
        headers,
        body: raw[split + 4..].to_vec(),
    }
}

fn admin(port: u16, method: &str, path: &str, body: Option<Value>) -> Reply {
    let b = body.map(|v| v.to_string()).unwrap_or_default();
    http(
        port,
        method,
        path,
        &[
            ("X-Commander-Token", TOKEN),
            ("Content-Type", "application/json"),
        ],
        b.as_bytes(),
    )
}

/// A game request: form-encoded, the way the relay forwards it.
fn game(port: u16, war: &str, player: Option<&str>, fields: &[(&str, &str)]) -> Value {
    let body = form_urlencoded::Serializer::new(String::new())
        .extend_pairs(fields)
        .finish();
    let mut headers = vec![(
        "Content-Type",
        "application/x-www-form-urlencoded;charset=UTF-8",
    )];
    if let Some(p) = player {
        headers.push(("X-Commander-Player", p));
    }
    let r = http(
        port,
        "POST",
        &format!("/w/{war}/1.0/"),
        &headers,
        body.as_bytes(),
    );
    assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
    r.json()
}

fn auth() -> String {
    json!({"online_id": PLAYER, "issuer_id": 256, "platform": "steam"}).to_string()
}

fn create_war(port: u16, settings: Value) -> Value {
    let r = admin(
        port,
        "POST",
        "/api/wars",
        Some(json!({"name": "Test War", "model": "vanilla", "settings": settings})),
    );
    assert_eq!(r.status, 201, "{}", String::from_utf8_lossy(&r.body));
    r.json()
}

#[test]
fn game_api_answers_like_the_official_server() {
    let (data, ui) = (temp_dir("game"), temp_dir("game-ui"));
    let h = start(&data, &ui);
    let war = create_war(h.port, json!({"director": false}));
    let id = war["id"].as_str().unwrap().to_string();
    let season = war["season"].as_i64().unwrap();

    // get_campaign_status: the full shape.
    let s = game(
        h.port,
        &id,
        Some(PLAYER),
        &[("action", "get_campaign_status")],
    );
    assert_eq!(s["error_code"], 0);
    assert!(s["time"].is_i64());
    let rows = s["campaign_status"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    for (i, r) in rows.iter().enumerate() {
        for k in [
            "season",
            "points",
            "points_taken",
            "points_max",
            "status",
            "introduction_order",
        ] {
            assert!(r.get(k).is_some(), "row {i} misses {k}");
        }
        assert_eq!(r["season"], season);
        assert_eq!(r["points"], 15000);
        assert_eq!(r["status"], "active");
    }
    assert_eq!(s["attack_events"], json!([]));
    assert_eq!(s["statistics"].as_array().unwrap().len(), 3);
    assert!(s.get("defend_event").is_none());

    // complete_planets: the planet's `enemy` is 1-based, so 2 is the cyborgs (front 1).
    let planets = json!([{"index": 1, "enemy": 2, "season": season, "difficulty": 4, "success": 0.700004995}]).to_string();
    let a = auth();
    let r = game(
        h.port,
        &id,
        Some(PLAYER),
        &[
            ("action", "complete_planets"),
            ("auth", &a),
            ("planets", &planets),
        ],
    );
    assert_eq!(r["error_code"], 0);
    assert_eq!(r["completed_planets"], 1);
    // 4 * 0.700004995 * 250 = 700
    assert_eq!(r["campaign_status"][1]["points"], 15700);
    assert_eq!(r["campaign_status"][0]["points"], 15000);
    // The same index again counts once.
    let r = game(
        h.port,
        &id,
        Some(PLAYER),
        &[
            ("action", "complete_planets"),
            ("auth", &a),
            ("planets", &planets),
        ],
    );
    assert_eq!(r["completed_planets"], 1);
    assert_eq!(r["campaign_status"][1]["points"], 15700);
    // Another player with the same index counts.
    let r = game(
        h.port,
        &id,
        Some("110000100000abc"),
        &[
            ("action", "complete_planets"),
            ("auth", &a),
            ("planets", &planets),
        ],
    );
    assert_eq!(r["campaign_status"][1]["points"], 16400);

    // upload_statistics acks the highest index and counts once.
    let stats = json!([{"index": 4, "enemy": 1, "season": season, "missions": 1, "successful_missions": 1,
                        "mission_difficulty": 1, "players": 1, "kills": 12, "deaths": 0, "shots": 0, "hits": 0, "accidentals": 0}])
    .to_string();
    for _ in 0..2 {
        let r = game(
            h.port,
            &id,
            Some(PLAYER),
            &[
                ("action", "upload_statistics"),
                ("auth", &a),
                ("statistics", &stats),
            ],
        );
        assert_eq!(r["uploaded_statistics"], 4);
    }
    let s = game(
        h.port,
        &id,
        Some(PLAYER),
        &[("action", "get_campaign_status")],
    );
    assert_eq!(s["statistics"][1]["missions"], 1);
    assert_eq!(s["statistics"][1]["kills"], 12);
    assert_eq!(s["statistics"][1]["completed_planets"], 2);

    // The tamper report form: ack only.
    let r = game(
        h.port,
        &id,
        Some(PLAYER),
        &[
            ("action", "upload_statistics"),
            ("auth", &a),
            ("c", "12345"),
        ],
    );
    assert_eq!(r["error_code"], 0);
    assert!(r.get("uploaded_statistics").is_none());

    let lb = json!([{"index": 2, "enemy": 1, "season": season, "planets": 1, "score": 1, "player_xp": 105, "playtime": 19}]).to_string();
    let r = game(
        h.port,
        &id,
        Some(PLAYER),
        &[
            ("action", "upload_leaderboard_statistics"),
            ("auth", &a),
            ("statistics", &lb),
        ],
    );
    assert_eq!(r["uploaded_leaderboard_statistics"], 2);
    let r = game(
        h.port,
        &id,
        Some(PLAYER),
        &[
            ("action", "upload_leaderboard_provinggrounds_statistics"),
            ("auth", &a),
            ("statistics", &lb),
        ],
    );
    assert_eq!(r["uploaded_leaderboard_provinggrounds_statistics"], 2);

    // A defense, started by the GM, then a defend mission.
    let r = admin(
        h.port,
        "POST",
        &format!("/api/wars/{id}/actions"),
        Some(json!({"action": "start_defend", "front": 0, "region": 2})),
    );
    assert_eq!(r.status, 200);
    let event_id = r.json()["defend_event"]["event_id"].as_u64().unwrap();
    let r = game(
        h.port,
        &id,
        Some(PLAYER),
        &[
            ("action", "complete_defend_mission"),
            ("event_id", &event_id.to_string()),
            ("difficulty", "3"),
            ("auth", &a),
        ],
    );
    assert_eq!(r["error_code"], 0);
    assert_eq!(r["defend_event"]["event_id"], event_id);
    assert_eq!(r["defend_event"]["points"], 450);
    assert_eq!(r["defend_event"]["status"], "active");
    assert_eq!(r["campaign_status"].as_array().unwrap().len(), 3);
    let r = game(
        h.port,
        &id,
        Some(PLAYER),
        &[
            ("action", "get_defend_event_by_id"),
            ("event_id", &event_id.to_string()),
        ],
    );
    assert_eq!(r["defend_event"]["points_max"], 3000);

    // Snapshots: `data` is a JSON string of three rows.
    let r = game(
        h.port,
        &id,
        Some(PLAYER),
        &[("action", "get_snapshots"), ("season", &season.to_string())],
    );
    assert_eq!(r["introduction_order"], json!([0, 1, 2]));
    assert_eq!(r["points_max"], json!([100000, 100000, 100000]));
    let snaps = r["snapshots"].as_array().unwrap();
    assert!(!snaps.is_empty());
    let first: Value =
        serde_json::from_str(snaps[0]["data"].as_str().expect("data is a string")).unwrap();
    assert_eq!(first.as_array().unwrap().len(), 3);
    assert_eq!(r["defend_events"].as_array().unwrap().len(), 1);
    let r = game(
        h.port,
        &id,
        Some(PLAYER),
        &[
            ("action", "get_snapshots"),
            ("season", &season.to_string()),
            ("start", "1"),
            ("end", "2"),
        ],
    );
    assert_eq!(r["snapshots"], json!([]));

    // The read actions with no real data still answer.
    let r = game(h.port, &id, None, &[("action", "get_provinggrounds")]);
    assert_eq!(r["trials"].as_array().unwrap().len(), 3);
    assert!(r["trials"][0]["trial_seed"].is_u64());
    assert_eq!(
        game(
            h.port,
            &id,
            None,
            &[("action", "get_leaderboards"), ("count", "10")]
        )["leaderboards"],
        json!([])
    );
    assert_eq!(
        game(
            h.port,
            &id,
            None,
            &[("action", "get_top_of_leaderboard_provinggrounds")]
        )["experts"],
        json!([])
    );
    assert_eq!(
        game(
            h.port,
            &id,
            None,
            &[("action", "get_available_entitlements")]
        )["entitlements"],
        json!([])
    );
    let r = game(
        h.port,
        &id,
        None,
        &[
            ("action", "get_season_statistics"),
            ("season", &season.to_string()),
        ],
    );
    assert_eq!(r["statistics"].as_array().unwrap().len(), 3);
    let r = game(
        h.port,
        &id,
        None,
        &[("action", "get_usernames"), ("count", "10")],
    );
    let names = r["usernames"].as_array().unwrap();
    assert!(names.contains(&json!(PLAYER)));
    assert!(!names.contains(&json!("local")));

    // Unknown actions answer error 3.
    let r = game(h.port, &id, None, &[("action", "no_such_thing")]);
    assert_eq!(r["error_code"], 3);
    assert_eq!(r["error_message"], "Missing or invalid arguments");

    // A request with no player header shows up as "local".
    let w = admin(h.port, "GET", &format!("/api/wars/{id}"), None).json();
    let members: Vec<&str> = w["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["player"].as_str().unwrap())
        .collect();
    assert!(!members.contains(&"local") && members.contains(&PLAYER), "only identified players are members");

    // An unknown war is a 404.
    let r = http(
        h.port,
        "POST",
        "/w/nowar1/1.0/",
        &[],
        b"action=get_campaign_status",
    );
    assert_eq!(r.status, 404);
    h.shutdown();
}

#[test]
fn attack_mission_through_the_game_api() {
    let (data, ui) = (temp_dir("attack"), temp_dir("attack-ui"));
    let h = start(&data, &ui);
    let id = create_war(h.port, json!({"director": false, "attack_points": 300}))["id"]
        .as_str()
        .unwrap()
        .to_string();
    let r = admin(
        h.port,
        "POST",
        &format!("/api/wars/{id}/actions"),
        Some(json!({"action": "set_points", "front": 2, "points": 100000})),
    );
    let w = r.json();
    let attack = &w["attack_events"][0];
    assert_eq!(attack["region"], 11);
    assert_eq!(attack["max_event_id"], attack["event_id"]);
    let eid = attack["event_id"].as_u64().unwrap().to_string();
    let r = game(
        h.port,
        &id,
        Some(PLAYER),
        &[
            ("action", "complete_attack_mission"),
            ("event_id", &eid),
            ("difficulty", "2"),
        ],
    );
    assert_eq!(r["attack_events"][0]["status"], "success");
    assert_eq!(r["campaign_status"][2]["status"], "defeated");
    h.shutdown();
}

#[test]
fn admin_api_token_settings_actions_feed() {
    let (data, ui) = (temp_dir("admin"), temp_dir("admin-ui"));
    let h = start(&data, &ui);
    let p = h.port;

    assert_eq!(http(p, "GET", "/api/info", &[], b"").status, 401);
    assert_eq!(
        http(
            p,
            "GET",
            "/api/info",
            &[("X-Commander-Token", "wrong")],
            b""
        )
        .status,
        401
    );
    let r = http(p, "GET", &format!("/api/info?token={TOKEN}"), &[], b"");
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["protocol"], 1);

    let war = create_war(p, json!({}));
    let id = war["id"].as_str().unwrap().to_string();
    assert_eq!(war["state"], "running");
    assert_eq!(war["fronts"][0]["region"], 2);
    assert_eq!(war["settings"]["points_max"], 100000);
    assert_eq!(war["lan"], json!({"open": false, "port": null}));
    assert_eq!(
        admin(p, "GET", "/api/info", None).json()["wars"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    // Settings: nonsense is refused with a message; good values stick.
    for bad in [
        json!({"settings": {"points_max": -5}}),
        json!({"settings": {"speed": 2}}),
        json!({"settings": {"defend_duration": "long"}}),
        json!({"colour": "red"}),
    ] {
        let r = admin(p, "PATCH", &format!("/api/wars/{id}"), Some(bad.clone()));
        assert_eq!(r.status, 400, "{bad}");
        assert!(r.json()["error"].as_str().unwrap().len() > 3);
    }
    let r = admin(
        p,
        "PATCH",
        &format!("/api/wars/{id}"),
        Some(json!({"name": "Renamed", "settings": {"planet_value": 400, "director": false}})),
    );
    assert_eq!(r.status, 200);
    let w = r.json();
    assert_eq!(w["name"], "Renamed");
    assert_eq!(w["settings"]["planet_value"], 400.0);

    let act = |body: Value| admin(p, "POST", &format!("/api/wars/{id}/actions"), Some(body));
    assert_eq!(
        act(json!({"action": "push", "front": 1, "regions": 3})).json()["fronts"][1]["region"],
        5
    );
    assert_eq!(
        act(json!({"action": "set_points", "front": 0, "points": 55555})).json()["fronts"][0]["points"],
        55555
    );
    assert_eq!(
        act(json!({"action": "set_points", "front": 7, "points": 1})).status,
        400
    );
    assert_eq!(act(json!({"action": "set_speed", "speed": 50})).status, 400);
    assert_eq!(
        act(json!({"action": "set_speed", "speed": 2})).json()["speed"],
        2.0
    );
    assert_eq!(act(json!({"action": "pause"})).json()["state"], "paused");
    assert_eq!(act(json!({"action": "pause"})).status, 400);
    assert_eq!(act(json!({"action": "resume"})).json()["state"], "running");
    assert_eq!(
        act(json!({"action": "set_status", "front": 2, "status": "hidden"})).json()["fronts"][2]["status"],
        "hidden"
    );
    let w = act(json!({"action": "start_defend", "front": 1, "region": 0, "duration": 600, "points_max": 100})).json();
    let eid = w["defend_event"]["event_id"].as_u64().unwrap();
    assert_eq!(w["defend_event"]["region"], 0);
    assert_eq!(
        act(json!({"action": "start_defend", "front": 0, "region": 3})).status,
        400
    );
    let w = act(json!({"action": "set_event", "event_id": eid, "points": 50})).json();
    assert_eq!(w["defend_event"]["points"], 50);
    let w = act(json!({"action": "end_event", "event_id": eid, "result": "success"})).json();
    assert!(w["defend_event"].is_null());
    assert_eq!(w["fronts"][1]["points"], 10000);
    let w = act(json!({"action": "start_attack", "front": 0, "duration": 600, "points_max": 100}))
        .json();
    assert_eq!(w["attack_events"][0]["status"], "active");
    assert_eq!(
        act(json!({"action": "end_season", "result": "won"})).json()["state"],
        "won"
    );
    let season = w["season"].as_i64().unwrap();
    let w = act(json!({"action": "new_season"})).json();
    assert_eq!(w["season"], season + 1);
    assert_eq!(w["state"], "running");
    assert_eq!(w["fronts"][0]["points"], 15000);
    assert_eq!(act(json!({"action": "dance"})).status, 400);

    // Feed: GM entries, newest last; `after` pages.
    let f = admin(p, "GET", &format!("/api/wars/{id}/feed?limit=500"), None).json();
    let entries = f["entries"].as_array().unwrap();
    assert!(
        entries
            .iter()
            .any(|e| e["text_key"] == "gm_push" && e["player"] == "gm")
    );
    assert!(entries.iter().any(|e| e["text_key"] == "region_liberated"));
    let ids: Vec<u64> = entries.iter().map(|e| e["id"].as_u64().unwrap()).collect();
    assert!(ids.windows(2).all(|w| w[0] < w[1]));
    let last = f["last_id"].as_u64().unwrap();
    let f2 = admin(
        p,
        "GET",
        &format!("/api/wars/{id}/feed?after={}", last - 2),
        None,
    )
    .json();
    assert_eq!(f2["entries"].as_array().unwrap().len(), 2);
    for k in [
        "id", "time", "war_time", "kind", "front", "region", "event_id", "player", "value",
        "text_key",
    ] {
        assert!(entries[0].get(k).is_some(), "feed entry misses {k}");
    }

    let hist = admin(p, "GET", &format!("/api/wars/{id}/history?from=0"), None).json();
    assert!(hist["snapshots"].as_array().unwrap().len() > 3);

    // Export, import as a new war, delete.
    let exp = admin(p, "GET", &format!("/api/wars/{id}/export"), None);
    assert!(
        exp.header("Content-Disposition")
            .unwrap()
            .contains("attachment")
    );
    let r = http(
        p,
        "POST",
        "/api/wars/import",
        &[("X-Commander-Token", TOKEN)],
        &exp.body,
    );
    assert_eq!(r.status, 201);
    let copy = r.json();
    assert_ne!(copy["id"], json!(id));
    assert_eq!(copy["name"], "Renamed");
    assert_eq!(copy["season"], season + 1);
    let copy_id = copy["id"].as_str().unwrap();
    assert!(data.join("wars").join(copy_id).join("war.json").is_file());
    assert_eq!(
        admin(p, "DELETE", &format!("/api/wars/{copy_id}"), None).status,
        200
    );
    assert!(!data.join("wars").join(copy_id).exists());
    assert_eq!(
        admin(p, "GET", &format!("/api/wars/{copy_id}"), None).status,
        404
    );
    assert_eq!(
        http(
            p,
            "POST",
            "/api/wars/import",
            &[("X-Commander-Token", TOKEN)],
            b"{\"war\": 5}"
        )
        .status,
        400
    );
    h.shutdown();
}

#[test]
fn wars_survive_a_restart_without_losing_or_gaining_time() {
    let (data, ui) = (temp_dir("restart"), temp_dir("restart-ui"));
    let h = start(&data, &ui);
    let id = create_war(h.port, json!({"director": false}))["id"]
        .as_str()
        .unwrap()
        .to_string();
    h.app.tick_by(30.0);
    h.app.tick_by(30.0);
    let before = admin(h.port, "GET", &format!("/api/wars/{id}"), None).json();
    assert!((before["war_time"].as_f64().unwrap() - 60.0).abs() < 1e-6);
    h.shutdown();

    std::thread::sleep(std::time::Duration::from_millis(1200));
    let h = start(&data, &ui);
    let after = admin(h.port, "GET", &format!("/api/wars/{id}"), None).json();
    assert_eq!(after["war_time"], before["war_time"]);
    assert_eq!(after["fronts"], before["fronts"]);
    assert_eq!(after["season"], before["season"]);
    // A long gap between ticks still counts at most 60 seconds.
    h.app.tick_by(3600.0);
    let later = admin(h.port, "GET", &format!("/api/wars/{id}"), None).json();
    assert!((later["war_time"].as_f64().unwrap() - 120.0).abs() < 1e-6);
    let feed = admin(h.port, "GET", &format!("/api/wars/{id}/feed"), None).json();
    assert!(!feed["entries"].as_array().unwrap().is_empty());
    h.shutdown();
}

#[test]
fn serves_the_interface_with_spa_fallback() {
    let (data, ui) = (temp_dir("ui"), temp_dir("ui-files"));
    std::fs::write(
        ui.join("index.html"),
        "<!doctype html><title>Commander</title>",
    )
    .unwrap();
    std::fs::create_dir_all(ui.join("assets")).unwrap();
    std::fs::write(ui.join("assets").join("app.js"), "console.log(1)").unwrap();
    std::fs::write(ui.join("assets").join("app.css"), "body{}").unwrap();
    std::fs::write(data.join("secret.txt"), "no").unwrap();
    let h = start(&data, &ui);
    let p = h.port;

    let r = http(p, "GET", "/?token=abc", &[], b"");
    assert_eq!(r.status, 200);
    assert!(r.header("Content-Type").unwrap().starts_with("text/html"));
    assert!(String::from_utf8_lossy(&r.body).contains("Commander"));
    let r = http(p, "GET", "/assets/app.js", &[], b"");
    assert!(
        r.header("Content-Type")
            .unwrap()
            .starts_with("text/javascript")
    );
    let r = http(p, "GET", "/assets/app.css", &[], b"");
    assert!(r.header("Content-Type").unwrap().starts_with("text/css"));
    let r = http(p, "GET", "/wars/abc/settings", &[], b"");
    assert_eq!(r.status, 200);
    assert!(String::from_utf8_lossy(&r.body).contains("Commander"));
    assert_eq!(http(p, "GET", "/assets/missing.js", &[], b"").status, 404);
    assert_eq!(http(p, "GET", "/missing.png", &[], b"").status, 404);
    assert_eq!(http(p, "GET", "/../secret.txt", &[], b"").status, 404);
    assert_eq!(http(p, "GET", "/%2e%2e/secret.txt", &[], b"").status, 404);
    h.shutdown();
}

#[test]
fn lan_listener_serves_only_lan_wars_read_only() {
    let (data, ui) = (temp_dir("lan"), temp_dir("lan-ui"));
    std::fs::write(
        ui.join("index.html"),
        "<!doctype html><title>Commander</title>",
    )
    .unwrap();
    let h = start(&data, &ui);
    let open_war = create_war(h.port, json!({}))["id"]
        .as_str()
        .unwrap()
        .to_string();
    let closed_war = create_war(h.port, json!({}))["id"]
        .as_str()
        .unwrap()
        .to_string();

    let r = admin(
        h.port,
        "POST",
        &format!("/api/wars/{open_war}/lan"),
        Some(json!({"open": true})),
    );
    assert_eq!(r.status, 200);
    let lan = r.json()["port"].as_u64().expect("a LAN port") as u16;
    assert_eq!(
        admin(h.port, "GET", &format!("/api/wars/{open_war}"), None).json()["lan"],
        json!({"open": true, "port": lan})
    );

    // Read-only, no token, LAN wars only.
    let info = http(lan, "GET", "/api/info", &[], b"").json();
    let wars = info["wars"].as_array().unwrap();
    assert_eq!(wars.len(), 1);
    assert_eq!(wars[0]["id"], json!(open_war));
    assert_eq!(
        http(lan, "GET", &format!("/api/wars/{open_war}"), &[], b"").status,
        200
    );
    assert_eq!(
        http(lan, "GET", &format!("/api/wars/{open_war}/feed"), &[], b"").status,
        200
    );
    assert_eq!(
        http(
            lan,
            "GET",
            &format!("/api/wars/{open_war}/history"),
            &[],
            b""
        )
        .status,
        200
    );
    assert_eq!(
        http(lan, "GET", &format!("/api/wars/{closed_war}"), &[], b"").status,
        404
    );
    assert_eq!(
        http(
            lan,
            "GET",
            &format!("/api/wars/{open_war}/export"),
            &[("X-Commander-Token", TOKEN)],
            b""
        )
        .status,
        404
    );
    assert_eq!(
        http(
            lan,
            "POST",
            "/api/wars",
            &[("X-Commander-Token", TOKEN)],
            b"{}"
        )
        .status,
        404
    );
    assert_eq!(http(lan, "GET", "/", &[], b"").status, 200);
    assert_eq!(http(lan, "GET", "/some/route", &[], b"").status, 404);

    // The game API of the LAN war only.
    let r = game(
        lan,
        &open_war,
        Some(PLAYER),
        &[("action", "get_campaign_status")],
    );
    assert_eq!(r["error_code"], 0);
    let r = http(
        lan,
        "POST",
        &format!("/w/{closed_war}/1.0/"),
        &[],
        b"action=get_campaign_status",
    );
    assert_eq!(r.status, 404);

    // Closing the last LAN war closes the listener.
    let r = admin(
        h.port,
        "POST",
        &format!("/api/wars/{open_war}/lan"),
        Some(json!({"open": false})),
    );
    assert_eq!(r.json(), json!({"open": false, "port": null}));
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert!(
        TcpStream::connect(("127.0.0.1", lan)).is_err(),
        "LAN listener still open"
    );
    h.shutdown();
}
