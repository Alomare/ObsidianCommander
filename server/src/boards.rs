//! The two boards of the war screen: Heroes of the Federation and the Proving Grounds. The game uploads
//! a row after a mission and reads the lists on the war screen (docs/protocol.md, "Boards").
//!
//! The game draws a list for every front it asks about without checking that the list is there, so an
//! answer always holds one list per front, and for the heroes one more for the whole war. An empty
//! list draws an empty table; a missing one stops the game.

use crate::rules::{ENEMIES, War};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// The time the game shows as "no time" on the Proving Grounds board.
pub const NO_TIME: i64 = 99_999;
/// The most rows a list holds, whatever `count` asks for.
const MAX_ROWS: usize = 100;
/// The most players in a squad.
const SQUAD: usize = 4;

/// A player's totals on one front in one season. The game keeps these totals and uploads them
/// whole after each mission, so a new row replaces the one before; each number only grows.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
pub struct HeroRow {
    pub season: i64,
    pub enemy: u8,
    pub player: String,
    pub score: i64,
    pub planets: i64,
    pub playtime: i64,
    pub player_xp: i64,
}

/// A squad on the Proving Grounds of one front in one season: the best time, and the influence
/// and playtime of the uploads, which the game also keeps as totals.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
pub struct TrialRow {
    pub season: i64,
    pub enemy: u8,
    /// Steam IDs, sorted, at most four.
    pub players: Vec<String>,
    pub completion_time: i64,
    pub influence: i64,
    pub playtime: i64,
    pub trial_seed: i64,
    pub mission_seed: i64,
}

fn int(row: &Map<String, Value>, key: &str) -> Option<i64> {
    row.get(key)
        .and_then(Value::as_f64)
        .filter(|f| f.is_finite())
        .map(|f| f as i64)
}

/// A Steam ID as the game writes it: hexadecimal, as in the `X-Commander-Player` header.
fn steam_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 32 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// The front of a row, counted from 0 as in every upload but planets.
fn enemy(row: &Map<String, Value>) -> Option<u8> {
    int(row, "enemy")
        .filter(|e| (0..ENEMIES as i64).contains(e))
        .map(|e| e as u8)
}

/// Takes one `upload_leaderboard_statistics` row from `player`.
pub fn add_hero(war: &mut War, player: &str, row: &Map<String, Value>) {
    let Some(enemy) = enemy(row) else { return };
    if !steam_id(player) {
        return;
    }
    let season = int(row, "season").unwrap_or(war.season);
    let new = HeroRow {
        season,
        enemy,
        player: player.to_string(),
        score: int(row, "score").unwrap_or(0).max(0),
        planets: int(row, "planets").unwrap_or(0).max(0),
        playtime: int(row, "playtime").unwrap_or(0).max(0),
        player_xp: int(row, "player_xp").unwrap_or(0).max(0),
    };
    match war
        .heroes
        .iter_mut()
        .find(|h| h.season == season && h.enemy == enemy && h.player == player)
    {
        Some(h) => {
            h.score = h.score.max(new.score);
            h.planets = h.planets.max(new.planets);
            h.playtime = h.playtime.max(new.playtime);
            h.player_xp = h.player_xp.max(new.player_xp);
        }
        None => war.heroes.push(new),
    }
}

/// Takes one `upload_leaderboard_provinggrounds_statistics` row from `player`. The squad is the
/// `players` of the row (Steam IDs as keys and values), or the player alone.
pub fn add_trial(war: &mut War, player: &str, row: &Map<String, Value>) {
    let Some(enemy) = enemy(row) else { return };
    let mut players: Vec<String> = match row.get("players") {
        Some(Value::Object(o)) => o
            .iter()
            .flat_map(|(k, v)| [Some(k.as_str()), v.as_str()])
            .flatten()
            .filter(|s| steam_id(s))
            .map(str::to_string)
            .collect(),
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(Value::as_str)
            .filter(|s| steam_id(s))
            .map(str::to_string)
            .collect(),
        _ => vec![],
    };
    if steam_id(player) {
        players.push(player.to_string());
    }
    players.sort();
    players.dedup();
    players.truncate(SQUAD);
    if players.is_empty() {
        return;
    }
    let season = int(row, "season").unwrap_or(war.season);
    let done = row
        .get("mission_completed")
        .map(|v| v.as_bool().unwrap_or(v.as_f64() == Some(1.0)))
        .unwrap_or(true);
    let time = int(row, "completion_time")
        .filter(|t| done && *t > 0)
        .unwrap_or(NO_TIME)
        .min(NO_TIME);
    let new = TrialRow {
        season,
        enemy,
        players,
        completion_time: time,
        influence: int(row, "influence").unwrap_or(0).max(0),
        playtime: int(row, "playtime").unwrap_or(0).max(0),
        trial_seed: int(row, "trial_seed").unwrap_or(0),
        mission_seed: int(row, "mission_seed").unwrap_or(0),
    };
    match war
        .trials
        .iter_mut()
        .find(|t| t.season == season && t.enemy == enemy && t.players == new.players)
    {
        Some(t) => {
            t.completion_time = t.completion_time.min(new.completion_time);
            t.influence = t.influence.max(new.influence);
            t.playtime = t.playtime.max(new.playtime);
            if new.trial_seed != 0 {
                t.trial_seed = new.trial_seed;
                t.mission_seed = new.mission_seed;
            }
        }
        None => war.trials.push(new),
    }
}

