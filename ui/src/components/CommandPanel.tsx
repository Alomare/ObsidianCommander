// The side panel's first tab: what is selected on the map, and the Game Master's orders for it.
import { useEffect, useState, type CSSProperties } from "react";
import { t, tk } from "../strings";
import type { Front, GmAction, War, WarEvent } from "../types";
import { clock, enemyName, num, pct, regionName, regionOf, regionProgress, FACTION_OF } from "../util";
import { FACTION_ACCENT, HELLDIVER_ACCENT, regionState, type Selection } from "../map/GalaxyMap";
import { useTween } from "../hooks";
import { EnemyIcon, IDown, IFlag, IShield, ITarget, IUp, IWarn } from "./Icons";
import { Bar, Confirm, NumberField, Seg } from "./ui";

interface Props {
  war: War;
  selection: Selection;
  onSelect: (s: Selection) => void;
  names: Record<string, string>;
  readOnly: boolean;
  run: (a: GmAction) => Promise<void>;
  nowUnix: number;
}

export function CommandPanel(p: Props) {
  const { war, selection } = p;
  if (!selection) return <WarSummaryPanel {...p} />;
  if (selection.kind === "superearth") return <SuperEarthPanel {...p} />;
  const front = war.fronts.find((f) => f.enemy === selection.enemy);
  if (!front) return <WarSummaryPanel {...p} />;
  return <FrontPanel {...p} front={front} region={selection.kind === "region" ? selection.region : null} />;
}

/* Nothing selected: the three fronts at a glance, and the season. */
function WarSummaryPanel({ war, onSelect, readOnly, run, names }: Props) {
  const [ask, setAsk] = useState<null | "end" | "new">(null);
  const [result, setResult] = useState<"won" | "lost">("won");
  const ended = war.state === "won" || war.state === "lost";
  return (
    <div className="cmd">
      <p className="muted hint">{readOnly ? t("selectHintRo") : t("selectHint")}</p>
      <div className="front-rows">
        {war.fronts.map((f) => (
          <button key={f.enemy} className={`front-row ${f.status}`} onClick={() => onSelect({ kind: "front", enemy: f.enemy })} style={{ "--fc": FACTION_ACCENT[FACTION_OF[f.enemy]] } as CSSProperties}>
            <EnemyIcon enemy={f.enemy} />
            <span className="fr-text">
              <b>{enemyName(f.enemy)}</b>
              <small>{f.status === "active" ? `${regionName(f.enemy, regionOf(f), names)} · ${t("regionOf", { n: regionOf(f) })}` : tk(`status_${f.status}`)}</small>
            </span>
            <span className="fr-pct">{f.status === "hidden" ? "" : pct(f.status === "defeated" ? 1 : f.points / f.points_max)}</span>
          </button>
        ))}
      </div>
      {!readOnly && (
        <section className="cmd-section">
          <h3 className="cap">{t("season")} {war.season}</h3>
          {ended && <p className="muted small">{t("seasonEndedText")}</p>}
          <div className="btn-row">
            {!ended && <button className="btn" onClick={() => setAsk("end")}><IFlag />{t("endSeason")}</button>}
            <button className={`btn${ended ? " gold" : ""}`} onClick={() => setAsk("new")}>{t("newSeason")}</button>
          </div>
        </section>
      )}
      {ask === "end" && (
        <Confirm title={t("endSeason")} text={t("endSeasonText", { n: war.season })} okLabel={t("endSeason")} danger={result === "lost"} onOk={() => run({ action: "end_season", result })} onClose={() => setAsk(null)}>
          <Seg value={result} onChange={setResult} options={[{ v: "won", label: t("endWon") }, { v: "lost", label: t("endLost") }]} />
        </Confirm>
      )}
      {ask === "new" && <Confirm title={t("newSeason")} text={t("newSeasonText", { n: war.season + 1 })} okLabel={t("newSeason")} onOk={() => run({ action: "new_season" })} onClose={() => setAsk(null)} />}
    </div>
  );
}

function eventOn(war: War, enemy: number, region: number | "any"): WarEvent | null {
  const all = [...(war.defend_event?.status === "active" ? [war.defend_event] : []), ...war.attack_events.filter((e) => e.status === "active")];
  return all.find((e) => e.enemy === enemy && (region === "any" || Math.min(11, e.region) === region)) ?? null;
}

