//! Starts the server on port 0 and drives it with real HTTP, shaped like the samples in docs/protocol.md.

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
    start_with(data, ui, true)
}

/// `any_source`: every caller of the network listener counts as local. The tests reach that listener
/// from loopback, which otherwise counts as a caller from outside (a tunnel program on the PC).
fn start_with(data: &Path, ui: &Path, any_source: bool) -> Handle {
    let mut cfg = Config::new(data.to_path_buf(), 0, TOKEN.into(), ui.to_path_buf());
    cfg.lan_port = 0;
    // Loopback, so Windows shows no firewall prompt for the test program.
    cfg.lan_bind = std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST);
    cfg.lan_any_source = any_source;
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
    let season = war["game_season"].as_i64().unwrap();

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

    // complete_planets: the planet `enemy` value is 1-based, so 2 is the cyborgs (front 1).
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
    assert!(
        !members.contains(&"local") && members.contains(&PLAYER),
        "only identified players are members"
    );

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
    assert_eq!(
        war["lan"],
        json!({"open": false, "port": null, "internet": false})
    );
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

    // A new war starts at season 1; the game gets a separate season number.
    assert_eq!(w["season"], 1);
    assert!((1000..=9999).contains(&w["game_season"].as_i64().unwrap()));
    assert_eq!(w["description"], "");
    assert_eq!(w["logo"], "");

    // Description and logo: checked, kept, cleared.
    let logo = "data:image/png;base64,iVBORw0KGgo=";
    for bad in [
        json!({"description": 5}),
        json!({"description": "x".repeat(601)}),
        json!({"logo": "https://example.com/a.png"}),
        json!({"logo": "data:image/svg+xml;base64,PHN2Zz4="}),
        json!({"logo": "data:image/png;base64,<script>"}),
        json!({"logo": format!("data:image/png;base64,{}", "A".repeat(200_001))}),
    ] {
        let r = admin(p, "PATCH", &format!("/api/wars/{id}"), Some(bad.clone()));
        assert_eq!(r.status, 400, "{bad}");
    }
    let w = admin(
        p,
        "PATCH",
        &format!("/api/wars/{id}"),
        Some(json!({"description": "  The long night.  ", "logo": logo})),
    )
    .json();
    assert_eq!(w["description"], "The long night.");
    assert_eq!(w["logo"], logo);
    assert_eq!(w["name"], "Renamed", "fields left out stay");
    let listed = admin(p, "GET", "/api/info", None).json();
    assert_eq!(listed["wars"][0]["description"], "The long night.");
    assert_eq!(listed["wars"][0]["logo"], logo);
    assert_eq!(listed["wars"][0]["season"], 1);
    let w = admin(
        p,
        "PATCH",
        &format!("/api/wars/{id}"),
        Some(json!({"logo": null, "description": ""})),
    )
    .json();
    assert_eq!(w["logo"], "");
    assert_eq!(w["description"], "");

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
    let game_season = w["game_season"].as_i64().unwrap();
    let w = act(json!({"action": "new_season"})).json();
    assert_eq!(w["season"], season + 1);
    assert_eq!(w["game_season"], game_season + 1);
    assert_eq!(w["past_seasons"][0]["season"], 1);
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
        json!({"open": true, "port": lan, "internet": false})
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
    assert_eq!(
        r.json(),
        json!({"open": false, "port": null, "internet": false, "invite": null})
    );
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert!(
        TcpStream::connect(("127.0.0.1", lan)).is_err(),
        "LAN listener still open"
    );
    h.shutdown();
}

