// Create War: a name, the model, a preset, and every rule under Advanced.
import { useState } from "react";
import { api } from "../api";
import { PRESETS, presetOf, sanitize, type PresetId } from "../settings";
import { t, tk } from "../strings";
import type { Settings } from "../types";
import { hoursText, num } from "../util";
import { MiniMap } from "../map/MiniMap";
import { IBack, IChevron, IPlus } from "./Icons";
import { SettingsForm } from "./SettingsForm";
import { notify } from "./ui";

const PRESET_IDS: PresetId[] = ["standard", "short", "hard"];

export function CreateWar({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [settings, setSettings] = useState<Settings>(PRESETS.standard);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const preset = presetOf(settings);

  const create = async () => {
    setBusy(true);
    try {
      const w = await api.createWar({ name: name.trim() || t("warNamePh"), model: "vanilla", settings: sanitize(settings) });
      onCreated(w.id);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
      setBusy(false);
    }
  };

  return (
    <div className="page create-page">
      <header className="create-head">
        <button className="btn icon" onClick={onCancel} aria-label={t("back")} data-tip={t("back")}><IBack /></button>
        <h1 className="cap">{t("createTitle")}</h1>
      </header>
      <form className="create-body" onSubmit={(e) => { e.preventDefault(); if (!busy) create(); }}>
        <section className="panel create-main">
          <label className="field">
            <span className="field-label">{t("warName")}</span>
            <input autoFocus maxLength={64} value={name} placeholder={t("warNamePh")} onChange={(e) => setName(e.target.value)} />
          </label>

          <div className="field">
            <span className="field-label">{t("model")}</span>
            <div className="model-cards">
              <button type="button" className="model-card on" aria-pressed="true">
                <MiniMap fronts={[0, 1, 2].map((e) => ({ enemy: e as 0, points: settings.start_points, points_max: settings.points_max, points_taken: 0, status: "active", introduction_order: e, region: 0 }))} />
                <span className="mc-text"><b className="cap">{t("modelVanilla")}</b><small>{t("modelVanillaText")}</small></span>
              </button>
              <button type="button" className="model-card" disabled aria-disabled="true">
                <span className="mc-soon cap">{t("comingLater")}</span>
                <span className="mc-text"><b className="cap">{t("modelEvolved")}</b><small>{t("modelEvolvedText")}</small></span>
              </button>
            </div>
          </div>

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

          <button type="button" className={`fold${advanced ? " open" : ""}`} aria-expanded={advanced} onClick={() => setAdvanced(!advanced)} data-tip={t("advancedLead")}>
            <IChevron /> <span className="cap">{t("advanced")}</span>
          </button>
          {advanced && <SettingsForm value={settings} onChange={setSettings} />}
        </section>
        <footer className="create-foot">
          <button type="button" className="btn" onClick={onCancel}>{t("cancel")}</button>
          <button type="submit" className="btn play" disabled={busy}><IPlus />{busy ? t("creating") : t("create")}</button>
        </footer>
      </form>
    </div>
  );
}
