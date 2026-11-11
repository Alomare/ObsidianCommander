// An Evolved war: the galaxy map with the Major Order and the campaigns over it, and the side panel:
// the selected planet or the orders, the dispatches, players, statistics.
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { isMock } from "../api";
import { useTween } from "../hooks";
import { t, tk } from "../strings";
import type { EvoCampaign, EvoOperation, EvoOrder, Evolved, GmAction, OrderKind, War } from "../types";
import { clock, dateTime, enemySingle, num, pct, timeOfDay } from "../util";
import { activeOrders, campaignOn, orderCount, orderShare, ownerName, pctText, secondsLeft, sortedCampaigns } from "../evolved";
import { EvolvedMap } from "../map/EvolvedMap";
import { NEIGHBOURS, PLANETS, PLANETS_BY_NAME, SECTORS, ownerColor, planetName } from "../map/galaxy";
import { HELLDIVER_ACCENT } from "../map/GalaxyMap";
import { PlayersPanel, Tile } from "./Panels";
import { EnemyIcon, IClose, IFlag, IPlus, IShield, ITarget, IWarn } from "./Icons";
import { Bar, Confirm, NumberField, Seg } from "./ui";

export type EvoTab = "command" | "feed" | "players" | "stats";

/** A Major Order being written. Its planets show on the map, and map clicks add or remove them. */
interface OrderDraft { kind: OrderKind; planets: number[]; faction: number; target: number; hours: number; brief: string }
const newDraft = (evo: Evolved): OrderDraft => ({
  kind: "liberate", planets: [], faction: 0,
  target: Math.max(5, Math.round(3 * evo.settings.liberation_missions)), hours: evo.settings.order_hours, brief: "",
});

/** Mock only, for screenshots: `&sel=205` or `&sel=merga-iv` selects a planet, `&sel=order` opens a new Major Order. */
const mockStart = (() => {
  const sel = isMock ? new URLSearchParams(location.search).get("sel") : null;
  if (!sel) return { planet: null, order: false };
  if (sel === "order") return { planet: null, order: true };
  if (/^\d+$/.test(sel)) return { planet: Number(sel) < PLANETS.length ? Number(sel) : null, order: false };
  const name = sel.replace(/[-_+]/g, " ").toLowerCase();
  return { planet: PLANETS.find((p) => p.name.toLowerCase() === name)?.id ?? null, order: false };
})();

type Run = (a: GmAction) => Promise<boolean>;

interface BodyProps {
  war: War;
  evo: Evolved;
  readOnly: boolean;
  run: Run;
  nowUnix: number;
  serverNow: number;
  tab: EvoTab;
  setTab: (t: EvoTab) => void;
  tabsNav: ReactNode;
}

export function EvolvedBody({ war, evo, readOnly, run, nowUnix, serverNow, tab, setTab, tabsNav }: BodyProps) {
  const [planet, setPlanet] = useState<number | null>(mockStart.planet);
  const [draft, setDraft] = useState<OrderDraft | null>(() => (mockStart.order && !readOnly ? newDraft(evo) : null));

  const select = useCallback((p: number | null) => { setPlanet(p); if (p != null) setTab("command"); }, [setTab]);
  const showOrders = useCallback(() => { setPlanet(null); setTab("command"); }, [setTab]);
  const pick = useCallback((p: number) => setDraft((d) => d && ({ ...d, planets: d.planets.includes(p) ? d.planets.filter((x) => x !== p) : [...d.planets, p] })), []);
  const picking = !readOnly && tab === "command" && planet == null && draft != null && draft.kind !== "missions";

  // Escape clears the planet; the order being written stays.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (e.key !== "Escape" || tag === "INPUT" || tag === "TEXTAREA" || document.querySelector(".modal, .menu")) return;
      setPlanet(null);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  return (
    <div className="war-body">
      <div className="map-col solo">
        <div className="map-stage">
          <EvolvedMap war={war} evo={evo} selected={planet} onSelect={select} picks={picking ? draft!.planets : null} onPick={pick} nowUnix={nowUnix} />
          <div className="status-col">
            <OrderCard war={war} evo={evo} nowUnix={nowUnix} onOpen={showOrders} />
            <CampaignList war={war} evo={evo} nowUnix={nowUnix} selected={planet} onSelect={select} />
          </div>
          <Legend />
        </div>
      </div>

      <aside className="side">
        {tabsNav}
        <div className="side-body" key={tab}>
          {tab === "command" && (planet != null
            ? <PlanetPanel key={planet} war={war} evo={evo} planet={planet} readOnly={readOnly} run={run} nowUnix={nowUnix} />
            : <OrdersPanel war={war} evo={evo} readOnly={readOnly} run={run} nowUnix={nowUnix} draft={draft} setDraft={setDraft} onSelect={select} />)}
          {tab === "feed" && <DispatchPanel evo={evo} readOnly={readOnly} run={run} onSelect={select} />}
          {tab === "players" && <PlayersPanel war={war} nowUnix={serverNow} readOnly={readOnly} />}
          {tab === "stats" && <EvoStatsPanel evo={evo} />}
        </div>
      </aside>
    </div>
  );
}

