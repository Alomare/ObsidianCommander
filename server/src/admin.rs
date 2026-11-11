//! The admin JSON API (spec section 5). Loopback needs the token; the LAN listener answers only the
//! read-only calls, and only for wars open to LAN.

use crate::evolved::{CampaignKind, EvoSettings, OrderKind};
use crate::http::{Req, Resp, Via};
use crate::rules::{FrontStatus, Out, Settings, War, WarState};
use crate::store::{FeedEntry, WarSlot};
use crate::{App, PROTOCOL, VERSION, lan, now_unix};
use serde_json::{Map, Value, json};
use std::sync::Arc;

fn token_ok(app: &App, req: &Req) -> bool {
    let given = req
        .header("X-Commander-Token")
        .or_else(|| req.query.get("token").map(String::as_str))
        .unwrap_or("");
    let want = app.cfg.token.as_bytes();
    let given = given.as_bytes();
    // Length first, then every byte, so the time doesn't say how much matched.
    given.len() == want.len()
        && given
            .iter()
            .zip(want)
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

fn body_object(req: &Req) -> Result<Map<String, Value>, Resp> {
    if req.body.is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_slice::<Value>(&req.body) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(_) => Err(Resp::error(400, "the body must be a JSON object")),
        Err(e) => Err(Resp::error(400, &format!("bad JSON: {e}"))),
    }
}

fn war_view(app: &App, slot: &WarSlot, now: i64) -> Value {
    let mut v = slot.war.admin_view(now, slot.lan_open, app.lan_port());
    v["lan"]["internet"] = json!(slot.lan_open && slot.internet_open);
    v
}

pub fn route(app: &Arc<App>, req: &Req, via: Via) -> Resp {
    let parts: Vec<&str> = req.path.trim_end_matches('/').split('/').skip(2).collect();
    let m = req.method.as_str();

    if via != Via::Loopback {
        if m != "GET" {
            return Resp::not_found();
        }
        return match parts.as_slice() {
            ["info"] => info(app, via),
            ["wars", id] => lan_read(app, via, id, |slot, now| war_view(app, slot, now)),
            ["wars", id, "feed"] => lan_read(app, via, id, |slot, _| feed(slot, req)),
            ["wars", id, "history"] => lan_read(app, via, id, |slot, _| history(slot, req)),
            _ => Resp::not_found(),
        };
    }

    if !token_ok(app, req) {
        return Resp::error(401, "missing or wrong admin token");
    }
    match (m, parts.as_slice()) {
        ("GET", ["info"]) => info(app, Via::Loopback),
        ("POST", ["wars"]) => create(app, req),
        ("POST", ["wars", "import"]) => import(app, req),
        ("GET", ["wars", id]) => read(app, id, |slot, now| {
            Resp::json(200, &war_view(app, slot, now))
        }),
        ("PATCH", ["wars", id]) => patch(app, req, id),
        ("DELETE", ["wars", id]) => delete(app, id),
        ("POST", ["wars", id, "actions"]) => action(app, req, id),
        ("GET", ["wars", id, "feed"]) => read(app, id, |slot, _| Resp::json(200, &feed(slot, req))),
        ("GET", ["wars", id, "history"]) => {
            read(app, id, |slot, _| Resp::json(200, &history(slot, req)))
        }
        ("POST", ["wars", id, "lan"]) => set_lan(app, req, id),
        ("GET", ["wars", id, "export"]) => export(app, id),
        (_, ["info"] | ["wars"] | ["wars", _] | ["wars", _, _]) => {
            Resp::error(405, "method not allowed")
        }
        _ => Resp::not_found(),
    }
}

fn info(app: &App, via: Via) -> Resp {
    let now = now_unix();
    let wars: Vec<Value> = app
        .wars()
        .values()
        .filter(|s| s.reachable(via))
        .map(|s| s.war.summary(now, s.lan_open))
        .collect();
    Resp::json(
        200,
        &json!({"version": VERSION, "protocol": PROTOCOL, "wars": wars}),
    )
}

