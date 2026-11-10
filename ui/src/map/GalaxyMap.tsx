// The galactic war overview: the game's own map, regions coloured by who holds them, events marked.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent, type KeyboardEvent as RKeyboardEvent } from "react";
import type { War, WarEvent } from "../types";
import { t } from "../strings";
import { clock, enemyName, pct, regionName, regionOf, regionProgress, FACTION_OF } from "../util";
import { FACTIONS, FRONT_MID, FRONT_SPAN, OUTER_R, REGIONS, SUPER_EARTH_R, arcPath, gameColor, polar, ringRadius, wedgePath, type Faction, type RegionShape } from "./geometry";

export type Selection =
  | { kind: "front"; enemy: number }
  | { kind: "region"; enemy: number; region: number }
  | { kind: "superearth" }
  | null;

export type RegionState = "liberated" | "front" | "enemy" | "home" | "hidden";

export function regionState(war: War, enemy: number, index: number): RegionState {
  const f = war.fronts.find((x) => x.enemy === enemy);
  if (!f || f.status === "hidden") return "hidden";
  if (f.status === "defeated") return "liberated";
  const cur = regionOf(f);
  if (index >= 11) return "home";
  if (index < cur) return "liberated";
  if (index === cur) return "front";
  return "enemy";
}

/** Colours per faction and state, from the game's table. Alphas lifted, as the game draws additively over a bright backdrop. */
function paint(f: Faction, s: RegionState): { fill: string; stroke: string } {
  switch (s) {
    case "liberated": return { fill: gameColor("helldivers", "fill_color", 0.5), stroke: gameColor("helldivers", "border_color", 1) };
    case "front": return { fill: gameColor(f, "active_fill_color", 0.62), stroke: gameColor(f, "active_border_color", 1.25) };
    case "home": return { fill: gameColor(f, "hq_fill_color", 0.95), stroke: gameColor(f, "hq_border_color", 1.4) };
    case "hidden": return { fill: gameColor("hidden", "fill_color", 2.4), stroke: gameColor("hidden", "border_color", 1.6) };
    default: return { fill: gameColor(f, "fill_color", 1.15), stroke: gameColor(f, "border_color", 1.7) };
  }
}

export const FACTION_ACCENT: Record<Faction, string> = {
  bugs: gameColor("bugs", "active_border_color", 4),
  cyborgs: gameColor("cyborgs", "active_border_color", 4),
  illuminates: gameColor("illuminates", "active_border_color", 4),
};
/** The Helldiver amber of the game's progress bars (bar_color is [r, g, b], without alpha). */
export const HELLDIVER_ACCENT = "rgb(255, 170, 20)";

// Room for the home world names: they sit beside and under the rings, never above them.
const PAD_X = 100, PAD_TOP = 28, PAD_BOTTOM = 92;
const FULL = { x: -OUTER_R - PAD_X, y: -OUTER_R - PAD_TOP, w: (OUTER_R + PAD_X) * 2, h: OUTER_R * 2 + PAD_TOP + PAD_BOTTOM };

interface Props {
  war: War;
  names: Record<string, string>;
  selection: Selection;
  onSelect: (s: Selection) => void;
  nowUnix: number;
}

type Hover = { x: number; y: number; title: string; lines: string[] } | null;

function eventsByRegion(war: War): Map<string, WarEvent> {
  const m = new Map<string, WarEvent>();
  const evs = [...(war.defend_event && war.defend_event.status === "active" ? [war.defend_event] : []), ...war.attack_events.filter((e) => e.status === "active")];
  for (const e of evs) m.set(e.region === 0 ? "superearth" : `${FACTION_OF[e.enemy]}:${Math.min(11, e.region)}`, e);
  return m;
}