/* ---------------------------------------------------------------- over the map */

function OrderCard({ war, evo, nowUnix, onOpen }: { war: War; evo: Evolved; nowUnix: number; onOpen: () => void }) {
  const orders = activeOrders(evo);
  const o = orders[0];
  const share = useTween(o ? orderShare(o) : 0);
  return (
    <button className={`evo-order${o ? "" : " none"}`} onClick={onOpen}>
      <span className="eo-head">
        <b className="cap">{t("majorOrder")}</b>
        {o && <span className="mono">{clock(secondsLeft(o.ends_in, war, nowUnix) ?? 0)}</span>}
      </span>
      {o ? <>
        <span className="eo-brief">{o.brief}</span>
        <span className="eo-row"><span className="ec-bar"><i style={{ width: `${share * 100}%` }} /></span><span className="mono">{orderCount(o)}</span></span>
        {orders.length > 1 && <small className="eo-more">{t("orderMore", { n: orders.length - 1 })}</small>}
      </> : <span className="eo-brief muted">{t("noOrder")}</span>}
    </button>
  );
}

function CampaignList({ war, evo, nowUnix, selected, onSelect }: { war: War; evo: Evolved; nowUnix: number; selected: number | null; onSelect: (p: number | null) => void }) {
  const list = useMemo(() => sortedCampaigns(evo), [evo]);
  return (
    <div className="events-overlay evo-campaigns">
      <h3 className="cap">{t("campaigns")} <span className="count">{list.length}</span></h3>
      {list.length === 0 && <p className="muted small">{t("noCampaigns")}</p>}
      {list.map((c) => <CampaignRow key={c.id} c={c} war={war} nowUnix={nowUnix} sel={selected === c.planet} onClick={() => onSelect(selected === c.planet ? null : c.planet)} />)}
    </div>
  );
}

function CampaignRow({ c, war, nowUnix, sel, onClick }: { c: EvoCampaign; war: War; nowUnix: number; sel: boolean; onClick: () => void }) {
  const defense = c.kind === "defense";
  const v = useTween((defense ? c.defense : c.liberation) / 100);
  const p = PLANETS[c.planet];
  return (
    <button className={`evo-camp-row ${c.kind}${sel ? " sel" : ""}`} onClick={onClick} aria-pressed={sel} style={{ "--oc": ownerColor(c.faction), "--hd": HELLDIVER_ACCENT } as CSSProperties}>
      <span className="ecr-top"><b>{p.name}</b><small>{SECTORS[p.sector]?.name}</small></span>
      <span className="ecr-state">
        {defense
          ? <><IWarn width={13} height={13} />{t("defense")} · {t("leftT", { t: clock(secondsLeft(c.ends_in, war, nowUnix) ?? 0) })}</>
          : <><ITarget width={13} height={13} />{t("liberatedPct", { p: pctText(c.liberation) })}</>}
      </span>
      <span className="ec-bar"><i style={{ width: `${v * 100}%` }} /></span>
    </button>
  );
}

