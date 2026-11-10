// Evolved wars: the settings the server checks, owner names, and campaign and order lookups.

import type { StringKey } from "./strings";
import { t } from "./strings";
import type { EvoCampaign, EvoOrder, EvoSettings, Evolved, War } from "./types";
import { enemyName } from "./util";

/** The server defaults (server/src/evolved.rs). */
export const EVO_DEFAULTS: EvoSettings = {
  campaigns: 3, liberation_missions: 10, regen_per_hour: 1, defense_hours: 24,
  defense_missions: 5, attack_hours: 30, order_hours: 72, director: true,
};

export type EvoFieldKind = "int" | "num" | "hours" | "rate" | "bool";
export interface EvoField {
  key: keyof EvoSettings;
  kind: EvoFieldKind;
  /** The range the server accepts. */
  min: number;
  max: number;
  /** The slider stops here; the number field takes up to `max`. */
  slide: number;
  step: number;
  group: StringKey;
  /** Only does something while the war director is on. */
  director?: boolean;
}

export const EVO_FIELDS: EvoField[] = [
  { key: "director", kind: "bool", min: 0, max: 1, slide: 1, step: 1, group: "evoGroupDirector" },
  { key: "campaigns", kind: "int", min: 0, max: 12, slide: 12, step: 1, group: "evoGroupDirector", director: true },
  { key: "attack_hours", kind: "hours", min: 1, max: 2000, slide: 240, step: 1, group: "evoGroupDirector", director: true },
  { key: "order_hours", kind: "hours", min: 1, max: 2000, slide: 336, step: 1, group: "evoGroupDirector", director: true },
  { key: "liberation_missions", kind: "num", min: 1, max: 10000, slide: 100, step: 1, group: "evoGroupLiberation" },
  { key: "regen_per_hour", kind: "rate", min: 0, max: 100, slide: 20, step: 0.5, group: "evoGroupLiberation" },
  { key: "defense_hours", kind: "hours", min: 0.25, max: 720, slide: 168, step: 0.25, group: "evoGroupDefense" },
  { key: "defense_missions", kind: "num", min: 1, max: 10000, slide: 100, step: 1, group: "evoGroupDefense" },
];

/** Settings kept inside the server ranges. */
export function sanitizeEvo(s: EvoSettings): EvoSettings {
  const out = { ...s };
  for (const f of EVO_FIELDS) {
    if (f.kind === "bool") continue;
    let v = Math.min(f.max, Math.max(f.min, Number(out[f.key]) || 0));
    if (f.kind === "int") v = Math.round(v);
    (out as any)[f.key] = v;
  }
  return out;
}

/** Only the settings that differ from `base`. */
export function evoPatch(base: EvoSettings, next: EvoSettings): Partial<EvoSettings> {
  const p: Partial<EvoSettings> = {};
  for (const k of Object.keys(next) as (keyof EvoSettings)[]) if (next[k] !== base[k]) (p as any)[k] = next[k];
  return p;
}

/** Super Earth, Bugs, Cyborgs or Illuminates. */
export const ownerName = (owner: number) => (owner === 0 ? t("superEarth") : enemyName(owner - 1));

export const evoOf = (war: War): Evolved | null => (war.model === "evolved" && war.evolved ? war.evolved : null);
export const campaignOn = (evo: Evolved, planet: number): EvoCampaign | undefined => evo.campaigns.find((c) => c.planet === planet);
export const activeOrders = (evo: Evolved): EvoOrder[] => evo.orders.filter((o) => o.state === "active");

/** Defenses first, then liberations by progress. */
export function sortedCampaigns(evo: Evolved): EvoCampaign[] {
  return [...evo.campaigns].sort((a, b) => (a.kind === b.kind ? (a.kind === "defense" ? (a.ends_in ?? 0) - (b.ends_in ?? 0) : b.liberation - a.liberation) : a.kind === "defense" ? -1 : 1));
}

/** Real seconds left: `endsIn` counts from the server time of the last answer. `nowUnix` stops there while paused. */
export function secondsLeft(endsIn: number | null | undefined, war: War, nowUnix: number): number | null {
  if (endsIn == null) return null;
  return Math.max(0, endsIn - Math.max(0, nowUnix - war.server_time));
}

/** "+10%" style, without trailing zeros. */
export function pctText(v: number, digits = 1): string {
  const r = Math.round(v * 10 ** digits) / 10 ** digits;
  return `${r}%`;
}

/** Order progress as "3 / 5". */
export const orderCount = (o: EvoOrder) => `${Math.round(o.progress)} / ${Math.max(1, Math.round(o.target))}`;
export const orderShare = (o: EvoOrder) => (o.target > 0 ? Math.max(0, Math.min(1, o.progress / o.target)) : 0);
