//! The Vanilla war: state and rules, with no I/O and no clock: the caller passes the time in.
//!
//! Every function that needs the time takes `now` (server unix seconds) and, for the tick, the real
//! seconds since the last tick. Randomness comes in through [`Dice`], so tests can fix it. What a call
//! changed beyond the state itself (feed entries, a snapshot to keep) comes back in an [`Out`].

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

pub const ENEMIES: usize = 3;
pub const MAX_TICK_SECONDS: f64 = 60.0;
pub const SUPER_EARTH_REGION: i64 = 0;
pub const HOME_WORLD_REGION: i64 = 11;
/// Clamp for planet and mission `difficulty`, so a forged value can't win a front in one call.
pub const MAX_DIFFICULTY: f64 = 100.0;

// ---------------------------------------------------------------- randomness

pub trait Dice {
    /// A number in [0, 1).
    fn next_f64(&mut self) -> f64;
    fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            return 0;
        }
        ((self.next_f64() * n as f64) as usize).min(n - 1)
    }
}

/// SplitMix64: small, fast and good enough for a war director.
#[derive(Clone, Debug)]
pub struct SplitMix(pub u64);

impl SplitMix {
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        mix64(self.0)
    }

    pub fn from_entropy() -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        let addr = &COUNTER as *const _ as u64;
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        SplitMix(mix64(
            nanos ^ addr.rotate_left(17) ^ n.wrapping_mul(0xA24B_AED4_963E_E407),
        ))
    }
}

pub fn mix64(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

impl Dice for SplitMix {
    fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
}

// ---------------------------------------------------------------- settings

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Settings {
    pub points_max: i64,
    pub start_points: i64,
    pub pressure_per_hour: f64,
    pub planet_value: f64,
    pub defend_chance_per_hour: f64,
    pub defend_duration: f64,
    pub defend_points: i64,
    pub defend_mission_value: f64,
    pub defend_reward: i64,
    pub attack_duration: f64,
    pub attack_points: i64,
    pub attack_mission_value: f64,
    pub director: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            points_max: 100_000,
            // The middle of region 2, so a little enemy pressure doesn't cross a region edge at once.
            start_points: 15_000,
            pressure_per_hour: 600.0,
            planet_value: 250.0,
            defend_chance_per_hour: 0.08,
            defend_duration: 14_400.0,
            defend_points: 3_000,
            defend_mission_value: 150.0,
            defend_reward: 3_000,
            attack_duration: 21_600.0,
            attack_points: 5_000,
            attack_mission_value: 150.0,
            director: true,
        }
    }
}

const INT_SETTINGS: [&str; 5] = [
    "points_max",
    "start_points",
    "defend_points",
    "defend_reward",
    "attack_points",
];
const MAX_DURATION: f64 = 30.0 * 86_400.0;

impl Settings {
    /// These settings with `patch` laid over them, checked. The message names the field at fault.
    pub fn patched(&self, patch: &Map<String, Value>) -> Result<Settings, String> {
        let mut merged = match serde_json::to_value(self) {
            Ok(Value::Object(m)) => m,
            _ => return Err("settings could not be read".into()),
        };
        for (key, value) in patch {
            if !merged.contains_key(key) {
                return Err(format!("unknown setting `{key}`"));
            }
            let mut value = value.clone();
            if INT_SETTINGS.contains(&key.as_str())
                && let Some(f) = value.as_f64()
                && !value.is_i64()
            {
                if f.fract() != 0.0 || !f.is_finite() {
                    return Err(format!("`{key}` must be a whole number"));
                }
                value = json!(f as i64);
            }
            merged.insert(key.clone(), value);
        }
        let s: Settings = serde_json::from_value(Value::Object(merged))
            .map_err(|e| format!("bad settings: {e}"))?;
        s.validate()?;
        Ok(s)
    }

    pub fn validate(&self) -> Result<(), String> {
        fn range(name: &str, v: f64, lo: f64, hi: f64) -> Result<(), String> {
            if !v.is_finite() || v < lo || v > hi {
                return Err(format!("`{name}` must be between {lo} and {hi}"));
            }
            Ok(())
        }
        range("points_max", self.points_max as f64, 1_000.0, 100_000_000.0)?;
        range(
            "start_points",
            self.start_points as f64,
            1.0,
            (self.points_max - 1) as f64,
        )?;
        range(
            "pressure_per_hour",
            self.pressure_per_hour,
            0.0,
            self.points_max as f64,
        )?;
        range("planet_value", self.planet_value, 0.0, 1_000_000.0)?;
        range(
            "defend_chance_per_hour",
            self.defend_chance_per_hour,
            0.0,
            60.0,
        )?;
        range("defend_duration", self.defend_duration, 60.0, MAX_DURATION)?;
        range(
            "defend_points",
            self.defend_points as f64,
            1.0,
            100_000_000.0,
        )?;
        range(
            "defend_mission_value",
            self.defend_mission_value,
            0.0,
            1_000_000.0,
        )?;
        range(
            "defend_reward",
            self.defend_reward as f64,
            0.0,
            self.points_max as f64,
        )?;
        range("attack_duration", self.attack_duration, 60.0, MAX_DURATION)?;
        range(
            "attack_points",
            self.attack_points as f64,
            1.0,
            100_000_000.0,
        )?;
        range(
            "attack_mission_value",
            self.attack_mission_value,
            0.0,
            1_000_000.0,
        )?;
        Ok(())
    }
}

// ---------------------------------------------------------------- state

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FrontStatus {
    Active,
    Defeated,
    Hidden,
}

