//! The war API the game calls (`POST /w/<id>/1.0/`, form-encoded `action=...`), per docs/protocol.md.

use crate::boards;
use crate::rules::{ENEMIES, Out, War, mix64};
use crate::store::WarSlot;
use serde_json::{Map, Value, json};
use std::collections::HashMap;

pub type Fields = HashMap<String, String>;

pub fn parse_form(body: &[u8]) -> Fields {
    form_urlencoded::parse(body)
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect()
}

fn base(now: i64) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("time".into(), json!(now));
    m.insert("error_code".into(), json!(0));
    m
}

pub fn error_answer(now: i64) -> Value {
    json!({"time": now, "error_code": 3, "error_message": "Missing or invalid arguments"})
}

/// A JSON form field (`planets`, `statistics`) as a list of objects. Dict values count too.
fn json_rows(fields: &Fields, name: &str) -> Option<Vec<Map<String, Value>>> {
    let v: Value = serde_json::from_str(fields.get(name)?).ok()?;
    let items: Vec<Value> = match v {
        Value::Array(a) => a,
        Value::Object(o) => o.into_iter().map(|(_, v)| v).collect(),
        _ => return None,
    };
    Some(
        items
            .into_iter()
            .filter_map(|v| {
                if let Value::Object(o) = v {
                    Some(o)
                } else {
                    None
                }
            })
            .collect(),
    )
}

fn row_index(row: &Map<String, Value>) -> Option<i64> {
    row.get("index")
        .and_then(Value::as_f64)
        .filter(|f| f.is_finite())
        .map(|f| f as i64)
}

fn row_season_ok(war: &War, row: &Map<String, Value>) -> bool {
    match row.get("season").and_then(Value::as_i64) {
        Some(s) => s == war.season,
        None => true,
    }
}

fn int_field(fields: &Fields, name: &str) -> Option<i64> {
    fields
        .get(name)
        .and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|f| f.is_finite())
        .map(|f| f as i64)
}

fn num_field(fields: &Fields, name: &str) -> Option<f64> {
    fields
        .get(name)
        .and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|f| f.is_finite())
}

/// Takes the rows in index order and applies each one that is new for this player and kind.
/// Answers the index to acknowledge, if the request had any.
fn take_rows(
    war: &mut War,
    player: &str,
    kind: &str,
    mut rows: Vec<Map<String, Value>>,
    mut apply: impl FnMut(&mut War, &Map<String, Value>),
) -> Option<i64> {
    rows.sort_by_key(|r| row_index(r).unwrap_or(i64::MIN));
    let mut seen = None;
    for row in &rows {
        match row_index(row) {
            Some(i) => {
                seen = Some(seen.map_or(i, |s: i64| s.max(i)));
                if war.take_index(player, kind, i) {
                    apply(war, row);
                }
            }
            None => apply(war, row),
        }
    }
    seen.map(|s| war.acked_index(player, kind).map_or(s, |a| a.max(s)))
}

/// The full status, as `get_campaign_status` answers it.
fn full_status(war: &War, now: i64) -> Map<String, Value> {
    let mut m = base(now);
    m.insert("campaign_status".into(), war.status_rows());
    if let Some(d) = war.defend_event_view(now) {
        m.insert("defend_event".into(), d);
    }
    m.insert("attack_events".into(), war.attack_events_view(now));
    m.insert("statistics".into(), war.statistics_rows(now));
    m
}

fn hidden_rows(season: i64) -> Value {
    Value::Array(
        (0..ENEMIES)
            .map(|e| json!({"season": season, "points": 0, "points_taken": 0, "points_max": 100000, "status": "hidden", "introduction_order": e}))
            .collect(),
    )
}

fn seed_for(war: &War, enemy: usize, salt: u64) -> u64 {
    mix64(
        war.seed
            ^ (war.season as u64).wrapping_mul(0x9E37_79B9)
            ^ ((enemy as u64 + 1) << 40)
            ^ salt,
    )
}

