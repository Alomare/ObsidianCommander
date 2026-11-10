// The game's war map as SVG. data/warfront.json describes each region as cells on a polar grid:
// [angle_start, ring, angle_count], 48 angle steps around, 11 rings out from Super Earth (ring 10 is the
// home world). Cells of one region merge into one outline, traced along the grid lines.
//
// Orientation: angle step s points s * 7.5 degrees counterclockwise from straight up. That puts the cyborg
// front (steps 1-14) upper left, the illuminates (17-30) at the bottom and the bugs (33-46) upper right,
// as the game draws them.

import raw from "./warfront.json";

export const FACTIONS = ["bugs", "cyborgs", "illuminates"] as const;
export type Faction = (typeof FACTIONS)[number];

const info = (raw as any).warfront_info;
export const ANGULAR: number = info.grid_angular_size; // 48
export const RADIAL: number = info.grid_radial_size; // 11
const GRID_RADIUS: number = info.grid_radius; // 2: Super Earth's radius in rings

/** SVG units per ring. */
export const UNIT = 44;
/** The radius of ring boundary `i` (0 = Super Earth's edge, 11 = the outer edge of the home worlds). */
export function ringRadius(i: number): number {
  const base = GRID_RADIUS * UNIT * 0.9;
  if (i <= 10) return base + i * UNIT;
  // The home world ring is drawn a little deeper, so the capital reads as a place of its own.
  return base + 10 * UNIT + (i - 10) * UNIT * 1.35;
}
export const SUPER_EARTH_R = ringRadius(0) - 10;
export const OUTER_R = ringRadius(11);

export function angleOf(step: number): number {
  return Math.PI / 2 + (step * 2 * Math.PI) / ANGULAR;
}
export function polar(r: number, step: number): [number, number] {
  const a = angleOf(step);
  return [r * Math.cos(a), -r * Math.sin(a)];
}

export interface RegionShape {
  /** "bugs:3", "cyborgs:11" (11 = home world). */
  id: string;
  faction: Faction;
  /** 1..10, 11 for the home world. */
  index: number;
  nameKey: string;
  path: string;
  /** A point inside the region for the label and markers. */
  center: [number, number];
  /** The mean angle step and ring, for placing text. */
  meanStep: number;
  meanRing: number;
  cells: number;
}

type Cell = { ring: number; step: number };

interface Edge {
  from: [number, number]; // [ringBoundary, step]
  to: [number, number];
  kind: "arc" | "radial";
  used?: boolean;
}

const key = (r: number, s: number) => `${r},${s}`;
const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

function cellsOf(region: number[][]): Cell[] {
  const out: Cell[] = [];
  for (const [start, ring, count] of region) {
    for (let i = 0; i < count; i++) out.push({ ring, step: (start + i) % ANGULAR });
  }
  return out;
}

/** Owner of every cell. A cell listed by two regions goes to the first (the data overlaps by one cell). */
function buildOwners(): Map<string, string> {
  const owners = new Map<string, string>();
  for (const f of FACTIONS) {
    const list = info.warfronts[f] as { region: number[][] }[];
    list.forEach((reg, i) => {
      const id = `${f}:${i + 1}`;
      for (const c of cellsOf(reg.region)) {
        const k = key(c.ring, c.step);
        if (!owners.has(k)) owners.set(k, id);
      }
    });
  }
  return owners;
}

function tracePath(id: string, cells: Cell[], owners: Map<string, string>): string {
  const own = (r: number, s: number) => owners.get(key(r, ((s % ANGULAR) + ANGULAR) % ANGULAR)) === id;
  const edges: Edge[] = [];
  for (const { ring: r, step: s } of cells) {
    // Corners go (ring boundary, step); the walk keeps the cell on the same side throughout.
    if (r === 0 || !own(r - 1, s)) edges.push({ from: [r, s], to: [r, s + 1], kind: "arc" });
    if (!own(r, s + 1)) edges.push({ from: [r, s + 1], to: [r + 1, s + 1], kind: "radial" });
    if (!own(r + 1, s)) edges.push({ from: [r + 1, s + 1], to: [r + 1, s], kind: "arc" });
    if (!own(r, s - 1)) edges.push({ from: [r + 1, s], to: [r, s], kind: "radial" });
  }
  const byStart = new Map<string, Edge[]>();
  for (const e of edges) {
    const k = key(e.from[0], e.from[1] % ANGULAR);
    (byStart.get(k) ?? byStart.set(k, []).get(k)!).push(e);
  }
  const loops: Edge[][] = [];
  for (const first of edges) {
    if (first.used) continue;
    const loop: Edge[] = [];
    let e: Edge | undefined = first;
    while (e && !e.used) {
      e.used = true;
      loop.push(e);
      const next: Edge[] = byStart.get(key(e.to[0], e.to[1] % ANGULAR)) ?? [];
      e = next.find((n) => !n.used);
    }
    loops.push(loop);
  }

  let d = "";
  for (const loop of loops) {
    // Merge runs: arcs on one ring boundary going the same way, radial lines on one step.
    const runs: Edge[] = [];
    for (const e of loop) {
      const last = runs[runs.length - 1];
      const sameArc = last && last.kind === "arc" && e.kind === "arc" && last.to[0] === e.from[0] &&
        Math.sign(last.to[1] - last.from[1]) === Math.sign(e.to[1] - e.from[1]);
      const sameRadial = last && last.kind === "radial" && e.kind === "radial" && last.to[1] % ANGULAR === e.from[1] % ANGULAR &&
        Math.sign(last.to[0] - last.from[0]) === Math.sign(e.to[0] - e.from[0]);
      if (sameArc || sameRadial) runs[runs.length - 1] = { ...last, to: e.to };
      else runs.push({ ...e });
    }
    const [r0, s0] = runs[0].from;
    const [x0, y0] = polar(ringRadius(r0), s0);
    d += `M${fmt(x0)} ${fmt(y0)}`;
    for (const e of runs) {
      const [x, y] = polar(ringRadius(e.to[0]), e.to[1]);
      if (e.kind === "arc") {
        const R = ringRadius(e.to[0]);
        // Steps grow counterclockwise on screen; SVG's sweep flag 1 is clockwise.
        const sweep = e.to[1] > e.from[1] ? 0 : 1;
        d += `A${fmt(R)} ${fmt(R)} 0 0 ${sweep} ${fmt(x)} ${fmt(y)}`;
      } else {
        d += `L${fmt(x)} ${fmt(y)}`;
      }
    }
    d += "Z";
  }
  return d;
}