fn read(app: &App, id: &str, f: impl FnOnce(&WarSlot, i64) -> Resp) -> Resp {
    let wars = app.wars();
    match wars.get(id) {
        Some(slot) => f(slot, now_unix()),
        None => Resp::error(404, "no such war"),
    }
}

fn lan_read(app: &App, via: Via, id: &str, f: impl FnOnce(&WarSlot, i64) -> Value) -> Resp {
    let wars = app.wars();
    match wars.get(id).filter(|s| s.reachable(via)) {
        Some(slot) => Resp::json(200, &f(slot, now_unix())),
        None => Resp::not_found(),
    }
}

fn feed(slot: &WarSlot, req: &Req) -> Value {
    let after = req.query.get("after").and_then(|s| s.parse::<u64>().ok());
    let limit = req
        .query
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(200)
        .clamp(1, 5000);
    let entries: Vec<&FeedEntry> = match after {
        Some(a) => slot.feed.iter().filter(|e| e.id > a).take(limit).collect(),
        None => {
            let skip = slot.feed.len().saturating_sub(limit);
            slot.feed.iter().skip(skip).collect()
        }
    };
    json!({"entries": entries, "last_id": slot.feed.last().map(|e| e.id).unwrap_or(0)})
}

fn history(slot: &WarSlot, req: &Req) -> Value {
    let from = req.query.get("from").and_then(|s| s.parse::<i64>().ok());
    // The war screens count seasons from 1, as the war view does.
    let snaps: Vec<Value> = slot
        .history
        .iter()
        .filter(|s| from.is_none_or(|f| s.time >= f))
        .map(|s| {
            let mut v = json!(s);
            v["season"] = json!(slot.war.shown(s.season));
            v
        })
        .collect();
    json!({"snapshots": snaps})
}

fn clean_name(v: Option<&Value>) -> Result<Option<String>, Resp> {
    match v {
        None => Ok(None),
        Some(Value::String(s)) => {
            let s = s.trim();
            if s.is_empty() || s.chars().count() > 80 {
                Err(Resp::error(400, "`name` must have 1 to 80 characters"))
            } else {
                Ok(Some(s.to_string()))
            }
        }
        Some(_) => Err(Resp::error(400, "`name` must be a string")),
    }
}

/// The longest description, in characters.
pub const DESCRIPTION_MAX: usize = 600;
/// The longest logo address, in bytes: a small picture the war screens shrink before sending.
pub const LOGO_MAX: usize = 200_000;

/// A description: any text up to `DESCRIPTION_MAX` characters, trimmed; null or "" clears it.
fn clean_description(v: Option<&Value>) -> Result<Option<String>, Resp> {
    match v {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(String::new())),
        Some(Value::String(s)) => {
            let s = s.trim();
            if s.chars().count() > DESCRIPTION_MAX {
                Err(Resp::error(
                    400,
                    &format!("`description` must have at most {DESCRIPTION_MAX} characters"),
                ))
            } else {
                Ok(Some(s.to_string()))
            }
        }
        Some(_) => Err(Resp::error(400, "`description` must be a string")),
    }
}

/// A logo: a base64 PNG, JPEG or WebP `data:` address up to `LOGO_MAX` bytes; null or "" clears it.
fn clean_logo(v: Option<&Value>) -> Result<Option<String>, Resp> {
    let s = match v {
        None => return Ok(None),
        Some(Value::Null) => return Ok(Some(String::new())),
        Some(Value::String(s)) => s.trim(),
        Some(_) => return Err(Resp::error(400, "`logo` must be a string")),
    };
    if s.is_empty() {
        return Ok(Some(String::new()));
    }
    if s.len() > LOGO_MAX {
        return Err(Resp::error(400, "`logo` is too large"));
    }
    let data = ["image/png", "image/jpeg", "image/webp"]
        .iter()
        .find_map(|m| s.strip_prefix(&format!("data:{m};base64,")));
    match data {
        Some(d)
            if !d.is_empty()
                && d.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b)) =>
        {
            Ok(Some(s.to_string()))
        }
        _ => Err(Resp::error(
            400,
            "`logo` must be a base64 PNG, JPEG or WebP data address",
        )),
    }
}

