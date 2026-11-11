// Share: every way a war reaches other players, in one dialog: LAN, Internet (asked once more each time it
// opens, since the war then answers callers from anywhere who have the code) and the invite code.
import { useState } from "react";
import { t } from "../strings";
import type { War } from "../types";
import { copyText } from "../util";
import { IGlobe, ILan, IWarn } from "./Icons";
import { Modal, Switch, notify } from "./ui";

const DEFAULT_PORT = 17494;

export function ShareDialog({ war, setLan, onClose }: {
  war: War;
  /** Opens or closes the war to LAN, and to the internet; `newInvite` replaces the code. */
  setLan: (open: boolean, internet?: boolean, newInvite?: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const { open, internet = false, invite, port } = war.lan;
  const shown = port ?? DEFAULT_PORT;
  const copy = () => copyText(invite ?? "").then((ok) => notify(ok ? t("inviteCopied") : t("inviteCopyFailed"), !ok));

  return (
    <Modal title={t("shareTitle")} onClose={onClose} className="share-dialog" foot={<button className="btn" onClick={onClose}>{t("close")}</button>}>
      <div className={`share-row${open ? " on" : ""}`}>
        <ILan />
        <div className="share-text">
          <span className="share-name"><b>{t("lanShort")}</b><small>{open && port ? t("lanPort", { port }) : t("lanClosed")}</small></span>
          <p>{t("lanText")}</p>
        </div>
        <Switch on={open} onChange={(on) => { setAsking(false); setLan(on); }} label={t("lan")} />
      </div>

      <div className={`share-row${internet ? " on" : ""}`}>
        <IGlobe />
        <div className="share-text">
          <span className="share-name"><b>{t("internetShort")}</b><small>{internet ? t("internetOpen") : t("lanClosed")}</small></span>
          <p>{t("internetText", { port: shown })}</p>
        </div>
        <Switch on={internet || asking} onChange={(on) => (on ? setAsking(true) : (setAsking(false), setLan(true, false)))} label={t("internet")} />
      </div>

      {asking && !internet && (
        <div className="share-ask" role="alert">
          <IWarn />
          <div>
            <p>{t("internetAsk", { port: shown })}</p>
            <div className="btn-row">
              <button className="btn" onClick={() => setAsking(false)}>{t("cancel")}</button>
              <button className="btn go" onClick={() => setLan(true, true).then(() => setAsking(false))}><IGlobe />{t("internet")}</button>
            </div>
          </div>
        </div>
      )}

      {internet && invite && (
        <div className="share-invite">
          <span className="field-label">{t("invite")}</span>
          <div className="invite-box">
            <input className="invite-code" readOnly value={invite} aria-label={t("invite")} onFocus={(e) => e.currentTarget.select()} />
            <button className="btn go" onClick={copy}>{t("inviteCopy")}</button>
            <button className="btn" data-tip={t("inviteNewTip")} onClick={() => setLan(true, true, true)}>{t("inviteNew")}</button>
          </div>
          <p className="muted small">{t("inviteText")}</p>
        </div>
      )}

      <p className="share-note muted small">{t("shareNote")}</p>
    </Modal>
  );
}