function Legend() {
  return (
    <div className="legend map-legend evo-legend" aria-hidden>
      <span><i className="lg-mark liberation" />{t("legendLiberation")}</span>
      <span><i className="lg-mark defense" />{t("legendDefense")}</span>
      <span><i className="lg-mark order" />{t("legendOrder")}</span>
      <span><i className="lg-mark front" />{t("legendFrontLine")}</span>
    </div>
  );
}

/* ---------------------------------------------------------------- the selected planet */

function PlanetGlyph({ owner, size = 22 }: { owner: number; size?: number }) {
  if (owner > 0) return <EnemyIcon enemy={owner - 1} width={size} height={size} />;
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="12" r="5.5" fill="currentColor" /><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="3 3" /></svg>;
}

function PlanetPanel({ war, evo, planet, readOnly, run, nowUnix }: { war: War; evo: Evolved; planet: number; readOnly: boolean; run: Run; nowUnix: number }) {
  const p = PLANETS[planet];
  const owner = evo.owners[planet] ?? 0;
  const c = campaignOn(evo, planet);
  const sector = SECTORS[p.sector];
  const inOrder = activeOrders(evo).some((o) => o.kind !== "missions" && o.planets.includes(planet));
  const links = NEIGHBOURS[planet];
  return (
    <div className="cmd" style={{ "--fc": ownerColor(owner), "--oc": ownerColor(owner) } as CSSProperties}>
      <div className="sel-head">
        {planet === 0 ? <span className="sel-icon se" /> : <span className="sel-icon"><PlanetGlyph owner={owner} /></span>}
        <div className="sel-title">
          <h2>{p.name}</h2>
          <span className="muted">{t("sectorName", { name: sector?.name ?? "" })}{p.home ? ` · ${t("homeWorld", { enemy: enemySingle(p.home - 1) })}` : ""}</span>
        </div>
        <span className={`owner-chip o${owner}`}>{ownerName(owner)}</span>
      </div>

      <section className="cmd-section">
        <div className="kv"><span className="muted">{t("biome")}</span><span>{p.biome}</span></div>
        <div className="kv"><span className="muted">{t("hazards")}</span><span className="kv-wrap">{p.hazards.length ? p.hazards.join(", ") : t("noHazards")}</span></div>
        <div className="kv" data-tip={links.map(planetName).join(", ")}><span className="muted">{t("supplyLines")}</span><span>{links.length === 1 ? t("planetOne") : t("supplyLinesN", { n: links.length })}</span></div>
        {inOrder && <div className="order-note"><IFlag width={14} height={14} />{t("orderTarget_tip")}</div>}
      </section>

      {c && <CampaignBlock c={c} war={war} readOnly={readOnly} run={run} nowUnix={nowUnix} />}
      {!readOnly && <PlanetGm evo={evo} planet={planet} owner={owner} campaign={c} run={run} />}
    </div>
  );
}