fn settings_patch(v: Option<&Value>) -> Result<Option<&Map<String, Value>>, Resp> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(m)) => Ok(Some(m)),
        Some(_) => Err(Resp::error(400, "`settings` must be an object")),
    }
}

fn new_id(app: &App, taken: &std::collections::BTreeMap<String, WarSlot>) -> String {
    const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
    loop {
        let id: String = (0..6)
            .map(|_| {
                ALPHABET[(app.roll() * ALPHABET.len() as f64) as usize % ALPHABET.len()] as char
            })
            .collect();
        if !taken.contains_key(&id) && !app.wars_dir().join(&id).exists() {
            return id;
        }
    }
}

fn create(app: &App, req: &Req) -> Resp {
    let body = match body_object(req) {
        Ok(b) => b,
        Err(r) => return r,
    };
    for k in body.keys() {
        if !matches!(
            k.as_str(),
            "name" | "description" | "logo" | "model" | "settings" | "evolved"
        ) {
            return Resp::error(400, &format!("unknown field `{k}`"));
        }
    }
    let name = match clean_name(body.get("name")) {
        Ok(n) => n.unwrap_or_else(|| "Galactic War".into()),
        Err(r) => return r,
    };
    let description = match clean_description(body.get("description")) {
        Ok(d) => d.unwrap_or_default(),
        Err(r) => return r,
    };
    let logo = match clean_logo(body.get("logo")) {
        Ok(l) => l.unwrap_or_default(),
        Err(r) => return r,
    };
    let evolved = match body.get("model") {
        None => false,
        Some(Value::String(s)) if s == "vanilla" => false,
        Some(Value::String(s)) if s == "evolved" => true,
        Some(_) => return Resp::error(400, "`model` must be \"vanilla\" or \"evolved\""),
    };
    let evo_settings = match body.get("evolved") {
        None | Some(Value::Null) => EvoSettings::default(),
        Some(Value::Object(p)) => match EvoSettings::default().patched(p) {
            Ok(s) => s,
            Err(e) => return Resp::error(400, &e),
        },
        Some(_) => return Resp::error(400, "`evolved` must be an object"),
    };
    let settings = match settings_patch(body.get("settings")) {
        Ok(Some(p)) => match Settings::default().patched(p) {
            Ok(s) => s,
            Err(e) => return Resp::error(400, &e),
        },
        Ok(None) => Settings::default(),
        Err(r) => return r,
    };
    let now = now_unix();
    let mut wars = app.wars();
    let id = new_id(app, &wars);
    let (mut war, out) = {
        let mut dice = app.dice.lock().unwrap_or_else(|e| e.into_inner());
        if evolved {
            War::new_evolved(&id, &name, settings, evo_settings, now, &mut *dice)
        } else {
            War::new(&id, &name, settings, now, &mut *dice)
        }
    };
    war.description = description;
    war.logo = logo;
    let mut slot = WarSlot::new(war, &app.wars_dir());
    if let Err(e) = slot.commit(out, now) {
        return Resp::error(500, &format!("could not write the war: {e}"));
    }
    app.log.line(&format!("war {id} created: {name}"));
    let view = war_view(app, &slot, now);
    wars.insert(id, slot);
    Resp::json(201, &view)
}

fn import(app: &App, req: &Req) -> Resp {
    let body = match body_object(req) {
        Ok(b) => b,
        Err(r) => return r,
    };
    let war_value = body
        .get("war")
        .cloned()
        .unwrap_or_else(|| Value::Object(body.clone()));
    let mut war: War = match serde_json::from_value(war_value) {
        Ok(w) => w,
        Err(e) => return Resp::error(400, &format!("not a Commander war: {e}")),
    };
    if war.fronts.len() != crate::rules::ENEMIES || war.stats.len() != crate::rules::ENEMIES {
        return Resp::error(400, "a war needs three fronts");
    }
    if let Err(e) = war.settings.validate() {
        return Resp::error(400, &e);
    }
    if !(0.5..=10.0).contains(&war.speed) {
        war.speed = 1.0;
    }
    let feed: Vec<FeedEntry> = body
        .get("feed")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let history = body
        .get("history")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let now = now_unix();
    let mut wars = app.wars();
    let id = new_id(app, &wars);
    war.id = id.clone();
    let mut slot = WarSlot::new(war, &app.wars_dir());
    slot.feed = feed;
    slot.history = history;
    if let Err(e) = slot.save_all() {
        return Resp::error(500, &format!("could not write the war: {e}"));
    }
    app.log.line(&format!("war {id} imported"));
    let view = war_view(app, &slot, now);
    wars.insert(id, slot);
    Resp::json(201, &view)
}

