// The wars on this server: open one, select one for Obsidian's Play button, create or import.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api } from "../api";
import { importWarText } from "../App";
import { playModel, selectWar, useHost } from "../bridge";
import { t, tk } from "../strings";
import type { FrontBrief, Info, WarSummary } from "../types";
import { enemyName, pct, FACTION_OF } from "../util";
import { FACTION_ACCENT, HELLDIVER_ACCENT } from "../map/GalaxyMap";
import { EnemyIcon, ICheck, IChevron, IEdit, IImport, ILan, IPlus, IUsers, Skull } from "./Icons";
import { WarLogo, WarSettingsDialog } from "./WarInfo";

export function WarList({ readOnly, onOpen, onCreate }: { readOnly: boolean; onOpen: (id: string) => void; onCreate: () => void }) {
  const host = useHost();
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState<WarSummary | null>(null);
  const [reload, setReload] = useState(0);
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
  }, [reload]);

  const doImport = async (f: File) => {
    const id = await importWarText(await f.text());
    if (id) onOpen(id);
  };

  const wars = info?.wars ?? [];
  // Obsidian with the tools in its own bar: Import and New War show there instead.
  const tools = !readOnly && !host.barTools;
  return (
    <div className="page list-page">
      {tools && (
        <header className="list-head">
          <div className="list-tools">
            <button className="btn" onClick={() => file.current?.click()} data-tip={t("importTip")}><IImport />{t("importWar")}</button>
            <button className="btn go" onClick={onCreate}><IPlus />{t("createWar")}</button>
          </div>
          <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) doImport(f); }} />
        </header>
      )}

      {error && <div className="banner">{t("offline")}</div>}
      {!info && !error && <div className="empty muted">{t("loading")}</div>}
      {info && wars.length === 0 && (
        <div className="empty-card">
          <Skull variant="vanilla" width={96} height={96} />
          <p>{t("noWars")}</p>
          {!readOnly && <button className="btn go" onClick={onCreate}><IPlus />{t("createWar")}</button>}
        </div>
      )}

      <div className="war-cards">
        {wars.map((w, i) => <WarCard key={w.id} war={w} index={i} playing={host.playing === w.id} gameRunning={host.gameRunning} readOnly={readOnly} onOpen={() => onOpen(w.id)} onEdit={() => setEditing(w)} />)}
      </div>
      {editing && <WarSettingsDialog war={editing} onClose={() => setEditing(null)} onSaved={() => setReload((n) => n + 1)} />}
    </div>
  );
}

function WarCard({ war, index, playing, gameRunning, readOnly, onOpen, onEdit }: { war: WarSummary; index: number; playing: boolean; gameRunning: boolean; readOnly: boolean; onOpen: () => void; onEdit: () => void }) {
  const members = Array.isArray(war.members) ? war.members.length : war.members;
  const fronts = war.fronts ?? [];
  const model = playModel(war.model);
  const lanOpen = typeof war.lan === "boolean" ? war.lan : !!war.lan?.open;
  const lanPort = typeof war.lan === "object" && war.lan ? war.lan.port : null;
  const share = (f: FrontBrief) => f.status === "defeated" ? 1 : f.status === "hidden" ? 0 : f.points != null && f.points_max ? f.points / f.points_max : Math.max(0, (f.region - 1) / 10);
  const busy = gameRunning ? t("gameRunningTip") : undefined;
  return (
    <div className={`war-card${playing ? " playing" : ""}`} style={{ animationDelay: `${index * 50}ms` }} role="button" tabIndex={0} aria-label={t("openWar", { name: war.name })}
      onClick={onOpen} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}>
      <WarLogo war={war} />
      <div className="wc-body">
        <div className="wc-name">
          <span className="nm-text">{war.name}</span>
        </div>
        {war.description && <p className="wc-desc">{war.description}</p>}
        <div className="wc-chips">
          {war.model === "enhanced" && <span className="chip model enhanced">{t("modelEnhancedShort")}</span>}
          {war.season != null && <span className="chip" data-tip={t("seasonTip")}>{t("seasonN", { n: war.season })}</span>}
          {war.state && <span className={`chip state ${war.state}`}>{tk(`state_${war.state}`)}</span>}
          {lanOpen && <span className="chip lan" data-tip={lanPort ? t("shareOpenLan", { port: lanPort }) : undefined}><ILan width={13} height={13} />{t("lanOpen")}</span>}
          {members != null && <span className="chip" data-tip={war.players != null ? t("recentPlayers", { n: war.players }) : undefined}><IUsers width={13} height={13} />{members === 1 ? t("memberOne") : t("membersN", { n: members })}</span>}
        </div>
        {fronts.length > 0 && (
          <div className="wc-fronts">
            {fronts.map((f) => (
              <div key={f.enemy} className={`wc-front ${f.status}`} style={{ "--fc": FACTION_ACCENT[FACTION_OF[f.enemy]], "--hd": HELLDIVER_ACCENT } as CSSProperties}
                data-tip={`${enemyName(f.enemy)}: ${f.status === "active" ? pct(share(f)) : tk(`status_${f.status}`)}`}>
                <EnemyIcon enemy={f.enemy} width={14} height={14} />
                <div className="mini-bar"><i style={{ width: `${share(f) * 100}%` }} /></div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="wc-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        {!readOnly && <button className="btn small" onClick={onEdit} data-tip={t("editTip")}><IEdit />{t("editShort")}</button>}
        {!readOnly && (playing
          ? <button className="btn small selected-btn" disabled data-tip={t("playingTip")}><ICheck />{t("playingShort")}</button>
          : <button className="btn small" disabled={gameRunning} onClick={() => selectWar(war.id, war.name, model)} data-tip={busy ?? t("selectTip")}>{t("select")}</button>)}
      </div>
      <IChevron className="wc-open" aria-hidden />
    </div>
  );
}
