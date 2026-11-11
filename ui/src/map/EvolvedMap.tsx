// The Evolved war map: the HELLDIVERS 2 galaxy, the sectors tinted by who holds them, supply lines,
// planets coloured by owner, campaigns and the Major Order targets. Only the planets take clicks.
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from "react";
import type { EvoCampaign, Evolved, War } from "../types";
import { t } from "../strings";
import { clock, enemySingle } from "../util";
import { activeOrders, ownerName, pctText, secondsLeft } from "../evolved";
import { BORDER_PATH, EDGE_PATH, LINKS, NEIGHBOURS, OWNER_KEYS, PLANETS, RIM, SECTORS, SECTOR_EDGES, ownerColor, sectorHolder } from "./galaxy";

const PAD_X = 125, PAD_Y = 22;
const FULL = { x: -RIM - PAD_X, y: -RIM - PAD_Y, w: (RIM + PAD_X) * 2, h: (RIM + PAD_Y) * 2 };
/** Where each enemy name sits outside the rim: degrees counterclockwise from the right, and the text anchor. */
const ENEMY_LABEL: Record<number, { deg: number; anchor: "start" | "end"; hang: boolean }> = {
  1: { deg: 28, anchor: "start", hang: false },
  2: { deg: 152, anchor: "end", hang: false },
  3: { deg: 238, anchor: "end", hang: true },
};

interface Props {
  war: War;
  evo: Evolved;
  selected: number | null;
  onSelect: (planet: number | null) => void;
  /** The planets of a Major Order being written; clicks then add or remove planets. */
  picks: number[] | null;
  onPick: (planet: number) => void;
  nowUnix: number;
}

type Hover = { x: number; y: number; planet: number } | null;

