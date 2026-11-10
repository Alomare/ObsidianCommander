// The war: the galaxy overview as the hero, the fronts under it, the clock and tools above, the side panel.
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { api, isMock } from "../api";
import { play, useHost } from "../bridge";
import { useNow, useTween, useWarData } from "../hooks";
import { t, tk } from "../strings";
import type { Front, GmAction, War, WarEvent } from "../types";
import { clock, enemyName, pct, regionName, regionOf, regionProgress, FACTION_OF } from "../util";
import { FACTION_ACCENT, GalaxyMap, HELLDIVER_ACCENT, type Selection } from "../map/GalaxyMap";
import { CommandPanel } from "./CommandPanel";
import { HistoryChart } from "./HistoryChart";
import { FeedList, SettingsDialog, StatsPanel } from "./Panels";
import { EnemyIcon, IBack, IChart, ICommand, IEye, IExport, IGear, IList, IPause, IPlay, IStats, ITarget, ITrash, IWarn } from "./Icons";
import { Confirm, Switch, notify } from "./ui";

type Tab = "command" | "feed" | "stats" | "history";

/** Mock only, for screenshots: `&sel=bugs:4` (or `superearth`) selects a region, `&tab=feed` opens a tab. */
const mockStart = (() => {
  const q = new URLSearchParams(location.search);
  const sel = isMock ? q.get("sel") : null;
  let s: Selection = null;
  if (sel === "superearth") s = { kind: "superearth" };
  else if (sel) {
    const [f, r] = sel.split(":");
    const enemy = FACTION_OF.indexOf(f as (typeof FACTION_OF)[number]);
    if (enemy >= 0) s = r ? { kind: "region", enemy, region: Number(r) } : { kind: "front", enemy };
  }
  const tab = (isMock && ["command", "feed", "stats", "history"].includes(q.get("tab") ?? "") ? q.get("tab") : "command") as Tab;
  return { sel: s, tab };
})();
const SPEEDS = [0.5, 1, 2, 5, 10];

