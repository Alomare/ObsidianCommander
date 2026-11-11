// The Evolved war rules: used by Create War and by Settings on an Evolved war.
import { Fragment, useState } from "react";
import { api } from "../api";
import { EVO_FIELDS, evoPatch, sanitizeEvo, type EvoField } from "../evolved";
import { t, tk, type StringKey } from "../strings";
import type { EvoSettings, War } from "../types";
import { Modal, NumberField, Range, Switch, notify } from "./ui";

function unit(f: EvoField): string {
  if (f.kind === "hours") return t("hours");
  if (f.kind === "rate") return t("percentPerHour");
  if (f.key === "campaigns") return t("campaignsUnit");
  return t("missionsUnit");
}

export function EvolvedSettingsForm({ value, onChange }: { value: EvoSettings; onChange: (s: EvoSettings) => void }) {
  const groups: StringKey[] = ["evoGroupDirector", "evoGroupLiberation", "evoGroupDefense"];
  const set = (f: EvoField, v: number | boolean) => onChange({ ...value, [f.key]: v });
  return (
    <div className="settings-form">
      {groups.map((g) => (
        <Fragment key={g}>
          <h3 className="form-group cap">{t(g)}</h3>
          {EVO_FIELDS.filter((f) => f.group === g).map((f) => {
            const off = !!f.director && !value.director;
            const v = value[f.key];
            return (
              <div key={f.key} className={`set-row${off ? " off" : ""}`}>
                <div className="set-text">
                  <label className="set-name">{tk(`evoSet_${f.key}`)}</label>
                  <small>{tk(`evoSetText_${f.key}`)}</small>
                  {off && <small className="set-hint">{t("evoDirectorOff")}</small>}
                </div>
                <div className="set-ctl">
                  {f.kind === "bool"
                    ? <Switch on={!!v} onChange={(x) => set(f, x)} label={tk(`evoSet_${f.key}`)} />
                    : <>
                      <Range min={f.min} max={f.slide} step={f.step} value={Math.min(f.slide, Number(v))} disabled={off}
                        onChange={(x) => set(f, x)} label={tk(`evoSet_${f.key}`)} />
                      <NumberField value={Number(v)} min={f.min} max={f.max} step={f.step} onChange={(x) => set(f, f.kind === "int" ? Math.round(x) : x)} suffix={unit(f)} />
                    </>}
                </div>
              </div>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

/** Settings on an Evolved war: the name through PATCH, the rules through the evo_settings action. */
export function EvolvedSettingsDialog({ war, settings, onClose, onSaved }: { war: War; settings: EvoSettings; onClose: () => void; onSaved: (w: War) => void }) {
  const [name, setName] = useState(war.name);
  const [value, setValue] = useState<EvoSettings>(settings);
  const [busy, setBusy] = useState(false);
  const patch = evoPatch(settings, sanitizeEvo(value));
  const dirty = name.trim() !== war.name || Object.keys(patch).length > 0;
  const save = async () => {
    setBusy(true);
    try {
      let w = war;
      if (name.trim() && name.trim() !== war.name) w = await api.patchWar(war.id, { name: name.trim() });
      if (Object.keys(patch).length) w = await api.action(war.id, { action: "evo_settings", settings: patch });
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
      <EvolvedSettingsForm value={value} onChange={setValue} />
    </Modal>
  );
}
