// The war info (logo, name, description) in the war list, and the one dialog that edits a war: the info on
// top, every rule under it. The settings button of the war view and Edit in the war list both open it.
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { sanitize } from "../settings";
import { t } from "../strings";
import type { Settings, War, WarSummary } from "../types";
import { IImport, ITrash, Skull } from "./Icons";
import { SettingsForm } from "./SettingsForm";
import { Modal, notify } from "./ui";

/** The skull of a war model: white for Vanilla, gold for Enhanced. */
export const ModelSkull = ({ model, size = 48 }: { model?: string | null; size?: number }) =>
  <Skull variant={model === "enhanced" ? "enhanced" : "vanilla"} width={size} height={size} />;

/** The logo of a war: the one the host chose, else the skull of the model. */
export function WarLogo({ war, className = "" }: { war: Pick<WarSummary, "logo" | "model">; className?: string }) {
  const own = !!war.logo;
  return (
    <span className={`war-logo${own ? " own" : ` model ${war.model === "enhanced" ? "enhanced" : "vanilla"}`} ${className}`}>
      {own ? <img src={war.logo} alt="" draggable={false} /> : <ModelSkull model={war.model} />}
    </span>
  );
}

const LOGO_SIZE = 256;
const DESCRIPTION_MAX = 600;

/** An image file shrunk to fit LOGO_SIZE, as a PNG data address (WebP when that is smaller). */
async function shrink(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, LOGO_SIZE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    if (!g) throw new Error("no canvas");
    g.imageSmoothingQuality = "high";
    g.drawImage(img, 0, 0, w, h);
    const png = c.toDataURL("image/png");
    const webp = c.toDataURL("image/webp", 0.92);
    return webp.startsWith("data:image/webp") && webp.length < png.length ? webp : png;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The war settings: info and rules, saved together. A war from the list may come without its settings;
    the dialog then loads the full war first. */
export function WarSettingsDialog({ war, onClose, onSaved }: { war: War | WarSummary; onClose: () => void; onSaved: (w: War) => void }) {
  const [full, setFull] = useState<War | null>("settings" in war && war.settings && "fronts" in war ? (war as War) : null);
  const [name, setName] = useState(war.name);
  const [description, setDescription] = useState(war.description ?? "");
  const [logo, setLogo] = useState(war.logo ?? "");
  const [settings, setSettings] = useState<Settings | null>(full?.settings ?? null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (full) return;
    let alive = true;
    api.getWar(war.id).then((w) => { if (alive) { setFull(w); setSettings(w.settings); } })
      .catch((e) => { if (alive) { notify(e instanceof Error ? e.message : String(e), true); close.current(); } });
    return () => { alive = false; };
  }, [full, war.id]);

  const infoDirty = name.trim() !== war.name || description.trim() !== (war.description ?? "") || logo !== (war.logo ?? "");
  const rulesDirty = !!full && !!settings && JSON.stringify(settings) !== JSON.stringify(full.settings);
  const dirty = infoDirty || rulesDirty;

  const pick = async (f: File) => {
    try { setLogo(await shrink(f)); } catch { notify(t("logoFailed"), true); }
  };
  const save = async () => {
    setBusy(true);
    try {
      const w = await api.patchWar(war.id, {
        ...(infoDirty ? { name: name.trim() || war.name, description: description.trim(), logo: logo || null } : {}),
        ...(rulesDirty && settings ? { settings: sanitize(settings) } : {}),
      });
      onSaved(w);
      onClose();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
      setBusy(false);
    }
  };

  return (
    <Modal title={t("warSettings")} onClose={onClose} className="settings-dialog" keep={dirty} foot={<>
      <button className="btn" onClick={onClose}>{t("cancel")}</button>
      <button className="btn play" disabled={busy || !dirty} onClick={save}>{t("save")}</button>
    </>}>
      <h3 className="form-group cap first">{t("warInfo")}</h3>
      <div className="field">
        <span className="field-label">{t("warLogo")}</span>
        <div className="logo-edit">
          <WarLogo war={{ logo, model: war.model }} className="big" />
          <div className="logo-side">
            <small>{logo ? t("warLogoText") : t("warLogoDefault")}</small>
            <div className="btn-row">
              <button type="button" className="btn small" onClick={() => file.current?.click()}><IImport />{t("chooseLogo")}</button>
              {logo && <button type="button" className="btn small danger-soft" onClick={() => setLogo("")}><ITrash />{t("removeLogo")}</button>}
            </div>
          </div>
        </div>
        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) pick(f); }} />
      </div>
      <label className="field">
        <span className="field-label">{t("warName")}</span>
        <input className="text-field" maxLength={64} value={name} placeholder={t("warNamePh")} autoComplete="off" spellCheck={false} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">{t("warDescription")}</span>
        <textarea className="text-field" rows={4} maxLength={DESCRIPTION_MAX} value={description} placeholder={t("warDescriptionPh")} onChange={(e) => setDescription(e.target.value)} />
        <small className="field-count">{description.length} / {DESCRIPTION_MAX}</small>
      </label>
      {settings ? <SettingsForm value={settings} onChange={setSettings} /> : <p className="muted">{t("loading")}</p>}
    </Modal>
  );
}