export function WarView({ id, readOnly, guest, onBack }: { id: string; readOnly: boolean; guest: boolean; onBack: () => void }) {
  const host = useHost();
  const { war, feed, history, error, offset, accept } = useWarData(id);
  const now = useNow(1000);
  const [selection, setSelection] = useState<Selection>(mockStart.sel);
  const [tab, setTab] = useState<Tab>(mockStart.tab);
  const [dialog, setDialog] = useState<null | "settings" | "delete">(null);

  const run = useCallback(async (a: GmAction) => {
    try {
      accept(await api.action(id, a));
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    }
  }, [id, accept]);

  const select = useCallback((s: Selection) => { setSelection(s); if (s) setTab("command"); }, []);

  // Keys: Space pauses, Escape clears the selection, 1-4 switch tabs.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || document.querySelector(".modal")) return;
      if (e.key === "Escape") setSelection(null);
      if (["1", "2", "3", "4"].includes(e.key)) setTab((["command", "feed", "stats", "history"] as Tab[])[Number(e.key) - 1]);
      if (e.key === " " && !readOnly && war && (war.state === "running" || war.state === "paused") && (e.target as HTMLElement).tagName !== "BUTTON") {
        e.preventDefault();
        run({ action: war.state === "running" ? "pause" : "resume" });
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [readOnly, war, run]);

  if (!war) {
    return (
      <div className="page war-loading">
        {!guest && <button className="btn icon" onClick={onBack} aria-label={t("back")}><IBack /></button>}
        <span className="muted">{error ? t("offline") : t("loading")}</span>
      </div>
    );
  }

  const running = war.state === "running";
  // Countdowns stop with the clock: while paused they read from the last server time.
  const serverNow = now / 1000 + offset;
  const nowUnix = running ? serverNow : war.server_time;
  const isPlaying = host.playing === war.id;

  const exportWar = async () => {
    try {
      const blob = await api.exportWar(war.id);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${war.name.replace(/[^\w -]+/g, "").trim() || "war"}-${war.id}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    }
  };
  const toggleLan = async (open: boolean) => {
    try {
      const lan = await api.lan(war.id, open);
      accept({ ...war, lan });
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    }
  };

  const tabs: { id: Tab; label: string; icon: ReactNode }[] = [
    { id: "command", label: readOnly ? t("overview") : t("command"), icon: readOnly ? <IEye /> : <ICommand /> },
    { id: "feed", label: t("feed"), icon: <IList /> },
    { id: "stats", label: t("statistics"), icon: <IStats /> },
    { id: "history", label: t("history"), icon: <IChart /> },
  ];

  return (
    <div className={`war-view state-${war.state}`}>
      <header className="war-bar">
        {!guest && <button className="btn icon" onClick={onBack} aria-label={t("back")} data-tip={t("back")}><IBack /></button>}
        <div className="war-title">
          <h1 title={war.name}>{war.name}</h1>
          <div className="wc-chips">
            <span className="chip">{t("modelVanilla")}</span>
            <span className="chip">{t("seasonN", { n: war.season })}</span>
            <span className={`chip state ${war.state}`}>{tk(`state_${war.state}`)}</span>
            {readOnly && <span className="chip ro" data-tip={t("readOnlyTip")}><IEye width={13} height={13} />{t("readOnly")}</span>}
          </div>
        </div>

        <WarClock war={war} serverNow={serverNow} readOnly={readOnly} run={run} />

        {!readOnly && (
          <div className="lan-ctl" data-tip={t("lanTip")}>
            <Switch on={war.lan.open} onChange={toggleLan} label={t("lan")} />
            <span className="lan-text">
              <b>{t("lan")}</b>
              <small className={war.lan.open ? "on" : ""}>{war.lan.open && war.lan.port ? t("lanPort", { port: war.lan.port }) : t("lanClosed")}</small>
            </span>
          </div>
        )}
        {!readOnly && (
          <div className="bar-tools">
            <button className="btn icon" onClick={() => setDialog("settings")} aria-label={t("settings")} data-tip={t("settings")}><IGear /></button>
            <button className="btn icon" onClick={exportWar} aria-label={t("export")} data-tip-title={t("export")} data-tip={t("exportTip")}><IExport /></button>
            <button className="btn icon danger-soft" onClick={() => setDialog("delete")} aria-label={t("deleteWar")} data-tip={t("deleteWar")}><ITrash /></button>
          </div>
        )}
        <div className="play-wrap">
          <button className={`btn play big${isPlaying ? " selected" : ""}`} onClick={() => play(war.id, war.name)} data-tip={isPlaying ? t("playing") : undefined}>
            <IPlay />{t("play")}
          </button>
          {isPlaying && <span className="play-note">{host.gameRunning ? t("gameRunning") : t("playing")}</span>}
        </div>
      </header>

      <div className="war-body">
        <div className="map-col">
          <div className="map-stage">
            <GalaxyMap war={war} names={host.names} selection={selection} onSelect={select} nowUnix={nowUnix} />
            <EventsOverlay war={war} names={host.names} nowUnix={nowUnix} onSelect={select} />
            {(war.state === "won" || war.state === "lost") && (
              <div className={`season-banner ${war.state}`}>
                <b className="cap">{tk(`seasonEnded_${war.state}`, { n: war.season })}</b>
                <span>{t("seasonEndedText")}</span>
              </div>
            )}
            <Legend />
          </div>
          <div className="front-strip">
            {war.fronts.map((f) => (
              <FrontCard key={f.enemy} front={f} names={host.names} selected={!!selection && selection.kind !== "superearth" && selection.enemy === f.enemy}
                event={eventFor(war, f.enemy)} onClick={() => select(selection && selection.kind === "front" && selection.enemy === f.enemy ? null : { kind: "front", enemy: f.enemy })} />
            ))}
          </div>
        </div>

        <aside className="side">
          <nav className="side-tabs" role="tablist">
            {tabs.map((x, i) => (
              <button key={x.id} role="tab" aria-selected={tab === x.id} className={`side-tab${tab === x.id ? " cur" : ""}`} onClick={() => setTab(x.id)} data-tip={`${x.label} (${i + 1})`}>
                {x.icon}<span className="cap">{x.label}</span>
              </button>
            ))}
          </nav>
          <div className="side-body" key={tab}>
            {tab === "command" && <CommandPanel war={war} selection={selection} onSelect={select} names={host.names} readOnly={readOnly} run={run} nowUnix={nowUnix} />}
            {tab === "feed" && <FeedList feed={feed} war={war} names={host.names} onSelect={select} />}
            {tab === "stats" && <StatsPanel war={war} nowUnix={serverNow} />}
            {tab === "history" && <HistoryChart war={war} history={history} nowUnix={serverNow} />}
          </div>
        </aside>
      </div>

      {error && <div className="banner floating">{t("offline")}</div>}
      {dialog === "settings" && <SettingsDialog war={war} onClose={() => setDialog(null)} onSaved={accept} />}
      {dialog === "delete" && (
        <Confirm title={t("deleteWar")} text={t("deleteWarText", { name: war.name })} okLabel={t("delete")} danger onClose={() => setDialog(null)}
          onOk={async () => { try { await api.deleteWar(war.id); onBack(); } catch (e) { notify(e instanceof Error ? e.message : String(e), true); } }} />
      )}
    </div>
  );
}