function CampaignBlock({ c, war, readOnly, run, nowUnix }: { c: EvoCampaign; war: War; readOnly: boolean; run: Run; nowUnix: number }) {
  const defense = c.kind === "defense";
  const name = planetName(c.planet);
  const value = useTween((defense ? c.defense : c.liberation) / 100);
  const left = secondsLeft(c.ends_in, war, nowUnix);
  const [ask, setAsk] = useState<null | "won" | "lost">(null);
  const askText = ask === "won"
    ? (defense ? t("endDefenseWon", { planet: name }) : t("endLiberationWon", { planet: name }))
    : (defense ? t("endDefenseLost", { planet: name, enemy: ownerName(c.faction) }) : t("endLiberationLost", { planet: name }));
  return (
    <section className={`event-block evo-camp ${defense ? "defend" : "liberation"}`} style={{ "--oc": ownerColor(c.faction) } as CSSProperties}>
      <div className="eb-head">
        {defense ? <IWarn /> : <ITarget />}
        <b>{defense ? t("defenseOfPlanet", { planet: name }) : t("liberationOf", { planet: name })}</b>
        <span className="eb-enemy">{ownerName(c.faction)}</span>
      </div>
      {defense && <div className="kv"><span className="muted">{war.state === "running" ? t("timeLeft") : t("frozen")}</span><b className="mono">{clock(left ?? 0)}</b></div>}
      <div className="kv"><span className="muted">{defense ? t("defense") : t("liberationLabel")}</span><b>{pctText(defense ? c.defense : c.liberation, 2)}</b></div>
      <Bar value={value} color={HELLDIVER_ACCENT} className="big" />
      <div className="rate" data-tip={t("rateTip")}>
        {defense ? t("defenseRate", { p: pctText(c.per_mission) }) : t("liberationRate", { p: pctText(c.per_mission), r: pctText(c.regen_per_hour) })}
      </div>
      <div className="kv"><span className="muted">{t("missions")}</span><span>{t("missionsWonLost", { w: num(c.missions_won), l: num(c.missions_lost) })}</span></div>

      <h4 className="cap ops-title">{t("operations")}</h4>
      {c.operations.length === 0 && <p className="why">{t("noOperations")}</p>}
      <ul className="ops">{c.operations.map((op) => <OperationRow key={op.id} op={op} />)}</ul>

      {!readOnly && (
        <div className="btn-row two">
          <button className="btn small" onClick={() => setAsk("won")} data-tip={t("campaignWonTip")}>{t("campaignWon")}</button>
          <button className="btn small danger-soft" onClick={() => setAsk("lost")} data-tip={t("campaignLostTip")}>{t("campaignLost")}</button>
        </div>
      )}
      {ask && <Confirm title={ask === "won" ? t("campaignWon") : t("campaignLost")} text={askText} okLabel={ask === "won" ? t("campaignWon") : t("campaignLost")} danger={ask === "lost"}
        onOk={() => run({ action: "evo_end_campaign", campaign: c.id, won: ask === "won" })} onClose={() => setAsk(null)} />}
    </section>
  );
}

function OperationRow({ op }: { op: EvoOperation }) {
  const done = op.missions.filter((m) => m.done).length;
  return (
    <li className="op">
      <i className="op-mark" />
      <span className="op-text">
        <b>{op.name}</b>
        <small>{t("difficultyN", { n: op.difficulty })} · {t("missionsDone", { d: done, n: op.missions.length })}</small>
      </span>
      <span className="op-pips">
        {op.missions.map((m, i) => (
          <i key={i} className={`pip${m.done ? " done" : ""}${m.kind === 2 ? " ext" : ""}`} data-tip={`${tk(`missionKind_${m.kind}`)} · ${tk(`tod_${m.tod}`)} · ${m.done ? t("missionDone") : t("missionOpen")}`} />
        ))}
      </span>
    </li>
  );
}

