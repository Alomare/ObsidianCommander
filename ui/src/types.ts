// The admin API shapes (docs/spec-m1.md, section 5).

export type Enemy = 0 | 1 | 2;
export type FrontStatus = "active" | "defeated" | "hidden";
export type WarState = "running" | "paused" | "won" | "lost";

export interface Front {
  enemy: Enemy;
  points: number;
  points_max: number;
  points_taken: number;
  status: FrontStatus;
  introduction_order: number;
  region: number;
  pressure_per_hour?: number;
}

/** A front as the war list sees it: enough for the small map. */
export interface FrontBrief {
  enemy: number;
  status: FrontStatus;
  region: number;
  points?: number;
  points_max?: number;
}

export interface WarEvent {
  event_id: number;
  enemy: Enemy;
  region: number;
  points: number;
  points_max: number;
  start_time: number;
  end_time: number;
  status: string;
  players_at_start?: number;
}

export interface FrontStats {
  enemy: Enemy;
  missions: number;
  successful_missions: number;
  kills: number;
  deaths: number;
  shots: number;
  hits: number;
  accidentals: number;
  players: number;
  completed_planets: number;
}

export interface Member {
  player: string;
  name?: string | null;
  first_seen: number;
  last_seen: number;
  missions: number;
}

export interface Settings {
  points_max: number;
  start_points: number;
  pressure_per_hour: number;
  planet_value: number;
  defend_chance_per_hour: number;
  defend_duration: number;
  defend_points: number;
  defend_mission_value: number;
  defend_reward: number;
  attack_duration: number;
  attack_points: number;
  attack_mission_value: number;
  director: boolean;
}

export interface War {
  id: string;
  name: string;
  /** What the war is about; empty when the host gave none. */
  description?: string;
  /** A data: address of the war picture; empty for the picture of the model. */
  logo?: string;
  model: string;
  /** Counted from 1. */
  season: number;
  /** The season the game gets: far above the official ones and apart for every war. */
  game_season?: number;
  created: number;
  state: WarState;
  war_time: number;
  speed: number;
  fronts: Front[];
  defend_event: WarEvent | null;
  attack_events: WarEvent[];
  statistics: FrontStats[];
  members: Member[];
  settings: Settings;
  /** The Evolved war state; null for a Vanilla war. */
  evolved?: Evolved | null;
  lan: { open: boolean; port: number | null; internet?: boolean; invite?: string | null };
  server_time: number;
}

// ---- Evolved wars: the HELLDIVERS 2 galaxy (data/galaxy-hd2.json) with campaigns and Major Orders.

/** Who holds a planet: 0 Super Earth, 1 Bugs, 2 Cyborgs, 3 Illuminates. */
export type Owner = 0 | 1 | 2 | 3;

export interface EvoMission {
  /** 0 a mission, 2 an extermination. */
  kind: number;
  random: number;
  /** 0 dawn, 1 day, 2 dusk, 3 night. */
  tod: number;
  done: boolean;
}

export interface EvoOperation {
  id: number;
  name: string;
  difficulty: number;
  lat: number;
  lon: number;
  seed: number;
  variant: number;
  shading: number;
  missions: EvoMission[];
}

export interface EvoCampaign {
  id: number;
  planet: number;
  kind: "liberation" | "defense";
  /** The enemy, 1 to 3. */
  faction: number;
  /** Percent, 0 to 100. */
  liberation: number;
  defense: number;
  /** Real seconds from server_time to the end of a defense; null for a liberation. */
  ends_in: number | null;
  regen_per_hour: number;
  /** Percent a won mission at difficulty 5 adds. */
  per_mission: number;
  missions_won: number;
  missions_lost: number;
  operations: EvoOperation[];
}

export type OrderKind = "liberate" | "defend" | "missions";

export interface EvoOrder {
  id: number;
  kind: OrderKind;
  brief: string;
  planets: number[];
  /** For "missions": the enemy (1 to 3), 0 for any. */
  faction: number;
  progress: number;
  target: number;
  ends_in: number;
  state: "active" | "won" | "failed" | "cancelled";
  by: string;
}

export interface EvoNews {
  id: number;
  time: number;
  war_time: number;
  kind: string;
  text: string;
  planet: number | null;
}

export interface EvoStats {
  missions_won: number;
  missions_lost: number;
  operations: number;
  kills: number;
  deaths: number;
  liberated: number;
  lost: number;
  defended: number;
}

export interface EvoSettings {
  campaigns: number;
  liberation_missions: number;
  regen_per_hour: number;
  defense_hours: number;
  defense_missions: number;
  attack_hours: number;
  order_hours: number;
  director: boolean;
}

export interface Evolved {
  galaxy: string;
  galaxy_version: number;
  owners: number[];
  campaigns: EvoCampaign[];
  /** Newest first. */
  orders: EvoOrder[];
  /** Newest first. */
  news: EvoNews[];
  stats: EvoStats;
  settings: EvoSettings;
}

/** A war in the list from GET /api/info. The server may send the full war or fewer fields. */
export interface WarSummary {
  id: string;
  name: string;
  description?: string;
  logo?: string;
  model?: string;
  season?: number;
  state?: WarState;
  /** The server sends a boolean here; a full war sends {open, port}. */
  lan?: boolean | { open: boolean; port: number | null; internet?: boolean; invite?: string | null };
  members?: number | Member[];
  players?: number;
  fronts?: FrontBrief[];
  created?: number;
  /** Sent by the mock, which lists full wars; the server summary leaves it out. */
  evolved?: Evolved | null;
}

export interface Info {
  version: string;
  protocol: number;
  wars: WarSummary[];
}

export interface FeedEntry {
  id: number;
  time: number;
  war_time?: number;
  kind?: string;
  front?: number | null;
  region?: number | null;
  event_id?: number | null;
  player?: string | null;
  value?: number | null;
  text_key: string;
}

export interface SnapshotFront {
  points: number;
  points_taken?: number;
  status?: string;
}

export interface Snapshot {
  time: number;
  season?: number;
  data: SnapshotFront[];
}

export type GmAction =
  | { action: "set_points"; front: number; points: number }
  | { action: "push"; front: number; regions: number }
  | { action: "set_status"; front: number; status: FrontStatus }
  | { action: "start_defend"; front: number; region: number; duration: number; points_max: number }
  | { action: "start_attack"; front: number; duration: number; points_max: number }
  | { action: "set_event"; event_id: number; points: number }
  | { action: "end_event"; event_id: number; result: "success" | "fail" }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "set_speed"; speed: number }
  | { action: "end_season"; result: "won" | "lost" }
  | { action: "new_season" }
  | { action: "evo_planet"; planet: number; owner: number }
  | { action: "evo_campaign"; planet: number; kind: "liberation" | "defense"; faction?: number; hours?: number }
  | { action: "evo_end_campaign"; campaign: number; won: boolean }
  | { action: "evo_order"; kind: OrderKind; planets?: number[]; faction?: number; target?: number; hours?: number; brief?: string }
  | { action: "evo_cancel_order"; order: number }
  | { action: "evo_news"; text: string }
  | { action: "evo_settings"; settings: Partial<EvoSettings> };
