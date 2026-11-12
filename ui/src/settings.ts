// War settings: defaults (spec section 4), the presets, and what the settings form shows for each field.

import type { Settings } from "./types";
import type { StringKey } from "./strings";

export const DEFAULT_SETTINGS: Settings = {
  points_max: 100000, start_points: 15000, pressure_per_hour: 600, planet_value: 250,
  defend_chance_per_hour: 0.08, defend_duration: 14400, defend_points: 3000, defend_mission_value: 150,
  defend_reward: 3000, attack_duration: 21600, attack_points: 5000, attack_mission_value: 150, director: true,
  own_save_only: false, allow_achievements: false,
};

export type PresetId = "standard" | "short" | "hard";
export const PRESETS: Record<PresetId, Settings> = {
  standard: DEFAULT_SETTINGS,
  short: {
    ...DEFAULT_SETTINGS, points_max: 30000, start_points: 3000, pressure_per_hour: 250, planet_value: 250,
    defend_chance_per_hour: 0.12, defend_duration: 7200, defend_points: 1500, defend_reward: 1500,
    attack_duration: 10800, attack_points: 2500,
  },
  hard: {
    ...DEFAULT_SETTINGS, pressure_per_hour: 1200, planet_value: 200, defend_chance_per_hour: 0.16,
    defend_duration: 10800, defend_points: 4500, defend_mission_value: 120, defend_reward: 2000,
    attack_duration: 14400, attack_points: 8000, attack_mission_value: 120,
  },
};

export type FieldKind = "int" | "chance" | "hours" | "bool";
export interface Field {
  key: keyof Settings;
  kind: FieldKind;
  min: number;
  max: number;
  step: number;
  group: StringKey;
}

/** min/max in the shown unit: points, percent, or hours. */
export const FIELDS: Field[] = [
  { key: "points_max", kind: "int", min: 10000, max: 1000000, step: 1000, group: "groupFronts" },
  { key: "start_points", kind: "int", min: 0, max: 1000000, step: 500, group: "groupFronts" },
  { key: "pressure_per_hour", kind: "int", min: 0, max: 20000, step: 50, group: "groupFronts" },
  { key: "planet_value", kind: "int", min: 0, max: 10000, step: 25, group: "groupFronts" },
  { key: "director", kind: "bool", min: 0, max: 1, step: 1, group: "groupDefense" },
  { key: "defend_chance_per_hour", kind: "chance", min: 0, max: 100, step: 1, group: "groupDefense" },
  { key: "defend_duration", kind: "hours", min: 0.5, max: 72, step: 0.5, group: "groupDefense" },
  { key: "defend_points", kind: "int", min: 100, max: 100000, step: 100, group: "groupDefense" },
  { key: "defend_mission_value", kind: "int", min: 10, max: 10000, step: 10, group: "groupDefense" },
  { key: "defend_reward", kind: "int", min: 0, max: 100000, step: 100, group: "groupDefense" },
  { key: "attack_duration", kind: "hours", min: 0.5, max: 72, step: 0.5, group: "groupAttack" },
  { key: "attack_points", kind: "int", min: 100, max: 100000, step: 100, group: "groupAttack" },
  { key: "attack_mission_value", kind: "int", min: 10, max: 10000, step: 10, group: "groupAttack" },
  { key: "own_save_only", kind: "bool", min: 0, max: 1, step: 1, group: "groupPlayers" },
  { key: "allow_achievements", kind: "bool", min: 0, max: 1, step: 1, group: "groupPlayers" },
];

/** A setting value in the unit the form shows. */
export function toShown(f: Field, v: number | boolean): number {
  if (f.kind === "bool") return v ? 1 : 0;
  if (f.kind === "chance") return Math.round((v as number) * 1000) / 10;
  if (f.kind === "hours") return Math.round(((v as number) / 3600) * 100) / 100;
  return v as number;
}
export function fromShown(f: Field, v: number): number | boolean {
  if (f.kind === "bool") return v !== 0;
  if (f.kind === "chance") return Math.round(v * 10) / 1000;
  if (f.kind === "hours") return Math.round(v * 3600);
  return Math.round(v);
}

/** Settings the form would send, kept inside the ranges and start points under the points per front. */
export function sanitize(s: Settings): Settings {
  const out = { ...s };
  for (const f of FIELDS) {
    if (f.kind === "bool") continue;
    const shown = Math.min(f.max, Math.max(f.min, toShown(f, out[f.key] as number)));
    (out as any)[f.key] = fromShown(f, shown);
  }
  out.start_points = Math.min(out.start_points, out.points_max);
  return out;
}

export function presetOf(s: Settings): PresetId | null {
  for (const id of Object.keys(PRESETS) as PresetId[]) {
    const p = PRESETS[id];
    if ((Object.keys(p) as (keyof Settings)[]).every((k) => p[k] === s[k])) return id;
  }
  return null;
}