function PlanetGm({ evo, planet, owner, campaign, run }: { evo: Evolved; planet: number; owner: number; campaign: EvoCampaign | undefined; run: Run }) {
  const name = planetName(planet);
  const [to, setTo] = useState(owner);
  useEffect(() => setTo(owner), [owner]);
  const near = NEIGHBOURS[planet].map((q) => evo.owners[q]).find((o) => o > 0) ?? 1;
  const [attacker, setAttacker] = useState(near);
  const [hours, setHours] = useState(evo.settings.defense_hours);
  const [askOwner, setAskOwner] = useState(false);
  const setOwner = () => (campaign ? setAskOwner(true) : run({ action: "evo_planet", planet, owner: to }));
  return (
    <>
      <section className="cmd-section">
        <h3 className="cap">{t("gmActions")}</h3>
        <span className="if-label">{t("owner")}</span>
        <div className="owner-pick" role="radiogroup" aria-label={t("owner")}>
          {[0, 1, 2, 3].map((o) => (
            <button key={o} type="button" role="radio" aria-checked={to === o} className={to === o ? "on" : ""} style={{ "--oc": ownerColor(o) } as CSSProperties} onClick={() => setTo(o)}>
              <i />{ownerName(o)}
            </button>
          ))}
        </div>
        <button className="btn wide" disabled={to === owner} onClick={setOwner} data-tip={t("setOwnerTip")}>{t("setOwner")}</button>
      </section>

      {!campaign && owner !== 0 && (
        <section className="cmd-section">
          <h3 className="cap"><ITarget width={14} height={14} />{t("liberationOf", { planet: name })}</h3>
          <button className="btn wide" onClick={() => run({ action: "evo_campaign", planet, kind: "liberation" })} data-tip={t("startLiberationTip")}><ITarget />{t("startLiberation")}</button>
        </section>
      )}
      {!campaign && owner === 0 && (
        <section className="cmd-section">
          <h3 className="cap"><IWarn width={14} height={14} />{t("defenseOfPlanet", { planet: name })}</h3>
          <span className="if-label">{t("attacker")}</span>
          <Seg value={attacker} onChange={setAttacker} options={[1, 2, 3].map((o) => ({ v: o, label: ownerName(o) }))} />
          <div className="if-row">
            <label className="mini-field"><span>{t("duration")}</span><NumberField value={hours} min={0.25} max={720} step={0.25} onChange={setHours} suffix={t("hours")} /></label>
          </div>
          <button className="btn wide" onClick={() => run({ action: "evo_campaign", planet, kind: "defense", faction: attacker, hours })} data-tip={t("evoStartDefenseTip")}><IShield />{t("startDefense")}</button>
        </section>
      )}
      {askOwner && (
        <Confirm title={t("setOwner")} text={t("setOwnerText", { planet: name, owner: ownerName(to) })} okLabel={t("setOwner")} danger
          onOk={() => run({ action: "evo_planet", planet, owner: to })} onClose={() => setAskOwner(false)} />
      )}
    </>
  );
}

/* ---------------------------------------------------------------- nothing selected: the orders */

function OrdersPanel({ war, evo, readOnly, run, nowUnix, draft, setDraft, onSelect }: {
  war: War; evo: Evolved; readOnly: boolean; run: Run; nowUnix: number; draft: OrderDraft | null; setDraft: (d: OrderDraft | null) => void; onSelect: (p: number | null) => void;
}) {
  const active = activeOrders(evo);
  const past = evo.orders.filter((o) => o.state !== "active").slice(0, 5);
  return (
    <div className="cmd">
      <p className="muted hint">{readOnly ? t("evoSelectHintRo") : t("evoSelectHint")}</p>
      <section className="cmd-section">
        <h3 className="cap"><IFlag width={14} height={14} />{t("majorOrder")}</h3>
        {active.length === 0 && <p className="muted small">{t("noOrder")}</p>}
        {active.map((o) => <OrderBlock key={o.id} o={o} war={war} evo={evo} readOnly={readOnly} run={run} nowUnix={nowUnix} onSelect={onSelect} />)}
        {!readOnly && !draft && <button className="btn wide" onClick={() => setDraft(newDraft(evo))} data-tip={t("issueOrderTip")}><IPlus />{t("issueOrder")}</button>}
        {!readOnly && draft && <OrderForm evo={evo} draft={draft} setDraft={setDraft} run={run} />}
      </section>
      <section className="cmd-section">
        <h3 className="cap">{t("galaxyControl")}</h3>
        <ControlRows evo={evo} />
      </section>
      {past.length > 0 && (
        <section className="cmd-section">
          <h3 className="cap">{t("pastOrders")}</h3>
          <ul className="past-orders">
            {past.map((o) => <li key={o.id}><span className="po-brief">{o.brief}</span><span className={`state-chip order-${o.state}`}>{tk(`orderState_${o.state}`)}</span></li>)}
          </ul>
        </section>
      )}
    </div>
  );
}

