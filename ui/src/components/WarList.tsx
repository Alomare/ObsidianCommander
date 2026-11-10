// The wars on this server: open one, play one, create or import.
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { officialWar, play, selectWar, useHost } from "../bridge";
import { t, tk } from "../strings";
import type { FrontBrief, Info, WarSummary } from "../types";
import { enemyName, FACTION_OF } from "../util";
import { MiniMap } from "../map/MiniMap";
import { FACTION_ACCENT } from "../map/GalaxyMap";
import { EnemyIcon, IGlobe, IImport, ILan, IPlay, IPlus, IUsers } from "./Icons";
import { notify } from "./ui";

export function WarList({ readOnly, onOpen, onCreate }: { readOnly: boolean; onOpen: (id: string) => void; onCreate: () => void }) {
  const host = useHost();
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    let timer = 0;
    const load = async () => {
      try {
        const i = await api.info();
        if (alive) { setInfo(i); setError(false); }
      } catch {
        if (alive) setError(true);
      }
      if (alive) timer = window.setTimeout(load, 5000);
    };
    load();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  const doImport = async (f: File) => {
    try {
      const json = JSON.parse(await f.text());
      const w = await api.importWar(json);
      notify(t("importDone"));
      onOpen(w.id);
    } catch {
      notify(t("importFailed"), true);
    }
  };

  const wars = info?.wars ?? [];
  return (
    <div className="page list-page">
      <header className="list-head">
        <div className="list-title">
          <h1 className="cap">{t("warsTitle")}</h1>
          <p className="muted">{t("warsLead")}</p>
        </div>
        <div className="list-tools">
          {host.playing && <button className="btn" onClick={officialWar} data-tip={t("officialWarTip")}><IGlobe />{t("officialWar")}</button>}
          {!readOnly && <>
            <button className="btn" onClick={() => file.current?.click()}><IImport />{t("importWar")}</button>
            <button className="btn go" onClick={onCreate}><IPlus />{t("createWar")}</button>
          </>}
          <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) doImport(f); }} />
        </div>
      </header>

      {error && <div className="banner">{t("offline")}</div>}
      {!info && !error && <div className="empty muted">{t("loading")}</div>}
      {info && wars.length === 0 && (
        <div className="empty-card">
          <MiniMap />
          <p>{t("noWars")}</p>
          {!readOnly && <button className="btn go" onClick={onCreate}><IPlus />{t("createWar")}</button>}
        </div>
      )}

      <div className="war-cards">
        {wars.map((w, i) => <WarCard key={w.id} war={w} index={i} playing={host.playing === w.id} readOnly={readOnly} onOpen={() => onOpen(w.id)} />)}
      </div>
      {info && <div className="list-foot muted">{t("serverVersion", { v: info.version })}</div>}
    </div>
  );
}

function WarCard({ war, index, playing, readOnly, onOpen }: { war: WarSummary; index: number; playing: boolean; readOnly: boolean; onOpen: () => void }) {
  const members = Array.isArray(war.members) ? war.members.length : war.members;
  const fronts = war.fronts ?? [];
  const lanOpen = typeof war.lan === "boolean" ? war.lan : !!war.lan?.open;
  const lanPort = typeof war.lan === "object" && war.lan ? war.lan.port : null;
  const share = (f: FrontBrief) => f.status === "defeated" ? 1 : f.points != null && f.points_max ? f.points / f.points_max : Math.max(0, (f.region - 1) / 10);
  return (
    <div className={`war-card${playing ? " playing" : ""}`} style={{ animationDelay: `${index * 50}ms` }} role="button" tabIndex={0}
      onClick={onOpen} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}>
      <MiniMap fronts={war.fronts} />
      <div className="wc-body">
        <div className="wc-name">
          <span className="nm-text">{war.name}</span>
          {playing && <span className="tag">{t("playingShort")}</span>}
        </div>
        <div className="wc-chips">
          <span className="chip">{war.model === "vanilla" || !war.model ? t("modelVanilla") : war.model}</span>
          {war.season != null && <span className="chip">{t("seasonN", { n: war.season })}</span>}
          {war.state && <span className={`chip state ${war.state}`}>{tk(`state_${war.state}`)}</span>}
          {lanOpen && <span className="chip lan" data-tip={lanPort ? t("lanOpenTip", { port: lanPort }) : undefined}><ILan width={13} height={13} />{t("lanOpen")}</span>}
          {members != null && <span className="chip"><IUsers width={13} height={13} />{members === 1 ? t("memberOne") : t("membersN", { n: members })}</span>}
        </div>
        {fronts.length > 0 && (
          <div className="wc-fronts">
            {fronts.map((f) => (
              <div key={f.enemy} className={`wc-front ${f.status}`} data-tip={`${enemyName(f.enemy)}: ${f.status === "active" ? t("regionOf", { n: f.region }) : tk(`status_${f.status}`)}`}>
                <EnemyIcon enemy={f.enemy} width={14} height={14} />
                <div className="mini-bar"><i style={{ width: `${share(f) * 100}%`, background: FACTION_ACCENT[FACTION_OF[f.enemy]] }} /></div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="wc-actions" onClick={(e) => e.stopPropagation()}>
        <button className="btn play" onClick={() => play(war.id, war.name)}><IPlay />{t("play")}</button>
        {!readOnly && !playing && <button className="btn small" onClick={() => selectWar(war.id, war.name)} data-tip={t("selectTip")}>{t("select")}</button>}
      </div>
    </div>
  );
}