#[test]
fn evolved_war_through_the_mod_routes() {
    let (data, ui) = (temp_dir("evolved"), temp_dir("evolved-ui"));
    let h = start(&data, &ui);
    let r = admin(
        h.port,
        "POST",
        "/api/wars",
        Some(json!({"name": "Evolved Test", "model": "evolved", "evolved": {"campaigns": 2}})),
    );
    assert_eq!(r.status, 201, "{}", String::from_utf8_lossy(&r.body));
    let war = r.json();
    let id = war["id"].as_str().unwrap().to_string();
    assert_eq!(war["model"], "evolved");
    assert_eq!(war["evolved"]["settings"]["campaigns"], 2);

    // The state the mod reads.
    let s = http(h.port, "GET", &format!("/w/{id}/evolved/state"), &[], b"");
    assert_eq!(s.status, 200);
    let s = s.json();
    assert_eq!(s["owners"].as_array().unwrap().len(), 273);
    assert_eq!(s["war"]["id"], id.as_str());
    let campaigns = s["campaigns"].as_array().unwrap();
    assert_eq!(
        campaigns
            .iter()
            .filter(|c| c["kind"] == "liberation")
            .count(),
        2
    );
    let c = &campaigns[0];
    let op = &c["operations"][0];

    // A won mission counts once per lobby.
    let report = json!({"campaign": c["id"], "operation": op["id"], "mission": 0, "success": true,
                        "lobby": "109775241000000001", "kills": 120, "deaths": 2});
    let body = report.to_string();
    let a = http(
        h.port,
        "POST",
        &format!("/w/{id}/evolved/report"),
        &[
            ("Content-Type", "application/json"),
            ("X-Commander-Player", PLAYER),
        ],
        body.as_bytes(),
    )
    .json();
    assert_eq!(a["credited"], true, "{a}");
    assert!(a["liberation"].as_f64().unwrap() > 0.0);
    let again = http(
        h.port,
        "POST",
        &format!("/w/{id}/evolved/report"),
        &[
            ("Content-Type", "application/json"),
            ("X-Commander-Player", PLAYER),
        ],
        body.as_bytes(),
    )
    .json();
    assert_eq!(again["credited"], false);
    let bad = http(
        h.port,
        "POST",
        &format!("/w/{id}/evolved/report"),
        &[],
        b"{\"campaign\": 1}",
    );
    assert_eq!(bad.status, 400);

    // The game polls still answer, and the stock uploads move nothing in an Evolved war.
    let st = game(
        h.port,
        &id,
        Some(PLAYER),
        &[("action", "get_campaign_status")],
    );
    assert_eq!(st["error_code"], 0);

    // The GM: a dispatch, a defense, an order.
    let r = admin(
        h.port,
        "POST",
        &format!("/api/wars/{id}/actions"),
        Some(json!({"action": "evo_news", "text": "Hold the line."})),
    );
    assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
    assert!(
        r.json()["evolved"]["news"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["text"] == "Hold the line.")
    );
    let r = admin(
        h.port,
        "POST",
        &format!("/api/wars/{id}/actions"),
        Some(
            json!({"action": "evo_campaign", "planet": 0, "kind": "defense", "faction": 2, "hours": 2}),
        ),
    );
    assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
    let r = admin(
        h.port,
        "POST",
        &format!("/api/wars/{id}/actions"),
        Some(json!({"action": "evo_order", "kind": "defend", "planets": [0], "hours": 5})),
    );
    assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
    let r = admin(
        h.port,
        "POST",
        &format!("/api/wars/{id}/actions"),
        Some(json!({"action": "evo_planet", "planet": 9999, "owner": 1})),
    );
    assert_eq!(r.status, 400);

    // A Vanilla war has no Evolved routes.
    let v = admin(h.port, "POST", "/api/wars", Some(json!({"name": "Plain"}))).json();
    let vid = v["id"].as_str().unwrap();
    assert_eq!(
        http(h.port, "GET", &format!("/w/{vid}/evolved/state"), &[], b"").status,
        404
    );

    // Saved and loaded back whole.
    h.shutdown();
    let h = start(&data, &ui);
    let s2 = http(h.port, "GET", &format!("/w/{id}/evolved/state"), &[], b"").json();
    assert_eq!(s2["owners"], s["owners"]);
    assert!(
        s2["campaigns"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["kind"] == "defense")
    );
    h.shutdown();
}