impl FrontStatus {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "active" => Some(Self::Active),
            "defeated" => Some(Self::Defeated),
            "hidden" => Some(Self::Hidden),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Defeated => "defeated",
            Self::Hidden => "hidden",
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EventStatus {
    Active,
    Success,
    Fail,
}

impl EventStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Success => "success",
            Self::Fail => "fail",
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WarState {
    Running,
    Paused,
    Won,
    Lost,
}

impl WarState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Won => "won",
            Self::Lost => "lost",
        }
    }
    pub fn ended(self) -> bool {
        matches!(self, Self::Won | Self::Lost)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Front {
    pub enemy: usize,
    pub points: f64,
    pub points_max: i64,
    pub points_taken: f64,
    pub status: FrontStatus,
    pub introduction_order: u8,
    pub pressure_per_hour: f64,
}

impl Front {
    pub fn points_int(&self) -> i64 {
        // A hair of slack so float pressure sums land on whole points.
        (self.points + 1e-6).floor() as i64
    }
    pub fn region(&self) -> i64 {
        region_of(self.points_int(), self.points_max)
    }
    fn region_size(&self) -> f64 {
        self.points_max as f64 / 10.0
    }
}

/// The in-game formula: `clamp(floor(points / (points_max / 10)) + 1, 1, 10)`.
pub fn region_of(points: i64, points_max: i64) -> i64 {
    if points_max <= 0 {
        return 1;
    }
    let r = (points as f64 / (points_max as f64 / 10.0)).floor() as i64 + 1;
    r.clamp(1, 10)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Event {
    pub season: i64,
    pub event_id: u64,
    pub enemy: usize,
    pub region: i64,
    pub points: f64,
    pub points_max: i64,
    pub status: EventStatus,
    /// War seconds when it started and when it runs out.
    pub start_war: f64,
    pub end_war: f64,
    /// Unix seconds: set at the start and the end; while active, views project them from the war clock.
    pub start_time: i64,
    pub end_time: i64,
    pub players_at_start: u32,
}

impl Event {
    pub fn active(&self) -> bool {
        self.status == EventStatus::Active
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct EnemyStats {
    pub missions: i64,
    pub successful_missions: i64,
    pub total_mission_difficulty: i64,
    pub completed_planets: i64,
    pub deaths: i64,
    pub kills: i64,
    pub accidentals: i64,
    pub shots: i64,
    pub hits: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Member {
    pub player: String,
    #[serde(default)]
    pub name: Option<String>,
    pub first_seen: i64,
    pub last_seen: i64,
    #[serde(default)]
    pub missions: i64,
    #[serde(default)]
    pub last_enemy: Option<usize>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct PastSeason {
    pub season: i64,
    pub result: String,
    pub ended: i64,
    pub status_rows: Value,
    pub statistics: Value,
    pub points_max: Vec<i64>,
    pub introduction_order: Vec<u8>,
    pub defend_events: Vec<Event>,
    pub attack_events: Vec<Event>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct War {
    pub id: String,
    pub name: String,
    /// What the war is about, in the words of the host. Empty when none was given.
    #[serde(default)]
    pub description: String,
    /// A small picture for the war list, as a `data:image/...;base64,` address. Empty for the
    /// picture of the model.
    #[serde(default)]
    pub logo: String,
    pub model: String,
    /// The season the game sees. It stays far above the official seasons and apart for every war,
    /// since the game puts players of one season in one matchmaking pool. People see
    /// `shown_season`, which counts from 1.
    pub season: i64,
    /// The game season of the first season. Older wars have none and count back from the past
    /// seasons they keep.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_season: Option<i64>,
    pub created: i64,
    pub state: WarState,
    pub war_time: f64,
    pub speed: f64,
    pub seed: u64,
    pub fronts: Vec<Front>,
    pub defend_events: Vec<Event>,
    pub attack_events: Vec<Event>,
    pub next_event_id: u64,
    pub stats: Vec<EnemyStats>,
    pub members: Vec<Member>,
    pub settings: Settings,
    /// Highest index taken, per player and kind (`planets`, `statistics`, ...).
    #[serde(default)]
    pub indexes: BTreeMap<String, BTreeMap<String, i64>>,
    #[serde(default)]
    pub past_seasons: Vec<PastSeason>,
    pub season_start_war: f64,
    pub season_start_time: i64,
    pub last_snapshot_hour: i64,
    /// The Evolved war state, for a war of model "evolved". The fronts above then stay as they
    /// started: the game still asks for them, and the Evolved War Engine mod draws this instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evolved: Option<crate::evolved::Evolved>,
}

// ---------------------------------------------------------------- effects

#[derive(Clone, Debug, PartialEq)]
pub struct Feed {
    pub kind: &'static str,
    pub text_key: String,
    pub front: Option<usize>,
    pub region: Option<i64>,
    pub event_id: Option<u64>,
    pub player: Option<String>,
    pub value: Option<f64>,
}

impl Feed {
    pub fn new(kind: &'static str, text_key: impl Into<String>) -> Self {
        Feed {
            kind,
            text_key: text_key.into(),
            front: None,
            region: None,
            event_id: None,
            player: None,
            value: None,
        }
    }
    pub fn front(mut self, f: usize) -> Self {
        self.front = Some(f);
        self
    }
    pub fn region(mut self, r: i64) -> Self {
        self.region = Some(r);
        self
    }
    pub fn event(mut self, e: u64) -> Self {
        self.event_id = Some(e);
        self
    }
    pub fn player(mut self, p: &str) -> Self {
        self.player = Some(p.to_string());
        self
    }
    pub fn value(mut self, v: f64) -> Self {
        self.value = Some(v);
        self
    }
}

/// What a rules call did besides changing the war.
#[derive(Debug, Default)]
pub struct Out {
    pub feed: Vec<Feed>,
    pub snapshot: bool,
    pub changed: bool,
}

impl Out {
    fn push(&mut self, f: Feed) {
        self.feed.push(f);
        self.changed = true;
    }
}

/// A war snapshot row, as `get_snapshots` encodes it in `data`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SnapRow {
    pub points: i64,
    pub points_taken: i64,
    pub status: FrontStatus,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Snapshot {
    pub season: i64,
    pub time: i64,
    pub war_time: f64,
    pub data: Vec<SnapRow>,
}

// ---------------------------------------------------------------- the war

const GM: &str = "gm";

impl War {
    pub fn new(
        id: &str,
        name: &str,
        settings: Settings,
        now: i64,
        dice: &mut dyn Dice,
    ) -> (War, Out) {
        let season = 1000 + dice.below(9000) as i64;
        let seed = (dice.next_f64() * u32::MAX as f64) as u64;
        let fronts = (0..ENEMIES)
            .map(|e| Front {
                enemy: e,
                points: settings.start_points as f64,
                points_max: settings.points_max,
                points_taken: 0.0,
                status: FrontStatus::Active,
                introduction_order: e as u8,
                pressure_per_hour: settings.pressure_per_hour,
            })
            .collect();
        let war = War {
            id: id.to_string(),
            name: name.to_string(),
            description: String::new(),
            logo: String::new(),
            model: "vanilla".into(),
            season,
            first_season: Some(season),
            created: now,
            state: WarState::Running,
            war_time: 0.0,
            speed: 1.0,
            seed,
            fronts,
            defend_events: vec![],
            attack_events: vec![],
            next_event_id: 1,
            stats: vec![EnemyStats::default(); ENEMIES],
            members: vec![],
            settings,
            indexes: BTreeMap::new(),
            past_seasons: vec![],
            season_start_war: 0.0,
            season_start_time: now,
            last_snapshot_hour: 0,
            evolved: None,
        };
        let mut out = Out {
            snapshot: true,
            changed: true,
            ..Default::default()
        };
        out.push(Feed::new("season", "season_started").value(1.0));
        (war, out)
    }

    /// The season number people see for a game season: the first season of the war is 1.
    pub fn shown(&self, game_season: i64) -> i64 {
        let first = self
            .first_season
            .unwrap_or(self.season - self.past_seasons.len() as i64);
        game_season - first + 1
    }

    /// The season number people see now.
    pub fn shown_season(&self) -> i64 {
        self.shown(self.season)
    }

    /// A new Evolved war: the HELLDIVERS 2 galaxy with campaigns, operations and Major Orders.
    pub fn new_evolved(
        id: &str,
        name: &str,
        settings: Settings,
        evo: crate::evolved::EvoSettings,
        now: i64,
        dice: &mut dyn Dice,
    ) -> (War, Out) {
        let (mut war, mut out) = War::new(id, name, settings, now, dice);
        war.model = "evolved".into();
        let mut e = crate::evolved::Evolved::new(evo);
        e.start(0.0, now, dice, &mut out);
        war.evolved = Some(e);
        (war, out)
    }

    pub fn is_evolved(&self) -> bool {
        self.evolved.is_some()
    }

    // ---- lookups

    pub fn active_defend(&self) -> Option<&Event> {
        self.defend_events.iter().find(|e| e.active())
    }

    fn active_defend_index(&self) -> Option<usize> {
        self.defend_events.iter().position(|e| e.active())
    }

    pub fn active_attack_on(&self, front: usize) -> Option<&Event> {
        self.attack_events
            .iter()
            .find(|e| e.active() && e.enemy == front)
    }

    fn front_busy(&self, front: usize) -> bool {
        self.active_defend().is_some_and(|e| e.enemy == front)
            || self.active_attack_on(front).is_some()
    }

    /// Members seen in the last 24 hours.
    pub fn recent_players(&self, now: i64) -> u32 {
        self.members
            .iter()
            .filter(|m| now - m.last_seen <= 86_400)
            .count() as u32
    }

    pub fn snapshot(&self, now: i64) -> Snapshot {
        Snapshot {
            season: self.season,
            time: now,
            war_time: self.war_time,
            data: self
                .fronts
                .iter()
                .map(|f| SnapRow {
                    points: f.points_int(),
                    points_taken: f.points_taken.floor() as i64,
                    status: f.status,
                })
                .collect(),
        }
    }

    // ---- points

    /// Moves front points, clamped to [0, points_max], and reports a region change.
    fn set_front_points(&mut self, front: usize, points: f64, credit: bool, out: &mut Out) {
        let f = &mut self.fronts[front];
        let before = f.region();
        let new = points.clamp(0.0, f.points_max as f64);
        if credit && new > f.points {
            f.points_taken += new - f.points;
        }
        if new != f.points {
            out.changed = true;
        }
        f.points = new;
        let after = f.region();
        if after > before {
            out.push(
                Feed::new("region", "region_liberated")
                    .front(front)
                    .region(after),
            );
            out.snapshot = true;
        } else if after < before {
            out.push(
                Feed::new("region", "region_lost")
                    .front(front)
                    .region(after),
            );
            out.snapshot = true;
        }
    }

    // ---- the tick

    /// Advances the war by `real_seconds` (capped at 60) times the speed, then applies pressure,
    /// event deadlines, triggers, the director and the hourly snapshot.
    pub fn tick(&mut self, now: i64, real_seconds: f64, dice: &mut dyn Dice, out: &mut Out) {
        if self.state != WarState::Running {
            return;
        }
        let dt = real_seconds.clamp(0.0, MAX_TICK_SECONDS) * self.speed;
        if dt <= 0.0 {
            return;
        }
        self.war_time += dt;
        out.changed = true;

        if let Some(e) = self.evolved.as_mut() {
            e.tick(self.war_time, dt, now, dice, out);
            let hour = (self.war_time / 3600.0).floor() as i64;
            if hour != self.last_snapshot_hour {
                self.last_snapshot_hour = hour;
                out.snapshot = true;
            }
            return;
        }

        for front in 0..ENEMIES {
            let f = &self.fronts[front];
            if f.status != FrontStatus::Active || self.front_busy(front) {
                continue;
            }
            let p = f.points - f.pressure_per_hour * dt / 3600.0;
            self.set_front_points(front, p, false, out);
        }

        // Deadlines.
        if let Some(i) = self.active_defend_index()
            && self.war_time >= self.defend_events[i].end_war
        {
            let ok = self.defend_events[i].points >= self.defend_events[i].points_max as f64;
            self.resolve_defend(i, ok, now, out);
        }
        let due: Vec<usize> = (0..self.attack_events.len())
            .filter(|&i| {
                self.attack_events[i].active() && self.war_time >= self.attack_events[i].end_war
            })
            .collect();
        for i in due {
            if self.state.ended() {
                break;
            }
            let ok = self.attack_events[i].points >= self.attack_events[i].points_max as f64;
            self.resolve_attack(i, ok, now, out);
        }

        self.check_triggers(now, out);

        // The director.
        if self.state == WarState::Running
            && self.settings.director
            && self.active_defend().is_none()
        {
            let p = 1.0 - (-self.settings.defend_chance_per_hour * dt / 3600.0).exp();
            if dice.next_f64() < p {
                let candidates: Vec<usize> = (0..ENEMIES)
                    .filter(|&e| {
                        let f = &self.fronts[e];
                        f.status == FrontStatus::Active
                            && f.points > 0.0
                            && self.active_attack_on(e).is_none()
                    })
                    .collect();
                if !candidates.is_empty() {
                    let front = candidates[dice.below(candidates.len())];
                    let region = self.fronts[front].region();
                    let (dur, pts) = (self.settings.defend_duration, self.settings.defend_points);
                    let _ = self.start_defend(front, region, dur, pts, now, "director", out);
                }
            }
        }

        let hour = (self.war_time / 3600.0).floor() as i64;
        if hour != self.last_snapshot_hour {
            self.last_snapshot_hour = hour;
            out.snapshot = true;
        }
    }

    /// Starts what the fronts' points call for: the attack on a home world at points_max, the
    /// defense of Super Earth at 0, and the end of the season when every front is defeated.
    pub fn check_triggers(&mut self, now: i64, out: &mut Out) {
        if self.state.ended() {
            return;
        }
        for front in 0..ENEMIES {
            let f = &self.fronts[front];
            if f.status == FrontStatus::Active
                && f.points >= f.points_max as f64
                && self.active_attack_on(front).is_none()
            {
                let (dur, pts) = (self.settings.attack_duration, self.settings.attack_points);
                let _ = self.start_attack(front, dur, pts, now, "war", out);
            }
        }
        if self.active_defend().is_none() {
            let fallen = (0..ENEMIES).find(|&e| {
                self.fronts[e].status == FrontStatus::Active && self.fronts[e].points <= 0.0
            });
            if let Some(front) = fallen {
                let (dur, pts) = (self.settings.defend_duration, self.settings.defend_points);
                let _ = self.start_defend(front, SUPER_EARTH_REGION, dur, pts, now, "war", out);
            }
        }
        let shown: Vec<&Front> = self
            .fronts
            .iter()
            .filter(|f| f.status != FrontStatus::Hidden)
            .collect();
        if !shown.is_empty() && shown.iter().all(|f| f.status == FrontStatus::Defeated) {
            self.end_season(true, now, "war", out);
        }
    }

    // ---- events

    fn new_event(
        &mut self,
        front: usize,
        region: i64,
        duration: f64,
        points_max: i64,
        now: i64,
    ) -> Event {
        let id = self.next_event_id;
        self.next_event_id += 1;
        Event {
            season: self.season,
            event_id: id,
            enemy: front,
            region,
            points: 0.0,
            points_max,
            status: EventStatus::Active,
            start_war: self.war_time,
            end_war: self.war_time + duration,
            start_time: now,
            end_time: now + (duration / self.speed).round() as i64,
            players_at_start: self.recent_players(now),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn start_defend(
        &mut self,
        front: usize,
        region: i64,
        duration: f64,
        points_max: i64,
        now: i64,
        who: &str,
        out: &mut Out,
    ) -> Result<u64, String> {
        if self.state.ended() {
            return Err("the season is over".into());
        }
        if front >= ENEMIES {
            return Err("`front` must be 0, 1 or 2".into());
        }
        if self.active_defend().is_some() {
            return Err("a defense is already running".into());
        }
        if !(0..=10).contains(&region) {
            return Err("`region` must be between 0 and 10".into());
        }
        let e = self.new_event(front, region, duration, points_max, now);
        let id = e.event_id;
        self.defend_events.push(e);
        let key = if region == SUPER_EARTH_REGION {
            "super_earth_defend_started"
        } else {
            "defend_started"
        };
        out.push(
            Feed::new("event", key)
                .front(front)
                .region(region)
                .event(id)
                .player(who),
        );
        out.snapshot = true;
        Ok(id)
    }

    pub fn start_attack(
        &mut self,
        front: usize,
        duration: f64,
        points_max: i64,
        now: i64,
        who: &str,
        out: &mut Out,
    ) -> Result<u64, String> {
        if self.state.ended() {
            return Err("the season is over".into());
        }
        if front >= ENEMIES {
            return Err("`front` must be 0, 1 or 2".into());
        }
        if self.fronts[front].status != FrontStatus::Active {
            return Err("that front isn't active".into());
        }
        if self.active_attack_on(front).is_some() {
            return Err("an attack on that home world is already running".into());
        }
        let e = self.new_event(front, HOME_WORLD_REGION, duration, points_max, now);
        let id = e.event_id;
        self.attack_events.push(e);
        out.push(
            Feed::new("event", "attack_started")
                .front(front)
                .region(HOME_WORLD_REGION)
                .event(id)
                .player(who),
        );
        out.snapshot = true;
        Ok(id)
    }

    fn close_event_times(e: &mut Event, war_time: f64, speed: f64, now: i64) {
        e.start_time = now - ((war_time - e.start_war).max(0.0) / speed).round() as i64;
        e.end_time = now;
    }

    fn resolve_defend(&mut self, i: usize, success: bool, now: i64, out: &mut Out) {
        let (wt, sp) = (self.war_time, self.speed);
        let e = &mut self.defend_events[i];
        if !e.active() {
            return;
        }
        e.status = if success {
            EventStatus::Success
        } else {
            EventStatus::Fail
        };
        Self::close_event_times(e, wt, sp, now);
        let (front, region, id) = (e.enemy, e.region, e.event_id);
        out.snapshot = true;
        if region == SUPER_EARTH_REGION {
            if success {
                out.push(
                    Feed::new("event", "super_earth_held")
                        .front(front)
                        .region(region)
                        .event(id),
                );
                let p = self.fronts[front].region_size();
                self.set_front_points(front, p, false, out);
            } else {
                out.push(
                    Feed::new("event", "super_earth_lost")
                        .front(front)
                        .region(region)
                        .event(id),
                );
                self.end_season(false, now, "war", out);
                return;
            }
        } else if success {
            out.push(
                Feed::new("event", "defend_success")
                    .front(front)
                    .region(region)
                    .event(id),
            );
            let p = self.fronts[front].points + self.settings.defend_reward as f64;
            self.set_front_points(front, p, true, out);
        } else {
            out.push(
                Feed::new("event", "defend_fail")
                    .front(front)
                    .region(region)
                    .event(id),
            );
            let p = self.fronts[front].points - self.fronts[front].region_size();
            self.set_front_points(front, p, false, out);
        }
        self.check_triggers(now, out);
    }

    fn resolve_attack(&mut self, i: usize, success: bool, now: i64, out: &mut Out) {
        let (wt, sp) = (self.war_time, self.speed);
        let e = &mut self.attack_events[i];
        if !e.active() {
            return;
        }
        e.status = if success {
            EventStatus::Success
        } else {
            EventStatus::Fail
        };
        Self::close_event_times(e, wt, sp, now);
        let (front, id) = (e.enemy, e.event_id);
        out.snapshot = true;
        if success {
            out.push(
                Feed::new("event", "attack_success")
                    .front(front)
                    .region(HOME_WORLD_REGION)
                    .event(id),
            );
            let f = &mut self.fronts[front];
            f.points = f.points_max as f64;
            f.status = FrontStatus::Defeated;
            out.push(Feed::new("front", "front_defeated").front(front));
        } else {
            out.push(
                Feed::new("event", "attack_fail")
                    .front(front)
                    .region(HOME_WORLD_REGION)
                    .event(id),
            );
            let p = self.fronts[front].points_max as f64 * 0.8;
            self.set_front_points(front, p, false, out);
        }
        self.check_triggers(now, out);
    }

    /// Ends an event now, with the consequences.
    pub fn end_event(
        &mut self,
        event_id: u64,
        success: bool,
        now: i64,
        out: &mut Out,
    ) -> Result<(), String> {
        if let Some(i) = self
            .defend_events
            .iter()
            .position(|e| e.event_id == event_id && e.active())
        {
            self.resolve_defend(i, success, now, out);
            return Ok(());
        }
        if let Some(i) = self
            .attack_events
            .iter()
            .position(|e| e.event_id == event_id && e.active())
        {
            self.resolve_attack(i, success, now, out);
            return Ok(());
        }
        Err("no running event with that id".into())
    }

    /// Sets event progress; reaching the goal wins it.
    pub fn set_event_points(
        &mut self,
        event_id: u64,
        points: f64,
        now: i64,
        out: &mut Out,
    ) -> Result<(), String> {
        if !points.is_finite() || points < 0.0 {
            return Err("`points` must be 0 or more".into());
        }
        if let Some(i) = self
            .defend_events
            .iter()
            .position(|e| e.event_id == event_id && e.active())
        {
            let e = &mut self.defend_events[i];
            e.points = points.min(e.points_max as f64);
            out.changed = true;
            if e.points >= e.points_max as f64 {
                self.resolve_defend(i, true, now, out);
            }
            return Ok(());
        }
        if let Some(i) = self
            .attack_events
            .iter()
            .position(|e| e.event_id == event_id && e.active())
        {
            let e = &mut self.attack_events[i];
            e.points = points.min(e.points_max as f64);
            out.changed = true;
            if e.points >= e.points_max as f64 {
                self.resolve_attack(i, true, now, out);
            }
            return Ok(());
        }
        Err("no running event with that id".into())
    }

    // ---- seasons

    pub fn end_season(&mut self, won: bool, now: i64, who: &str, out: &mut Out) {
        if self.state.ended() {
            return;
        }
        let (wt, sp) = (self.war_time, self.speed);
        for e in self
            .defend_events
            .iter_mut()
            .chain(self.attack_events.iter_mut())
        {
            if e.active() {
                e.status = EventStatus::Fail;
                Self::close_event_times(e, wt, sp, now);
            }
        }
        self.state = if won { WarState::Won } else { WarState::Lost };
        out.push(
            Feed::new("season", if won { "season_won" } else { "season_lost" })
                .player(who)
                .value(self.shown_season() as f64),
        );
        out.snapshot = true;
    }

    pub fn new_season(&mut self, now: i64, out: &mut Out) {
        let result = match self.state {
            WarState::Won => "won",
            WarState::Lost => "lost",
            _ => "abandoned",
        };
        self.past_seasons.push(PastSeason {
            season: self.season,
            result: result.into(),
            ended: now,
            status_rows: self.status_rows(),
            statistics: self.statistics_rows(now),
            points_max: self.fronts.iter().map(|f| f.points_max).collect(),
            introduction_order: self.fronts.iter().map(|f| f.introduction_order).collect(),
            defend_events: std::mem::take(&mut self.defend_events),
            attack_events: std::mem::take(&mut self.attack_events),
        });
        self.season += 1;
        for f in &mut self.fronts {
            f.points = self.settings.start_points as f64;
            f.points_max = self.settings.points_max;
            f.points_taken = 0.0;
            f.pressure_per_hour = self.settings.pressure_per_hour;
            if f.status == FrontStatus::Defeated {
                f.status = FrontStatus::Active;
            }
        }
        self.stats = vec![EnemyStats::default(); ENEMIES];
        self.state = WarState::Running;
        self.season_start_war = self.war_time;
        self.season_start_time = now;
        out.push(
            Feed::new("season", "season_started")
                .player(GM)
                .value(self.shown_season() as f64),
        );
        out.snapshot = true;
    }

    // ---- settings

    pub fn apply_settings(&mut self, s: Settings, out: &mut Out) {
        let old_max = self.settings.points_max;
        if s.points_max != old_max {
            // Keep each front where it is on the map.
            let scale = s.points_max as f64 / old_max as f64;
            for f in &mut self.fronts {
                f.points = (f.points * scale).clamp(0.0, s.points_max as f64);
                f.points_max = s.points_max;
            }
            out.snapshot = true;
        }
        for f in &mut self.fronts {
            f.pressure_per_hour = s.pressure_per_hour;
        }
        self.settings = s;
        out.changed = true;
    }

    // ---- members and indexes

    /// Records a request from a player. Saves are only asked for when something worth keeping moved.
    pub fn touch_member(&mut self, player: &str, name: Option<&str>, now: i64, out: &mut Out) {
        let name = name
            .map(|n| n.trim())
            .filter(|n| !n.is_empty())
            .map(|n| n.chars().take(64).collect::<String>());
        if let Some(m) = self.members.iter_mut().find(|m| m.player == player) {
            if now - m.last_seen >= 60 {
                out.changed = true;
            }
            m.last_seen = now;
            if name.is_some() && m.name != name {
                m.name = name;
                out.changed = true;
            }
            return;
        }
        self.members.push(Member {
            player: player.into(),
            name,
            first_seen: now,
            last_seen: now,
            missions: 0,
            last_enemy: None,
        });
        out.push(Feed::new("member", "member_joined").player(player));
    }

    /// True when `index` is new for this player and kind (and records it).
    pub fn take_index(&mut self, player: &str, kind: &str, index: i64) -> bool {
        let slot = self
            .indexes
            .entry(player.into())
            .or_default()
            .entry(kind.into())
            .or_insert(i64::MIN);
        if index > *slot {
            *slot = index;
            true
        } else {
            false
        }
    }

    pub fn acked_index(&self, player: &str, kind: &str) -> Option<i64> {
        self.indexes
            .get(player)
            .and_then(|m| m.get(kind))
            .copied()
            .filter(|&i| i != i64::MIN)
    }

    // ---- what the game sends

    /// Whether the in-game uploads move the war. An Evolved war counts only the reports of the
    /// Evolved War Engine mod, which name the planet and the operation.
    fn crediting(&self) -> bool {
        !self.state.ended() && self.evolved.is_none()
    }

    /// A completed planet. `front` is 0-based here: the caller has already turned the 1-based in-game
    /// planet `enemy` into a front.
    pub fn credit_planet(
        &mut self,
        player: &str,
        front: usize,
        difficulty: f64,
        success: f64,
        now: i64,
        out: &mut Out,
    ) -> bool {
        if !self.crediting() || front >= ENEMIES || self.fronts[front].status != FrontStatus::Active
        {
            return false;
        }
        let difficulty = if difficulty.is_finite() {
            difficulty.clamp(0.0, MAX_DIFFICULTY)
        } else {
            0.0
        };
        let success = if success.is_finite() {
            success.clamp(0.0, 1.0)
        } else {
            0.0
        };
        let gain = difficulty * success * self.settings.planet_value;
        self.stats[front].completed_planets += 1;
        out.push(
            Feed::new("mission", "planet_completed")
                .front(front)
                .region(self.fronts[front].region())
                .player(player)
                .value(gain.round()),
        );
        let p = self.fronts[front].points + gain;
        self.set_front_points(front, p, true, out);
        self.check_triggers(now, out);
        true
    }

    pub fn credit_defend_mission(
        &mut self,
        player: &str,
        event_id: u64,
        difficulty: f64,
        now: i64,
        out: &mut Out,
    ) -> bool {
        if !self.crediting() {
            return false;
        }
        let Some(i) = self
            .defend_events
            .iter()
            .position(|e| e.event_id == event_id && e.active())
        else {
            return false;
        };
        let d = if difficulty.is_finite() {
            difficulty.clamp(1.0, MAX_DIFFICULTY)
        } else {
            1.0
        };
        let gain = d * self.settings.defend_mission_value;
        let e = &mut self.defend_events[i];
        e.points = (e.points + gain).min(e.points_max as f64);
        out.push(
            Feed::new("mission", "defend_mission_completed")
                .front(e.enemy)
                .region(e.region)
                .event(event_id)
                .player(player)
                .value(gain.round()),
        );
        if e.points >= e.points_max as f64 {
            self.resolve_defend(i, true, now, out);
        }
        true
    }

    pub fn credit_attack_mission(
        &mut self,
        player: &str,
        event_id: u64,
        difficulty: f64,
        now: i64,
        out: &mut Out,
    ) -> bool {
        if !self.crediting() {
            return false;
        }
        let Some(i) = self
            .attack_events
            .iter()
            .position(|e| e.event_id == event_id && e.active())
        else {
            return false;
        };
        let d = if difficulty.is_finite() {
            difficulty.clamp(1.0, MAX_DIFFICULTY)
        } else {
            1.0
        };
        let gain = d * self.settings.attack_mission_value;
        let e = &mut self.attack_events[i];
        e.points = (e.points + gain).min(e.points_max as f64);
        out.push(
            Feed::new("mission", "attack_mission_completed")
                .front(e.enemy)
                .region(e.region)
                .event(event_id)
                .player(player)
                .value(gain.round()),
        );
        if e.points >= e.points_max as f64 {
            self.resolve_attack(i, true, now, out);
        }
        true
    }

    /// One statistics row from `upload_statistics` (`enemy` 0-based).
    pub fn add_statistics(&mut self, player: &str, row: &Map<String, Value>, out: &mut Out) {
        let num = |k: &str| {
            row.get(k)
                .and_then(Value::as_f64)
                .filter(|v| v.is_finite() && *v >= 0.0)
                .map(|v| v as i64)
                .unwrap_or(0)
        };
        let Some(front) = row
            .get("enemy")
            .and_then(Value::as_i64)
            .filter(|e| (0..ENEMIES as i64).contains(e))
        else {
            return;
        };
        let front = front as usize;
        let s = &mut self.stats[front];
        let missions = num("missions");
        let won = num("successful_missions");
        s.missions += missions;
        s.successful_missions += won;
        s.total_mission_difficulty += num("mission_difficulty");
        s.kills += num("kills");
        s.deaths += num("deaths");
        s.shots += num("shots");
        s.hits += num("hits");
        s.accidentals += num("accidentals");
        if let Some(m) = self.members.iter_mut().find(|m| m.player == player) {
            m.missions += missions;
            m.last_enemy = Some(front);
        }
        let key = if won > 0 {
            "mission_won"
        } else {
            "mission_lost"
        };
        out.push(
            Feed::new("mission", key)
                .front(front)
                .region(self.fronts[front].region())
                .player(player)
                .value(num("kills") as f64),
        );
    }

    // ---- GM

    pub fn set_points(
        &mut self,
        front: usize,
        points: f64,
        now: i64,
        out: &mut Out,
    ) -> Result<(), String> {
        check_front(front)?;
        if !points.is_finite() || points < 0.0 || points > self.fronts[front].points_max as f64 {
            return Err(format!(
                "`points` must be between 0 and {}",
                self.fronts[front].points_max
            ));
        }
        self.set_front_points(front, points, false, out);
        out.snapshot = true;
        self.check_triggers(now, out);
        Ok(())
    }

    pub fn push(
        &mut self,
        front: usize,
        regions: i64,
        now: i64,
        out: &mut Out,
    ) -> Result<(), String> {
        check_front(front)?;
        if !(-10..=10).contains(&regions) || regions == 0 {
            return Err("`regions` must be a whole number from -10 to 10, not 0".into());
        }
        let p = self.fronts[front].points + regions as f64 * self.fronts[front].region_size();
        self.set_front_points(front, p, false, out);
        out.snapshot = true;
        self.check_triggers(now, out);
        Ok(())
    }

    pub fn set_status(
        &mut self,
        front: usize,
        status: FrontStatus,
        now: i64,
        out: &mut Out,
    ) -> Result<(), String> {
        check_front(front)?;
        let (wt, sp) = (self.war_time, self.speed);
        let old = self.fronts[front].status;
        if old == status {
            return Ok(());
        }
        if status != FrontStatus::Active {
            // Events on a front leaving the war end without consequences.
            for e in self
                .defend_events
                .iter_mut()
                .chain(self.attack_events.iter_mut())
            {
                if e.active() && e.enemy == front {
                    e.status = if status == FrontStatus::Defeated {
                        EventStatus::Success
                    } else {
                        EventStatus::Fail
                    };
                    Self::close_event_times(e, wt, sp, now);
                }
            }
        }
        let f = &mut self.fronts[front];
        f.status = status;
        match status {
            FrontStatus::Defeated => f.points = f.points_max as f64,
            FrontStatus::Active
                if old == FrontStatus::Defeated && f.points >= f.points_max as f64 =>
            {
                f.points = f.points_max as f64 * 0.8;
            }
            _ => {}
        }
        out.changed = true;
        out.snapshot = true;
        let key = match status {
            FrontStatus::Active if old == FrontStatus::Hidden => "front_introduced",
            FrontStatus::Active => "front_reactivated",
            FrontStatus::Defeated => "front_defeated",
            FrontStatus::Hidden => "front_hidden",
        };
        out.push(Feed::new("front", key).front(front).player(GM));
        self.check_triggers(now, out);
        Ok(())
    }

    // ---- views

    /// The fronts as `campaign_status` rows. `shown_season` is extra: the game reads only the fields it knows, and
    /// the Obsidian loader reads it to print the war season in the game texts instead of the game season.
    pub fn status_rows(&self) -> Value {
        Value::Array(
            self.fronts
                .iter()
                .map(|f| {
                    json!({"season": self.season, "shown_season": self.shown_season(), "points": f.points_int(), "points_taken": f.points_taken.floor() as i64,
                           "points_max": f.points_max, "status": f.status.as_str(), "introduction_order": f.introduction_order})
                })
                .collect(),
        )
    }

    /// An event as the game reads it. Running event times are projected from the war clock.
    pub fn event_view(&self, e: &Event, now: i64, attack: bool) -> Value {
        let (start, end) = if e.active() {
            let sp = if self.speed > 0.0 { self.speed } else { 1.0 };
            (
                now - ((self.war_time - e.start_war).max(0.0) / sp).round() as i64,
                now + ((e.end_war - self.war_time).max(0.0) / sp).round() as i64,
            )
        } else {
            (e.start_time, e.end_time)
        };
        let mut v = json!({"season": e.season, "event_id": e.event_id, "start_time": start, "end_time": end,
                           "region": e.region, "enemy": e.enemy, "points_max": e.points_max,
                           "points": e.points.floor() as i64, "status": e.status.as_str(),
                           "players_at_start": e.players_at_start});
        if attack {
            v["max_event_id"] = json!(e.event_id);
        }
        v
    }

    pub fn statistics_rows(&self, now: i64) -> Value {
        let defend = self.defend_events.len();
        let defend_ok = self
            .defend_events
            .iter()
            .filter(|e| e.status == EventStatus::Success)
            .count();
        let attack = self.attack_events.len();
        let attack_ok = self
            .attack_events
            .iter()
            .filter(|e| e.status == EventStatus::Success)
            .count();
        let duration = (self.war_time - self.season_start_war).max(0.0).floor() as i64;
        Value::Array(
            (0..ENEMIES)
                .map(|e| {
                    let s = &self.stats[e];
                    let players = self.members.iter().filter(|m| now - m.last_seen <= 3600 && m.last_enemy == Some(e)).count();
                    json!({"season": self.season, "season_duration": duration, "enemy": e, "players": players,
                           "total_unique_players": self.members.len(), "missions": s.missions,
                           "successful_missions": s.successful_missions, "total_mission_difficulty": s.total_mission_difficulty,
                           "completed_planets": s.completed_planets, "defend_events": defend,
                           "successful_defend_events": defend_ok, "attack_events": attack,
                           "successful_attack_events": attack_ok, "deaths": s.deaths, "kills": s.kills,
                           "accidentals": s.accidentals, "shots": s.shots, "hits": s.hits})
                })
                .collect(),
        )
    }

    /// The latest defense of this season, running or not, as the official server shows it.
    pub fn defend_event_view(&self, now: i64) -> Option<Value> {
        self.defend_events
            .last()
            .map(|e| self.event_view(e, now, false))
    }

    pub fn attack_events_view(&self, now: i64) -> Value {
        Value::Array(
            self.attack_events
                .iter()
                .map(|e| self.event_view(e, now, true))
                .collect(),
        )
    }

    /// The war as the admin API shows it.
    pub fn admin_view(&self, now: i64, lan_open: bool, lan_port: Option<u16>) -> Value {
        let fronts: Vec<Value> = self
            .fronts
            .iter()
            .map(|f| {
                json!({"enemy": f.enemy, "points": f.points_int(), "points_max": f.points_max,
                       "points_taken": f.points_taken.floor() as i64, "status": f.status.as_str(),
                       "introduction_order": f.introduction_order, "region": f.region(),
                       "pressure_per_hour": f.pressure_per_hour})
            })
            .collect();
        let active_defend = self.active_defend().map(|e| self.event_view(e, now, false));
        let members: Vec<Value> = self
            .members
            .iter()
            .map(|m| json!({"player": m.player, "name": m.name, "first_seen": m.first_seen, "last_seen": m.last_seen, "missions": m.missions}))
            .collect();
        json!({
            "id": self.id, "name": self.name, "description": self.description, "logo": self.logo,
            "model": self.model, "season": self.shown_season(), "game_season": self.season, "created": self.created,
            "state": self.state.as_str(), "war_time": self.war_time, "speed": self.speed,
            "fronts": fronts,
            "defend_event": active_defend,
            "defend_events": self.defend_events.iter().map(|e| self.event_view(e, now, false)).collect::<Vec<_>>(),
            "attack_events": self.attack_events_view(now),
            "statistics": self.statistics_rows(now),
            "members": members,
            "settings": self.settings,
            "past_seasons": self.past_seasons.iter().map(|p| json!({"season": self.shown(p.season), "result": p.result, "ended": p.ended})).collect::<Vec<_>>(),
            "evolved": self.evolved.as_ref().map(|e| e.view(self.war_time, self.speed)),
            "lan": {"open": lan_open, "port": if lan_open { lan_port } else { None }},
            "server_time": now,
        })
    }

    pub fn summary(&self, now: i64, lan_open: bool) -> Value {
        json!({
            "id": self.id, "name": self.name, "description": self.description, "logo": self.logo,
            "model": self.model, "season": self.shown_season(), "state": self.state.as_str(),
            "war_time": self.war_time, "created": self.created, "lan": lan_open,
            "players": self.recent_players(now), "members": self.members.len(),
            "fronts": self.fronts.iter().map(|f| json!({"enemy": f.enemy, "region": f.region(), "status": f.status.as_str()})).collect::<Vec<_>>(),
        })
    }
}

fn check_front(front: usize) -> Result<(), String> {
    if front >= ENEMIES {
        Err("`front` must be 0, 1 or 2".into())
    } else {
        Ok(())
    }
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    /// Dice that always roll the same number.
    struct Fixed(f64);
    impl Dice for Fixed {
        fn next_f64(&mut self) -> f64 {
            self.0
        }
    }

    const NOW: i64 = 1_794_258_000;

    fn war() -> War {
        // The rules tests start on the region 2 edge, which their numbers are worked out from.
        let s = Settings {
            director: false,
            start_points: 10_000,
            ..Default::default()
        };
        War::new("test01", "Test", s, NOW, &mut Fixed(0.5)).0
    }

    #[test]
    fn a_new_war_starts_mid_region_so_pressure_doesnt_cross_an_edge_at_once() {
        let (mut w, _) = War::new(
            "test02",
            "Test",
            Settings {
                director: false,
                ..Default::default()
            },
            NOW,
            &mut Fixed(0.5),
        );
        assert_eq!(w.fronts[0].points_int(), 15_000);
        let out = run(&mut w, 600.0);
        assert_eq!(w.fronts[0].region(), 2);
        assert!(out.feed.is_empty() || !format!("{:?}", out.feed).contains("region_lost"));
    }

    fn run(w: &mut War, seconds: f64) -> Out {
        let mut out = Out::default();
        let mut t = 0.0;
        while t < seconds {
            let step = (seconds - t).min(5.0);
            w.tick(NOW + t as i64, step, &mut Fixed(0.99), &mut out);
            t += step;
        }
        out
    }

    #[test]
    fn region_math_matches_the_game() {
        assert_eq!(region_of(0, 100_000), 1);
        assert_eq!(region_of(9_999, 100_000), 1);
        assert_eq!(region_of(10_000, 100_000), 2);
        assert_eq!(region_of(23_000, 100_000), 3);
        assert_eq!(region_of(99_999, 100_000), 10);
        assert_eq!(region_of(100_000, 100_000), 10);
        assert_eq!(region_of(-5, 100_000), 1);
        // The official season 162 cyborg front: 111448 of 158490.
        assert_eq!(region_of(111_448, 158_490), 8);
    }

    #[test]
    fn new_war_starts_in_region_two() {
        let w = war();
        assert!((1000..=9999).contains(&w.season));
        for f in &w.fronts {
            assert_eq!(f.points_int(), 10_000);
            assert_eq!(f.region(), 2);
            assert_eq!(f.status, FrontStatus::Active);
        }
    }

    #[test]
    fn pressure_costs_points_per_war_hour() {
        let mut w = war();
        let out = run(&mut w, 3600.0);
        assert!((w.war_time - 3600.0).abs() < 1e-6);
        for f in &w.fronts {
            assert!((f.points - 9_400.0).abs() < 1e-6, "{}", f.points);
        }
        // Region 2 to region 1 for every front.
        assert_eq!(
            out.feed
                .iter()
                .filter(|f| f.text_key == "region_lost")
                .count(),
            3
        );
        assert!(out.snapshot);
    }

    #[test]
    fn speed_and_tick_cap() {
        let mut w = war();
        w.speed = 2.0;
        let mut out = Out::default();
        w.tick(NOW, 600.0, &mut Fixed(0.99), &mut out); // capped at 60 real seconds
        assert!((w.war_time - 120.0).abs() < 1e-9);
        w.state = WarState::Paused;
        w.tick(NOW, 5.0, &mut Fixed(0.99), &mut out);
        assert!((w.war_time - 120.0).abs() < 1e-9);
    }

    #[test]
    fn no_pressure_on_a_front_with_an_event() {
        let mut w = war();
        let mut out = Out::default();
        w.start_defend(0, 2, 14_400.0, 3000, NOW, "gm", &mut out)
            .unwrap();
        run(&mut w, 3600.0);
        assert_eq!(w.fronts[0].points_int(), 10_000);
        assert_eq!(w.fronts[1].points_int(), 9_400);
    }

    #[test]
    fn planets_credit_and_cap() {
        let mut w = war();
        let mut out = Out::default();
        assert!(w.credit_planet("p", 1, 4.0, 0.5, NOW, &mut out));
        assert_eq!(w.fronts[1].points_int(), 10_500);
        assert_eq!(w.fronts[1].points_taken as i64, 500);
        assert_eq!(w.stats[1].completed_planets, 1);
        w.fronts[2].points = 99_900.0;
        w.credit_planet("p", 2, 100.0, 1.0, NOW, &mut out);
        assert_eq!(w.fronts[2].points_int(), 100_000);
        // Reaching points_max opens the attack on the home world.
        assert!(w.active_attack_on(2).is_some());
    }

    #[test]
    fn defend_event_success_pays_the_reward() {
        let mut w = war();
        let mut out = Out::default();
        let id = w
            .start_defend(0, 2, 14_400.0, 3000, NOW, "gm", &mut out)
            .unwrap();
        for _ in 0..9 {
            w.credit_defend_mission("p", id, 2.0, NOW, &mut out);
        }
        assert_eq!(w.active_defend().unwrap().points as i64, 2700);
        w.credit_defend_mission("p", id, 2.0, NOW, &mut out);
        assert!(w.active_defend().is_none());
        assert_eq!(w.defend_events[0].status, EventStatus::Success);
        assert_eq!(w.fronts[0].points_int(), 13_000);
    }

    #[test]
    fn defend_event_fail_costs_a_region() {
        let mut w = war();
        w.fronts[0].points = 25_000.0;
        let mut out = Out::default();
        w.start_defend(0, 3, 3600.0, 3000, NOW, "gm", &mut out)
            .unwrap();
        let out = run(&mut w, 3600.0);
        assert_eq!(w.defend_events[0].status, EventStatus::Fail);
        assert_eq!(w.fronts[0].points_int(), 15_000);
        assert!(out.feed.iter().any(|f| f.text_key == "defend_fail"));
    }

    #[test]
    fn only_one_defense_at_a_time() {
        let mut w = war();
        let mut out = Out::default();
        w.start_defend(0, 2, 3600.0, 3000, NOW, "gm", &mut out)
            .unwrap();
        assert!(
            w.start_defend(1, 2, 3600.0, 3000, NOW, "gm", &mut out)
                .is_err()
        );
    }

    #[test]
    fn director_starts_a_defense() {
        let mut w = war();
        w.settings.director = true;
        let mut out = Out::default();
        w.tick(NOW, 5.0, &mut Fixed(0.0), &mut out);
        let e = w.active_defend().expect("a defense");
        assert_eq!(e.region, w.fronts[e.enemy].region());
        assert_eq!(e.points_max, 3000);
        assert!((e.end_war - e.start_war - 14_400.0).abs() < 1e-9);
    }

    #[test]
    fn super_earth_defense_then_loss() {
        let mut w = war();
        w.fronts[1].points = 10.0;
        w.tick(NOW, 60.0, &mut Fixed(0.99), &mut Out::default());
        let e = w.active_defend().expect("Super Earth defense");
        assert_eq!(e.region, SUPER_EARTH_REGION);
        assert_eq!(e.enemy, 1);
        let out = run(&mut w, 14_400.0);
        assert_eq!(w.state, WarState::Lost);
        assert!(out.feed.iter().any(|f| f.text_key == "super_earth_lost"));
        assert!(out.feed.iter().any(|f| f.text_key == "season_lost"));
        // A lost war stops.
        let t = w.war_time;
        run(&mut w, 60.0);
        assert_eq!(w.war_time, t);
    }

    #[test]
    fn super_earth_held_restores_a_region() {
        let mut w = war();
        let mut out = Out::default();
        w.set_points(1, 0.0, NOW, &mut out).unwrap();
        let id = w.active_defend().unwrap().event_id;
        w.end_event(id, true, NOW, &mut out).unwrap();
        assert_eq!(w.fronts[1].points_int(), 10_000);
        assert_eq!(w.state, WarState::Running);
    }

    #[test]
    fn attack_win_defeats_the_front_and_fail_drops_it() {
        let mut w = war();
        let mut out = Out::default();
        w.set_points(0, 100_000.0, NOW, &mut out).unwrap();
        let id = w.active_attack_on(0).unwrap().event_id;
        assert_eq!(w.active_attack_on(0).unwrap().region, HOME_WORLD_REGION);
        for _ in 0..(5000 / 300) {
            w.credit_attack_mission("p", id, 2.0, NOW, &mut out);
        }
        assert!(w.active_attack_on(0).is_some());
        w.credit_attack_mission("p", id, 2.0, NOW, &mut out);
        assert_eq!(w.fronts[0].status, FrontStatus::Defeated);
        assert_eq!(w.attack_events[0].status, EventStatus::Success);

        w.set_points(1, 100_000.0, NOW, &mut out).unwrap();
        let out = run(&mut w, 21_600.0);
        assert_eq!(w.attack_events[1].status, EventStatus::Fail);
        assert_eq!(w.fronts[1].status, FrontStatus::Active);
        assert!(w.fronts[1].points_int() <= 80_000 && w.fronts[1].points_int() > 79_000);
        assert!(out.feed.iter().any(|f| f.text_key == "attack_fail"));
    }

    #[test]
    fn season_won_when_every_front_falls_and_new_season_resets() {
        let mut w = war();
        let mut out = Out::default();
        w.set_status(2, FrontStatus::Hidden, NOW, &mut out).unwrap();
        for front in 0..2 {
            w.set_points(front, 100_000.0, NOW, &mut out).unwrap();
            let id = w.active_attack_on(front).unwrap().event_id;
            w.end_event(id, true, NOW, &mut out).unwrap();
        }
        assert_eq!(w.state, WarState::Won);
        assert!(out.feed.iter().any(|f| f.text_key == "season_won"));
        let season = w.season;
        w.new_season(NOW + 10, &mut out);
        assert_eq!(w.season, season + 1);
        assert_eq!(w.state, WarState::Running);
        assert_eq!(w.fronts[0].status, FrontStatus::Active);
        assert_eq!(w.fronts[2].status, FrontStatus::Hidden);
        assert_eq!(w.fronts[0].points_int(), 10_000);
        assert!(w.attack_events.is_empty());
        assert_eq!(w.past_seasons[0].result, "won");
    }

    #[test]
    fn people_see_seasons_from_one_and_the_game_its_own() {
        let mut w = war();
        let game = w.season;
        assert!(
            game >= 1000,
            "the game season stays apart from the official ones"
        );
        assert_eq!(w.shown_season(), 1);
        let mut out = Out::default();
        w.new_season(NOW, &mut out);
        w.new_season(NOW, &mut out);
        assert_eq!(w.season, game + 2);
        assert_eq!(w.shown_season(), 3);
        assert_eq!(w.shown(w.past_seasons[0].season), 1);
        let started: Vec<f64> = out
            .feed
            .iter()
            .filter(|f| f.text_key == "season_started")
            .filter_map(|f| f.value)
            .collect();
        assert_eq!(started, [2.0, 3.0], "the feed counts as people do");
        let rows = w.status_rows();
        assert_eq!(rows[0]["season"], game + 2, "the game keeps the game season");
        assert_eq!(rows[0]["shown_season"], 3, "the loader shows the war season");
        // A war from before first_season counts back from the seasons it keeps.
        w.first_season = None;
        assert_eq!(w.shown_season(), 3);
        let old: War = serde_json::from_value({
            let mut v = serde_json::to_value(&w).unwrap();
            v.as_object_mut().unwrap().remove("first_season");
            v.as_object_mut().unwrap().remove("description");
            v.as_object_mut().unwrap().remove("logo");
            v
        })
        .unwrap();
        assert_eq!(old.shown_season(), 3);
        assert_eq!(old.description, "");
    }

    #[test]
    fn index_dedupe() {
        let mut w = war();
        assert!(w.take_index("a", "planets", 1));
        assert!(!w.take_index("a", "planets", 1));
        assert!(w.take_index("b", "planets", 1));
        assert!(w.take_index("a", "statistics", 1));
        assert!(w.take_index("a", "planets", 3));
        assert!(!w.take_index("a", "planets", 2));
        assert_eq!(w.acked_index("a", "planets"), Some(3));
    }

    #[test]
    fn settings_validation() {
        let s = Settings::default();
        let m: Map<String, Value> =
            serde_json::from_str(r#"{"planet_value": 300, "points_max": 50000.0}"#).unwrap();
        let ok = s.patched(&m).unwrap();
        assert_eq!(ok.planet_value, 300.0);
        assert_eq!(ok.points_max, 50_000);
        for bad in [
            r#"{"points_max": -1}"#,
            r#"{"start_points": 200000}"#,
            r#"{"defend_duration": 0}"#,
            r#"{"planet_value": "lots"}"#,
            r#"{"nonsense": 1}"#,
            r#"{"points_max": 1000.5}"#,
            r#"{"director": 3}"#,
        ] {
            let m: Map<String, Value> = serde_json::from_str(bad).unwrap();
            assert!(s.patched(&m).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn running_event_times_follow_the_war_clock() {
        let mut w = war();
        let mut out = Out::default();
        w.start_defend(0, 2, 3600.0, 3000, NOW, "gm", &mut out)
            .unwrap();
        w.war_time += 600.0;
        let v = w.event_view(w.active_defend().unwrap(), NOW + 9999, false);
        assert_eq!(v["start_time"], json!(NOW + 9999 - 600));
        assert_eq!(v["end_time"], json!(NOW + 9999 + 3000));
    }
}
