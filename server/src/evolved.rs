//! The Evolved war: a HELLDIVERS 2-style war on the HELLDIVERS 2 galaxy map, played in HELLDIVERS
//! (2015) through the Evolved War Engine mod. See docs/evolved.md.
//!
//! - Planets belong to Super Earth or to one of the three enemies. Supply lines link them, and only a
//!   planet linked to a Super Earth planet can be attacked.
//! - A **liberation** campaign runs on an enemy planet: won missions lower the enemy hold, the enemy
//!   regains some every hour, and at 0 the planet is liberated.
//! - A **defense** campaign runs on a Super Earth planet under attack: won missions fill a bar before
//!   a deadline, or the planet falls.
//! - Each campaign offers **operations**: a set of 2 or 3 HELLDIVERS missions on that planet (the
//!   game already plays a planet as several missions in a row). Finishing every mission of an
//!   operation counts extra, and a fresh operation takes its place.
//! - **Major Orders** give the war a goal and a deadline. The **director** opens campaigns, sends
//!   enemy attacks and issues orders when the GM doesn't.
//!
//! Like the Vanilla rules, nothing here does I/O or reads a clock: callers pass the war time (in
//! seconds), the real time for the news, and the dice.

#![allow(clippy::too_many_arguments)]

use crate::rules::{Dice, Out};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::sync::OnceLock;

pub const SUPER_EARTH: u8 = 0;
pub const FACTIONS: [&str; 4] = ["superearth", "bugs", "cyborgs", "illuminates"];
const FACTION_NAMES: [&str; 4] = ["Super Earth", "Bug", "Cyborg", "Illuminate"];
pub const GALAXY_JSON: &str = include_str!("../../data/galaxy-hd2.json");
const NEWS_KEPT: usize = 60;
const CREDITED_KEPT: usize = 4000;
const OPERATIONS_PER_CAMPAIGN: usize = 3;
const MAX_DIFFICULTY: u8 = 15;
const HOUR: f64 = 3600.0;

// ---------------------------------------------------------------- the map

#[derive(Deserialize)]
struct GalaxyFile {
    galaxy: String,
    version: u32,
    planets: Vec<GPlanet>,
    sectors: Vec<GSector>,
    links: Vec<[usize; 2]>,
    #[serde(default)]
    homes: BTreeMap<String, usize>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct GPlanet {
    pub id: usize,
    pub name: String,
    pub sector: usize,
    pub x: f64,
    pub y: f64,
    pub biome: String,
    /// The HELLDIVERS environment: 0 desert, 1 forest, 2 snow, 3 lava, 4 city.
    pub env: u8,
    /// Owner at the start of a war.
    pub owner: u8,
}

#[derive(Clone, Debug, Deserialize)]
pub struct GSector {
    pub id: usize,
    pub name: String,
    pub planets: Vec<usize>,
}

pub struct Galaxy {
    pub id: String,
    pub version: u32,
    pub planets: Vec<GPlanet>,
    pub sectors: Vec<GSector>,
    pub adj: Vec<Vec<usize>>,
    /// The home world of each enemy, by faction.
    pub homes: [Option<usize>; 4],
}

impl Galaxy {
    fn parse(text: &str) -> Galaxy {
        let f: GalaxyFile = serde_json::from_str(text).expect("data/galaxy-hd2.json");
        let mut adj = vec![vec![]; f.planets.len()];
        for [a, b] in &f.links {
            adj[*a].push(*b);
            adj[*b].push(*a);
        }
        let mut homes = [None; 4];
        for (name, p) in &f.homes {
            if let Some(i) = FACTIONS.iter().position(|n| n == name) {
                homes[i] = Some(*p);
            }
        }
        Galaxy { id: f.galaxy, version: f.version, planets: f.planets, sectors: f.sectors, adj, homes }
    }

    pub fn is_home(&self, planet: usize) -> bool {
        self.homes.contains(&Some(planet))
    }

    /// Planet difficulty before a campaign changes it: harder the further from Super Earth.
    pub fn base_difficulty(&self, planet: usize) -> u8 {
        if self.is_home(planet) {
            return 14;
        }
        let p = &self.planets[planet];
        let r = (p.x * p.x + p.y * p.y).sqrt();
        (2.0 + r * 11.0).round().clamp(1.0, 13.0) as u8
    }
}

pub fn galaxy() -> &'static Galaxy {
    static G: OnceLock<Galaxy> = OnceLock::new();
    G.get_or_init(|| Galaxy::parse(GALAXY_JSON))
}

// ---------------------------------------------------------------- settings

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct EvoSettings {
    /// Liberation campaigns the director keeps open.
    pub campaigns: u32,
    /// Won missions (at difficulty 5) that take an enemy planet from 0% to 100% liberated.
    pub liberation_missions: f64,
    /// Liberation the enemy regains each hour on a planet under a liberation campaign, in percent.
    pub regen_per_hour: f64,
    /// How long a defense campaign lasts, in hours of war time.
    pub defense_hours: f64,
    /// Won missions (at difficulty 5) that hold a planet under attack.
    pub defense_missions: f64,
    /// Average hours between the attacks of each enemy.
    pub attack_hours: f64,
    /// How long a Major Order from the director lasts, in hours.
    pub order_hours: f64,
    /// The director opens campaigns, sends attacks and issues orders.
    pub director: bool,
}

impl Default for EvoSettings {
    fn default() -> Self {
        EvoSettings {
            campaigns: 3,
            liberation_missions: 10.0,
            regen_per_hour: 1.0,
            defense_hours: 24.0,
            defense_missions: 5.0,
            attack_hours: 30.0,
            order_hours: 72.0,
            director: true,
        }
    }
}

impl EvoSettings {
    pub fn patched(&self, patch: &Map<String, Value>) -> Result<EvoSettings, String> {
        let mut v = serde_json::to_value(self).map_err(|e| e.to_string())?;
        let obj = v.as_object_mut().expect("settings object");
        for (k, val) in patch {
            if !obj.contains_key(k) {
                return Err(format!("unknown setting `{k}`"));
            }
            obj.insert(k.clone(), val.clone());
        }
        let s: EvoSettings = serde_json::from_value(v).map_err(|e| format!("bad setting: {e}"))?;
        s.validate()?;
        Ok(s)
    }

