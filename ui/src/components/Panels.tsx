// Side panel tabs: the feed, the players, statistics with the fronts over time, and the war settings dialog.
import { useMemo, useState, type CSSProperties } from "react";
import { api } from "../api";
import { sanitize } from "../settings";
import { t } from "../strings";
import type { FeedEntry, Settings, Snapshot, War } from "../types";
import { ago, enemyName, feedText, feedTone, memberName, num, pct, timeOfDay, dateTime, FACTION_OF } from "../util";
import { FACTION_ACCENT } from "../map/GalaxyMap";
import { EnemyIcon } from "./Icons";
import { SettingsForm } from "./SettingsForm";
import { HistoryChart } from "./HistoryChart";
import { ONLINE_S } from "./CommandPanel";
import { Modal, notify } from "./ui";
import type { Selection } from "../map/GalaxyMap";

export function FeedList({ feed, war, names, onSelect }: { feed: FeedEntry[]; war: War; names: Record<string, string>; onSelect: (s: Selection) => void }) {
  const items = useMemo(() => [...feed].reverse(), [feed]);
  if (!items.length) return <p className="muted empty">{t("feedEmpty")}</p>;
  let lastDay = "";
  return (
    <ol className="feed">
      {items.map((e) => {
        const day = new Date(e.time * 1000).toDateString();
        const sep = day !== lastDay;
        lastDay = day;
        const tone = feedTone(e);
        const where: Selection = e.region === 0 ? { kind: "superearth" } : e.front != null && e.region != null ? { kind: "region", enemy: e.front, region: Math.min(11, e.region) } : e.front != null ? { kind: "front", enemy: e.front } : null;
        return (
          <li key={e.id} className={`feed-item ${tone}${sep ? " sep" : ""}`} data-day={sep ? dateTime(e.time).replace(/,.*$/, "") : undefined}
            style={e.front != null ? ({ "--fc": FACTION_ACCENT[FACTION_OF[e.front]] } as CSSProperties) : undefined}>
            <time dateTime={new Date(e.time * 1000).toISOString()} data-tip={dateTime(e.time)}>{timeOfDay(e.time)}</time>
            <i className="feed-dot" />
            <span className="feed-text">
              {e.player === "gm" && <span className="gm-chip">{t("gm")}</span>}
              {where ? <button className="feed-link" onClick={() => onSelect(where)}>{feedText(e, war, names)}</button> : feedText(e, war, names)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/* Who plays this war: online first, then by when they were last seen. */
export function PlayersPanel({ war, nowUnix, readOnly }: { war: War; nowUnix: number; readOnly: boolean }) {
  const members = [...war.members].sort((a, b) => {
    const oa = nowUnix - a.last_seen < ONLINE_S, ob = nowUnix - b.last_seen < ONLINE_S;
    return oa !== ob ? (oa ? -1 : 1) : b.last_seen - a.last_seen;
  });
  const online = members.filter((m) => nowUnix - m.last_seen < ONLINE_S).length;
  if (members.length === 0) return <p className="muted empty">{t("noMembers")}</p>;
  return (
    <div className="stats">
      <div className="players-head">
        <span><b>{online}</b> {t("onlineShort")}</span>
        <span className="muted">{members.length === 1 ? t("memberOne") : t("membersN", { n: members.length })}</span>
      </div>
      <ul className="members">
        {members.map((m) => {
          const on = nowUnix - m.last_seen < ONLINE_S;
          return (
            <li key={m.player}>
              <span className={`avatar${on ? " on" : ""}`}>{(m.name || "?").slice(0, 1).toUpperCase()}</span>
              <span className="m-text" data-tip={`${readOnly ? "" : `${t("playerId")}: ${m.player}\n`}${t("firstSeen", { t: dateTime(m.first_seen) })}`}>
                <b>{memberName(war, m.player)}</b>
                <small className={on ? "on" : undefined}>{on ? t("online") : t("lastSeen", { t: ago(m.last_seen, nowUnix) })}</small>
              </span>
              <span className="m-side"><b>{num(m.missions)}</b><small>{m.missions === 1 ? t("missionOne") : t("missionsWord")}</small></span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* The war in numbers: the fronts over time, then totals and each front. */
export function StatsPanel({ war, history, nowUnix }: { war: War; history: Snapshot[]; nowUnix: number }) {
  const total = war.statistics.reduce((a, s) => ({
    missions: a.missions + s.missions, successful: a.successful + s.successful_missions, kills: a.kills + s.kills,
    deaths: a.deaths + s.deaths, accidentals: a.accidentals + s.accidentals, planets: a.planets + s.completed_planets,
    shots: a.shots + s.shots, hits: a.hits + s.hits,
  }), { missions: 0, successful: 0, kills: 0, deaths: 0, accidentals: 0, planets: 0, shots: 0, hits: 0 });
  return (
    <div className="stats">
      <HistoryChart war={war} history={history} nowUnix={nowUnix} />
      <div className="stat-tiles">
        <Tile label={t("missions")} value={num(total.missions)} sub={total.missions ? t("successN", { p: pct(total.successful / total.missions) }) : undefined} />
        <Tile label={t("planets")} value={num(total.planets)} tip={t("planetsTip")} />
        <Tile label={t("kills")} value={num(total.kills)} sub={total.shots > 0 ? t("accuracyN", { p: pct(total.hits / total.shots) }) : undefined} />
        <Tile label={t("deaths")} value={num(total.deaths)} sub={total.accidentals ? t("accidentalsN", { n: num(total.accidentals) }) : undefined} />
      </div>
      <table className="stat-table">
        <thead>
          <tr><th>{t("front")}</th><th>{t("missions")}</th><th>{t("successRate")}</th><th>{t("planets")}</th><th>{t("kills")}</th></tr>
        </thead>
        <tbody>
          {war.statistics.map((s) => (
            <tr key={s.enemy} style={{ "--fc": FACTION_ACCENT[FACTION_OF[s.enemy]] } as CSSProperties}>
              <td><span className="st-front"><EnemyIcon enemy={s.enemy} width={14} height={14} />{enemyName(s.enemy)}</span></td>
              <td>{num(s.missions)}</td>
              <td>{s.missions ? pct(s.successful_missions / s.missions) : "—"}</td>
              <td>{num(s.completed_planets)}</td>
              <td>{num(s.kills)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Tile({ label, value, sub, tip }: { label: string; value: string; sub?: string; tip?: string }) {
  return (
    <div className="tile" data-tip={tip}>
      <span className="tile-label">{label}</span>
      <b className="tile-value">{value}</b>
      <small>{sub ?? " "}</small>
    </div>
  );
}

export function SettingsDialog({ war, onClose, onSaved }: { war: War; onClose: () => void; onSaved: (w: War) => void }) {
  const [name, setName] = useState(war.name);
  const [settings, setSettings] = useState<Settings>(war.settings);
  const [busy, setBusy] = useState(false);
  const dirty = name !== war.name || JSON.stringify(settings) !== JSON.stringify(war.settings);
  const save = async () => {
    setBusy(true);
    try {
      const w = await api.patchWar(war.id, { name: name.trim() || war.name, settings: sanitize(settings) });
      onSaved(w);
      onClose();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
      setBusy(false);
    }
  };
  return (
    <Modal title={t("settings")} onClose={onClose} className="settings-dialog" keep={dirty} foot={<>
      <button className="btn" onClick={onClose}>{t("cancel")}</button>
      <button className="btn play" disabled={busy || !dirty} onClick={save}>{t("save")}</button>
    </>}>
      <label className="field">
        <span className="field-label">{t("warName")}</span>
        <input maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <SettingsForm value={settings} onChange={setSettings} />
    </Modal>
  );
}