fn patch(app: &App, req: &Req, id: &str) -> Resp {
    let body = match body_object(req) {
        Ok(b) => b,
        Err(r) => return r,
    };
    for k in body.keys() {
        if !matches!(k.as_str(), "name" | "description" | "logo" | "settings") {
            return Resp::error(
                400,
                &format!("only `name`, `description`, `logo` and `settings` can change, not `{k}`"),
            );
        }
    }
    let name = match clean_name(body.get("name")) {
        Ok(n) => n,
        Err(r) => return r,
    };
    let description = match clean_description(body.get("description")) {
        Ok(d) => d,
        Err(r) => return r,
    };
    let logo = match clean_logo(body.get("logo")) {
        Ok(l) => l,
        Err(r) => return r,
    };
    let patch = match settings_patch(body.get("settings")) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let now = now_unix();
    let mut wars = app.wars();
    let Some(slot) = wars.get_mut(id) else {
        return Resp::error(404, "no such war");
    };
    let settings = match patch.map(|p| slot.war.settings.patched(p)).transpose() {
        Ok(s) => s,
        Err(e) => return Resp::error(400, &e),
    };
    let mut out = Out::default();
    if let Some(n) = name {
        slot.war.name = n;
        out.changed = true;
    }
    if let Some(d) = description {
        slot.war.description = d;
        out.changed = true;
    }
    if let Some(l) = logo {
        slot.war.logo = l;
        out.changed = true;
    }
    if let Some(s) = settings {
        slot.war.apply_settings(s, &mut out);
        out.feed
            .push(crate::rules::Feed::new("gm", "gm_settings").player("gm"));
        slot.war.check_triggers(now, &mut out);
    }
    app.commit(slot, out, now);
    Resp::json(200, &war_view(app, slot, now))
}

fn delete(app: &Arc<App>, id: &str) -> Resp {
    let removed = app.wars().remove(id);
    let Some(slot) = removed else {
        return Resp::error(404, "no such war");
    };
    let _ = lan::sync(app);
    if let Err(e) = std::fs::remove_dir_all(&slot.dir)
        && slot.dir.exists()
    {
        return Resp::error(500, &format!("could not delete the war folder: {e}"));
    }
    app.log.line(&format!("war {id} deleted"));
    Resp::json(200, &json!({"deleted": id}))
}

fn set_lan(app: &Arc<App>, req: &Req, id: &str) -> Resp {
    let body = match body_object(req) {
        Ok(b) => b,
        Err(r) => return r,
    };
    let Some(open) = body.get("open").and_then(Value::as_bool) else {
        return Resp::error(400, "`open` must be true or false");
    };
    // `internet` is optional: left out, a war that stays open keeps what it had.
    let internet = match body.get("internet") {
        None => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => return Resp::error(400, "`internet` must be true or false"),
    };
    let internet = {
        let mut wars = app.wars();
        let Some(slot) = wars.get_mut(id) else {
            return Resp::error(404, "no such war");
        };
        slot.lan_open = open;
        slot.internet_open = open && internet.unwrap_or(slot.internet_open);
        slot.internet_open
    };
    if let Err(e) = lan::sync(app) {
        if let Some(slot) = app.wars().get_mut(id) {
            slot.lan_open = false;
            slot.internet_open = false;
        }
        return Resp::error(500, &e);
    }
    app.log.line(&format!(
        "war {id} LAN {}{}",
        if open { "open" } else { "closed" },
        if internet {
            ", open to the internet"
        } else {
            ""
        }
    ));
    Resp::json(
        200,
        &json!({"open": open, "port": if open { app.lan_port() } else { None }, "internet": internet}),
    )
}

