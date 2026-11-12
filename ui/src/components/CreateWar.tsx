// Create War: a name, the model and a preset. Every rule is in the war settings once the war exists.
import { useState } from "react";
import { api, isMock } from "../api";
import { PRESETS, presetOf, sanitize, type PresetId } from "../settings";
import { t, tk } from "../strings";
import type { Settings } from "../types";
import { hoursText, num } from "../util";
import { playModel, warCreated } from "../bridge";
import { IBack, IInfo, IPlus } from "./Icons";
import { ModelSkull } from "./WarInfo";
import { notify } from "./ui";

const PRESET_IDS: PresetId[] = ["standard", "short", "hard"];
type Model = "vanilla" | "enhanced";
/** Mock only, for screenshots: `&model=enhanced` opens and picks the Enhanced model. */
const mockQ = new URLSearchParams(isMock ? location.search : "");
/** Enhanced wars are a skeleton for now: the card shows, disabled, outside the mock. */
const ENHANCED_OPEN = isMock && mockQ.get("model") === "enhanced";

export function CreateWar({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [model, setModel] = useState<Model>(ENHANCED_OPEN ? "enhanced" : "vanilla");
  const [settings, setSettings] = useState<Settings>(PRESETS.standard);
  const [busy, setBusy] = useState(false);
  const preset = presetOf(settings);

  const create = async () => {
    setBusy(true);
    try {
      const w = await api.createWar({ name: name.trim() || t("warNamePh"), model, settings: sanitize(settings) });
      // For an Enhanced war Obsidian sets up the Enhanced War Client mod.
      warCreated(w.id, w.name, playModel(w.model));
      onCreated(w.id);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
      setBusy(false);
    }
  };

  // The form scrolls by itself; the buttons stay in a row under it, so nothing passes beneath them.
  return (
    <div className="create-shell">
    <div className="page create-page">
      <header className="create-head">
        <button className="btn icon" onClick={onCancel} aria-label={t("back")} data-tip={t("back")}><IBack /></button>
        <h1 className="cap">{t("createTitle")}</h1>
      </header>
      <form id="create-war" className="create-body" onSubmit={(e) => { e.preventDefault(); if (!busy) create(); }} autoComplete="off">
        <section className="panel create-main">
          <label className="field">
            <span className="field-label">{t("warName")}</span>
            <input className="text-field" autoFocus maxLength={64} value={name} placeholder={t("warNamePh")} spellCheck={false} onChange={(e) => setName(e.target.value)} />
          </label>

          <div className="field">
            <span className="field-label">{t("model")}</span>
            <div className="model-cards" role="radiogroup" aria-label={t("model")}>
              <button type="button" role="radio" className={`model-card${model === "vanilla" ? " on" : ""}`} aria-checked={model === "vanilla"} onClick={() => setModel("vanilla")}>
                <span className="mc-logo vanilla"><ModelSkull model="vanilla" size={44} /></span>
                <span className="mc-text"><b className="cap">{t("modelVanilla")}</b><small>{t("modelVanillaText")}</small></span>
              </button>
              <button type="button" role="radio" className={`model-card${model === "enhanced" ? " on" : ""}`} aria-checked={model === "enhanced"} disabled={!ENHANCED_OPEN}
                onClick={() => setModel("enhanced")}>
                <span className="mc-logo enhanced"><ModelSkull model="enhanced" size={44} /></span>
                <span className="mc-text">
                  <b className="cap">{t("modelEnhanced")}{!ENHANCED_OPEN && <span className="chip later">{t("comingLater")}</span>}</b>
                  <small>{t("modelEnhancedText")}</small>
                </span>
              </button>
            </div>
          </div>

          {model === "enhanced" && (
            <div className="info-box" role="note">
              <IInfo />
              <span><b>{t("enhancedModTitle")}</b>{t("enhancedModText")}</span>
            </div>
          )}

          <div className="field">
            <span className="field-label">{t("preset")}</span>
            <div className="preset-cards">
              {PRESET_IDS.map((id) => (
                <button type="button" key={id} className={`preset-card${preset === id ? " on" : ""}`} aria-pressed={preset === id} onClick={() => setSettings(PRESETS[id])}>
                  <b>{tk(`preset_${id}`)}</b>
                  <small>{tk(`presetText_${id}`)}</small>
                  <span className="preset-nums">
                    <span>{num(PRESETS[id].points_max)} {t("points")}</span>
                    <span>−{num(PRESETS[id].pressure_per_hour)} / {t("hours")}</span>
                    <span>{t("defense")} {hoursText(PRESETS[id].defend_duration)}</span>
                  </span>
                </button>
              ))}
            </div>
            <small className="field-note muted">{t("createRulesNote")}</small>
          </div>
        </section>
      </form>
    </div>
    <footer className="create-foot">
      <div className="create-foot-row">
        <button type="button" className="btn" onClick={onCancel}>{t("cancel")}</button>
        <button type="submit" form="create-war" className="btn play" disabled={busy}><IPlus />{busy ? t("creating") : t("create")}</button>
      </div>
    </footer>
    </div>
  );
}