function eventFor(war: War, enemy: number): WarEvent | null {
  if (war.defend_event?.status === "active" && war.defend_event.enemy === enemy) return war.defend_event;
  return war.attack_events.find((e) => e.status === "active" && e.enemy === enemy) ?? null;
}

function WarClock({ war, serverNow, readOnly, run }: { war: War; serverNow: number; readOnly: boolean; run: (a: GmAction) => Promise<void> }) {
  const running = war.state === "running";
  const ended = war.state === "won" || war.state === "lost";
  // Between polls the war time runs on locally from the last answer.
  const wt = war.war_time + (running ? Math.max(0, serverNow - war.server_time) * war.speed : 0);
  return (
    <div className={`war-clock${running ? " running" : ""}`}>
      <div className="wc-time">
        <span className="cap">{t("warTime")}</span>
        <b className="mono">{clock(wt)}</b>
      </div>
      {!readOnly && !ended && (
        <button className="btn icon" onClick={() => run({ action: running ? "pause" : "resume" })} aria-label={running ? t("pause") : t("resume")} data-tip={`${running ? t("pause") : t("resume")} (Space)`}>
          {running ? <IPause /> : <IPlay />}
        </button>
      )}
      {readOnly || ended ? (
        <span className="speed-read" data-tip={t("speedTip")}>{war.speed}×</span>
      ) : (
        <div className="seg speed" role="radiogroup" aria-label={t("speed")} data-tip={t("speedTip")}>
          {SPEEDS.map((s) => (
            <button key={s} role="radio" aria-checked={war.speed === s} className={war.speed === s ? "on" : ""} onClick={() => run({ action: "set_speed", speed: s })}>{s}×</button>
          ))}
        </div>
      )}
    </div>
  );
}