function FrontPanel({ war, front, region, names, readOnly, run, nowUnix }: Props & { front: Front; region: number | null }) {
  const enemy = front.enemy;
  const f = FACTION_OF[enemy];
  const cur = regionOf(front);
  const shown = region ?? cur;
  const st = regionState(war, enemy, shown);
  const step = front.points_max / 10;
  const accent = FACTION_ACCENT[f];
  const total = useTween(front.status === "defeated" ? 1 : front.points / front.points_max);
  const within = useTween(front.status === "active" ? regionProgress(front) : front.status === "defeated" ? 1 : 0);
  const ev = eventOn(war, enemy, region == null ? "any" : region);
  const attackEv = eventOn(war, enemy, 11);
  const s = war.settings;
  const [points, setPoints] = useState(Math.round(front.points));
  useEffect(() => setPoints(Math.round(front.points)), [front.points, enemy]);
  const [defDur, setDefDur] = useState(s.defend_duration / 3600);
  const [defGoal, setDefGoal] = useState(s.defend_points);
  const [atkDur, setAtkDur] = useState(s.attack_duration / 3600);
  const [atkGoal, setAtkGoal] = useState(s.attack_points);
  const defendRegion = shown;
  const stateLabel = st === "liberated" ? t("liberated") : st === "front" ? t("contested") : st === "home" ? t("homeWorldState") : st === "hidden" ? t("hidden") : t("enemyHeld");

  return (
    <div className="cmd" style={{ "--fc": accent } as CSSProperties}>
      <div className="sel-head">
        <span className="sel-icon"><EnemyIcon enemy={enemy} width={22} height={22} /></span>
        <div className="sel-title">
          <h2>{region == null ? t("frontOf", { enemy: enemyName(enemy) }) : regionName(enemy, region, names)}</h2>
          <span className="muted">{region == null ? tk(`status_${front.status}`) : `${t("frontOf", { enemy: enemyName(enemy) })} · ${shown >= 11 ? t("homeWorldState") : t("regionOf", { n: shown })}`}</span>
        </div>
        {region != null && <span className={`state-chip ${st}`}>{stateLabel}</span>}
      </div>
      {region != null && region >= 11 && <p className="muted small">{t("homeWorldText")}</p>}

      <section className="cmd-section">
        <div className="kv"><span>{t("region")}</span><b>{front.status === "hidden" ? "—" : `${cur} / 10`}</b></div>
        <Bar value={total} color={HELLDIVER_ACCENT} marks={10} className="big" />
        <div className="kv"><span>{t("inRegion")} {cur}</span><b>{pct(within)}</b></div>
        <Bar value={within} color={accent} />
        <div className="kv muted"><span>{t("pointsLabel")}</span><span>{num(front.points)} / {num(front.points_max)}</span></div>
        <div className="kv muted"><span>{t("pressure")}</span><span>{t("pressureValue", { n: num(front.pressure_per_hour ?? s.pressure_per_hour) })}</span></div>
      </section>

      {ev && <EventBlock ev={ev} war={war} names={names} readOnly={readOnly} run={run} nowUnix={nowUnix} />}

      {!readOnly && front.status === "active" && (
        <>
          <section className="cmd-section">
            <h3 className="cap">{t("gmActions")}</h3>
            <div className="btn-row two">
              <button className="btn danger-soft" onClick={() => run({ action: "push", front: enemy, regions: -1 })} disabled={front.points <= 0} data-tip={t("enemyPushTip")}><IDown />{t("enemyPush")}</button>
              <button className="btn" onClick={() => run({ action: "push", front: enemy, regions: 1 })} disabled={front.points >= front.points_max} data-tip={t("liberateTip")}><IUp />{t("liberate")}</button>
            </div>
            {region != null && region <= 10 && region !== cur && (
              <button className="btn wide" onClick={() => run({ action: "set_points", front: enemy, points: (region - 1) * step + step * 0.05 })} data-tip={t("moveFrontHereTip")}>{t("moveFrontHere")}</button>
            )}
            <div className="inline-form">
              <span className="if-label">{t("setProgress")}</span>
              <input type="range" min={0} max={front.points_max} step={step / 20} value={points} onChange={(e) => setPoints(Number(e.target.value))} aria-label={t("setProgress")} />
              <div className="if-row">
                <NumberField value={points} min={0} max={front.points_max} step={100} onChange={setPoints} suffix={t("points")} />
                <button className="btn small" disabled={points === Math.round(front.points)} onClick={() => run({ action: "set_points", front: enemy, points })}>{t("apply")}</button>
              </div>
            </div>
          </section>

          {(region == null || region <= 10) && (
            <section className="cmd-section">
              <h3 className="cap"><IWarn width={14} height={14} />{t("defense")} · {regionName(enemy, defendRegion, names)}</h3>
              <div className="if-row">
                <label className="mini-field"><span>{t("duration")}</span><NumberField value={defDur} min={0.5} max={72} step={0.5} onChange={setDefDur} suffix={t("hours")} /></label>
                <label className="mini-field"><span>{t("goal")}</span><NumberField value={defGoal} min={100} max={100000} step={100} onChange={setDefGoal} suffix={t("points")} /></label>
              </div>
              <button className="btn wide" disabled={!!war.defend_event && war.defend_event.status === "active"} data-tip={war.defend_event?.status === "active" ? t("defenseRunning") : t("startDefenseTip")}
                onClick={() => run({ action: "start_defend", front: enemy, region: defendRegion, duration: Math.round(defDur * 3600), points_max: defGoal })}>
                <IShield />{region != null ? t("startDefenseHere") : t("startDefense")}
              </button>
            </section>
          )}

          {(region == null || region >= 10) && (
            <section className="cmd-section">
              <h3 className="cap"><ITarget width={14} height={14} />{regionName(enemy, 11, names)}</h3>
              <div className="if-row">
                <label className="mini-field"><span>{t("duration")}</span><NumberField value={atkDur} min={0.5} max={72} step={0.5} onChange={setAtkDur} suffix={t("hours")} /></label>
                <label className="mini-field"><span>{t("goal")}</span><NumberField value={atkGoal} min={100} max={100000} step={100} onChange={setAtkGoal} suffix={t("points")} /></label>
              </div>
              <button className="btn wide" disabled={!!attackEv} data-tip={attackEv ? t("attackRunning") : t("startAttackTip")}
                onClick={() => run({ action: "start_attack", front: enemy, duration: Math.round(atkDur * 3600), points_max: atkGoal })}>
                <ITarget />{t("startAttack")}
              </button>
            </section>
          )}
        </>
      )}

      {!readOnly && (
        <section className="cmd-section">
          <h3 className="cap">{t("front")}</h3>
          <div className="btn-row two">
            {front.status === "hidden" && <button className="btn gold" onClick={() => run({ action: "set_status", front: enemy, status: "active" })} data-tip={t("introduceFrontTip")}>{t("introduceFront")}</button>}
            {front.status === "defeated" && <button className="btn" onClick={() => run({ action: "set_status", front: enemy, status: "active" })}>{t("reopenFront")}</button>}
            {front.status === "active" && <button className="btn" onClick={() => run({ action: "set_status", front: enemy, status: "defeated" })} data-tip={t("markDefeatedTip")}>{t("markDefeated")}</button>}
            {front.status !== "hidden" && <button className="btn" onClick={() => run({ action: "set_status", front: enemy, status: "hidden" })} data-tip={t("removeFrontTip")}>{t("removeFront")}</button>}
          </div>
        </section>
      )}
      {readOnly && front.status === "active" && attackEv && !ev && <EventBlock ev={attackEv} war={war} names={names} readOnly run={run} nowUnix={nowUnix} />}
    </div>
  );
}