function centerOf(cells: Cell[]): { center: [number, number]; meanStep: number; meanRing: number } {
  // Area-weighted mean of the cell centres, then nudged onto the nearest cell so it falls inside.
  let sx = 0, sy = 0, sw = 0, ss = 0, sr = 0;
  for (const c of cells) {
    const rm = (ringRadius(c.ring) + ringRadius(c.ring + 1)) / 2;
    const w = rm * (ringRadius(c.ring + 1) - ringRadius(c.ring));
    const [x, y] = polar(rm, c.step + 0.5);
    sx += x * w; sy += y * w; sw += w; ss += (c.step + 0.5) * w; sr += (c.ring + 0.5) * w;
  }
  const mx = sx / sw, my = sy / sw;
  let best: [number, number] = [mx, my], bd = Infinity;
  for (const c of cells) {
    const rm = (ringRadius(c.ring) + ringRadius(c.ring + 1)) / 2;
    const p = polar(rm, c.step + 0.5);
    const d = (p[0] - mx) ** 2 + (p[1] - my) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  // Keep the mean when it already sits inside a cell of the region (most regions); else take the nearest cell.
  const inside = bd < (UNIT * 0.6) ** 2;
  return { center: inside ? [mx, my] : best, meanStep: ss / sw, meanRing: sr / sw };
}

function build(): RegionShape[] {
  const owners = buildOwners();
  const shapes: RegionShape[] = [];
  for (const f of FACTIONS) {
    const list = info.warfronts[f] as { region: number[][]; name: string }[];
    list.forEach((reg, i) => {
      const id = `${f}:${i + 1}`;
      const cells = cellsOf(reg.region).filter((c) => owners.get(key(c.ring, c.step)) === id);
      const { center, meanStep, meanRing } = centerOf(cells);
      shapes.push({ id, faction: f, index: i + 1, nameKey: reg.name, path: tracePath(id, cells, owners), center, meanStep, meanRing, cells: cells.length });
    });
  }
  return shapes;
}

export const REGIONS: RegionShape[] = build();
export const REGION_BY_ID = new Map(REGIONS.map((r) => [r.id, r]));

/** The middle step of each front, for labels and the home world name. */
export const FRONT_MID: Record<Faction, number> = { cyborgs: 8, illuminates: 24, bugs: 40 };
/** The steps a front spans, for its wedge. */
export const FRONT_SPAN: Record<Faction, [number, number]> = { cyborgs: [1, 15], illuminates: [17, 31], bugs: [33, 47] };

/** An arc path from step a to step b at radius r (for text on a path), drawn left to right on screen. */
export function arcPath(r: number, a: number, b: number): string {
  const [x0, y0] = polar(r, a);
  const [x1, y1] = polar(r, b);
  const sweep = b > a ? 0 : 1;
  return `M${fmt(x0)} ${fmt(y0)}A${fmt(r)} ${fmt(r)} 0 0 ${sweep} ${fmt(x1)} ${fmt(y1)}`;
}

/** A filled annular wedge from step a to step b between radii r0 and r1. */
export function wedgePath(r0: number, r1: number, a: number, b: number): string {
  const [x0, y0] = polar(r1, a);
  const [x1, y1] = polar(r1, b);
  const [x2, y2] = polar(r0, b);
  const [x3, y3] = polar(r0, a);
  const large = Math.abs(b - a) * (360 / ANGULAR) > 180 ? 1 : 0;
  return `M${fmt(x0)} ${fmt(y0)}A${fmt(r1)} ${fmt(r1)} 0 ${large} 0 ${fmt(x1)} ${fmt(y1)}L${fmt(x2)} ${fmt(y2)}A${fmt(r0)} ${fmt(r0)} 0 ${large} 1 ${fmt(x3)} ${fmt(y3)}Z`;
}

/** The game's colours, [a, r, g, b], as CSS. `boost` scales the alpha. */
const colors = (raw as any).colors;
export function gameColor(group: string, name: string, boost = 1): string {
  const c = colors[group]?.[name] as number[] | undefined;
  if (!c) return "transparent";
  const [a, r, g, b] = c.map((v) => Math.min(255, Math.max(0, v)));
  return `rgba(${r}, ${g}, ${b}, ${Math.min(1, (a / 255) * boost).toFixed(3)})`;
}
export function gameRgb(group: string, name: string): string {
  const c = colors[group]?.[name] as number[] | undefined;
  if (!c) return "#888";
  const [, r, g, b] = c.map((v) => Math.min(255, Math.max(0, v)));
  return `rgb(${r}, ${g}, ${b})`;
}