function FrontCard({ front, names, selected, event, onClick }: { front: Front; names: Record<string, string>; selected: boolean; event: WarEvent | null; onClick: () => void }) {
  const f = FACTION_OF[front.enemy];
  const total = useTween(front.status === "defeated" ? 1 : front.points / front.points_max);
  const cur = regionOf(front);
  return (
    <button className={`front-card ${front.status}${selected ? " sel" : ""}`} onClick={onClick} style={{ "--fc": FACTION_ACCENT[f], "--hd": HELLDIVER_ACCENT } as CSSProperties}
      aria-pressed={selected}>
      <span className="fc-icon"><EnemyIcon enemy={front.enemy} width={22} height={22} /></span>
      <span className="fc-main">
        <span className="fc-top">
          <b className="cap">{enemyName(front.enemy)}</b>
          {event && <span className={`fc-event ${event.region >= 11 ? "attack" : "defend"}`}>{event.region >= 11 ? <ITarget width={13} height={13} /> : <IWarn width={13} height={13} />}</span>}
          <span className="fc-pct">{front.status === "hidden" ? tk("status_hidden") : front.status === "defeated" ? tk("status_defeated") : pct(total, 1)}</span>
        </span>
        <span className="fc-bar">
          <i className="fc-fill" style={{ width: `${total * 100}%` }} />
          {front.status === "active" && <i className="fc-cur" style={{ left: `${(cur - 1) * 10}%`, width: `${regionProgress(front) * 10}%` }} />}
          {Array.from({ length: 9 }, (_, i) => <b key={i} style={{ left: `${(i + 1) * 10}%` }} />)}
        </span>
        <span className="fc-sub muted">{front.status === "active" ? `${t("regionOf", { n: cur })} · ${regionName(front.enemy, cur, names)}` : " "}</span>
      </span>
    </button>
  );
}

function EventsOverlay({ war, names, nowUnix, onSelect }: { war: War; names: Record<string, string>; nowUnix: number; onSelect: (s: Selection) => void }) {
  const evs = [...(war.defend_event?.status === "active" ? [war.defend_event] : []), ...war.attack_events.filter((e) => e.status === "active")];
  return (
    <div className="events-overlay">
      <h3 className="cap">{t("events")}</h3>
      {evs.length === 0 && <p className="muted small">{t("noEvents")}</p>}
      {evs.map((e) => <EventCard key={e.event_id} ev={e} names={names} nowUnix={nowUnix} paused={war.state !== "running"}
        onClick={() => onSelect(e.region === 0 ? { kind: "superearth" } : { kind: "region", enemy: e.enemy, region: Math.min(11, e.region) })} />)}
    </div>
  );
}

function EventCard({ ev, names, nowUnix, paused, onClick }: { ev: WarEvent; names: Record<string, string>; nowUnix: number; paused: boolean; onClick: () => void }) {
  const attack = ev.region >= 11;
  const p = useTween(ev.points / ev.points_max);
  const left = ev.end_time - nowUnix;
  const urgent = left < 1800;
  return (
    <button className={`event-card ${attack ? "attack" : "defend"}${urgent ? " urgent" : ""}`} onClick={onClick} style={{ "--fc": FACTION_ACCENT[FACTION_OF[ev.enemy]], "--hd": HELLDIVER_ACCENT } as CSSProperties}>
      <span className="ec-icon">{attack ? <ITarget /> : <IWarn />}</span>
      <span className="ec-main">
        <b>{attack ? t("attackOn", { region: regionName(ev.enemy, ev.region, names) }) : t("defenseOf", { region: regionName(ev.enemy, ev.region, names) })}</b>
        <span className="ec-row"><span className="muted">{enemyName(ev.enemy)}</span><span className="mono">{paused ? `${clock(left)} · ${t("state_paused")}` : clock(left)}</span></span>
        <span className="ec-bar"><i style={{ width: `${p * 100}%` }} /></span>
        <span className="ec-row small"><span className="muted">{t("progress")}</span><span>{pct(p)}</span></span>
      </span>
    </button>
  );
}

function Legend() {
  return (
    <div className="legend map-legend" aria-hidden>
      <span><i className="lg liberated" />{t("legendLiberated")}</span>
      <span><i className="lg front" />{t("legendFront")}</span>
      <span><i className="lg enemy" />{t("legendEnemy")}</span>
    </div>
  );
}