function SuperEarthPanel({ war, names, readOnly, run, nowUnix }: Props) {
  const s = war.settings;
  const active = war.fronts.filter((f) => f.status === "active");
  const [enemy, setEnemy] = useState(active[0]?.enemy ?? 0);
  const [dur, setDur] = useState(s.defend_duration / 3600);
  const [goal, setGoal] = useState(s.defend_points);
  const ev = war.defend_event?.status === "active" && war.defend_event.region === 0 ? war.defend_event : null;
  return (
    <div className="cmd" style={{ "--fc": "rgb(150, 210, 255)" } as CSSProperties}>
      <div className="sel-head">
        <span className="sel-icon se" />
        <div className="sel-title">
          <h2>{regionName(null, 0, names)}</h2>
          <span className="muted">{t("superEarth")}</span>
        </div>
      </div>
      <p className="muted small">{t("superEarthText")}</p>
      {ev && <EventBlock ev={ev} war={war} names={names} readOnly={readOnly} run={run} nowUnix={nowUnix} />}
      {!readOnly && !ev && (
        <section className="cmd-section">
          <h3 className="cap"><IWarn width={14} height={14} />{t("defense")}</h3>
          <span className="if-label">{t("defendFront")}</span>
          <Seg value={enemy} onChange={setEnemy} options={war.fronts.map((f) => ({ v: f.enemy, label: enemyName(f.enemy), disabled: f.status !== "active" }))} />
          <div className="if-row">
            <label className="mini-field"><span>{t("duration")}</span><NumberField value={dur} min={0.5} max={72} step={0.5} onChange={setDur} suffix={t("hours")} /></label>
            <label className="mini-field"><span>{t("goal")}</span><NumberField value={goal} min={100} max={100000} step={100} onChange={setGoal} suffix={t("points")} /></label>
          </div>
          <button className="btn wide" disabled={!!war.defend_event && war.defend_event.status === "active"} data-tip={war.defend_event?.status === "active" ? t("defenseRunning") : undefined}
            onClick={() => run({ action: "start_defend", front: enemy, region: 0, duration: Math.round(dur * 3600), points_max: goal })}><IShield />{t("startDefense")}</button>
        </section>
      )}
    </div>
  );
}