/// Answers one game request. Returns the JSON body and what changed.
pub fn handle(
    slot: &mut WarSlot,
    fields: &Fields,
    player: &str,
    name: Option<&str>,
    now: i64,
) -> (Value, Out) {
    let mut out = Out::default();
    let war = &mut slot.war;
    // Game reads carry no player: only an identified player is a member.
    if player != "local" {
        war.touch_member(player, name, now, &mut out);
    }
    let action = fields.get("action").map(String::as_str).unwrap_or("");
    let season_param = int_field(fields, "season");

    let answer: Map<String, Value> = match action {
        "get_campaign_status" => match season_param {
            Some(s) if s != war.season => {
                let mut m = base(now);
                let rows = war
                    .past_seasons
                    .iter()
                    .find(|p| p.season == s)
                    .map(|p| p.status_rows.clone())
                    .unwrap_or_else(|| hidden_rows(s));
                m.insert("campaign_status".into(), rows);
                m
            }
            Some(_) => {
                let mut m = base(now);
                m.insert("campaign_status".into(), war.status_rows());
                m
            }
            None => full_status(war, now),
        },

        "get_snapshots" => {
            let season = season_param.unwrap_or(war.season);
            let start = int_field(fields, "start");
            let end = int_field(fields, "end");
            let mut m = base(now);
            let (order, maxes, defend, attack): (Vec<u8>, Vec<i64>, Value, Value) =
                if season == war.season {
                    (
                        war.fronts.iter().map(|f| f.introduction_order).collect(),
                        war.fronts.iter().map(|f| f.points_max).collect(),
                        Value::Array(
                            war.defend_events
                                .iter()
                                .map(|e| war.event_view(e, now, false))
                                .collect(),
                        ),
                        war.attack_events_view(now),
                    )
                } else if let Some(p) = war.past_seasons.iter().find(|p| p.season == season) {
                    (
                        p.introduction_order.clone(),
                        p.points_max.clone(),
                        Value::Array(
                            p.defend_events
                                .iter()
                                .map(|e| war.event_view(e, now, false))
                                .collect(),
                        ),
                        Value::Array(
                            p.attack_events
                                .iter()
                                .map(|e| war.event_view(e, now, true))
                                .collect(),
                        ),
                    )
                } else {
                    (vec![0, 1, 2], vec![100_000; 3], json!([]), json!([]))
                };
            let snaps: Vec<Value> = slot
                .history
                .iter()
                .filter(|s| s.season == season && start.is_none_or(|t| s.time >= t) && end.is_none_or(|t| s.time <= t))
                .map(|s| json!({"season": s.season, "time": s.time, "data": serde_json::to_string(&s.data).unwrap_or_default()}))
                .collect();
            m.insert("introduction_order".into(), json!(order));
            m.insert("points_max".into(), json!(maxes));
            m.insert("snapshots".into(), Value::Array(snaps));
            m.insert("defend_events".into(), defend);
            m.insert("attack_events".into(), attack);
            m
        }

        "get_defend_event_by_id" | "get_attack_event_by_id" => {
            let attack = action == "get_attack_event_by_id";
            let id = int_field(fields, "event_id");
            let found = id.and_then(|id| {
                let current = if attack {
                    &war.attack_events
                } else {
                    &war.defend_events
                };
                current
                    .iter()
                    .find(|e| e.event_id as i64 == id)
                    .cloned()
                    .or_else(|| {
                        war.past_seasons
                            .iter()
                            .flat_map(|p| {
                                if attack {
                                    p.attack_events.iter()
                                } else {
                                    p.defend_events.iter()
                                }
                            })
                            .find(|e| e.event_id as i64 == id)
                            .cloned()
                    })
            });
            match found {
                Some(e) => {
                    let mut m = base(now);
                    m.insert(
                        if attack {
                            "attack_event"
                        } else {
                            "defend_event"
                        }
                        .into(),
                        war.event_view(&e, now, attack),
                    );
                    m
                }
                None => return (error_answer(now), out),
            }
        }

        "get_season_statistics" => {
            let season = season_param.unwrap_or(war.season);
            let mut m = base(now);
            let stats = if season == war.season {
                war.statistics_rows(now)
            } else {
                war.past_seasons
                    .iter()
                    .find(|p| p.season == season)
                    .map(|p| p.statistics.clone())
                    .unwrap_or_else(|| json!([]))
            };
            m.insert("statistics".into(), stats);
            m
        }

        "get_provinggrounds" => {
            let mut m = base(now);
            let trials: Vec<Value> = (0..ENEMIES)
                .map(|e| {
                    json!({"enemy": e, "trial_seed": 1_000_000 + (seed_for(war, e, 1) % 100_000),
                           "mission_seed": boards::trial_mission_seed(seed_for(war, e, 2), e), "unlocked": 1})
                })
                .collect();
            m.insert("trials".into(), Value::Array(trials));
            m
        }

        "get_leaderboards" | "get_leaderboards_provinggrounds" => {
            let season = season_param.unwrap_or(war.season);
            let count = int_field(fields, "count").filter(|c| *c > 0).unwrap_or(10) as usize;
            let users = boards::users(fields.get("users"));
            let (top, mine) = if action == "get_leaderboards" {
                boards::heroes(war, season, count, &users)
            } else {
                boards::trials(war, season, count, &users)
            };
            let mut m = base(now);
            m.insert("leaderboards".into(), top);
            m.insert("user_leaderboards".into(), mine);
            m
        }
        "get_top_of_leaderboard_provinggrounds" => {
            let mut m = base(now);
            m.insert("experts".into(), json!([]));
            m
        }
        "get_usernames" => {
            let count = int_field(fields, "count")
                .filter(|c| *c > 0)
                .map(|c| c as usize)
                .unwrap_or(usize::MAX);
            let names: Vec<&str> = war
                .members
                .iter()
                .map(|m| m.player.as_str())
                .filter(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_hexdigit()))
                .take(count)
                .collect();
            let mut m = base(now);
            m.insert("usernames".into(), json!(names));
            m
        }
        "get_available_entitlements" => {
            let mut m = base(now);
            m.insert("entitlements".into(), json!([]));
            m
        }

        "upload_statistics" => {
            let mut m = base(now);
            if fields.contains_key("statistics") {
                let Some(rows) = json_rows(fields, "statistics") else {
                    return (error_answer(now), out);
                };
                let ack = take_rows(war, player, "statistics", rows, |w, r| {
                    if row_season_ok(w, r) {
                        w.add_statistics(player, r, &mut out);
                    }
                });
                if let Some(a) = ack {
                    m.insert("uploaded_statistics".into(), json!(a));
                }
            } else if !fields.contains_key("c") {
                return (error_answer(now), out);
            }
            m
        }
        "upload_leaderboard_statistics" | "upload_leaderboard_provinggrounds_statistics" => {
            let Some(rows) = json_rows(fields, "statistics") else {
                return (error_answer(now), out);
            };
            let heroes = action == "upload_leaderboard_statistics";
            let kind = if heroes {
                "leaderboard"
            } else {
                "leaderboard_provinggrounds"
            };
            let ack = take_rows(war, player, kind, rows, |w, r| {
                if !row_season_ok(w, r) {
                    return;
                }
                if heroes {
                    boards::add_hero(w, player, r);
                } else {
                    boards::add_trial(w, player, r);
                }
            });
            out.changed = true;
            let mut m = base(now);
            if let Some(a) = ack {
                m.insert(
                    format!(
                        "uploaded_{action_tail}",
                        action_tail = action.trim_start_matches("upload_")
                    ),
                    json!(a),
                );
            }
            m
        }
        "complete_planets" => {
            let Some(rows) = json_rows(fields, "planets") else {
                return (error_answer(now), out);
            };
            let ack = take_rows(war, player, "planets", rows, |w, r| {
                if !row_season_ok(w, r) {
                    return;
                }
                // The planet `enemy` value counts from 1.
                let Some(enemy) = r
                    .get("enemy")
                    .and_then(Value::as_i64)
                    .filter(|e| (1..=ENEMIES as i64).contains(e))
                else {
                    return;
                };
                let difficulty = r.get("difficulty").and_then(Value::as_f64).unwrap_or(0.0);
                let success = r.get("success").and_then(Value::as_f64).unwrap_or(0.0);
                w.credit_planet(
                    player,
                    (enemy - 1) as usize,
                    difficulty,
                    success,
                    now,
                    &mut out,
                );
            });
            out.changed = true;
            let mut m = base(now);
            if let Some(a) = ack {
                m.insert("completed_planets".into(), json!(a));
            }
            m.insert("campaign_status".into(), war.status_rows());
            m
        }
        "complete_defend_mission" | "complete_attack_mission" => {
            let attack = action == "complete_attack_mission";
            let Some(event_id) = int_field(fields, "event_id").filter(|i| *i >= 0) else {
                return (error_answer(now), out);
            };
            let difficulty = num_field(fields, "difficulty").unwrap_or(1.0);
            // The game queue for these isn't seen yet; when an index comes along, count it once.
            let kind = if attack { "attack" } else { "defend" };
            let fresh = match int_field(fields, "index") {
                Some(i) => war.take_index(player, kind, i),
                None => true,
            };
            if fresh {
                if attack {
                    war.credit_attack_mission(player, event_id as u64, difficulty, now, &mut out);
                } else {
                    war.credit_defend_mission(player, event_id as u64, difficulty, now, &mut out);
                }
            }
            out.changed = true;
            full_status(war, now)
        }
        _ => return (error_answer(now), out),
    };
    (Value::Object(answer), out)
}