fn export(app: &App, id: &str) -> Resp {
    read(app, id, |slot, _| {
        let mut r = Resp::json(200, &slot.export());
        r.headers.push((
            "Content-Disposition",
            format!("attachment; filename=\"commander-war-{id}.json\""),
        ));
        r
    })
}

// ---------------------------------------------------------------- GM actions

fn get_front(b: &Map<String, Value>) -> Result<usize, String> {
    b.get("front")
        .and_then(Value::as_u64)
        .filter(|f| *f < 3)
        .map(|f| f as usize)
        .ok_or_else(|| "`front` must be 0, 1 or 2".into())
}

fn get_num(b: &Map<String, Value>, k: &str) -> Result<f64, String> {
    b.get(k)
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
        .ok_or_else(|| format!("`{k}` must be a number"))
}

fn get_int(b: &Map<String, Value>, k: &str) -> Result<i64, String> {
    let v = get_num(b, k)?;
    if v.fract() != 0.0 {
        return Err(format!("`{k}` must be a whole number"));
    }
    Ok(v as i64)
}

fn opt_duration(b: &Map<String, Value>, default: f64) -> Result<f64, String> {
    match b.get("duration") {
        None | Some(Value::Null) => Ok(default),
        Some(_) => {
            let d = get_num(b, "duration")?;
            if !(60.0..=30.0 * 86_400.0).contains(&d) {
                return Err("`duration` must be between 60 seconds and 30 days".into());
            }
            Ok(d)
        }
    }
}

fn opt_points_max(b: &Map<String, Value>, default: i64) -> Result<i64, String> {
    match b.get("points_max") {
        None | Some(Value::Null) => Ok(default),
        Some(_) => {
            let p = get_int(b, "points_max")?;
            if !(1..=100_000_000).contains(&p) {
                return Err("`points_max` must be between 1 and 100000000".into());
            }
            Ok(p)
        }
    }
}

fn run_action(
    war: &mut War,
    b: &Map<String, Value>,
    now: i64,
    out: &mut Out,
) -> Result<(String, Option<usize>, Option<f64>), String> {
    let action = b
        .get("action")
        .and_then(Value::as_str)
        .ok_or("`action` is missing")?
        .to_string();
    let mut front = None;
    let mut value = None;
    match action.as_str() {
        "set_points" => {
            let f = get_front(b)?;
            let p = get_num(b, "points")?;
            war.set_points(f, p, now, out)?;
            (front, value) = (Some(f), Some(p));
        }
        "push" => {
            let f = get_front(b)?;
            let r = get_int(b, "regions")?;
            war.push(f, r, now, out)?;
            (front, value) = (Some(f), Some(r as f64));
        }
        "set_status" => {
            let f = get_front(b)?;
            let s = b
                .get("status")
                .and_then(Value::as_str)
                .and_then(FrontStatus::parse)
                .ok_or("`status` must be active, defeated or hidden")?;
            if war.state.ended() {
                return Err("the season is over; start a new one".into());
            }
            war.set_status(f, s, now, out)?;
            front = Some(f);
        }
        "start_defend" => {
            let f = get_front(b)?;
            let region = get_int(b, "region")?;
            let d = opt_duration(b, war.settings.defend_duration)?;
            let p = opt_points_max(b, war.settings.defend_points)?;
            war.start_defend(f, region, d, p, now, "gm", out)?;
            front = Some(f);
        }
        "start_attack" => {
            let f = get_front(b)?;
            let d = opt_duration(b, war.settings.attack_duration)?;
            let p = opt_points_max(b, war.settings.attack_points)?;
            war.start_attack(f, d, p, now, "gm", out)?;
            front = Some(f);
        }
        "set_event" => {
            let id = get_int(b, "event_id")?;
            let p = get_num(b, "points")?;
            war.set_event_points(id.max(0) as u64, p, now, out)?;
            value = Some(p);
        }
        "end_event" => {
            let id = get_int(b, "event_id")?;
            let ok = match b.get("result").and_then(Value::as_str) {
                Some("success") => true,
                Some("fail") => false,
                _ => return Err("`result` must be success or fail".into()),
            };
            war.end_event(id.max(0) as u64, ok, now, out)?;
        }
        "pause" => {
            if war.state != WarState::Running {
                return Err("the war isn't running".into());
            }
            war.state = WarState::Paused;
            out.changed = true;
        }
        "resume" => {
            if war.state != WarState::Paused {
                return Err("the war isn't paused".into());
            }
            war.state = WarState::Running;
            out.changed = true;
        }
        "set_speed" => {
            let s = get_num(b, "speed")?;
            if !(0.5..=10.0).contains(&s) {
                return Err("`speed` must be between 0.5 and 10".into());
            }
            war.speed = s;
            out.changed = true;
            value = Some(s);
        }
        "end_season" => {
            let won = match b.get("result").and_then(Value::as_str) {
                Some("won") => true,
                Some("lost") => false,
                _ => return Err("`result` must be won or lost".into()),
            };
            if war.state.ended() {
                return Err("the season is already over".into());
            }
            war.end_season(won, now, "gm", out);
        }
        "new_season" => war.new_season(now, out),
        other => return Err(format!("unknown action `{other}`")),
    }
    Ok((action, front, value))
}