function OrderBlock({ o, war, evo, readOnly, run, nowUnix, onSelect }: { o: EvoOrder; war: War; evo: Evolved; readOnly: boolean; run: Run; nowUnix: number; onSelect: (p: number | null) => void }) {
  const [ask, setAsk] = useState(false);
  const share = useTween(orderShare(o));
  const by = o.by === "director" || o.by === "gm" ? tk(`orderBy_${o.by}`) : null;
  return (
    <div className="order-block">
      <div className="ob-top">
        <span className="chip">{tk(`orderKind_${o.kind}`)}</span>
        <span className="ob-time"><span className="muted">{war.state === "running" ? t("timeLeft") : t("frozen")}</span><b className="mono">{clock(secondsLeft(o.ends_in, war, nowUnix) ?? 0)}</b></span>
      </div>
      <b className="ob-brief">{o.brief}</b>
      {o.kind !== "missions" && o.planets.length > 0 && (
        <div className="planet-chips">
          {o.planets.map((p) => (
            <button key={p} className="planet-chip" style={{ "--oc": ownerColor(evo.owners[p] ?? 0) } as CSSProperties} onClick={() => onSelect(p)}><i />{planetName(p)}</button>
          ))}
        </div>
      )}
      <div className="kv"><span className="muted">{tk(`orderProgress_${o.kind}`)}</span><b>{orderCount(o)}</b></div>
      <Bar value={share} color={HELLDIVER_ACCENT} />
      {by && <span className="muted small">{by}</span>}
      {!readOnly && <button className="btn small danger-soft" onClick={() => setAsk(true)} data-tip={t("cancelOrderTip")}>{t("cancelOrder")}</button>}
      {ask && <Confirm title={t("cancelOrder")} text={t("cancelOrderText", { brief: o.brief })} okLabel={t("cancelOrder")} danger
        onOk={() => run({ action: "evo_cancel_order", order: o.id })} onClose={() => setAsk(false)} />}
    </div>
  );
}

function autoBrief(d: OrderDraft): string {
  const names = d.planets.map(planetName);
  const list = names.length <= 1 ? (names[0] ?? "") : t("listAnd", { a: names.slice(0, -1).join(", "), b: names[names.length - 1] });
  if (d.kind === "missions") return d.faction ? t("briefMissions", { n: num(d.target), enemy: enemySingle(d.faction - 1) }) : t("briefMissionsAny", { n: num(d.target) });
  if (!list) return "";
  return d.kind === "liberate" ? t("briefLiberate", { list }) : t("briefDefend", { list });
}