    pub fn validate(&self) -> Result<(), String> {
        let ranges: [(&str, f64, f64, f64); 7] = [
            ("campaigns", self.campaigns as f64, 0.0, 12.0),
            ("liberation_missions", self.liberation_missions, 1.0, 10_000.0),
            ("regen_per_hour", self.regen_per_hour, 0.0, 100.0),
            ("defense_hours", self.defense_hours, 0.25, 720.0),
            ("defense_missions", self.defense_missions, 1.0, 10_000.0),
            ("attack_hours", self.attack_hours, 1.0, 2_000.0),
            ("order_hours", self.order_hours, 1.0, 2_000.0),
        ];
        for (k, v, lo, hi) in ranges {
            if !v.is_finite() || v < lo || v > hi {
                return Err(format!("`{k}` must be between {lo} and {hi}"));
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------- state

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CampaignKind {
    Liberation,
    Defense,
}

impl CampaignKind {
    pub fn as_str(self) -> &'static str {
        match self {
            CampaignKind::Liberation => "liberation",
            CampaignKind::Defense => "defense",
        }
    }
}

/// One HELLDIVERS mission of an operation. The game builds the mission seed from the planet
/// (environment, variant, shading, enemy), the difficulty, `kind` and `random`, so every player
/// who builds it gets the same mission.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Mission {
    /// DifficultySettings.mission_type_lookup, 0-based: 0 a mission, 2 an extermination.
    pub kind: u8,
    pub random: u32,
    /// Time of day: 0 dawn, 1 day, 2 dusk, 3 night.
    pub tod: u8,
    pub done: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Operation {
    pub id: u64,
    pub name: String,
    pub difficulty: u8,
    /// Where it sits on the planet, in degrees.
    pub lat: f64,
    pub lon: f64,
    /// The planet record seed (1 to 1000), environment variant and shading the game reads.
    pub seed: u32,
    pub variant: u8,
    pub shading: u8,
    pub missions: Vec<Mission>,
}

impl Operation {
    pub fn complete(&self) -> bool {
        self.missions.iter().all(|m| m.done)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Campaign {
    pub id: u64,
    pub planet: usize,
    pub kind: CampaignKind,
    /// The enemy faction (1 to 3).
    pub faction: u8,
    pub started: f64,
    /// Defense deadline, in war time.
    #[serde(default)]
    pub ends: Option<f64>,
    /// Defense progress, 0 to 1.
    #[serde(default)]
    pub progress: f64,
    pub operations: Vec<Operation>,
    #[serde(default)]
    pub missions_won: u32,
    #[serde(default)]
    pub missions_lost: u32,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OrderKind {
    /// Every listed planet held by Super Earth at the deadline, or sooner.
    Liberate,
    /// No listed planet lost before the deadline.
    Defend,
    /// `target` missions won against `faction` (0: any enemy).
    Missions,
}

impl OrderKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "liberate" => Some(OrderKind::Liberate),
            "defend" => Some(OrderKind::Defend),
            "missions" => Some(OrderKind::Missions),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Order {
    pub id: u64,
    pub kind: OrderKind,
    #[serde(default)]
    pub planets: Vec<usize>,
    #[serde(default)]
    pub faction: u8,
    #[serde(default)]
    pub target: f64,
    #[serde(default)]
    pub progress: f64,
    pub brief: String,
    pub issued: f64,
    pub ends: f64,
    /// active, won or failed.
    pub state: String,
    pub by: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct News {
    pub id: u64,
    pub time: i64,
    pub war_time: f64,
    pub kind: String,
    pub text: String,
    #[serde(default)]
    pub planet: Option<usize>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct EvoStats {
    pub missions_won: u64,
    pub missions_lost: u64,
    pub operations: u64,
    pub kills: u64,
    pub deaths: u64,
    pub liberated: u64,
    pub lost: u64,
    pub defended: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Evolved {
    pub galaxy: String,
    pub owners: Vec<u8>,
    /// The owner hold on each planet, 0 to 1. Liberation of an enemy planet is 1 minus this.
    pub health: Vec<f64>,
    pub campaigns: Vec<Campaign>,
    pub orders: Vec<Order>,
    pub news: Vec<News>,
    pub next_id: u64,
    /// Reports already counted (lobby or player, operation, mission).
    #[serde(default)]
    pub credited: Vec<String>,
    /// War time each enemy may attack next (index 0 unused).
    pub next_attack: Vec<f64>,
    #[serde(default)]
    pub settings: EvoSettings,
    #[serde(default)]
    pub stats: EvoStats,
}

/// A mission result from the mod.
#[derive(Clone, Debug, Deserialize)]
pub struct Report {
    pub campaign: u64,
    pub operation: u64,
    pub mission: usize,
    pub success: bool,
    #[serde(default)]
    pub lobby: String,
    #[serde(default)]
    pub kills: f64,
    #[serde(default)]
    pub deaths: f64,
}

const ADJECTIVES: [&str; 24] = [
    "Swift", "Iron", "Silent", "Burning", "Righteous", "Steel", "Crimson", "Bright", "Valiant", "Stern",
    "Gilded", "Patient", "Thundering", "Lawful", "Eternal", "Glorious", "Vigilant", "Unyielding", "Radiant",
    "Steadfast", "Rolling", "Sudden", "Sovereign", "Honest",
];
const NOUNS: [&str; 24] = [
    "Hammer", "Vigil", "Spear", "Liberty", "Anvil", "Harvest", "Lance", "Bastion", "Tide", "Dawn", "Verdict",
    "Mandate", "Charter", "Torch", "Sentinel", "Ballot", "Citadel", "Covenant", "Banner", "Retribution",
    "Thunder", "Mercy", "Justice", "Freedom",
];

fn faction_name(f: u8) -> &'static str {
    FACTION_NAMES.get(f as usize).copied().unwrap_or("Enemy")
}

fn hd1_missions(difficulty: u8, dice: &mut dyn Dice) -> usize {
    // DifficultySettings.planet_missions_by_difficulty.
    match difficulty {
        0..=3 => 2,
        4..=6 => 2 + dice.below(2),
        _ => 3,
    }
}

/// Percent of a planet one won mission at `difficulty` is worth, against `missions` won missions at
/// difficulty 5 for a whole planet.
pub fn mission_value(difficulty: u8) -> f64 {
    0.6 + 0.08 * difficulty.clamp(1, MAX_DIFFICULTY) as f64
}

impl Evolved {
    pub fn new(settings: EvoSettings) -> Evolved {
        let g = galaxy();
        Evolved {
            galaxy: g.id.clone(),
            owners: g.planets.iter().map(|p| p.owner).collect(),
            health: vec![1.0; g.planets.len()],
            campaigns: vec![],
            orders: vec![],
            news: vec![],
            next_id: 1,
            credited: vec![],
            next_attack: vec![0.0; 4],
            settings,
            stats: EvoStats::default(),
        }
    }

    /// A new war: the first attacks wait a few hours, then the director opens the first campaigns
    /// and issues the first order.
    pub fn start(&mut self, war_time: f64, now: i64, dice: &mut dyn Dice, out: &mut Out) {
        for at in self.next_attack.iter_mut().skip(1) {
            *at = war_time + self.settings.attack_hours * HOUR * (0.25 + 0.5 * dice.next_f64());
        }
        self.add_news(now, war_time, "war", "The Galactic War has begun. Super Earth calls every Helldiver to the front.".into(), None);
        self.direct(war_time, now, dice, out);
        out.changed = true;
    }

    fn take_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn add_news(&mut self, now: i64, war_time: f64, kind: &str, text: String, planet: Option<usize>) {
        let id = self.take_id();
        self.news.push(News { id, time: now, war_time, kind: kind.into(), text, planet });
        if self.news.len() > NEWS_KEPT {
            let cut = self.news.len() - NEWS_KEPT;
            self.news.drain(..cut);
        }
    }

    pub fn planet_name(&self, p: usize) -> &'static str {
        &galaxy().planets[p].name
    }

    pub fn campaign_on(&self, planet: usize) -> Option<&Campaign> {
        self.campaigns.iter().find(|c| c.planet == planet)
    }

    /// Enemy planets of `faction` (0: any enemy) linked to a Super Earth planet.
    pub fn frontline(&self, faction: u8) -> Vec<usize> {
        let g = galaxy();
        (0..g.planets.len())
            .filter(|&p| {
                let o = self.owners[p];
                o != SUPER_EARTH
                    && (faction == 0 || o == faction)
                    && g.adj[p].iter().any(|&q| self.owners[q] == SUPER_EARTH)
            })
            .collect()
    }

    /// Super Earth planets linked to a planet of `faction`.
    pub fn exposed(&self, faction: u8) -> Vec<usize> {
        let g = galaxy();
        (0..g.planets.len())
            .filter(|&p| self.owners[p] == SUPER_EARTH && g.adj[p].iter().any(|&q| self.owners[q] == faction))
            .collect()
    }

    fn new_operation(&mut self, planet: usize, difficulty: u8, dice: &mut dyn Dice, taken: &[(f64, f64)]) -> Operation {
        let g = galaxy();
        let mut difficulty = difficulty.clamp(1, MAX_DIFFICULTY);
        // The game keeps snow and city planets off the three easiest difficulties.
        if difficulty <= 3 && matches!(g.planets[planet].env, 2 | 4) {
            difficulty = 4;
        }
        let n = hd1_missions(difficulty, dice);
        let extermination = if difficulty >= 4 && dice.next_f64() < 0.33 { Some(dice.below(n)) } else { None };
        let missions = (0..n)
            .map(|i| Mission {
                kind: if extermination == Some(i) { 2 } else { 0 },
                random: (dice.next_f64() * 2_147_483_646.0) as u32,
                tod: dice.below(4) as u8,
                done: false,
            })
            .collect();
        // Spread over the planet, apart from the others.
        let (mut lat, mut lon) = (0.0, 0.0);
        for _ in 0..24 {
            lat = -55.0 + 110.0 * dice.next_f64();
            lon = -180.0 + 360.0 * dice.next_f64();
            if taken.iter().all(|&(a, b)| angle_between(lat, lon, a, b) > 42.0) {
                break;
            }
        }
        let name = format!(
            "Operation {} {}",
            ADJECTIVES[dice.below(ADJECTIVES.len())],
            NOUNS[dice.below(NOUNS.len())]
        );
        Operation {
            id: self.take_id(),
            name,
            difficulty,
            lat: (lat * 10.0f64).round() / 10.0,
            lon: (lon * 10.0f64).round() / 10.0,
            seed: 1 + dice.below(1000) as u32,
            variant: dice.below(3) as u8,
            shading: dice.below(3) as u8,
            missions,
        }
    }

    /// Fills each campaign up to its operations: one easier than the planet, one at it, one harder.
    fn fill_operations(&mut self, dice: &mut dyn Dice) {
        let g = galaxy();
        for ci in 0..self.campaigns.len() {
            while self.campaigns[ci].operations.len() < OPERATIONS_PER_CAMPAIGN {
                let c = &self.campaigns[ci];
                let base = g.base_difficulty(c.planet) as i32 + if c.kind == CampaignKind::Defense { 1 } else { 0 };
                let used: Vec<i32> = c.operations.iter().map(|o| o.difficulty as i32).collect();
                let offsets = [-2, 0, 2];
                let pick = offsets
                    .iter()
                    .map(|o| base + o)
                    .find(|d| !used.contains(&(*d).clamp(1, MAX_DIFFICULTY as i32)))
                    .unwrap_or(base);
                let taken: Vec<(f64, f64)> = c.operations.iter().map(|o| (o.lat, o.lon)).collect();
                let planet = c.planet;
                let op = self.new_operation(planet, pick.clamp(1, MAX_DIFFICULTY as i32) as u8, dice, &taken);
                self.campaigns[ci].operations.push(op);
            }
            self.campaigns[ci].operations.sort_by_key(|o| o.difficulty);
        }
    }

    pub fn start_liberation(&mut self, planet: usize, war_time: f64, now: i64, dice: &mut dyn Dice, out: &mut Out) -> Result<u64, String> {
        let g = galaxy();
        if planet >= g.planets.len() {
            return Err("no such planet".into());
        }
        let owner = self.owners[planet];
        if owner == SUPER_EARTH {
            return Err(format!("{} is held by Super Earth", self.planet_name(planet)));
        }
        if self.campaign_on(planet).is_some() {
            return Err(format!("{} already has a campaign", self.planet_name(planet)));
        }
        let id = self.take_id();
        self.campaigns.push(Campaign {
            id,
            planet,
            kind: CampaignKind::Liberation,
            faction: owner,
            started: war_time,
            ends: None,
            progress: 0.0,
            operations: vec![],
            missions_won: 0,
            missions_lost: 0,
        });
        let text = format!(
            "Liberation of {} begins. Drive the {} forces out of the {} sector.",
            self.planet_name(planet),
            faction_name(owner),
            g.sectors[g.planets[planet].sector].name
        );
        self.add_news(now, war_time, "campaign", text, Some(planet));
        self.fill_operations(dice);
        out.changed = true;
        Ok(id)
    }

    pub fn start_defense(&mut self, planet: usize, faction: u8, hours: f64, war_time: f64, now: i64, dice: &mut dyn Dice, out: &mut Out) -> Result<u64, String> {
        let g = galaxy();
        if planet >= g.planets.len() {
            return Err("no such planet".into());
        }
        if !(1..=3).contains(&faction) {
            return Err("`faction` must be 1 (bugs), 2 (cyborgs) or 3 (illuminates)".into());
        }
        if self.owners[planet] != SUPER_EARTH {
            return Err(format!("{} isn't held by Super Earth", self.planet_name(planet)));
        }
        if self.campaign_on(planet).is_some() {
            return Err(format!("{} already has a campaign", self.planet_name(planet)));
        }
        let id = self.take_id();
        self.campaigns.push(Campaign {
            id,
            planet,
            kind: CampaignKind::Defense,
            faction,
            started: war_time,
            ends: Some(war_time + hours * HOUR),
            progress: 0.0,
            operations: vec![],
            missions_won: 0,
            missions_lost: 0,
        });
        let text = format!(
            "{} forces attack {}. Hold the planet for {} hours.",
            faction_name(faction),
            self.planet_name(planet),
            hours.round()
        );
        self.add_news(now, war_time, "attack", text, Some(planet));
        self.fill_operations(dice);
        out.changed = true;
        Ok(id)
    }

    fn remove_campaign(&mut self, id: u64) -> Option<Campaign> {
        let i = self.campaigns.iter().position(|c| c.id == id)?;
        Some(self.campaigns.remove(i))
    }

    fn liberate(&mut self, planet: usize, war_time: f64, now: i64) {
        let from = self.owners[planet];
        self.owners[planet] = SUPER_EARTH;
        self.health[planet] = 1.0;
        if let Some(c) = self.campaign_on(planet).map(|c| c.id) {
            self.remove_campaign(c);
        }
        self.stats.liberated += 1;
        let text = if galaxy().is_home(planet) {
            format!("{} has fallen. The {} home world is liberated.", self.planet_name(planet), faction_name(from))
        } else {
            format!("{} is liberated from the {} forces.", self.planet_name(planet), faction_name(from))
        };
        self.add_news(now, war_time, "liberated", text, Some(planet));
    }

    fn lose(&mut self, planet: usize, faction: u8, war_time: f64, now: i64) {
        self.owners[planet] = faction;
        self.health[planet] = 1.0;
        if let Some(c) = self.campaign_on(planet).map(|c| c.id) {
            self.remove_campaign(c);
        }
        self.stats.lost += 1;
        let text = format!("{} has fallen to the {} forces.", self.planet_name(planet), faction_name(faction));
        self.add_news(now, war_time, "lost", text, Some(planet));
    }

    /// A dispatch from the GM.
    pub fn post_news(&mut self, text: &str, war_time: f64, now: i64, out: &mut Out) {
        self.add_news(now, war_time, "gm", text.chars().take(400).collect(), None);
        out.changed = true;
    }

    /// Withdraws an active order (the GM). The director issues a new one at its next tick.
    pub fn cancel_order(&mut self, id: u64, war_time: f64, now: i64, out: &mut Out) -> Result<(), String> {
        let o = self.orders.iter_mut().find(|o| o.id == id && o.state == "active").ok_or("no such active order")?;
        o.state = "cancelled".into();
        let text = format!("Major Order withdrawn: {}", o.brief);
        self.add_news(now, war_time, "order", text, None);
        out.changed = true;
        Ok(())
    }

    /// Ends a campaign early (the GM): `won` liberates or holds the planet, otherwise the enemy keeps
    /// or takes it.
    pub fn end_campaign(&mut self, id: u64, won: bool, war_time: f64, now: i64, out: &mut Out) -> Result<(), String> {
        let c = self.campaigns.iter().find(|c| c.id == id).cloned().ok_or("no such campaign")?;
        match (c.kind, won) {
            (CampaignKind::Liberation, true) => self.liberate(c.planet, war_time, now),
            (CampaignKind::Liberation, false) => {
                self.remove_campaign(id);
                self.health[c.planet] = 1.0;
                let text = format!("The liberation of {} is called off.", self.planet_name(c.planet));
                self.add_news(now, war_time, "campaign", text, Some(c.planet));
            }
            (CampaignKind::Defense, true) => self.defended(id, war_time, now),
            (CampaignKind::Defense, false) => self.lose(c.planet, c.faction, war_time, now),
        }
        self.check_orders(war_time, now);
        out.changed = true;
        Ok(())
    }

    fn defended(&mut self, id: u64, war_time: f64, now: i64) {
        if let Some(c) = self.remove_campaign(id) {
            self.stats.defended += 1;
            let text = format!("{} holds. The {} attack is broken.", self.planet_name(c.planet), faction_name(c.faction));
            self.add_news(now, war_time, "defended", text, Some(c.planet));
        }
    }

    /// Sets who holds a planet (the GM). Any campaign on it ends.
    pub fn set_owner(&mut self, planet: usize, owner: u8, war_time: f64, now: i64, out: &mut Out) -> Result<(), String> {
        if planet >= self.owners.len() {
            return Err("no such planet".into());
        }
        if owner > 3 {
            return Err("`owner` must be 0 (Super Earth), 1 (bugs), 2 (cyborgs) or 3 (illuminates)".into());
        }
        if let Some(c) = self.campaign_on(planet).map(|c| c.id) {
            self.remove_campaign(c);
        }
        self.owners[planet] = owner;
        self.health[planet] = 1.0;
        let text = format!("{} is now held by {}.", self.planet_name(planet), if owner == 0 { "Super Earth".to_string() } else { format!("the {} forces", faction_name(owner)) });
        self.add_news(now, war_time, "gm", text, Some(planet));
        self.check_orders(war_time, now);
        out.changed = true;
        Ok(())
    }

    pub fn issue_order(&mut self, kind: OrderKind, planets: Vec<usize>, faction: u8, target: f64, hours: f64, brief: Option<String>, by: &str, war_time: f64, now: i64, out: &mut Out) -> Result<u64, String> {
        if planets.iter().any(|&p| p >= self.owners.len()) {
            return Err("no such planet".into());
        }
        if matches!(kind, OrderKind::Liberate | OrderKind::Defend) && planets.is_empty() {
            return Err("the order needs at least one planet".into());
        }
        if kind == OrderKind::Missions && !(1.0..=100_000.0).contains(&target) {
            return Err("`target` must be between 1 and 100000 missions".into());
        }
        if !(1.0..=2000.0).contains(&hours) {
            return Err("`hours` must be between 1 and 2000".into());
        }
        let names: Vec<&str> = planets.iter().map(|&p| self.planet_name(p)).collect();
        let brief = brief.filter(|b| !b.trim().is_empty()).unwrap_or_else(|| match kind {
            OrderKind::Liberate => format!("Liberate {}.", list(&names)),
            OrderKind::Defend => format!("Hold {} against every attack.", list(&names)),
            OrderKind::Missions => format!(
                "Win {} missions against the {} forces.",
                target.round(),
                if faction == 0 { "enemy".to_string() } else { faction_name(faction).to_string() }
            ),
        });
        let id = self.take_id();
        self.orders.push(Order {
            id,
            kind,
            planets,
            faction,
            target: if kind == OrderKind::Missions { target.round() } else { 0.0 },
            progress: 0.0,
            brief: brief.chars().take(240).collect(),
            issued: war_time,
            ends: war_time + hours * HOUR,
            state: "active".into(),
            by: by.into(),
        });
        let text = format!("New Major Order: {}", self.orders.last().map(|o| o.brief.clone()).unwrap_or_default());
        self.add_news(now, war_time, "order", text, None);
        self.check_orders(war_time, now);
        out.changed = true;
        Ok(id)
    }

    /// Progress of every active order, and the end of the ones that are decided.
    fn check_orders(&mut self, war_time: f64, now: i64) {
        let mut ended = vec![];
        for o in self.orders.iter_mut().filter(|o| o.state == "active") {
            match o.kind {
                OrderKind::Liberate => {
                    let held = o.planets.iter().filter(|&&p| self.owners[p] == SUPER_EARTH).count();
                    o.target = o.planets.len() as f64;
                    o.progress = held as f64;
                    if held == o.planets.len() {
                        o.state = "won".into();
                    } else if war_time >= o.ends {
                        o.state = "failed".into();
                    }
                }
                OrderKind::Defend => {
                    let held = o.planets.iter().filter(|&&p| self.owners[p] == SUPER_EARTH).count();
                    o.target = o.planets.len() as f64;
                    o.progress = held as f64;
                    if held < o.planets.len() {
                        o.state = "failed".into();
                    } else if war_time >= o.ends {
                        o.state = "won".into();
                    }
                }
                OrderKind::Missions => {
                    if o.progress >= o.target {
                        o.state = "won".into();
                    } else if war_time >= o.ends {
                        o.state = "failed".into();
                    }
                }
            }
            if o.state != "active" {
                ended.push((o.state.clone(), o.brief.clone()));
            }
        }
        for (state, brief) in ended {
            let text = if state == "won" {
                format!("Major Order complete: {brief} Super Earth thanks every Helldiver.")
            } else {
                format!("Major Order failed: {brief}")
            };
            self.add_news(now, war_time, "order", text, None);
        }
    }

    pub fn active_order(&self) -> Option<&Order> {
        self.orders.iter().rev().find(|o| o.state == "active")
    }

    /// The director: campaigns up to the setting, enemy attacks on their schedule, an order when
    /// none is active.
    fn direct(&mut self, war_time: f64, now: i64, dice: &mut dyn Dice, out: &mut Out) {
        let g = galaxy();
        // Liberation campaigns along the front, the order targets first.
        let wanted = self.settings.campaigns as usize;
        let mut guard = 0;
        while self.campaigns.iter().filter(|c| c.kind == CampaignKind::Liberation).count() < wanted && guard < 12 {
            guard += 1;
            let order_targets: Vec<usize> = self
                .active_order()
                .filter(|o| o.kind == OrderKind::Liberate)
                .map(|o| o.planets.clone())
                .unwrap_or_default();
            let mut front: Vec<usize> = self
                .frontline(0)
                .into_iter()
                .filter(|&p| self.campaign_on(p).is_none())
                .collect();
            if front.is_empty() {
                break;
            }
            // Spread the campaigns over the enemies: prefer a faction with no campaign yet.
            let busy: Vec<u8> = self.campaigns.iter().filter(|c| c.kind == CampaignKind::Liberation).map(|c| c.faction).collect();
            let preferred: Vec<usize> = front.iter().copied().filter(|p| order_targets.contains(p)).collect();
            let fresh: Vec<usize> = front.iter().copied().filter(|&p| !busy.contains(&self.owners[p])).collect();
            if !preferred.is_empty() {
                front = preferred;
            } else if !fresh.is_empty() {
                front = fresh;
            }
            // Home worlds last.
            let not_home: Vec<usize> = front.iter().copied().filter(|&p| !g.is_home(p)).collect();
            if !not_home.is_empty() {
                front = not_home;
            }
            let pick = front[dice.below(front.len())];
            let _ = self.start_liberation(pick, war_time, now, dice, out);
        }
        // Attacks.
        for f in 1..4u8 {
            let fi = f as usize;
            if war_time < self.next_attack[fi] {
                continue;
            }
            self.next_attack[fi] = war_time + self.settings.attack_hours * HOUR * (0.75 + 0.5 * dice.next_f64());
            let attacking = self.campaigns.iter().any(|c| c.kind == CampaignKind::Defense && c.faction == f);
            if attacking {
                continue;
            }
            let targets: Vec<usize> = self.exposed(f).into_iter().filter(|&p| self.campaign_on(p).is_none() && p != 0).collect();
            if targets.is_empty() {
                continue;
            }
            let pick = targets[dice.below(targets.len())];
            let hours = self.settings.defense_hours;
            let _ = self.start_defense(pick, f, hours, war_time, now, dice, out);
        }
        // A Major Order.
        if self.active_order().is_none() {
            let defense = self.campaigns.iter().find(|c| c.kind == CampaignKind::Defense).map(|c| c.planet);
            let liberation: Vec<usize> = self.campaigns.iter().filter(|c| c.kind == CampaignKind::Liberation).map(|c| c.planet).collect();
            let hours = self.settings.order_hours;
            let roll = dice.next_f64();
            if let Some(p) = defense.filter(|_| roll < 0.35) {
                let _ = self.issue_order(OrderKind::Defend, vec![p], 0, 0.0, hours.min(self.settings.defense_hours), None, "director", war_time, now, out);
            } else if !liberation.is_empty() && roll < 0.8 {
                let p = liberation[dice.below(liberation.len())];
                let _ = self.issue_order(OrderKind::Liberate, vec![p], 0, 0.0, hours, None, "director", war_time, now, out);
            } else {
                let f = 1 + dice.below(3) as u8;
                let target = (3.0 * self.settings.liberation_missions).round().max(5.0);
                let _ = self.issue_order(OrderKind::Missions, vec![], f, target, hours, None, "director", war_time, now, out);
            }
        }
        self.fill_operations(dice);
    }

    /// Advances the war by `dt` seconds of war time, ending at `war_time`.
    pub fn tick(&mut self, war_time: f64, dt: f64, now: i64, dice: &mut dyn Dice, out: &mut Out) {
        if dt <= 0.0 {
            return;
        }
        let regen = self.settings.regen_per_hour / 100.0 * dt / HOUR;
        let liberation: Vec<usize> = self.campaigns.iter().filter(|c| c.kind == CampaignKind::Liberation).map(|c| c.planet).collect();
        for p in liberation {
            self.health[p] = (self.health[p] + regen).min(1.0);
        }
        let due: Vec<u64> = self
            .campaigns
            .iter()
            .filter(|c| c.kind == CampaignKind::Defense && c.ends.is_some_and(|e| war_time >= e))
            .map(|c| c.id)
            .collect();
        for id in due {
            if let Some(c) = self.campaigns.iter().find(|c| c.id == id).cloned() {
                if c.progress >= 1.0 {
                    self.defended(id, war_time, now);
                } else {
                    self.lose(c.planet, c.faction, war_time, now);
                }
            }
        }
        self.check_orders(war_time, now);
        if self.settings.director {
            self.direct(war_time, now, dice, out);
        } else {
            self.fill_operations(dice);
        }
        out.changed = true;
    }

    /// A mission result from a player. Each mission of an operation counts once per lobby.
    pub fn report(&mut self, player: &str, r: &Report, war_time: f64, now: i64, dice: &mut dyn Dice, out: &mut Out) -> Value {
        let Some(ci) = self.campaigns.iter().position(|c| c.id == r.campaign) else {
            return json!({"credited": false, "reason": "campaign_over"});
        };
        let Some(oi) = self.campaigns[ci].operations.iter().position(|o| o.id == r.operation) else {
            return json!({"credited": false, "reason": "operation_over"});
        };
        let op = &self.campaigns[ci].operations[oi];
        if r.mission >= op.missions.len() {
            return json!({"credited": false, "reason": "no_such_mission"});
        }
        let who = if r.lobby.is_empty() { format!("p{player}") } else { format!("l{}", r.lobby) };
        let key = format!("{who}/{}/{}", r.operation, r.mission);
        if self.credited.contains(&key) {
            return json!({"credited": false, "reason": "already_counted"});
        }
        self.credited.push(key);
        if self.credited.len() > CREDITED_KEPT {
            let cut = self.credited.len() - CREDITED_KEPT;
            self.credited.drain(..cut);
        }
        self.stats.kills += r.kills.clamp(0.0, 100_000.0) as u64;
        self.stats.deaths += r.deaths.clamp(0.0, 10_000.0) as u64;
        out.changed = true;
        if !r.success {
            self.stats.missions_lost += 1;
            self.campaigns[ci].missions_lost += 1;
            return json!({"credited": false, "reason": "mission_lost"});
        }
        self.stats.missions_won += 1;
        let difficulty = op.difficulty;
        let faction = self.campaigns[ci].faction;
        self.campaigns[ci].missions_won += 1;
        self.campaigns[ci].operations[oi].missions[r.mission].done = true;
        let mut units = mission_value(difficulty);
        let op_complete = self.campaigns[ci].operations[oi].complete();
        if op_complete {
            units += 1.0;
            self.stats.operations += 1;
            self.campaigns[ci].operations.remove(oi);
        }
        for o in self.orders.iter_mut().filter(|o| o.state == "active" && o.kind == OrderKind::Missions) {
            if o.faction == 0 || o.faction == faction {
                o.progress += 1.0;
            }
        }
        let c = self.campaigns[ci].clone();
        let mut answer = json!({"credited": true, "operation_complete": op_complete, "value": units});
        match c.kind {
            CampaignKind::Liberation => {
                let p = c.planet;
                self.health[p] -= units / self.settings.liberation_missions.max(1.0);
                answer["liberation"] = json!(round2((1.0 - self.health[p].max(0.0)) * 100.0));
                if self.health[p] <= 0.0 {
                    self.liberate(p, war_time, now);
                    answer["planet_liberated"] = json!(true);
                }
            }
            CampaignKind::Defense => {
                let progress = (c.progress + units / self.settings.defense_missions.max(1.0)).min(1.0);
                self.campaigns[ci].progress = progress;
                answer["defense"] = json!(round2(progress * 100.0));
                if progress >= 1.0 {
                    self.defended(c.id, war_time, now);
                    answer["planet_defended"] = json!(true);
                }
            }
        }
        self.check_orders(war_time, now);
        self.fill_operations(dice);
        answer
    }

    // ---- views

    /// What the mod and the war screens read.
    pub fn view(&self, war_time: f64, speed: f64) -> Value {
        let real = |t: f64| if speed > 0.0 { ((t - war_time) / speed).max(0.0).round() } else { 0.0 };
        let campaigns: Vec<Value> = self
            .campaigns
            .iter()
            .map(|c| {
                let liberation = if c.kind == CampaignKind::Liberation { round2((1.0 - self.health[c.planet].clamp(0.0, 1.0)) * 100.0) } else { 0.0 };
                let per_mission = match c.kind {
                    CampaignKind::Liberation => 100.0 * mission_value(5) / self.settings.liberation_missions.max(1.0),
                    CampaignKind::Defense => 100.0 * mission_value(5) / self.settings.defense_missions.max(1.0),
                };
                json!({
                    "id": c.id, "planet": c.planet, "kind": c.kind.as_str(), "faction": c.faction,
                    "liberation": liberation, "defense": round2(c.progress * 100.0),
                    "ends_in": c.ends.map(real),
                    "regen_per_hour": if c.kind == CampaignKind::Liberation { self.settings.regen_per_hour } else { 0.0 },
                    "per_mission": round2(per_mission),
                    "missions_won": c.missions_won, "missions_lost": c.missions_lost,
                    "operations": c.operations,
                })
            })
            .collect();
        let orders: Vec<Value> = self
            .orders
            .iter()
            .rev()
            .take(6)
            .map(|o| {
                json!({"id": o.id, "kind": o.kind, "brief": o.brief, "planets": o.planets, "faction": o.faction,
                       "progress": o.progress, "target": o.target, "ends_in": real(o.ends), "state": o.state, "by": o.by})
            })
            .collect();
        let news: Vec<&News> = self.news.iter().rev().take(15).collect();
        json!({
            "galaxy": self.galaxy, "galaxy_version": galaxy().version,
            "owners": self.owners,
            "campaigns": campaigns,
            "orders": orders,
            "news": news,
            "stats": self.stats,
            "settings": self.settings,
        })
    }
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn list(names: &[&str]) -> String {
    match names.len() {
        0 => String::new(),
        1 => names[0].to_string(),
        n => format!("{} and {}", names[..n - 1].join(", "), names[n - 1]),
    }
}

/// Degrees between two points of a sphere.
pub fn angle_between(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let (a1, b1, a2, b2) = (lat1.to_radians(), lon1.to_radians(), lat2.to_radians(), lon2.to_radians());
    let c = a1.sin() * a2.sin() + a1.cos() * a2.cos() * (b1 - b2).cos();
    c.clamp(-1.0, 1.0).acos().to_degrees()
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::SplitMix;

    fn fresh() -> (Evolved, SplitMix, Out) {
        let mut e = Evolved::new(EvoSettings::default());
        let mut dice = SplitMix(7);
        let mut out = Out::default();
        e.start(0.0, 1000, &mut dice, &mut out);
        (e, dice, out)
    }

    #[test]
    fn the_map_loads_whole() {
        let g = galaxy();
        assert_eq!(g.planets.len(), 273);
        assert!(g.sectors.len() > 40);
        assert_eq!(g.planets[0].name, "Super Earth");
        assert_eq!(g.planets[0].owner, SUPER_EARTH);
        // Every planet reachable from Super Earth.
        let mut seen = vec![false; g.planets.len()];
        let mut stack = vec![0];
        seen[0] = true;
        while let Some(p) = stack.pop() {
            for &q in &g.adj[p] {
                if !seen[q] {
                    seen[q] = true;
                    stack.push(q);
                }
            }
        }
        assert!(seen.iter().all(|s| *s));
        for (f, name) in FACTIONS.iter().enumerate().skip(1) {
            assert!(g.homes[f].is_some(), "home of {name}");
        }
    }

    #[test]
    fn a_new_war_opens_campaigns_and_an_order() {
        let (e, _, _) = fresh();
        let lib = e.campaigns.iter().filter(|c| c.kind == CampaignKind::Liberation).count();
        assert_eq!(lib, 3);
        for c in &e.campaigns {
            assert_ne!(e.owners[c.planet], SUPER_EARTH);
            assert_eq!(c.operations.len(), OPERATIONS_PER_CAMPAIGN);
            assert!(galaxy().adj[c.planet].iter().any(|&q| e.owners[q] == SUPER_EARTH), "on the front");
            for o in &c.operations {
                assert!((2..=3).contains(&o.missions.len()));
                assert!((1..=15).contains(&o.difficulty));
            }
        }
        assert!(e.active_order().is_some());
        assert!(!e.news.is_empty());
    }

    #[test]
    fn missions_liberate_a_planet_once_each() {
        let (mut e, mut dice, mut out) = fresh();
        let c = e.campaigns.iter().find(|c| c.kind == CampaignKind::Liberation).unwrap().clone();
        let planet = c.planet;
        let mut wins = 0;
        let mut guard = 0;
        while e.owners[planet] != SUPER_EARTH && guard < 100 {
            guard += 1;
            let c = e.campaigns.iter().find(|x| x.planet == planet).unwrap().clone();
            let op = &c.operations[0];
            let m = op.missions.iter().position(|m| !m.done).unwrap();
            let r = Report { campaign: c.id, operation: op.id, mission: m, success: true, lobby: "L1".into(), kills: 10.0, deaths: 1.0 };
            let a = e.report("ab12", &r, 100.0, 1000, &mut dice, &mut out);
            assert_eq!(a["credited"], true, "{a}");
            let again = e.report("ab12", &r, 100.0, 1000, &mut dice, &mut out);
            assert_eq!(again["credited"], false, "counted once");
            wins += 1;
        }
        assert_eq!(e.owners[planet], SUPER_EARTH);
        assert!((5..=12).contains(&wins), "{wins} wins to liberate");
        assert!(e.campaign_on(planet).is_none());
        assert!(e.news.iter().any(|n| n.kind == "liberated"));
    }

    #[test]
    fn a_lost_mission_counts_nothing() {
        let (mut e, mut dice, mut out) = fresh();
        let c = e.campaigns[0].clone();
        let r = Report { campaign: c.id, operation: c.operations[0].id, mission: 0, success: false, lobby: String::new(), kills: 0.0, deaths: 4.0 };
        let a = e.report("ab12", &r, 10.0, 1000, &mut dice, &mut out);
        assert_eq!(a["credited"], false);
        assert_eq!(e.health[c.planet], 1.0);
        assert_eq!(e.stats.missions_lost, 1);
    }

    #[test]
    fn the_enemy_regains_liberation() {
        let (mut e, mut dice, mut out) = fresh();
        let p = e.campaigns[0].planet;
        e.health[p] = 0.5;
        e.tick(10.0 * HOUR, 10.0 * HOUR, 1000, &mut dice, &mut out);
        assert!((e.health[p] - 0.6).abs() < 1e-9, "{}", e.health[p]);
    }

    #[test]
    fn an_unheld_defense_loses_the_planet() {
        let (mut e, mut dice, mut out) = fresh();
        e.settings.director = false;
        let target = e.exposed(2)[0];
        let id = e.start_defense(target, 2, 2.0, 0.0, 1000, &mut dice, &mut out).unwrap();
        assert!(e.campaigns.iter().any(|c| c.id == id));
        e.tick(3.0 * HOUR, 3.0 * HOUR, 1000, &mut dice, &mut out);
        assert_eq!(e.owners[target], 2);
        assert!(e.campaigns.iter().all(|c| c.id != id));
    }

    #[test]
    fn a_held_defense_keeps_the_planet() {
        let (mut e, mut dice, mut out) = fresh();
        e.settings.director = false;
        let target = e.exposed(1)[0];
        let id = e.start_defense(target, 1, 24.0, 0.0, 1000, &mut dice, &mut out).unwrap();
        let mut guard = 0;
        while e.campaigns.iter().any(|c| c.id == id) && guard < 40 {
            guard += 1;
            let c = e.campaigns.iter().find(|c| c.id == id).unwrap().clone();
            let op = &c.operations[0];
            let m = op.missions.iter().position(|m| !m.done).unwrap();
            e.report("ab12", &Report { campaign: id, operation: op.id, mission: m, success: true, lobby: "L".into(), kills: 0.0, deaths: 0.0 }, 60.0, 1000, &mut dice, &mut out);
        }
        assert_eq!(e.owners[target], SUPER_EARTH);
        assert_eq!(e.stats.defended, 1);
    }

    #[test]
    fn the_director_attacks_on_schedule() {
        let (mut e, mut dice, mut out) = fresh();
        let before = e.campaigns.iter().filter(|c| c.kind == CampaignKind::Defense).count();
        assert_eq!(before, 0, "no attack in the first hours");
        let later = 60.0 * HOUR;
        e.tick(later, later, 1000, &mut dice, &mut out);
        assert!(e.campaigns.iter().any(|c| c.kind == CampaignKind::Defense));
    }

    #[test]
    fn orders_end_won_or_failed() {
        let (mut e, mut dice, mut out) = fresh();
        e.orders.clear();
        let p = e.campaigns[0].planet;
        e.issue_order(OrderKind::Liberate, vec![p], 0, 0.0, 10.0, None, "gm", 0.0, 1000, &mut out).unwrap();
        e.end_campaign(e.campaigns[0].id, true, 1.0, 1000, &mut out).unwrap();
        assert_eq!(e.orders.last().unwrap().state, "won");
        e.issue_order(OrderKind::Missions, vec![], 2, 50.0, 1.0, None, "gm", 1.0, 1000, &mut out).unwrap();
        e.settings.director = false;
        e.tick(2.0 * HOUR, 2.0 * HOUR, 1000, &mut dice, &mut out);
        assert_eq!(e.orders.last().unwrap().state, "failed");
    }

    #[test]
    fn settings_check_their_ranges() {
        let s = EvoSettings::default();
        let mut p = Map::new();
        p.insert("campaigns".into(), json!(5));
        assert_eq!(s.patched(&p).unwrap().campaigns, 5);
        p.insert("regen_per_hour".into(), json!(-1));
        assert!(s.patched(&p).is_err());
        let mut q = Map::new();
        q.insert("nope".into(), json!(1));
        assert!(s.patched(&q).is_err());
    }

    #[test]
    fn the_view_has_what_the_mod_reads() {
        let (e, _, _) = fresh();
        let v = e.view(0.0, 1.0);
        assert_eq!(v["owners"].as_array().unwrap().len(), 273);
        let c = &v["campaigns"][0];
        for k in ["id", "planet", "kind", "faction", "liberation", "operations", "per_mission"] {
            assert!(!c[k].is_null(), "{k}");
        }
        let op = &c["operations"][0];
        for k in ["id", "name", "difficulty", "lat", "lon", "seed", "variant", "shading", "missions"] {
            assert!(!op[k].is_null(), "{k}");
        }
        assert!(!v["orders"].as_array().unwrap().is_empty());
    }

    #[test]
    fn operations_spread_over_the_planet() {
        let (e, _, _) = fresh();
        for c in &e.campaigns {
            for (i, a) in c.operations.iter().enumerate() {
                for b in &c.operations[i + 1..] {
                    assert!(angle_between(a.lat, a.lon, b.lat, b.lon) > 20.0);
                }
            }
        }
    }
}