fn action(app: &App, req: &Req, id: &str) -> Resp {
    let body = match body_object(req) {
        Ok(b) => b,
        Err(r) => return r,
    };
    let now = now_unix();
    let mut wars = app.wars();
    let Some(slot) = wars.get_mut(id) else {
        return Resp::error(404, "no such war");
    };
    let mut out = Out::default();
    let name = body.get("action").and_then(Value::as_str).unwrap_or("");
    if name.starts_with("evo_") {
        let mut dice = app.dice.lock().unwrap_or_else(|e| e.into_inner());
        let done = evolved_action(&mut slot.war, &body, now, &mut *dice, &mut out);
        drop(dice);
        return match done {
            Ok(()) => {
                app.log.line(&format!("war {id}: GM {name}"));
                app.commit(slot, out, now);
                Resp::json(200, &war_view(app, slot, now))
            }
            Err(e) => {
                app.commit(slot, out, now);
                Resp::error(400, &e)
            }
        };
    }
    match run_action(&mut slot.war, &body, now, &mut out) {
        Ok((name, front, value)) => {
            let mut f = crate::rules::Feed::new("gm", format!("gm_{name}")).player("gm");
            f.front = front;
            f.value = value;
            f.event_id = body.get("event_id").and_then(Value::as_u64);
            // The GM entry first, then what it caused.
            out.feed.insert(0, f);
            out.changed = true;
            app.log.line(&format!("war {id}: GM {name}"));
            app.commit(slot, out, now);
            Resp::json(200, &war_view(app, slot, now))
        }
        Err(e) => {
            // A refused action may still have moved nothing; keep whatever it did record.
            app.commit(slot, out, now);
            Resp::error(400, &e)
        }
    }
}

// ---------------------------------------------------------------- Evolved GM actions

fn get_planet(b: &Map<String, Value>, k: &str) -> Result<usize, String> {
    let n = crate::evolved::galaxy().planets.len();
    b.get(k)
        .and_then(Value::as_u64)
        .map(|p| p as usize)
        .filter(|p| *p < n)
        .ok_or_else(|| format!("`{k}` must be a planet number below {n}"))
}