/** One running event: the countdown, the progress, and for the GM, the controls. */
export function EventBlock({ ev, war, names, readOnly, run, nowUnix }: { ev: WarEvent; war: War; names: Record<string, string>; readOnly: boolean; run: (a: GmAction) => Promise<void>; nowUnix: number }) {
  const attack = ev.region >= 11;
  const where = regionName(ev.enemy, ev.region, names);
  const p = useTween(ev.points / ev.points_max);
  const [val, setVal] = useState(ev.points);
  useEffect(() => setVal(ev.points), [ev.points]);
  const [ask, setAsk] = useState<null | "success" | "fail">(null);
  const left = ev.end_time - nowUnix;
  const span = Math.max(1, ev.end_time - ev.start_time);
  return (
    <section className={`event-block ${attack ? "attack" : "defend"}`}>
      <div className="eb-head">
        {attack ? <ITarget /> : <IWarn />}
        <b>{attack ? t("attackOn", { region: where }) : t("defenseOf", { region: where })}</b>
      </div>
      <div className="kv"><span className="muted">{war.state === "running" ? t("endsIn", { t: "" }).trim() : t("frozen")}</span><b className="mono">{clock(left)}</b></div>
      <div className="time-bar"><i style={{ width: `${Math.max(0, Math.min(1, left / span)) * 100}%` }} /></div>
      <div className="kv"><span className="muted">{t("progress")}</span><b>{t("eventProgress", { p: num(ev.points), m: num(ev.points_max) })}</b></div>
      <Bar value={p} color={HELLDIVER_ACCENT} className="big" />
      {!readOnly && (
        <div className="eb-gm">
          <div className="if-row">
            <NumberField value={val} min={0} max={ev.points_max} step={50} onChange={setVal} suffix={t("points")} />
            <button className="btn small" disabled={val === ev.points} onClick={() => run({ action: "set_event", event_id: ev.event_id, points: val })}>{t("setProgress")}</button>
          </div>
          <div className="btn-row two">
            <button className="btn small" onClick={() => setAsk("success")}>{t("succeed")}</button>
            <button className="btn small danger-soft" onClick={() => setAsk("fail")}>{t("fail")}</button>
          </div>
        </div>
      )}
      {ask && <Confirm title={ask === "success" ? t("succeed") : t("fail")} text={ask === "success" ? t("endEventSuccess") : t("endEventFail")} okLabel={ask === "success" ? t("succeed") : t("fail")} danger={ask === "fail"}
        onOk={() => run({ action: "end_event", event_id: ev.event_id, result: ask })} onClose={() => setAsk(null)} />}
    </section>
  );
}