/// The Steam IDs of a `users` field: a JSON list of strings (or numbers).
pub fn users(field: Option<&String>) -> Vec<String> {
    let Some(v) = field.and_then(|f| serde_json::from_str::<Value>(f).ok()) else {
        return vec![];
    };
    let items = match v {
        Value::Array(a) => a,
        Value::Object(o) => o.into_iter().map(|(_, v)| v).collect(),
        _ => vec![],
    };
    items
        .into_iter()
        .filter_map(|v| match v {
            Value::String(s) => Some(s),
            Value::Number(n) => Some(n.to_string()),
            _ => None,
        })
        .collect()
}

fn hero_json(h: &HeroRow) -> Value {
    json!({"online_id": h.player, "score": h.score, "planets": h.planets, "playtime": h.playtime, "player_xp": h.player_xp})
}

/// `leaderboards` and `user_leaderboards` for `get_leaderboards`: one list per front, best score
/// first, then the whole war (the fronts added up per player).
pub fn heroes(war: &War, season: i64, count: usize, users: &[String]) -> (Value, Value) {
    let count = count.clamp(1, MAX_ROWS);
    let mut lists: Vec<Vec<HeroRow>> = (0..ENEMIES)
        .map(|e| {
            war.heroes
                .iter()
                .filter(|h| h.season == season && h.enemy as usize == e)
                .cloned()
                .collect()
        })
        .collect();
    let mut total: Vec<HeroRow> = vec![];
    for h in lists.iter().flatten() {
        match total.iter_mut().find(|t| t.player == h.player) {
            Some(t) => {
                t.score += h.score;
                t.planets += h.planets;
                t.playtime += h.playtime;
                t.player_xp = t.player_xp.max(h.player_xp);
            }
            None => total.push(HeroRow {
                enemy: ENEMIES as u8,
                ..h.clone()
            }),
        }
    }
    lists.push(total);
    for l in &mut lists {
        l.sort_by(|a, b| {
            b.score
                .cmp(&a.score)
                .then(b.planets.cmp(&a.planets))
                .then(a.player.cmp(&b.player))
        });
    }
    let top = lists
        .iter()
        .map(|l| Value::Array(l.iter().take(count).map(hero_json).collect()))
        .collect();
    let mine = lists
        .iter()
        .map(|l| {
            Value::Array(
                users
                    .iter()
                    .filter_map(|u| l.iter().find(|h| h.player.eq_ignore_ascii_case(u)))
                    .map(hero_json)
                    .collect(),
            )
        })
        .collect();
    (Value::Array(top), Value::Array(mine))
}

fn trial_json(t: &TrialRow) -> Value {
    let id = |i: usize| t.players.get(i).cloned().unwrap_or_default();
    json!({"online_id_1": id(0), "online_id_2": id(1), "online_id_3": id(2), "online_id_4": id(3),
           "completion_time": t.completion_time, "influence": t.influence, "playtime": t.playtime,
           "trial_seed": t.trial_seed, "mission_seed": t.mission_seed})
}

/// `leaderboards` and `user_leaderboards` for `get_leaderboards_provinggrounds`: one list per front,
/// fastest squad first. A user list holds the best squad of the first user that has one.
pub fn trials(war: &War, season: i64, count: usize, users: &[String]) -> (Value, Value) {
    let count = count.clamp(1, MAX_ROWS);
    let mut top = vec![];
    let mut mine = vec![];
    for e in 0..ENEMIES {
        let mut l: Vec<&TrialRow> = war
            .trials
            .iter()
            .filter(|t| t.season == season && t.enemy as usize == e)
            .collect();
        l.sort_by(|a, b| {
            a.completion_time
                .cmp(&b.completion_time)
                .then(b.influence.cmp(&a.influence))
                .then(a.players.cmp(&b.players))
        });
        top.push(Value::Array(
            l.iter().take(count).map(|t| trial_json(t)).collect(),
        ));
        let best = users.iter().find_map(|u| {
            l.iter()
                .find(|t| t.players.iter().any(|p| p.eq_ignore_ascii_case(u)))
        });
        mine.push(Value::Array(
            best.map(|t| trial_json(t)).into_iter().collect(),
        ));
    }
    (Value::Array(top), Value::Array(mine))
}

