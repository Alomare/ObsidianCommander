// The Evolved war map: the HELLDIVERS 2 galaxy layout of data/galaxy-hd2.json, copied beside this file
// as warfront.json is for the Vanilla map. Map units put Super Earth at 0,0 with y up and the planets
// within a radius of about 0.95; here they become SVG units (MAP_SCALE per map unit), y down.

import raw from "./galaxy-hd2.json";
import { SIDES, sideColor } from "../palette";

interface RawPlanet { id: number; name: string; sector: number; x: number; y: number; biome: string; env: number; hazards: string[] | null; owner: number }
interface RawSector { id: number; name: string; x: number; y: number; owner: number; planets: number[]; shape: number[] }
interface RawGalaxy {
  galaxy: string; version: number; rim: number; homes: Record<string, number>;
  sectors: RawSector[]; planets: RawPlanet[]; links: [number, number][]; borders: number[][];
}

const g = raw as unknown as RawGalaxy;

export const MAP_SCALE = 500;
const sx = (v: number) => Math.round(v * MAP_SCALE * 10) / 10;
const sy = (v: number) => Math.round(-v * MAP_SCALE * 10) / 10;

export const GALAXY_ID = g.galaxy;
export const GALAXY_VERSION = g.version;
/** The edge of the galaxy, in SVG units. */
export const RIM = g.rim * MAP_SCALE;

/** Owner keys and colours (src/palette.ts). Index = owner. */
export const OWNER_KEYS = SIDES;
export const ownerColor = (owner: number, alpha = 1) => sideColor(SIDES[owner] ?? "superearth", alpha);

export interface GPlanet {
  id: number;
  name: string;
  sector: number;
  x: number;
  y: number;
  biome: string;
  env: number;
  hazards: string[];
  /** The owner at the start of a war. */
  start: number;
  /** The enemy (1 to 3) whose home world this is; 0 for any other planet. */
  home: number;
}

export interface GSector {
  id: number;
  name: string;
  x: number;
  y: number;
  planets: number[];
  /** The sector outline as the HELLDIVERS 2 map draws it, an SVG path. */
  path: string;
}

const homeOf = new Map<number, number>();
OWNER_KEYS.forEach((k, i) => { if (i > 0 && g.homes[k] != null) homeOf.set(g.homes[k], i); });

export const PLANETS: GPlanet[] = g.planets.map((p) => ({
  id: p.id, name: p.name, sector: p.sector, x: sx(p.x), y: sy(p.y), biome: p.biome, env: p.env,
  hazards: p.hazards ?? [], start: p.owner, home: homeOf.get(p.id) ?? 0,
}));

const ringPath = (flat: number[]) => {
  let d = "";
  for (let i = 0; i < flat.length; i += 2) d += `${i ? "L" : "M"}${sx(flat[i])} ${sy(flat[i + 1])}`;
  return d + "Z";
};

export const SECTORS: GSector[] = g.sectors.map((s) => ({ id: s.id, name: s.name, x: sx(s.x), y: sy(s.y), planets: s.planets, path: ringPath(s.shape) }));

/** Supply lines: pairs of planet ids. */
export const LINKS: [number, number][] = g.links;

/** Planets linked to each planet by a supply line. */
export const NEIGHBOURS: number[][] = PLANETS.map(() => []);
for (const [a, b] of LINKS) { NEIGHBOURS[a].push(b); NEIGHBOURS[b].push(a); }

/** The sector borders, every edge once: between two sectors, and the outer edge of the galaxy. */
const edge = (b: number[]) => `M${sx(b[0])} ${sy(b[1])}L${sx(b[2])} ${sy(b[3])}`;
export const BORDER_PATH = g.borders.filter((b) => b[5] >= 0).map(edge).join("");
export const EDGE_PATH = g.borders.filter((b) => b[5] < 0).map(edge).join("");
/** The edges between two sectors, with the sectors on each side, for the front lines. */
export const SECTOR_EDGES: { d: string; a: number; b: number }[] = g.borders.filter((b) => b[5] >= 0).map((b) => ({ d: edge(b), a: b[4], b: b[5] }));

/** Who holds a sector: the enemy with the most planets there (the first on a tie), or Super Earth when
 *  no enemy holds any; `share` is the part of the planets that enemy holds. */
export function sectorHolder(own: number[], s: GSector): { owner: number; share: number } {
  const n = [0, 0, 0, 0];
  for (const p of s.planets) n[own[p] ?? 0]++;
  let best = 0;
  for (let o = 1; o < 4; o++) if (n[o] > n[best] || (best === 0 && n[o] > 0)) best = o;
  return { owner: best, share: s.planets.length ? n[best] / s.planets.length : 0 };
}

/** The starting owner of every planet. */
export const START_OWNERS: number[] = PLANETS.map((p) => p.start);

export const planetName = (id: number | null | undefined) => (id != null && PLANETS[id] ? PLANETS[id].name : "");
export const sectorOf = (id: number) => SECTORS[PLANETS[id]?.sector ?? 0];

/** Planets sorted by name, for pickers. */
export const PLANETS_BY_NAME: GPlanet[] = [...PLANETS].sort((a, b) => a.name.localeCompare(b.name));
