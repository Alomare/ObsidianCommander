// The war info: the logo, the name and the description, in the war list and in a dialog to edit them.
import { useRef, useState } from "react";
import { api } from "../api";
import { t } from "../strings";
import type { War, WarSummary } from "../types";
import hd1Logo from "../assets/logo-hd1.png";
import hd2Logo from "../assets/logo-hd2.png";
import { IImport, ITrash } from "./Icons";
import { Modal, notify } from "./ui";

/** The picture of a war model: the HELLDIVERS logo for Vanilla, the HELLDIVERS 2 logo for Evolved. */
export const modelLogo = (model?: string | null) => (model === "evolved" ? hd2Logo : hd1Logo);

/** The logo of a war: the one the host chose, else the logo of the model. */
export function WarLogo({ war, className = "" }: { war: Pick<WarSummary, "logo" | "model">; className?: string }) {
  const own = !!war.logo;
  return (
    <span className={`war-logo${own ? " own" : ` model ${war.model === "evolved" ? "evolved" : "vanilla"}`} ${className}`}>
      <img src={own ? war.logo : modelLogo(war.model)} alt="" draggable={false} />
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

export function WarInfoDialog({ war, onClose, onSaved }: { war: War | WarSummary; onClose: () => void; onSaved: (w: War) => void }) {
  const [name, setName] = useState(war.name);
  const [description, setDescription] = useState(war.description ?? "");
  const [logo, setLogo] = useState(war.logo ?? "");
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const dirty = name.trim() !== war.name || description.trim() !== (war.description ?? "") || logo !== (war.logo ?? "");

  const pick = async (f: File) => {
    try { setLogo(await shrink(f)); } catch { notify(t("logoFailed"), true); }
  };
  const save = async () => {
    setBusy(true);
    try {
      const w = await api.patchWar(war.id, { name: name.trim() || war.name, description: description.trim(), logo: logo || null });
      notify(t("infoSaved"));
      onSaved(w);
      onClose();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
      setBusy(false);
    }
  };

  return (
    <Modal title={t("editInfo")} onClose={onClose} className="info-dialog" keep={dirty} foot={<>
      <button className="btn" onClick={onClose}>{t("cancel")}</button>
      <button className="btn play" disabled={busy || !dirty} onClick={save}>{t("save")}</button>
    </>}>
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
        <input maxLength={64} value={name} placeholder={t("warNamePh")} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">{t("warDescription")}</span>
        <textarea className="text-field" rows={4} maxLength={DESCRIPTION_MAX} value={description} placeholder={t("warDescriptionPh")} onChange={(e) => setDescription(e.target.value)} />
        <small className="field-count">{description.length} / {DESCRIPTION_MAX}</small>
      </label>
    </Modal>
  );
}