/// A Proving Grounds mission seed as the game reads it: the hundreds digit is the front, and the
/// last two digits are the mission type (60 to 79 is Proving Grounds) plus the difficulty.
pub fn trial_mission_seed(random: u64, enemy: usize) -> i64 {
    const DIFFICULTY: [i64; 3] = [5, 9, 15];
    let difficulty = DIFFICULTY[((random >> 32) % 3) as usize];
    let high = (random % 2_000_000) as i64 * 1000;
    high + enemy as i64 * 100 + 60 + difficulty
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn mission_seeds_decode_to_the_front_and_proving_grounds() {
        for r in [0u64, 1, 0xdead_beef_cafe, u64::MAX] {
            for e in 0..ENEMIES {
                let s = trial_mission_seed(r, e);
                assert!(s > 0 && s < 2_147_483_647);
                assert_eq!((s / 100) % 10 % 3, e as i64);
                assert_eq!((s % 100) / 20, 3, "type 4 of the lookup: provinggrounds");
                assert!([5, 9, 15].contains(&((s % 100) % 20)));
            }
        }
    }

    #[test]
    fn hero_rows_are_season_totals_and_the_war_list_adds_the_fronts() {
        let (mut war, _) = War::new(
            "w",
            "W",
            Default::default(),
            0,
            &mut crate::rules::SplitMix::from_entropy(),
        );
        let s = war.season;
        add_hero(
            &mut war,
            "aa01",
            &row(
                json!({"enemy": 0, "season": s, "score": 5, "planets": 1, "playtime": 10, "player_xp": 100}),
            ),
        );
        add_hero(
            &mut war,
            "aa01",
            &row(
                json!({"enemy": 0, "season": s, "score": 9, "planets": 2, "playtime": 30, "player_xp": 150}),
            ),
        );
        add_hero(
            &mut war,
            "aa01",
            &row(
                json!({"enemy": 2, "season": s, "score": 4, "planets": 1, "playtime": 5, "player_xp": 150}),
            ),
        );
        add_hero(
            &mut war,
            "bb02",
            &row(
                json!({"enemy": 0, "season": s, "score": 20, "planets": 3, "playtime": 40, "player_xp": 90}),
            ),
        );
        add_hero(&mut war, "local", &row(json!({"enemy": 0, "score": 99})));
        add_hero(&mut war, "aa01", &row(json!({"enemy": 3, "score": 99})));
        let (top, mine) = heroes(&war, s, 10, &["AA01".into()]);
        let top = top.as_array().unwrap();
        assert_eq!(top.len(), 4);
        assert_eq!(top[0][0]["online_id"], "bb02");
        assert_eq!(top[0][1]["score"], 9);
        assert_eq!(top[1], json!([]));
        assert_eq!(top[3][0]["online_id"], "bb02");
        assert_eq!(top[3][1]["score"], 13);
        assert_eq!(top[3][1]["planets"], 3);
        let mine = mine.as_array().unwrap();
        assert_eq!(mine.len(), 4);
        assert_eq!(mine[0][0]["online_id"], "aa01");
        assert_eq!(mine[1], json!([]));
        // Another season: empty lists, but still four.
        let (top, _) = heroes(&war, s + 1, 10, &[]);
        assert_eq!(top, json!([[], [], [], []]));
    }

    #[test]
    fn a_squad_keeps_the_best_time_and_has_four_ids() {
        let (mut war, _) = War::new(
            "w",
            "W",
            Default::default(),
            0,
            &mut crate::rules::SplitMix::from_entropy(),
        );
        let s = war.season;
        let squad = json!({"aa01": "aa01", "bb02": "bb02"});
        add_trial(
            &mut war,
            "aa01",
            &row(
                json!({"enemy": 1, "season": s, "players": squad, "completion_time": 600, "influence": 3, "playtime": 600, "mission_completed": true}),
            ),
        );
        add_trial(
            &mut war,
            "bb02",
            &row(
                json!({"enemy": 1, "season": s, "players": squad, "completion_time": 480, "influence": 6, "playtime": 1080, "mission_completed": true}),
            ),
        );
        add_trial(
            &mut war,
            "cc03",
            &row(
                json!({"enemy": 1, "season": s, "completion_time": 300, "mission_completed": false}),
            ),
        );
        let (top, mine) = trials(&war, s, 10, &["bb02".into()]);
        let l = top[1].as_array().unwrap();
        assert_eq!(l.len(), 2);
        assert_eq!(l[0]["online_id_1"], "aa01");
        assert_eq!(l[0]["online_id_2"], "bb02");
        assert_eq!(l[0]["online_id_3"], "");
        assert_eq!(l[0]["online_id_4"], "");
        assert_eq!(l[0]["completion_time"], 480);
        assert_eq!(l[0]["influence"], 6);
        assert_eq!(l[1]["completion_time"], NO_TIME, "a lost trial has no time");
        assert_eq!(top[0], json!([]));
        assert_eq!(top.as_array().unwrap().len(), 3);
        assert_eq!(mine[1][0]["completion_time"], 480);
        assert_eq!(mine[0], json!([]));
    }

    #[test]
    fn users_reads_strings_and_numbers() {
        assert_eq!(
            users(Some(&r#"["aa01", 12]"#.to_string())),
            vec!["aa01".to_string(), "12".to_string()]
        );
        assert!(users(Some(&"nope".to_string())).is_empty());
        assert!(users(None).is_empty());
    }
}