export const GalaxyMap = memo(function GalaxyMap({ war, names, selection, onSelect, nowUnix }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [view, setView] = useState(FULL);
  const [hover, setHover] = useState<Hover>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean; id: number } | null>(null);
  const events = useMemo(() => eventsByRegion(war), [war]);
  const zoomed = view.w < FULL.w - 1;

  const selId = selection?.kind === "region" ? `${FACTION_OF[selection.enemy]}:${selection.region}` : selection?.kind === "superearth" ? "superearth" : null;
  const selFront = selection && selection.kind !== "superearth" ? FACTION_OF[selection.enemy] : null;

  // The map's size on screen: text keeps a readable size however small the map is drawn.
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 800, h: el.clientHeight || 600 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const ppu = Math.max(0.05, Math.min(size.w / view.w, size.h / view.h));
  /** A font size in map units: `base` at full size, never under `minPx` on screen, never over `max`. */
  const fs = (base: number, minPx: number, max: number) => Math.min(max, Math.max(base, minPx / ppu));
  const nameF = fs(24, 12.5, 46), subF = fs(16, 10.5, 34), numF = fs(19, 10.5, 34), frontF = fs(23, 13, 40), seF = fs(16, 10.5, 30);
  const markK = Math.min(3.2, Math.max(1.5, 10.5 / (12 * ppu)));
  // Home world labels: top fronts write outward from the ring, the bottom front inward, so both lines
  // stack the same way at any font size.
  const rSubTop = OUTER_R + 8, rNameTop = rSubTop + subF * 1.17;
  const rNameBottom = OUTER_R + 8 + nameF * 0.72, rSubBottom = rNameBottom + subF * 1.17;

  // Wheel zoom about the pointer, from the whole map down to a third of it.
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setView((v) => {
        const k = Math.exp(e.deltaY * 0.0015);
        const w = Math.min(FULL.w, Math.max(FULL.w / 3, v.w * k));
        const s = Math.min(r.width / v.w, r.height / v.h);
        const ox = (r.width - v.w * s) / 2, oy = (r.height - v.h * s) / 2;
        const px = v.x + (e.clientX - r.left - ox) / s, py = v.y + (e.clientY - r.top - oy) / s;
        const ratio = w / v.w;
        return clampView({ x: px - (px - v.x) * ratio, y: py - (py - v.y) * ratio, w, h: (w * FULL.h) / FULL.w });
      });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  const onDown = (e: RPointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, id: e.pointerId };
  };
  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (d && zoomed) {
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) > 5) { d.moved = true; svg.current?.setPointerCapture(d.id); }
      if (d.moved) {
        const r = svg.current!.getBoundingClientRect();
        const s = Math.min(r.width / view.w, r.height / view.h);
        setView((v) => clampView({ ...v, x: d.vx - dx / s, y: d.vy - dy / s }));
        setHover(null);
        return;
      }
    }
    const host = (e.target as Element).closest?.("[data-region]");
    if (!host || !wrap.current) { if (hover) setHover(null); return; }
    const id = host.getAttribute("data-region")!;
    const r = wrap.current.getBoundingClientRect();
    setHover({ x: e.clientX - r.left, y: e.clientY - r.top, ...describe(id) });
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) { svg.current?.releasePointerCapture(d.id); }
  };
  const clickRegion = (id: string) => {
    if (drag.current?.moved) return;
    if (id === "superearth") return onSelect(selId === id ? null : { kind: "superearth" });
    const [f, i] = id.split(":");
    const enemy = FACTION_OF.indexOf(f as Faction);
    const region = Number(i);
    onSelect(selId === id ? { kind: "front", enemy } : { kind: "region", enemy, region });
  };

  const describe = useCallback((id: string): { title: string; lines: string[] } => {
    if (id === "superearth") {
      const ev = events.get("superearth");
      return { title: regionName(null, 0, names), lines: ev ? [t("defenseOf", { region: regionName(null, 0, names) }), t("endsIn", { t: clock(ev.end_time - nowUnix) })] : [t("superEarthText")] };
    }
    const [f, i] = id.split(":");
    const enemy = FACTION_OF.indexOf(f as Faction);
    const index = Number(i);
    const front = war.fronts.find((x) => x.enemy === enemy);
    const st = regionState(war, enemy, index);
    const lines = [`${t("frontOf", { enemy: enemyName(enemy) })} · ${index >= 11 ? t("homeWorldState") : t("regionOf", { n: index })}`];
    lines.push(st === "liberated" ? t("liberated") : st === "front" ? `${t("contested")} · ${pct(front ? regionProgress(front) : 0)}` : st === "hidden" ? t("hidden") : st === "home" ? t("homeWorldState") : t("enemyHeld"));
    const ev = events.get(id);
    if (ev) lines.push(`${ev.region >= 11 ? t("attackOn", { region: "" }).trim() : t("defense")} · ${pct(ev.points / ev.points_max)} · ${clock(ev.end_time - nowUnix)}`);
    return { title: regionName(enemy, index, names), lines };
  }, [events, names, nowUnix, war]);

  // Keyboard: arrows walk the regions of a front and between fronts; Escape clears.
  const onKey = (e: RKeyboardEvent) => {
    const order = [1, 2, 0]; // cyborgs, illuminates, bugs: around the circle
    const cur = selection && selection.kind !== "superearth" ? selection : null;
    if (e.key === "Escape") { onSelect(null); return; }
    if (e.key === "Home") { onSelect({ kind: "superearth" }); e.preventDefault(); return; }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    if (!cur) { onSelect({ kind: "region", enemy: 1, region: regionOf(war.fronts[1] ?? { region: 1 } as any) }); return; }
    const reg = cur.kind === "region" ? cur.region : regionOf(war.fronts.find((x) => x.enemy === cur.enemy)!);
    if (e.key === "ArrowUp") onSelect({ kind: "region", enemy: cur.enemy, region: Math.min(11, reg + 1) });
    else if (e.key === "ArrowDown") { if (reg <= 1) onSelect({ kind: "superearth" }); else onSelect({ kind: "region", enemy: cur.enemy, region: reg - 1 }); }
    else {
      const i = order.indexOf(cur.enemy);
      const next = order[(i + (e.key === "ArrowRight" ? 1 : order.length - 1)) % order.length];
      onSelect({ kind: "region", enemy: next, region: Math.min(reg, 11) });
    }
  };

  const vb = `${view.x} ${view.y} ${view.w} ${view.h}`;
  const shapesByFaction = useMemo(() => {
    const m: Record<Faction, RegionShape[]> = { bugs: [], cyborgs: [], illuminates: [] };
    for (const r of REGIONS) m[r.faction].push(r);
    return m;
  }, []);

  return (
    <div ref={wrap} className={`galaxy${zoomed ? " zoomed" : ""}`}>
      <Starfield />
      <svg ref={svg} className="galaxy-svg" viewBox={vb} preserveAspectRatio="xMidYMid meet" tabIndex={0} role="application" aria-label={t("mapTitle")}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => setHover(null)} onKeyDown={onKey}
        onDoubleClick={() => setView(FULL)}
        onClick={(e) => { if (!(e.target as Element).closest("[data-region]") && !drag.current?.moved) onSelect(null); }}>
        <defs>
          <radialGradient id="se-core" cx="42%" cy="38%" r="70%">
            <stop offset="0%" stopColor="#f4fbff" />
            <stop offset="35%" stopColor="#9fd0f0" />
            <stop offset="75%" stopColor="#2f6f9e" />
            <stop offset="100%" stopColor="#123a5a" />
          </radialGradient>
          <radialGradient id="se-glow">
            <stop offset="45%" stopColor="rgba(150, 210, 255, 0.55)" />
            <stop offset="70%" stopColor="rgba(120, 180, 255, 0.16)" />
            <stop offset="100%" stopColor="rgba(120, 180, 255, 0)" />
          </radialGradient>
          <radialGradient id="map-haze">
            <stop offset="0%" stopColor="rgba(120, 150, 210, 0.16)" />
            <stop offset="60%" stopColor="rgba(80, 100, 160, 0.06)" />
            <stop offset="100%" stopColor="rgba(80, 100, 160, 0)" />
          </radialGradient>
          <filter id="soft-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="5" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          {FACTIONS.map((f) => {
            const top = f !== "illuminates";
            const [a, b] = FRONT_SPAN[f];
            const rName = top ? rNameTop : rNameBottom;
            const rSub = top ? rSubTop : rSubBottom;
            return [
              <path key={`${f}-n`} id={`hwn-${f}`} d={top ? arcPath(rName, b + 2, a - 2) : arcPath(rName, a - 2, b + 2)} />,
              <path key={`${f}-s`} id={`hws-${f}`} d={top ? arcPath(rSub, b + 2, a - 2) : arcPath(rSub, a - 2, b + 2)} />,
            ];
          })}
        </defs>

        <circle r={OUTER_R + 70} fill="url(#map-haze)" />
        {/* The grid: one faint circle per ring, and the edges of each front. */}
        <g className="grid">
          {Array.from({ length: 12 }, (_, i) => <circle key={i} r={ringRadius(i)} />)}
          {FACTIONS.map((f) => <path key={f} className={`wedge ${f}${selFront === f ? " on" : ""}`} d={wedgePath(ringRadius(0), ringRadius(11), FRONT_SPAN[f][0], FRONT_SPAN[f][1])} />)}
        </g>

        {FACTIONS.map((f) => (
          <g key={f} className={`front ${f}`}>
            {shapesByFaction[f].map((r) => {
              const st = regionState(war, FACTION_OF.indexOf(f), r.index);
              const p = paint(f, st);
              return (
                <path key={r.id} data-region={r.id} className={`region ${st}${selId === r.id ? " sel" : ""}`} d={r.path}
                  style={{ fill: p.fill, stroke: p.stroke } as CSSProperties} onClick={() => clickRegion(r.id)} />
              );
            })}
          </g>
        ))}

        {/* The front line pulses; the selected region gets a bright outline on top of everything. */}
        <g className="pulses" aria-hidden>
          {REGIONS.filter((r) => regionState(war, FACTION_OF.indexOf(r.faction), r.index) === "front").map((r) => (
            <path key={r.id} className="pulse" d={r.path} style={{ stroke: FACTION_ACCENT[r.faction] }} />
          ))}
        </g>
        {selId && selId !== "superearth" && <path className="sel-outline" d={REGIONS.find((r) => r.id === selId)!.path} />}

        {/* Region numbers. */}
        <g className="region-nums" aria-hidden>
          {REGIONS.filter((r) => r.index <= 10).map((r) => {
            const st = regionState(war, FACTION_OF.indexOf(r.faction), r.index);
            return <text key={r.id} x={r.center[0]} y={r.center[1]} className={st} style={{ fontSize: st === "front" ? frontF : numF }}>{r.index}</text>;
          })}
        </g>

        {/* Super Earth */}
        <g className={`superearth${selId === "superearth" ? " sel" : ""}${events.has("superearth") ? " threat" : ""}`} data-region="superearth" onClick={() => clickRegion("superearth")}>
          <circle r={SUPER_EARTH_R * 1.75} fill="url(#se-glow)" className="se-glow" />
          <circle r={SUPER_EARTH_R} fill="url(#se-core)" className="se-core" />
          <path className="se-lines" d={`M${-SUPER_EARTH_R * 0.92} -12 Q0 ${-SUPER_EARTH_R * 0.25} ${SUPER_EARTH_R * 0.92} -12 M${-SUPER_EARTH_R * 0.78} 26 Q0 ${SUPER_EARTH_R * 0.62} ${SUPER_EARTH_R * 0.78} 26`} />
          <circle r={SUPER_EARTH_R + 4} className="se-ring" />
          <text y={SUPER_EARTH_R + 8 + seF} className="se-label" style={{ fontSize: seF }}>{regionName(null, 0, names).toUpperCase()}</text>
        </g>

        {/* Home world names and front state at the outer ring. */}
        <g className="hw-labels">
          {FACTIONS.map((f) => {
            const enemy = FACTION_OF.indexOf(f);
            const front = war.fronts.find((x) => x.enemy === enemy);
            const status = !front || front.status === "hidden" ? t("hidden") : front.status === "defeated" ? t("status_defeated") : `${enemyName(enemy)} · ${t("regionOf", { n: regionOf(front) })}`;
            return (
              <g key={f} className={`hw ${f}${front?.status === "hidden" ? " dim" : ""}`}>
                <text className="hw-name" style={{ fontSize: nameF }}><textPath href={`#hwn-${f}`} startOffset="50%">{regionName(enemy, 11, names).toUpperCase()}</textPath></text>
                <text className="hw-sub" style={{ fontSize: subF, fill: front?.status === "active" ? FACTION_ACCENT[f] : undefined }}><textPath href={`#hws-${f}`} startOffset="50%">{status.toUpperCase()}</textPath></text>
              </g>
            );
          })}
        </g>

        {/* Events: a warning triangle for a defense, a target on a home world under attack. */}
        <g className="markers">
          {[...events.entries()].map(([id, ev]) => {
            const shape = id === "superearth" ? null : REGIONS.find((r) => r.id === id);
            const [x, y] = shape ? (shape.index >= 11 ? polar((ringRadius(10) + ringRadius(11)) / 2, FRONT_MID[shape.faction]) : shape.center) : [0, -SUPER_EARTH_R - 30];
            const left = ev.end_time - nowUnix;
            const attack = ev.region >= 11;
            return (
              <g key={ev.event_id} className={`marker ${attack ? "attack" : "defend"}`} transform={`translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${markK.toFixed(2)})`} data-region={id} onClick={() => clickRegion(id)}>
                <circle r="22" className="marker-ping" />
                {attack
                  ? <g className="marker-icon"><circle r="13" /><path d="M0 -20V-6M0 6V20M-20 0H-6M6 0H20" /></g>
                  : <g className="marker-icon"><path d="M0 -17L16 11H-16Z" /><path d="M0 -6V2M0 5.5V7.5" className="mark" /></g>}
                <g transform="translate(0 30)">
                  <rect x="-40" y="-11" width="80" height="20" className="marker-tag" />
                  <text y="4" className="marker-time">{clock(left, false)}</text>
                </g>
              </g>
            );
          })}
        </g>
      </svg>

      {hover && <div className="map-tip" style={{ left: hover.x, top: hover.y }}><b>{hover.title}</b>{hover.lines.map((l, i) => <span key={i}>{l}</span>)}</div>}
      {zoomed && <button className="btn small map-reset" onClick={() => setView(FULL)}>{t("zoomReset")}</button>}
    </div>
  );
});

function clampView(v: { x: number; y: number; w: number; h: number }) {
  const maxX = FULL.x + FULL.w - v.w, maxY = FULL.y + FULL.h - v.h;
  return { ...v, x: Math.min(maxX, Math.max(FULL.x, v.x)), y: Math.min(maxY, Math.max(FULL.y, v.y)) };
}

/** A fixed starfield: small dots from a seeded generator, two nebula washes behind them in CSS. */
const Starfield = memo(function Starfield() {
  const stars = useMemo(() => {
    let s = 1337;
    const r = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    return Array.from({ length: 260 }, () => ({ x: r() * 1600, y: r() * 1000, r: r() < 0.08 ? 1.3 + r() : 0.35 + r() * 0.7, o: 0.25 + r() * 0.6, tw: r() < 0.12 }));
  }, []);
  return (
    <svg className="stars" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" aria-hidden>
      {stars.map((st, i) => <circle key={i} cx={st.x} cy={st.y} r={st.r} opacity={st.o} className={st.tw ? "tw" : undefined} style={st.tw ? { animationDelay: `${(i % 7) * 0.7}s` } : undefined} />)}
    </svg>
  );
});