function OrderForm({ evo, draft, setDraft, run }: { evo: Evolved; draft: OrderDraft; setDraft: (d: OrderDraft | null) => void; run: Run }) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const up = (p: Partial<OrderDraft>) => setDraft({ ...draft, ...p });
  const needsPlanets = draft.kind !== "missions";
  const quick = evo.campaigns
    .filter((c) => (draft.kind === "liberate" ? c.kind === "liberation" : c.kind === "defense"))
    .map((c) => c.planet).filter((p) => !draft.planets.includes(p));
  const match = PLANETS.find((p) => p.name.toLowerCase() === query.trim().toLowerCase());
  const add = () => {
    if (match && !draft.planets.includes(match.id)) up({ planets: [...draft.planets, match.id] });
    if (match) setQuery("");
  };
  const auto = autoBrief(draft);
  const ready = !needsPlanets || draft.planets.length > 0;
  const issue = async () => {
    setBusy(true);
    const ok = await run({
      action: "evo_order", kind: draft.kind, hours: draft.hours,
      ...(needsPlanets ? { planets: draft.planets } : { faction: draft.faction, target: draft.target }),
      ...(draft.brief.trim() ? { brief: draft.brief.trim() } : {}),
    });
    setBusy(false);
    if (ok) setDraft(null);
  };
  return (
    <div className="order-form">
      <span className="if-label">{t("orderType")}</span>
      <Seg value={draft.kind} onChange={(kind) => up({ kind })} options={(["liberate", "defend", "missions"] as OrderKind[]).map((k) => ({ v: k, label: tk(`orderKind_${k}`) }))} />

      {needsPlanets ? <>
        <span className="if-label">{t("orderPlanets")}</span>
        <p className="why">{t("orderPickHint")}</p>
        {draft.planets.length > 0 && (
          <div className="planet-chips">
            {draft.planets.map((p) => (
              <button key={p} className="planet-chip on" style={{ "--oc": ownerColor(evo.owners[p] ?? 0) } as CSSProperties} onClick={() => up({ planets: draft.planets.filter((x) => x !== p) })}
                aria-label={t("removeFrom", { name: planetName(p) })} data-tip={t("removeFrom", { name: planetName(p) })}>
                <i />{planetName(p)}<IClose width={12} height={12} />
              </button>
            ))}
          </div>
        )}
        {quick.length > 0 && (
          <div className="planet-chips quick">
            <span className="muted small">{t("orderQuick")}</span>
            {quick.map((p) => (
              <button key={p} className="planet-chip add" style={{ "--oc": ownerColor(evo.owners[p] ?? 0) } as CSSProperties} onClick={() => up({ planets: [...draft.planets, p] })}><IPlus width={12} height={12} />{planetName(p)}</button>
            ))}
          </div>
        )}
        <div className="if-row">
          <input className="text-field" list="evo-planet-names" value={query} placeholder={t("orderPlanetPh")} aria-label={t("orderPlanetPh")}
            onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
          <button className="btn small" disabled={!match} onClick={add}>{t("orderAdd")}</button>
          <datalist id="evo-planet-names">{PLANETS_BY_NAME.map((p) => <option key={p.id} value={p.name} />)}</datalist>
        </div>
      </> : <>
        <span className="if-label">{t("orderEnemy")}</span>
        <Seg value={draft.faction} onChange={(faction) => up({ faction })} small options={[0, 1, 2, 3].map((o) => ({ v: o, label: o ? ownerName(o) : t("anyEnemy") }))} />
        <div className="if-row">
          <label className="mini-field"><span>{t("orderTarget")}</span><NumberField value={draft.target} min={1} max={100000} step={1} onChange={(target) => up({ target: Math.round(target) })} suffix={t("missionsUnit")} /></label>
        </div>
      </>}

      <div className="if-row">
        <label className="mini-field"><span>{t("orderHours")}</span><NumberField value={draft.hours} min={1} max={2000} step={1} onChange={(hours) => up({ hours })} suffix={t("hours")} /></label>
      </div>
      <label className="mini-field">
        <span>{t("orderBrief")}</span>
        <textarea className="text-field" rows={2} maxLength={240} value={draft.brief} onChange={(e) => up({ brief: e.target.value })}
          placeholder={auto ? t("orderBriefPh", { brief: auto }) : t("orderBriefPhEmpty")} />
      </label>
      {!ready && <p className="why">{t("orderNeedsPlanet")}</p>}
      <div className="btn-row two">
        <button className="btn small" onClick={() => setDraft(null)}>{t("cancel")}</button>
        <button className="btn small play" disabled={!ready || busy} onClick={issue}><IFlag />{t("issueOrder")}</button>
      </div>
    </div>
  );
}

