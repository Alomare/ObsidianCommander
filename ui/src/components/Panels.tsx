// Side panel tabs: the feed, statistics with members, and the war settings dialog.
import { useMemo, useState, type CSSProperties } from "react";
import { api } from "../api";
import { sanitize } from "../settings";
import { t } from "../strings";
import type { FeedEntry, Settings, War } from "../types";
import { ago, enemyName, feedText, feedTone, memberName, num, pct, timeOfDay, dateTime, FACTION_OF } from "../util";
import { FACTION_ACCENT } from "../map/GalaxyMap";
import { EnemyIcon } from "./Icons";
import { SettingsForm } from "./SettingsForm";
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

export function StatsPanel({ war, nowUnix }: { war: War; nowUnix: number }) {
  const total = war.statistics.reduce((a, s) => ({
    missions: a.missions + s.missions, successful: a.successful + s.successful_missions, kills: a.kills + s.kills,
    deaths: a.deaths + s.deaths, accidentals: a.accidentals + s.accidentals, planets: a.planets + s.completed_planets,
    shots: a.shots + s.shots, hits: a.hits + s.hits,
  }), { missions: 0, successful: 0, kills: 0, deaths: 0, accidentals: 0, planets: 0, shots: 0, hits: 0 });
  const members = [...war.members].sort((a, b) => b.last_seen - a.last_seen);
  return (
    <div className="stats">
      <div className="stat-tiles">
        <Tile label={t("missions")} value={num(total.missions)} sub={total.missions ? `${pct(total.successful / total.missions)} ${t("successRate").toLowerCase()}` : undefined} />
        <Tile label={t("planets")} value={num(total.planets)} />
        <Tile label={t("kills")} value={num(total.kills)} />
        <Tile label={t("deaths")} value={num(total.deaths)} sub={total.accidentals ? `${num(total.accidentals)} ${t("accidentals").toLowerCase()}` : undefined} />
      </div>
      <table className="stat-table">
        <thead>
          <tr><th>{t("front")}</th><th>{t("missions")}</th><th>{t("successRate")}</th><th>{t("kills")}</th><th>{t("deaths")}</th></tr>
        </thead>
        <tbody>
          {war.statistics.map((s) => (
            <tr key={s.enemy} style={{ "--fc": FACTION_ACCENT[FACTION_OF[s.enemy]] } as CSSProperties}>
              <td><span className="st-front"><EnemyIcon enemy={s.enemy} width={14} height={14} />{enemyName(s.enemy)}</span></td>
              <td>{num(s.missions)}</td>
              <td>{s.missions ? pct(s.successful_missions / s.missions) : "—"}</td>
              <td>{num(s.kills)}</td>
              <td>{num(s.deaths)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {total.shots > 0 && <div className="kv muted"><span>{t("accuracy")}</span><span>{pct(total.hits / total.shots, 1)}</span></div>}

      <h3 className="cap section-title">{t("members")} <span className="count">{war.members.length}</span></h3>
      {members.length === 0 ? <p className="muted small">{t("noMembers")}</p> : (
        <ul className="members">
          {members.map((m) => {
            const online = nowUnix - m.last_seen < 900;
            return (
              <li key={m.player}>
                <span className={`avatar${online ? " on" : ""}`}>{(m.name || "?").slice(0, 1).toUpperCase()}</span>
                <span className="m-text">
                  <b>{memberName(war, m.player)}</b>
                  <small className="mono" data-tip={t("playerId")}>{m.player}</small>
                </span>
                <span className="m-side">
                  <span>{t("missionsN", { n: m.missions })}</span>
                  <small className="muted" data-tip={`${t("firstSeen", { t: dateTime(m.first_seen) })}`}>{t("lastSeen", { t: ago(m.last_seen, nowUnix) })}</small>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <b className="tile-value">{value}</b>
      {sub && <small>{sub}</small>}
    </div>
  );
}

export function SettingsDialog({ war, onClose, onSaved }: { war: War; onClose: () => void; onSaved: (w: War) => void }) {
  const [name, setName] = useState(war.name);
  const [settings, setSettings] = useState<Settings>(war.settings);
  const [busy, setBusy] = useState(false);
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
    <Modal title={t("settings")} onClose={onClose} className="settings-dialog" foot={<>
      <button className="btn" onClick={onClose}>{t("cancel")}</button>
      <button className="btn gold" disabled={busy} onClick={save}>{t("save")}</button>
    </>}>
      <label className="field">
        <span className="field-label">{t("warName")}</span>
        <input maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <SettingsForm value={settings} onChange={setSettings} />
    </Modal>
  );
}