#[test]
fn a_request_named_for_a_public_site_gets_nothing() {
    let (data, ui) = (temp_dir("host"), temp_dir("host-ui"));
    std::fs::write(ui.join("index.html"), "<!doctype html>").unwrap();
    let h = start(&data, &ui);
    let ask = |host: &str| {
        let mut s = TcpStream::connect(("127.0.0.1", h.port)).expect("connect");
        write!(
            s,
            "GET /api/info?token={TOKEN} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        let mut raw = String::new();
        s.read_to_string(&mut raw).unwrap();
        raw.split(' ').nth(1).unwrap().parse::<u16>().unwrap()
    };
    assert_eq!(ask("rebind.example.com"), 403);
    assert_eq!(ask(&format!("127.0.0.1:{}", h.port)), 200);
    assert_eq!(ask("localhost"), 200);
    h.shutdown();
}

#[test]
fn a_tunnel_caller_counts_as_outside_and_a_tunnel_name_passes_with_the_invite() {
    use commander::http::{Via, network_via};
    let (data, ui) = (temp_dir("tunnel"), temp_dir("tunnel-ui"));
    std::fs::write(ui.join("index.html"), "<!doctype html>").unwrap();
    let h = start_with(&data, &ui, false);
    let war = create_war(h.port, json!({}))["id"]
        .as_str()
        .unwrap()
        .to_string();
    let lan = |body: Value| admin(h.port, "POST", &format!("/api/wars/{war}/lan"), Some(body));
    // A raw request to the network listener from loopback, as a tunnel program on the PC sends it.
    let ask = |method: &str, path: &str, host: &str, key: Option<&str>| {
        let port = h.app.lan_port().expect("the network listener is open");
        let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        let key = key
            .map(|k| format!("X-Commander-Key: {k}\r\n"))
            .unwrap_or_default();
        let body = if method == "POST" {
            "action=get_campaign_status"
        } else {
            ""
        };
        write!(
            s,
            "{method} {path} HTTP/1.1\r\nHost: {host}\r\n{key}X-Commander-Player: {PLAYER}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        let mut raw = String::new();
        s.read_to_string(&mut raw).unwrap();
        raw.split(' ').nth(1).unwrap().parse::<u16>().unwrap()
    };
    let game = format!("/w/{war}/1.0/");
    let view = format!("/api/wars/{war}");

    assert_eq!(
        network_via(&h.app, Some("127.0.0.1".parse().unwrap())),
        None,
        "nothing open to the internet yet"
    );
    assert_eq!(
        network_via(&h.app, Some("192.168.0.7".parse().unwrap())),
        Some(Via::Lan)
    );

    // Open to LAN alone: a loopback caller of the network listener is outside, and gets nothing.
    assert_eq!(lan(json!({"open": true})).status, 200);
    assert_eq!(ask("GET", &view, "127.0.0.1", None), 403);
    assert_eq!(ask("POST", &game, "127.0.0.1", None), 403);

    // Open to the internet: the code is needed, by address or by tunnel name.
    let code = lan(json!({"open": true, "internet": true})).json()["invite"]
        .as_str()
        .expect("an invite code")
        .to_string();
    assert_eq!(
        network_via(&h.app, Some("127.0.0.1".parse().unwrap())),
        Some(Via::Internet)
    );
    assert_eq!(ask("GET", &view, "127.0.0.1", None), 404);
    assert_eq!(ask("GET", &view, "127.0.0.1", Some(&code)), 200);
    let tunnel = "abc.at.example-tunnel.gg:12345";
    assert_eq!(ask("POST", &game, tunnel, Some(&code)), 200);
    assert_eq!(ask("GET", &view, tunnel, Some(&code)), 200);
    assert_eq!(
        ask("POST", &game, tunnel, None),
        403,
        "a public name without the code"
    );
    assert_eq!(ask("POST", &game, tunnel, Some("AAAAA-AAAAA")), 403);
    // The interface files hold nothing of a war and load by the tunnel name too.
    assert_eq!(ask("GET", "/", tunnel, None), 200);
    assert_eq!(ask("GET", "/assets/none.js", tunnel, None), 404);
    // The admin listener stays strict about names, code or not.
    let mut s = TcpStream::connect(("127.0.0.1", h.port)).expect("connect");
    write!(
        s,
        "GET /api/info?token={TOKEN} HTTP/1.1\r\nHost: {tunnel}\r\nX-Commander-Key: {code}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut raw = String::new();
    s.read_to_string(&mut raw).unwrap();
    assert_eq!(raw.split(' ').nth(1), Some("403"));

    // A new code shuts the old one out on the tunnel name as well.
    assert_eq!(
        lan(json!({"open": true, "internet": true, "new_invite": true})).status,
        200
    );
    assert_eq!(ask("POST", &game, tunnel, Some(&code)), 403);
    lan(json!({"open": false}));
    h.shutdown();
}

#[test]
fn a_full_war_takes_no_new_players() {
    let (data, ui) = (temp_dir("room"), temp_dir("room-ui"));
    let h = start(&data, &ui);
    let war = create_war(h.port, json!({}))["id"]
        .as_str()
        .unwrap()
        .to_string();
    {
        let mut wars = h.app.wars();
        let slot = wars.get_mut(&war).unwrap();
        let mut out = commander::rules::Out::default();
        for i in 0..commander::rules::MAX_MEMBERS {
            slot.war.touch_member(&format!("a{i}"), None, 0, &mut out);
        }
        assert!(slot.war.has_room("a0"), "a member stays welcome");
        assert!(!slot.war.has_room("newcomer"));
    }
    let form = b"action=get_campaign_status";
    let ask = |player: &str| {
        http(
            h.port,
            "POST",
            &format!("/w/{war}/1.0/"),
            &[
                ("Content-Type", "application/x-www-form-urlencoded"),
                ("X-Commander-Player", player),
            ],
            form,
        )
        .status
    };
    assert_eq!(ask("a1"), 200);
    assert_eq!(ask("newcomer"), 403);
    h.shutdown();
}

#[test]
fn only_a_war_open_to_the_internet_answers_callers_from_outside_and_only_with_the_invite() {
    use commander::http::{Req, Via, route};
    let (data, ui) = (temp_dir("net"), temp_dir("net-ui"));
    std::fs::write(ui.join("index.html"), "<!doctype html>").unwrap();
    let h = start(&data, &ui);
    let war = create_war(h.port, json!({}))["id"]
        .as_str()
        .unwrap()
        .to_string();
    let other = create_war(h.port, json!({}))["id"]
        .as_str()
        .unwrap()
        .to_string();
    let ask = |via: Via, method: &str, path: &str, body: &str, key: Option<&str>| {
        let mut headers = vec![("X-Commander-Player".to_string(), PLAYER.to_string())];
        if let Some(k) = key {
            headers.push(("X-Commander-Key".to_string(), k.to_string()));
        }
        let req = Req {
            method: method.into(),
            path: path.into(),
            query: Default::default(),
            headers,
            body: body.as_bytes().to_vec(),
        };
        let r = route(&h.app, &req, via);
        (r.status, String::from_utf8_lossy(&r.body).to_string())
    };
    let lan = |body: Value| admin(h.port, "POST", &format!("/api/wars/{war}/lan"), Some(body));
    let game = format!("/w/{war}/1.0/");
    let view = format!("/api/wars/{war}");
    let status = "action=get_campaign_status";

    // Open to LAN alone: the local network gets the war, the internet does not, and no code is made.
    let r = lan(json!({"open": true})).json();
    assert_eq!(
        (r["internet"].clone(), r["invite"].clone()),
        (json!(false), json!(null))
    );
    assert_eq!(
        admin(
            h.port,
            "POST",
            &format!("/api/wars/{other}/lan"),
            Some(json!({"open": true}))
        )
        .status,
        200
    );
    assert_eq!(ask(Via::Lan, "POST", &game, status, None).0, 200);
    assert_eq!(
        ask(Via::Internet, "POST", &game, status, Some("ANY")).0,
        404
    );

    // Open to the internet: an invite code is made, and only the host is told it.
    let r = lan(json!({"open": true, "internet": true})).json();
    let code = r["invite"].as_str().expect("an invite code").to_string();
    assert_eq!(code.len(), 11, "{code}");
    assert_eq!(code.as_bytes()[5], b'-');
    assert!(
        code.chars()
            .all(|c| c == '-' || "23456789ABCDEFGHJKLMNPQRSTUVWXYZ".contains(c)),
        "{code}"
    );
    assert_eq!(
        admin(h.port, "GET", &view, None).json()["lan"],
        json!({"open": true, "port": r["port"], "internet": true, "invite": code})
    );
    let (s, seen) = ask(Via::Lan, "GET", &view, "", None);
    assert_eq!(s, 200);
    assert!(
        !seen.contains(&code) && !seen.contains("invite"),
        "a LAN guest is not told the code"
    );

    // From outside: nothing without the code or with a wrong one; the war with the right one.
    assert_eq!(ask(Via::Internet, "POST", &game, status, None).0, 404);
    assert_eq!(
        ask(Via::Internet, "POST", &game, status, Some("AAAAA-AAAAA")).0,
        404
    );
    assert_eq!(ask(Via::Internet, "GET", &view, "", Some("")).0, 404);
    assert_eq!(
        ask(Via::Internet, "POST", &game, status, Some(&code)).0,
        200
    );
    let typed = code.to_lowercase().replace('-', " ");
    assert_eq!(
        ask(Via::Internet, "POST", &game, status, Some(&typed)).0,
        200,
        "as a player types it"
    );
    let (s, seen) = ask(Via::Internet, "GET", &view, "", Some(&code));
    assert_eq!(s, 200);
    assert!(!seen.contains(&code), "the answer does not repeat the code");
    assert_eq!(
        ask(Via::Internet, "GET", "/", "", None).0,
        200,
        "the read-only war screens load"
    );

    // The list of wars names a war only to a caller with the code of that war.
    let listed = |key: Option<&str>| {
        let (_, body) = ask(Via::Internet, "GET", "/api/info", "", key);
        serde_json::from_str::<Value>(&body).unwrap()["wars"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w["id"].as_str().unwrap().to_string())
            .collect::<Vec<_>>()
    };
    assert!(listed(None).is_empty());
    assert_eq!(listed(Some(&code)), vec![war.clone()]);
    assert_eq!(
        ask(
            Via::Internet,
            "POST",
            &format!("/w/{other}/1.0/"),
            status,
            Some(&code)
        )
        .0,
        404
    );
    assert_eq!(
        ask(Via::Internet, "POST", "/api/wars", "{}", Some(&code)).0,
        404,
        "no admin call from outside"
    );
    assert_eq!(
        ask(
            Via::Internet,
            "GET",
            &format!("{view}/export"),
            "",
            Some(&code)
        )
        .0,
        404
    );

    // `open` alone keeps the switch and the code; a new code shuts the old one out.
    let r = lan(json!({"open": true})).json();
    assert_eq!(
        (r["internet"].clone(), r["invite"].clone()),
        (json!(true), json!(code))
    );
    let fresh = lan(json!({"open": true, "internet": true, "new_invite": true})).json()["invite"]
        .as_str()
        .unwrap()
        .to_string();
    assert_ne!(fresh, code);
    assert_eq!(
        ask(Via::Internet, "POST", &game, status, Some(&code)).0,
        404
    );
    assert_eq!(
        ask(Via::Internet, "POST", &game, status, Some(&fresh)).0,
        200
    );

    // Closing the LAN closes the internet with it, and it does not come back by itself.
    assert_eq!(lan(json!({"open": false})).json()["internet"], json!(false));
    assert_eq!(
        ask(Via::Internet, "POST", &game, status, Some(&fresh)).0,
        404
    );
    assert_eq!(lan(json!({"open": true})).json()["internet"], json!(false));
    assert_eq!(lan(json!({"open": true, "internet": "yes"})).status, 400);
    h.shutdown();

    // After a restart the war is closed again, and opening it gives the code friends already have.
    let h = start(&data, &ui);
    let r = admin(
        h.port,
        "POST",
        &format!("/api/wars/{war}/lan"),
        Some(json!({"open": true, "internet": true})),
    )
    .json();
    assert_eq!(r["invite"], json!(fresh));
    h.shutdown();
}
