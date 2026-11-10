// The Evolved war map: the HELLDIVERS 2 galaxy layout of data/galaxy-hd2.json, copied beside this file
// as warfront.json is for the Vanilla map. Map units put Super Earth at 0,0 with y up and the planets
// within a radius of about 0.95; here they become SVG units (MAP_SCALE per map unit), y down.

import raw from "./galaxy-hd2.json";

interface RawPlanet { id: number; name: string; sector: number; x: number; y: number; biome: string; env: number; hazards: string[] | null; owner: number; cell: number[] }
interface RawSector { id: number; name: string; x: number; y: number; owner: number; planets: number[] }
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

/** Owner keys and colours: the HELLDIVERS (2015) campaign colours. Index = owner. */
export const OWNER_KEYS = ["superearth", "bugs", "cyborgs", "illuminates"] as const;
const OWNER_RGB = ["255, 170, 20", "70, 220, 160", "230, 80, 70", "40, 150, 250"];
export const ownerColor = (owner: number, alpha = 1) => `rgba(${OWNER_RGB[owner] ?? OWNER_RGB[0]}, ${alpha})`;

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
  /** The planet territory, an SVG path. */
  cell: string;
  /** The enemy (1 to 3) whose home world this is; 0 for any other planet. */
  home: number;
}

export interface GSector {
  id: number;
  name: string;
  x: number;
  y: number;
  planets: number[];
}

const homeOf = new Map<number, number>();
OWNER_KEYS.forEach((k, i) => { if (i > 0 && g.homes[k] != null) homeOf.set(g.homes[k], i); });

export const PLANETS: GPlanet[] = g.planets.map((p) => {
  let cell = "";
  for (let i = 0; i < p.cell.length; i += 2) cell += `${i ? "L" : "M"}${sx(p.cell[i])} ${sy(p.cell[i + 1])}`;
  return {
    id: p.id, name: p.name, sector: p.sector, x: sx(p.x), y: sy(p.y), biome: p.biome, env: p.env,
    hazards: p.hazards ?? [], start: p.owner, cell: cell + "Z", home: homeOf.get(p.id) ?? 0,
  };
});

export const SECTORS: GSector[] = g.sectors.map((s) => ({ id: s.id, name: s.name, x: sx(s.x), y: sy(s.y), planets: s.planets }));

/** Supply lines: pairs of planet ids. */
export const LINKS: [number, number][] = g.links;

/** Planets linked to each planet by a supply line. */
export const NEIGHBOURS: number[][] = PLANETS.map(() => []);
for (const [a, b] of LINKS) { NEIGHBOURS[a].push(b); NEIGHBOURS[b].push(a); }

/** Every sector border edge as one path. */
export const BORDER_PATH = g.borders.map((b) => `M${sx(b[0])} ${sy(b[1])}L${sx(b[2])} ${sy(b[3])}`).join("");

/** Cell edges shared by planets. Where the planets have different owners, the territory line runs. */
export interface SharedEdge { planets: number[]; d: string }
export const SHARED_EDGES: SharedEdge[] = (() => {
  const by = new Map<string, { planets: number[]; d: string }>();
  for (const p of g.planets) {
    const c = p.cell;
    const n = c.length / 2;
    for (let i = 0; i < n; i++) {
      const a = [c[2 * i], c[2 * i + 1]], b = [c[(2 * (i + 1)) % c.length], c[(2 * (i + 1) + 1) % c.length]];
      const [lo, hi] = a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]) ? [a, b] : [b, a];
      const key = `${lo[0]},${lo[1]},${hi[0]},${hi[1]}`;
      const e = by.get(key);
      if (e) { if (!e.planets.includes(p.id)) e.planets.push(p.id); }
      else by.set(key, { planets: [p.id], d: `M${sx(lo[0])} ${sy(lo[1])}L${sx(hi[0])} ${sy(hi[1])}` });
    }
  }
  return [...by.values()].filter((e) => e.planets.length > 1);
})();

/** The starting owner of every planet. */
export const START_OWNERS: number[] = PLANETS.map((p) => p.start);

export const planetName = (id: number | null | undefined) => (id != null && PLANETS[id] ? PLANETS[id].name : "");
export const sectorOf = (id: number) => SECTORS[PLANETS[id]?.sector ?? 0];

/** Planets sorted by name, for pickers. */
export const PLANETS_BY_NAME: GPlanet[] = [...PLANETS].sort((a, b) => a.name.localeCompare(b.name));
