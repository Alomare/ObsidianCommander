// Create War: a name, the model, a preset (Vanilla), and every rule under Advanced.
import { useState } from "react";
import { api, isMock } from "../api";
import { EVO_DEFAULTS, sanitizeEvo } from "../evolved";
import { PRESETS, presetOf, sanitize, type PresetId } from "../settings";
import { t, tk } from "../strings";
import type { EvoSettings, Settings } from "../types";
import { hoursText, num } from "../util";
import { warCreated } from "../bridge";
import { IBack, IChevron, IInfo, IPlus } from "./Icons";
import { modelLogo } from "./WarInfo";
import { EvolvedSettingsForm } from "./EvolvedSettings";
import { SettingsForm } from "./SettingsForm";
import { notify } from "./ui";

const PRESET_IDS: PresetId[] = ["standard", "short", "hard"];
type Model = "vanilla" | "evolved";
/** Mock only, for screenshots: `&model=evolved` picks the model, `&adv=1` opens Advanced. */
const mockQ = new URLSearchParams(isMock ? location.search : "");

export function CreateWar({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [model, setModel] = useState<Model>(mockQ.get("model") === "evolved" ? "evolved" : "vanilla");
  const [settings, setSettings] = useState<Settings>(PRESETS.standard);
  const [evo, setEvo] = useState<EvoSettings>(EVO_DEFAULTS);
  const [advanced, setAdvanced] = useState(mockQ.get("adv") === "1");
  const [busy, setBusy] = useState(false);
  const preset = presetOf(settings);

  const create = async () => {
    setBusy(true);
    try {
      const w = model === "evolved"
        ? await api.createWar({ name: name.trim() || t("warNamePh"), model: "evolved", evolved: sanitizeEvo(evo) })
        : await api.createWar({ name: name.trim() || t("warNamePh"), model: "vanilla", settings: sanitize(settings) });
      // Obsidian installs and enables the Evolved War Engine mod for an Evolved war.
      warCreated(w.id, w.name, model === "evolved" ? "evolved" : undefined);
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
      <form id="create-war" className="create-body" onSubmit={(e) => { e.preventDefault(); if (!busy) create(); }}>
        <section className="panel create-main">
          <label className="field">
            <span className="field-label">{t("warName")}</span>
            <input autoFocus maxLength={64} value={name} placeholder={t("warNamePh")} onChange={(e) => setName(e.target.value)} />
          </label>

          <div className="field">
            <span className="field-label">{t("model")}</span>
            <div className="model-cards" role="radiogroup" aria-label={t("model")}>
              <button type="button" role="radio" className={`model-card${model === "vanilla" ? " on" : ""}`} aria-checked={model === "vanilla"} onClick={() => setModel("vanilla")}>
                <span className="mc-logo vanilla"><img src={modelLogo("vanilla")} alt="" draggable={false} /></span>
                <span className="mc-text"><b className="cap">{t("modelVanilla")}</b><small>{t("modelVanillaText")}</small></span>
              </button>
              <button type="button" role="radio" className={`model-card${model === "evolved" ? " on" : ""}`} aria-checked={model === "evolved"} onClick={() => setModel("evolved")}>
                <span className="mc-logo evolved"><img src={modelLogo("evolved")} alt="" draggable={false} /></span>
                <span className="mc-text"><b className="cap">{t("modelEvolved")}</b><small>{t("modelEvolvedText")}</small></span>
              </button>
            </div>
          </div>

          {model === "evolved" && (
            <div className="info-box" role="note">
              <IInfo />
              <span><b>{t("evolvedModTitle")}</b>{t("evolvedModText")}</span>
            </div>
          )}

          {model === "vanilla" && (
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
            </div>
          )}

          <button type="button" className={`fold${advanced ? " open" : ""}`} aria-expanded={advanced} onClick={() => setAdvanced(!advanced)} data-tip={t("advancedLead")}>
            <IChevron /> <span className="cap">{t("advanced")}</span>
          </button>
          {advanced && (model === "evolved" ? <EvolvedSettingsForm value={evo} onChange={setEvo} /> : <SettingsForm value={settings} onChange={setSettings} />)}
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
