// Names, numbers, times and feed sentences.

import { hasKey, t, tk } from "./strings";
import type { FeedEntry, Front, War } from "./types";
import type { Faction } from "./map/geometry";

export const FACTION_OF: Faction[] = ["bugs", "cyborgs", "illuminates"];
export const enemyName = (e: number) => tk(`enemy${e}`);
export const enemySingle = (e: number) => tk(`enemySingle${e}`);

/** A region name: the in-game words from Obsidian when there are any, else a plain label. */
export function regionName(enemy: number | null | undefined, region: number | null | undefined, names: Record<string, string>): string {
  if (region === 0) return names.region_superearth_01 || t("superEarth");
  if (enemy == null || region == null) return "";
  const f = FACTION_OF[enemy];
  if (!f) return "";
  const nk = region >= 11 ? `region_${f}_hq` : `region_${f}_${String(region).padStart(2, "0")}`;
  if (names[nk]) return names[nk];
  return region >= 11 ? t("homeWorld", { enemy: enemySingle(enemy) }) : t("sector", { enemy: enemySingle(enemy), n: region });
}

export const regionOf = (f: Front) => f.region || Math.min(10, Math.max(1, Math.floor(f.points / (f.points_max / 10)) + 1));
/** Progress through the current region, 0..1. */
export function regionProgress(f: Front): number {
  const step = f.points_max / 10;
  if (f.points >= f.points_max) return 1;
  return Math.max(0, Math.min(1, (f.points - (regionOf(f) - 1) * step) / step));
}

const nf = new Intl.NumberFormat("en-US");
export const num = (n: number) => nf.format(Math.round(n));
export const pct = (n: number, digits = 0) => `${(n * 100).toFixed(digits)}%`;

/** 3d 04:12:09 style for war time and countdowns. */
export function clock(sec: number, withDays = true): string {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const hh = String(withDays ? h : h + d * 24).padStart(2, "0");
  const body = `${hh}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return withDays && d > 0 ? `${d}d ${body}` : body;
}

export function hoursText(sec: number): string {
  const h = sec / 3600;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} ${t("hours")}`;
}

export function ago(unix: number, nowUnix: number): string {
  const d = Math.max(0, nowUnix - unix);
  if (d < 90) return t("justNow");
  if (d < 3600) return t("agoMin", { n: Math.round(d / 60) });
  if (d < 86400) return t("agoHour", { n: Math.round(d / 3600) });
  return t("agoDay", { n: Math.round(d / 86400) });
}

export function timeOfDay(unix: number): string {
  return new Date(unix * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
export function dateTime(unix: number): string {
  return new Date(unix * 1000).toLocaleString("en-GB", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** A member name, or the short player ID when the server has no name. */
export function memberName(war: War | null, player: string | null | undefined): string {
  if (!player) return t("someone");
  if (player === "gm") return t("gmName");
  const m = war?.members.find((x) => x.player === player);
  if (m?.name) return m.name;
  return /^[0-9a-f]{12,}$/i.test(player) ? `…${player.slice(-6)}` : player;
}

export function feedText(e: FeedEntry, war: War | null, names: Record<string, string>): string {
  const vars: Record<string, string | number> = {
    player: memberName(war, e.player),
    front: e.front != null ? enemySingle(e.front) : "",
    enemyPlural: e.front != null ? enemyName(e.front) : "",
    region: regionName(e.front ?? null, e.region ?? null, names),
    value: e.value != null ? (Number.isInteger(e.value) ? num(e.value) : String(e.value)) : "",
    key: e.text_key,
  };
  if (e.text_key === "gm_push" && e.value != null) vars.value = e.value > 0 ? `+${e.value}` : String(e.value);
  const k = e.text_key === "gm_push" && Math.abs(e.value ?? 0) === 1 ? "feed_gm_push_one" : `feed_${e.text_key}`;
  if (hasKey(k)) return tk(k, vars);
  // An unknown key still reads: words from the key, then the place.
  const words = e.text_key.replace(/_/g, " ");
  const where = vars.region || (e.front != null ? t("frontOf", { enemy: enemyName(e.front) }) : "");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}${where ? `: ${where}` : ""}${e.value != null ? ` (${vars.value})` : ""}.`;
}

/** A feed entry tone, for the dot beside it. */
export function feedTone(e: FeedEntry): "good" | "bad" | "event" | "gm" | "plain" {
  if (e.player === "gm" || e.kind === "gm") return "gm";
  if (/lost|fail|defeat(?!ed)/.test(e.text_key) || e.text_key === "region_lost") return "bad";
  if (/liberated|success|won|front_defeated/.test(e.text_key)) return "good";
  if (/started/.test(e.text_key)) return "event";
  return "plain";
}
