// The three fronts' progress over time, as lines. One region is a tenth of the height.
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { t } from "../strings";
import type { Snapshot, War } from "../types";
import { dateTime, enemyName, pct, timeOfDay, FACTION_OF } from "../util";
import { FACTION_ACCENT } from "../map/GalaxyMap";
import { Seg } from "./ui";

type Range = "day" | "week" | "all";

/** Round times for the x axis: midnights over a long span, whole hours over a short one, at most `max`. */
function axisTicks(t0: number, t1: number, max: number): { tm: number; label: string }[] {
  const span = t1 - t0;
  const days = span > 36 * 3600;
  const steps = days ? [1, 2, 7, 14, 30].map((d) => d * 86400) : [1, 2, 3, 6, 12].map((h) => h * 3600);
  const step = steps.find((s) => span / s <= max) ?? steps[steps.length - 1];
  const start = (() => {
    const d = new Date(t0 * 1000);
    if (days) { d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 1); } else { d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); }
    return d.getTime() / 1000;
  })();
  const out: { tm: number; label: string }[] = [];
  for (let tm = start; tm <= t1 && out.length < max + 1; tm += step) out.push({ tm, label: days ? dateTime(tm).replace(/,.*$/, "") : timeOfDay(tm) });
  if (out.length === 0) out.push({ tm: t0, label: timeOfDay(t0) });
  return out;
}
const SPAN: Record<Range, number> = { day: 86400, week: 7 * 86400, all: Infinity };

export function HistoryChart({ war, history, nowUnix }: { war: War; history: Snapshot[]; nowUnix: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(320);
  const [range, setRange] = useState<Range>("all");
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const points = useMemo(() => {
    const live: Snapshot = { time: nowUnix, data: war.fronts.map((f) => ({ points: f.points, status: f.status })) };
    const all = [...history.filter((s) => s.season == null || s.season === war.season), live].sort((a, b) => a.time - b.time);
    const from = nowUnix - SPAN[range];
    return all.filter((s) => s.time >= from);
  }, [history, war, nowUnix, range]);

  const H = 176, L = 30, R = 8, T = 10, B = 22;
  const iw = Math.max(10, w - L - R), ih = H - T - B;
  const t0 = points[0]?.time ?? nowUnix - 3600;
  const t1 = Math.max(t0 + 60, points[points.length - 1]?.time ?? nowUnix);
  const x = (tm: number) => L + ((tm - t0) / (t1 - t0)) * iw;
  const y = (v: number) => T + (1 - Math.max(0, Math.min(1, v))) * ih;
  const fronts = war.fronts.filter((f) => f.status !== "hidden");
  const val = (s: Snapshot, i: number) => {
    const d = s.data[i];
    if (!d) return null;
    if (d.status === "defeated") return 1;
    return d.points / (war.fronts[i]?.points_max || war.settings.points_max);
  };
  const line = (i: number) => {
    let d = "";
    points.forEach((s) => {
      const v = val(s, i);
      if (v == null) return;
      d += `${d ? "L" : "M"}${x(s.time).toFixed(1)} ${y(v).toFixed(1)}`;
    });
    return d;
  };
  const ticks = 4;
  const hi = hover != null ? points[hover] : null;

  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const tm = t0 + ((e.clientX - r.left - L) / iw) * (t1 - t0);
    let best = 0, bd = Infinity;
    points.forEach((s, k) => { const d = Math.abs(s.time - tm); if (d < bd) { bd = d; best = k; } });
    setHover(best);
  };

  return (
    <div className="history">
      <div className="history-head">
        <h3 className="cap section-title" data-tip={t("historyLead")}>{t("historyTitle")}</h3>
        <Seg small value={range} onChange={setRange} options={[{ v: "day", label: t("range_day") }, { v: "week", label: t("range_week") }, { v: "all", label: t("range_all") }]} />
      </div>
      <div ref={box} className="chart-box">
        {points.length < 2 ? <p className="muted empty">{t("historyEmpty")}</p> : (
          <svg width={w} height={H} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={t("historyTitle")}>
            <defs>
              {fronts.map((f) => (
                <linearGradient key={f.enemy} id={`hg-${f.enemy}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={FACTION_ACCENT[FACTION_OF[f.enemy]]} stopOpacity="0.22" />
                  <stop offset="100%" stopColor={FACTION_ACCENT[FACTION_OF[f.enemy]]} stopOpacity="0" />
                </linearGradient>
              ))}
            </defs>
            {Array.from({ length: 11 }, (_, i) => (
              <g key={i} className={`hgrid${i % 5 === 0 ? " major" : ""}`}>
                <line x1={L} x2={L + iw} y1={y(i / 10)} y2={y(i / 10)} />
                {i % 5 === 0 && <text x={L - 5} y={y(i / 10) + 3.5} className="haxis" textAnchor="end">{i * 10}%</text>}
              </g>
            ))}
            {axisTicks(t0, t1, ticks).map(({ tm, label }, i, all) => (
              <text key={tm} x={x(tm)} y={H - 6} className="haxis" textAnchor={all.length > 1 && i === 0 && x(tm) < L + 20 ? "start" : x(tm) > L + iw - 20 ? "end" : "middle"}>{label}</text>
            ))}
            {fronts.map((f) => {
              const d = line(f.enemy);
              if (!d) return null;
              const last = points[points.length - 1];
              const lv = val(last, f.enemy) ?? 0;
              return (
                <g key={f.enemy}>
                  <path d={`${d}L${x(last.time).toFixed(1)} ${y(0)}L${x(points.find((s) => val(s, f.enemy) != null)!.time).toFixed(1)} ${y(0)}Z`} fill={`url(#hg-${f.enemy})`} />
                  <path d={d} className="hline" style={{ stroke: FACTION_ACCENT[FACTION_OF[f.enemy]] }} />
                  <circle cx={x(last.time)} cy={y(lv)} r="3.5" className="hdot" style={{ fill: FACTION_ACCENT[FACTION_OF[f.enemy]] }} />
                </g>
              );
            })}
            {hi && (
              <g className="hcursor">
                <line x1={x(hi.time)} x2={x(hi.time)} y1={T} y2={T + ih} />
                {fronts.map((f) => { const v = val(hi, f.enemy); return v == null ? null : <circle key={f.enemy} cx={x(hi.time)} cy={y(v)} r="4" style={{ stroke: FACTION_ACCENT[FACTION_OF[f.enemy]] }} />; })}
              </g>
            )}
          </svg>
        )}
        {hi && (
          <div className="chart-tip" style={{ left: Math.min(w - 150, Math.max(0, x(hi.time) - 70)) }}>
            <b>{dateTime(hi.time)}</b>
            {fronts.map((f) => { const v = val(hi, f.enemy); return v == null ? null : <span key={f.enemy}><i style={{ background: FACTION_ACCENT[FACTION_OF[f.enemy]] }} />{enemyName(f.enemy)} <em>{pct(v, 1)}</em></span>; })}
          </div>
        )}
      </div>
      <div className="legend">
        {fronts.map((f) => <span key={f.enemy}><i style={{ background: FACTION_ACCENT[FACTION_OF[f.enemy]] }} />{enemyName(f.enemy)}</span>)}
      </div>
    </div>
  );
}