function ControlRows({ evo }: { evo: Evolved }) {
  const counts = [0, 0, 0, 0];
  for (const o of evo.owners) counts[o] = (counts[o] ?? 0) + 1;
  const total = evo.owners.length || 1;
  return (
    <div className="control-rows">
      {[0, 1, 2, 3].map((o) => (
        <div key={o} className="control-row" style={{ "--oc": ownerColor(o) } as CSSProperties}>
          <span className="cr-name"><i />{ownerName(o)}</span>
          <span className="cr-bar"><i style={{ width: `${(counts[o] / total) * 100}%` }} /></span>
          <b>{num(counts[o])}</b>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- dispatches and statistics */

function newsTone(kind: string): string {
  if (kind === "liberated" || kind === "defended") return "good";
  if (kind === "lost") return "bad";
  if (kind === "attack") return "event";
  if (kind === "order") return "order";
  if (kind === "gm") return "gm";
  return "plain";
}

function DispatchPanel({ evo, readOnly, run, onSelect }: { evo: Evolved; readOnly: boolean; run: Run; onSelect: (p: number | null) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const post = async () => {
    setBusy(true);
    if (await run({ action: "evo_news", text: text.trim() })) setText("");
    setBusy(false);
  };
  let lastDay = "";
  return (
    <div className="stats">
      {!readOnly && (
        <div className="dispatch-form">
          <textarea className="text-field" rows={3} maxLength={400} value={text} placeholder={t("dispatchPh")} aria-label={t("postDispatch")} onChange={(e) => setText(e.target.value)} />
          <div className="if-row">
            <span className="muted small">{t("dispatchCount", { n: text.length })}</span>
            <button className="btn small play" disabled={busy || !text.trim()} onClick={post}><IPlus />{t("postDispatch")}</button>
          </div>
        </div>
      )}
      {evo.news.length === 0 ? <p className="muted empty">{t("noNews")}</p> : (
        <ol className="feed">
          {evo.news.map((n) => {
            const day = new Date(n.time * 1000).toDateString();
            const sep = day !== lastDay;
            lastDay = day;
            return (
              <li key={n.id} className={`feed-item ${newsTone(n.kind)}${sep ? " sep" : ""}`} data-day={sep ? dateTime(n.time).replace(/,.*$/, "") : undefined}>
                <time dateTime={new Date(n.time * 1000).toISOString()} data-tip={dateTime(n.time)}>{timeOfDay(n.time)}</time>
                <i className="feed-dot" />
                <span className="feed-text">
                  {n.kind === "gm" && <span className="gm-chip">{t("gm")}</span>}
                  {n.planet != null ? <button className="feed-link" onClick={() => onSelect(n.planet)}>{n.text}</button> : n.text}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function EvoStatsPanel({ evo }: { evo: Evolved }) {
  const s = evo.stats;
  const played = s.missions_won + s.missions_lost;
  const counts = [0, 0, 0, 0];
  for (const o of evo.owners) counts[o] = (counts[o] ?? 0) + 1;
  return (
    <div className="stats">
      <div className="stat-tiles">
        <Tile label={t("missionsWon")} value={num(s.missions_won)} sub={played ? `${t("successN", { p: pct(s.missions_won / played) })} · ${t("missionsLostN", { n: num(s.missions_lost) })}` : undefined} />
        <Tile label={t("operationsDone")} value={num(s.operations)} tip={t("operationsDoneTip")} />
        <Tile label={t("kills")} value={num(s.kills)} />
        <Tile label={t("deaths")} value={num(s.deaths)} />
        <Tile label={t("planetsLiberated")} value={num(s.liberated)} tip={t("planetsLiberatedTip")} />
        <Tile label={t("planetsLost")} value={num(s.lost)} tip={t("planetsLostTip")} />
        <Tile label={t("defensesHeld")} value={num(s.defended)} />
        <Tile label={t("campaigns")} value={num(evo.campaigns.length)} />
      </div>
      <table className="stat-table">
        <thead>
          <tr><th>{t("faction")}</th><th>{t("planets")}</th><th>{t("campaigns")}</th></tr>
        </thead>
        <tbody>
          {[0, 1, 2, 3].map((o) => (
            <tr key={o} style={{ "--fc": ownerColor(o) } as CSSProperties}>
              <td><span className="st-front"><PlanetGlyph owner={o} size={14} />{ownerName(o)}</span></td>
              <td>{num(counts[o])}</td>
              <td>{o === 0 ? "—" : num(evo.campaigns.filter((c) => c.faction === o).length)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