/// `evo_planet`, `evo_campaign`, `evo_end_campaign`, `evo_order`, `evo_news`, `evo_settings`.
fn evolved_action(
    war: &mut War,
    b: &Map<String, Value>,
    now: i64,
    dice: &mut dyn crate::rules::Dice,
    out: &mut Out,
) -> Result<(), String> {
    let action = b.get("action").and_then(Value::as_str).unwrap_or("");
    let war_time = war.war_time;
    let Some(e) = war.evolved.as_mut() else {
        return Err("not an Evolved war".into());
    };
    match action {
        "evo_planet" => {
            let p = get_planet(b, "planet")?;
            let owner = b
                .get("owner")
                .and_then(Value::as_u64)
                .filter(|o| *o <= 3)
                .ok_or(
                    "`owner` must be 0 (Super Earth), 1 (bugs), 2 (cyborgs) or 3 (illuminates)",
                )?;
            e.set_owner(p, owner as u8, war_time, now, out)
        }
        "evo_campaign" => {
            let p = get_planet(b, "planet")?;
            let kind = match b.get("kind").and_then(Value::as_str) {
                None => {
                    if e.owners[p] == 0 {
                        CampaignKind::Defense
                    } else {
                        CampaignKind::Liberation
                    }
                }
                Some("liberation") => CampaignKind::Liberation,
                Some("defense") => CampaignKind::Defense,
                Some(_) => return Err("`kind` must be \"liberation\" or \"defense\"".into()),
            };
            match kind {
                CampaignKind::Liberation => {
                    e.start_liberation(p, war_time, now, dice, out).map(|_| ())
                }
                CampaignKind::Defense => {
                    let faction = b
                        .get("faction")
                        .and_then(Value::as_u64)
                        .filter(|f| (1..=3).contains(f))
                        .ok_or("`faction` must be 1 (bugs), 2 (cyborgs) or 3 (illuminates)")?;
                    let hours = match b.get("hours") {
                        None | Some(Value::Null) => e.settings.defense_hours,
                        Some(v) => v
                            .as_f64()
                            .filter(|h| (0.25..=720.0).contains(h))
                            .ok_or("`hours` must be between 0.25 and 720")?,
                    };
                    e.start_defense(p, faction as u8, hours, war_time, now, dice, out)
                        .map(|_| ())
                }
            }
        }
        "evo_end_campaign" => {
            let id = b
                .get("campaign")
                .and_then(Value::as_u64)
                .ok_or("`campaign` must be a campaign id")?;
            let won = b
                .get("won")
                .and_then(Value::as_bool)
                .ok_or("`won` must be true or false")?;
            e.end_campaign(id, won, war_time, now, out)
        }
        "evo_order" => {
            let kind = b
                .get("kind")
                .and_then(Value::as_str)
                .and_then(OrderKind::parse)
                .ok_or("`kind` must be \"liberate\", \"defend\" or \"missions\"")?;
            let n = crate::evolved::galaxy().planets.len();
            let planets: Vec<usize> = match b.get("planets") {
                None | Some(Value::Null) => vec![],
                Some(Value::Array(a)) => {
                    let mut v = vec![];
                    for x in a {
                        let p = x
                            .as_u64()
                            .map(|p| p as usize)
                            .filter(|p| *p < n)
                            .ok_or("`planets` must list planet numbers")?;
                        if !v.contains(&p) {
                            v.push(p);
                        }
                    }
                    v
                }
                Some(_) => return Err("`planets` must be a list".into()),
            };
            let faction = b
                .get("faction")
                .and_then(Value::as_u64)
                .filter(|f| *f <= 3)
                .unwrap_or(0) as u8;
            let target = b.get("target").and_then(Value::as_f64).unwrap_or(0.0);
            let hours = b
                .get("hours")
                .and_then(Value::as_f64)
                .unwrap_or(e.settings.order_hours);
            let brief = b.get("brief").and_then(Value::as_str).map(str::to_string);
            e.issue_order(
                kind, planets, faction, target, hours, brief, "gm", war_time, now, out,
            )
            .map(|_| ())
        }
        "evo_cancel_order" => {
            let id = b
                .get("order")
                .and_then(Value::as_u64)
                .ok_or("`order` must be an order id")?;
            e.cancel_order(id, war_time, now, out)
        }
        "evo_news" => {
            let text = b
                .get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|t| !t.is_empty() && t.chars().count() <= 400)
                .ok_or("`text` must be 1 to 400 characters")?;
            e.post_news(text, war_time, now, out);
            Ok(())
        }
        "evo_settings" => {
            let patch = b
                .get("settings")
                .and_then(Value::as_object)
                .ok_or("`settings` must be an object")?;
            e.settings = e.settings.patched(patch)?;
            out.changed = true;
            Ok(())
        }
        _ => Err(format!("unknown action `{action}`")),
    }
}