export const EvolvedMap = memo(function EvolvedMap({ war, evo, selected, onSelect, picks, onPick, nowUnix }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [view, setView] = useState(FULL);
  const [hover, setHover] = useState<Hover>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean; id: number } | null>(null);
  const zoomed = view.w < FULL.w - 1;
  const owners = evo.owners;
  const ownersKey = owners.join("");

  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 800, h: el.clientHeight || 600 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const ppu = Math.max(0.05, Math.min(size.w / view.w, size.h / view.h));
  /** A text size in map units: `base`, kept between `minPx` and `maxPx` on screen at any zoom. */
  const fs = (base: number, minPx: number, maxPx: number) => Math.min(maxPx / ppu, Math.max(base, minPx / ppu));
  const sectorF = fs(11, 9.5, 12.5), nameF = fs(12, 11, 14), enemyF = Math.min(30, fs(24, 14, 22)), enemySubF = fs(13, 10, 13), seF = fs(12, 10, 14);
  const dotR = Math.round(Math.min(7, Math.max(3, 2.3 / ppu)) * 10) / 10;
  const markK = Math.min(2.4, Math.max(0.7, 10 / (12 * ppu)));
  const seR = Math.min(26, Math.max(15, 8 / ppu));

  // Wheel zoom about the pointer, from the whole map down to a quarter of it.
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setView((v) => {
        const k = Math.exp(e.deltaY * 0.0015);
        const w = Math.min(FULL.w, Math.max(FULL.w / 4, v.w * k));
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
    const host = (e.target as Element).closest?.("[data-planet]");
    if (!host || !wrap.current) { if (hover) setHover(null); return; }
    const r = wrap.current.getBoundingClientRect();
    setHover({ x: e.clientX - r.left, y: e.clientY - r.top, planet: Number(host.getAttribute("data-planet")) });
  };
  const onUp = () => {
    const d = drag.current;
    if (d?.moved) svg.current?.releasePointerCapture(d.id);
    // The click that ends a drag comes after this; clear the drag a moment later.
    setTimeout(() => { if (drag.current === d) drag.current = null; }, 0);
  };
  const onClick = (e: RMouseEvent) => {
    if (drag.current?.moved) return;
    const host = (e.target as Element).closest("[data-planet]");
    if (!host) { if (!picks) onSelect(null); return; }
    const id = Number(host.getAttribute("data-planet"));
    if (picks) onPick(id);
    else onSelect(selected === id ? null : id);
  };

  // The sectors, borders, supply lines and planets change only with the owners and the zoom.
  const territory = useMemo(() => {
    const own = ownersKey.split("").map(Number);
    const sameLinks: string[] = ["", "", "", ""];
    let crossLinks = "";
    for (const [a, b] of LINKS) {
      const pa = PLANETS[a], pb = PLANETS[b];
      const seg = `M${pa.x} ${pa.y}L${pb.x} ${pb.y}`;
      if (own[a] === own[b]) sameLinks[own[a]] += seg;
      else crossLinks += seg;
    }
    const holders = SECTORS.map((s) => sectorHolder(own, s));
    let front = "";
    for (const e of SECTOR_EDGES) if (holders[e.a].owner !== holders[e.b].owner) front += e.d;
    return (
      <g className="evo-territory">
        {SECTORS.map((s) => {
          const h = holders[s.id];
          return <path key={s.id} d={s.path} className="evo-sector" style={{ fill: ownerColor(h.owner, h.owner === 0 ? 0.05 : 0.07 + 0.18 * h.share) }} />;
        })}
        <path className="evo-sector-borders" d={BORDER_PATH} />
        <path className="evo-galaxy-edge" d={EDGE_PATH} />
        <path className="evo-front-lines" d={front} />
        {sameLinks.map((d, o) => d && <path key={o} className="evo-links" d={d} style={{ stroke: ownerColor(o, o === 0 ? 0.3 : 0.42) }} />)}
        <path className="evo-links cross" d={crossLinks} />
        <g className="evo-dots">
          {PLANETS.map((p) => p.id !== 0 && (
            <g key={p.id} className="evo-planet" data-planet={p.id}>
              <circle cx={p.x} cy={p.y} r={Math.max(dotR * 2.2, 7 / ppu)} className="evo-hit" />
              <circle cx={p.x} cy={p.y} r={p.home ? dotR * 1.8 : dotR} className={`evo-dot${p.home ? " home" : ""}`}
                style={{ fill: ownerColor(own[p.id], 1), stroke: p.home ? ownerColor(own[p.id], 0.5) : undefined }} />
            </g>
          ))}
        </g>
      </g>
    );
  }, [ownersKey, dotR, ppu]);

  const counts = useMemo(() => {
    const c = [0, 0, 0, 0];
    for (const o of owners) c[o] = (c[o] ?? 0) + 1;
    return c;
  }, [owners]);

  const orderPlanets = useMemo(() => new Set(activeOrders(evo).flatMap((o) => o.kind === "missions" ? [] : o.planets)), [evo]);
  const vb = `${view.x} ${view.y} ${view.w} ${view.h}`;
  const sel = selected != null ? PLANETS[selected] : null;
  const hoverPlanet = hover ? PLANETS[hover.planet] : null;

  return (
    <div ref={wrap} className={`galaxy evo${zoomed ? " zoomed" : ""}${picks ? " picking" : ""}`}>
      <Stars />
      <svg ref={svg} className="galaxy-svg" viewBox={vb} preserveAspectRatio="xMidYMid meet" tabIndex={0} role="application" aria-label={t("evoMapTitle")}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => setHover(null)} onClick={onClick}
        onKeyDown={(e) => { if (e.key === "Escape") onSelect(null); }} onDoubleClick={() => setView(FULL)}>
        <defs>
          <radialGradient id="evo-se-core" cx="42%" cy="38%" r="70%">
            <stop offset="0%" stopColor="#f4fbff" />
            <stop offset="35%" stopColor="#9fd0f0" />
            <stop offset="75%" stopColor="#2f6f9e" />
            <stop offset="100%" stopColor="#123a5a" />
          </radialGradient>
          <radialGradient id="evo-se-glow">
            <stop offset="45%" stopColor="rgba(150, 210, 255, 0.5)" />
            <stop offset="100%" stopColor="rgba(120, 180, 255, 0)" />
          </radialGradient>
          <radialGradient id="evo-haze">
            <stop offset="0%" stopColor="rgba(70, 160, 255, 0.08)" />
            <stop offset="70%" stopColor="rgba(80, 100, 160, 0.05)" />
            <stop offset="100%" stopColor="rgba(80, 100, 160, 0.02)" />
          </radialGradient>
          <filter id="evo-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        <circle r={RIM} className="evo-disc" fill="url(#evo-haze)" />
        {territory}
        <circle r={RIM} className="evo-rim" />

        {/* Sector names; Sol is Super Earth and keeps the Super Earth label. */}
        <g className="evo-sectors" aria-hidden>
          {SECTORS.filter((s) => s.id !== 0).map((s) => <text key={s.id} x={s.x} y={s.y} style={{ fontSize: sectorF }}>{s.name.toUpperCase()}</text>)}
        </g>

        {/* The planets of the order being written, and the selected planet. */}
        {picks && (
          <g className="evo-picks" aria-hidden>
            {picks.map((id) => <circle key={id} cx={PLANETS[id].x} cy={PLANETS[id].y} r={dotR * 2.6} />)}
          </g>
        )}

        {/* Home worlds */}
        <g className="evo-homes" aria-hidden>
          {PLANETS.filter((p) => p.home).map((p) => (
            <text key={p.id} x={p.x} y={p.y + dotR * 1.8 + nameF * 1.05} style={{ fontSize: nameF }}>{p.name.toUpperCase()}</text>
          ))}
        </g>

        {/* Super Earth */}
        <g className={`evo-se${selected === 0 ? " sel" : ""}`} data-planet={0}>
          <circle r={seR * 1.8} fill="url(#evo-se-glow)" className="se-glow" />
          <circle r={seR} fill="url(#evo-se-core)" className="se-core" />
          <circle r={seR + 3} className="se-ring" />
          <text y={seR + 6 + seF} className="se-label" style={{ fontSize: seF }}>{PLANETS[0].name.toUpperCase()}</text>
        </g>

        {/* Major Order targets */}
        <g className="evo-order-marks" aria-hidden>
          {[...orderPlanets].map((id) => (
            <path key={id} transform={`translate(${PLANETS[id].x} ${PLANETS[id].y}) scale(${markK.toFixed(2)})`} d="M0 -17L17 0L0 17L-17 0Z" />
          ))}
        </g>

        {/* Campaigns */}
        <g className="evo-marks">
          {evo.campaigns.map((c) => <CampaignMark key={c.id} c={c} k={markK} nameF={nameF} left={secondsLeft(c.ends_in, war, nowUnix)} />)}
        </g>

        {sel && <circle className="evo-sel-ring" cx={sel.x} cy={sel.y} r={sel.id === 0 ? seR + 8 : Math.max(dotR * 2.8, 9 * markK)} />}

        {/* The enemies outside the rim, on their side */}
        <g className="evo-enemies" aria-hidden>
          {[1, 2, 3].map((o) => {
            const l = ENEMY_LABEL[o];
            const a = (l.deg * Math.PI) / 180, r = RIM + 14;
            const x = r * Math.cos(a), y = -r * Math.sin(a);
            const subY = l.hang ? y + enemyF * 1.05 : y + enemySubF * 1.25;
            return (
              <g key={o} className={`evo-enemy ${OWNER_KEYS[o]}`} style={{ "--oc": ownerColor(o) } as CSSProperties}>
                <text x={x} y={y} textAnchor={l.anchor} dominantBaseline={l.hang ? "hanging" : "auto"} className="evo-enemy-name" style={{ fontSize: enemyF }}>{ownerName(o).toUpperCase()}</text>
                <text x={x} y={subY} textAnchor={l.anchor} dominantBaseline={l.hang ? "hanging" : "auto"} className="evo-enemy-sub" style={{ fontSize: enemySubF }}>
                  {(counts[o] === 1 ? t("planetOne") : t("planetsN", { n: counts[o] })).toUpperCase()}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {hover && hoverPlanet && (
        <div className="map-tip" style={{
          left: hover.x, top: hover.y,
          // Near the right or bottom edge the tip opens the other way, so it stays inside the stage.
          transform: `translate(${hover.x > (wrap.current?.clientWidth ?? 0) - 300 ? "calc(-100% - 14px)" : "14px"}, ${hover.y > (wrap.current?.clientHeight ?? 0) - 150 ? "calc(-100% - 14px)" : "14px"})`,
        }}>
          <b>{hoverPlanet.name}</b>
          <TipLines evo={evo} war={war} planet={hoverPlanet.id} nowUnix={nowUnix} picks={picks} order={orderPlanets.has(hoverPlanet.id)} />
        </div>
      )}
      {zoomed && <button className="btn small map-reset" onClick={() => setView(FULL)}>{t("zoomReset")}</button>}
    </div>
  );
});

function TipLines({ evo, war, planet, nowUnix, picks, order }: { evo: Evolved; war: War; planet: number; nowUnix: number; picks: number[] | null; order: boolean }) {
  const p = PLANETS[planet];
  const owner = evo.owners[planet];
  const c = evo.campaigns.find((x) => x.planet === planet);
  const lines: string[] = [t("sectorName", { name: SECTORS[p.sector]?.name ?? "" }), t("heldBy", { owner: ownerName(owner) })];
  if (p.home) lines.push(t("homeWorld", { enemy: enemySingle(p.home - 1) }));
  if (c?.kind === "liberation") lines.push(`${t("liberationLabel")} · ${pctText(c.liberation)} · ${t("liberationRate", { p: pctText(c.per_mission), r: pctText(c.regen_per_hour) })}`);
  if (c?.kind === "defense") lines.push(`${t("defense")} · ${pctText(c.defense)} · ${t("leftT", { t: clock(secondsLeft(c.ends_in, war, nowUnix) ?? 0) })}`);
  if (order) lines.push(t("orderTarget_tip"));
  if (picks) lines.push(picks.includes(planet) ? t("orderUnpickTip") : t("orderPickTip"));
  else if (!c) lines.push(t("supplyLines") + ": " + NEIGHBOURS[planet].length);
  return <>{lines.map((l, i) => <span key={i}>{l}</span>)}</>;
}

function CampaignMark({ c, k, nameF, left }: { c: EvoCampaign; k: number; nameF: number; left: number | null }) {
  const p = PLANETS[c.planet];
  const defense = c.kind === "defense";
  const style = { "--oc": ownerColor(c.faction) } as CSSProperties;
  return (
    <g className={`evo-mark ${c.kind}`} data-planet={c.planet} style={style}>
      <g transform={`translate(${p.x} ${p.y}) scale(${k.toFixed(2)})`}>
        <circle r="20" className="marker-ping" />
        {defense
          ? <g className="evo-mark-icon"><path d="M0 -13L12 8.5H-12Z" /><path d="M0 -4.5V1.5M0 4V5.6" className="mark" /></g>
          : <g className="evo-mark-icon"><circle r="10" /><path d="M-4.5 2.6L0 -2.4L4.5 2.6" className="mark" /></g>}
      </g>
      {/* The name and the progress beside the mark, so nothing under it is covered. */}
      <text x={p.x + 14 * k} y={p.y - nameF * 0.12} className="evo-mark-name" style={{ fontSize: nameF }}>{p.name.toUpperCase()}</text>
      <text x={p.x + 14 * k} y={p.y + nameF * 0.98} className="evo-mark-value" style={{ fontSize: nameF * 0.95 }}>
        {defense ? clock(left ?? 0, false) : pctText(c.liberation)}
      </text>
    </g>
  );
}

function clampView(v: { x: number; y: number; w: number; h: number }) {
  const maxX = FULL.x + FULL.w - v.w, maxY = FULL.y + FULL.h - v.h;
  return { ...v, x: Math.min(maxX, Math.max(FULL.x, v.x)), y: Math.min(maxY, Math.max(FULL.y, v.y)) };
}

const Stars = memo(function Stars() {
  const stars = useMemo(() => {
    let s = 4242;
    const r = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    return Array.from({ length: 220 }, () => ({ x: r() * 1600, y: r() * 1000, r: r() < 0.08 ? 1.2 + r() : 0.35 + r() * 0.6, o: 0.2 + r() * 0.5 }));
  }, []);
  return (
    <svg className="stars" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" aria-hidden>
      {stars.map((st, i) => <circle key={i} cx={st.x} cy={st.y} r={st.r} opacity={st.o} />)}
    </svg>
  );
});
