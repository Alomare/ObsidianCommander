// Shared pieces: the tooltip layer, dialogs, number fields, switches, segmented choices, notices.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties, type KeyboardEvent as RKey } from "react";
import { createPortal } from "react-dom";
import { t } from "../strings";
import { IClose } from "./Icons";

/* Tooltips: any element with data-tip (and an optional data-tip-title) shows one on hover or focus. */
export function TipLayer() {
  const [tip, setTip] = useState<{ title?: string; text: string; x: number; y: number; below: boolean } | null>(null);
  const el = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    let cur: Element | null = null;
    let timer = 0;
    const show = (target: Element | null) => {
      const host = target?.closest?.("[data-tip]") ?? null;
      if (host === cur) return;
      cur = host;
      clearTimeout(timer);
      if (!host) { setTip(null); return; }
      timer = window.setTimeout(() => {
        const r = host.getBoundingClientRect();
        const below = r.top < 80;
        setTip({ title: host.getAttribute("data-tip-title") ?? undefined, text: host.getAttribute("data-tip") ?? "", x: r.left + r.width / 2, y: below ? r.bottom : r.top, below });
      }, 350);
    };
    const over = (e: Event) => show(e.target as Element);
    const hide = () => { cur = null; clearTimeout(timer); setTip(null); };
    document.addEventListener("pointerover", over);
    document.addEventListener("focusin", over);
    document.addEventListener("pointerdown", hide);
    document.addEventListener("keydown", hide);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("pointerover", over);
      document.removeEventListener("focusin", over);
      document.removeEventListener("pointerdown", hide);
      document.removeEventListener("keydown", hide);
      window.removeEventListener("blur", hide);
    };
  }, []);

  useLayoutEffect(() => {
    if (!tip || !el.current) { setPos(null); return; }
    const w = el.current.offsetWidth, h = el.current.offsetHeight;
    const left = Math.max(6, Math.min(window.innerWidth - w - 6, tip.x - w / 2));
    const top = tip.below ? tip.y + 8 : tip.y - h - 8;
    setPos({ left, top });
  }, [tip]);

  if (!tip || (!tip.text && !tip.title)) return null;
  return createPortal(
    <div className="tip-layer">
      <div ref={el} className={`tip${tip.below ? " below" : ""}`} style={pos ?? { visibility: "hidden", left: 0, top: 0 }}>
        {tip.title && <b className="tip-title">{tip.title}</b>}
        {tip.text && <span>{tip.text}</span>}
      </div>
    </div>,
    document.body,
  );
}

/* A dialog over the page. Escape and the backdrop close it. */
/* `keep`: a click beside the dialog doesn't close it (a form with unsaved changes). Focus goes to the
   first field once, when the dialog opens; the page behind re-renders every second and must not move it. */
export function Modal({ title, onClose, children, foot, className = "", keep }: { title: ReactNode; onClose: () => void; children: ReactNode; foot?: ReactNode; className?: string; keep?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close.current(); } };
    window.addEventListener("keydown", k);
    const first = box.current?.querySelector<HTMLElement>("[data-autofocus], input, select, textarea, button.btn:not(:disabled)");
    (first ?? box.current)?.focus();
    return () => window.removeEventListener("keydown", k);
  }, []);
  return createPortal(
    <div className="modal-back" onPointerDown={(e) => { if (e.target === e.currentTarget && !keep) onClose(); }}>
      <div ref={box} className={`modal ${className}`} role="dialog" aria-modal="true" tabIndex={-1}>
        <div className="modal-head">
          <h2 className="cap">{title}</h2>
          <button className="bare close" onClick={onClose} aria-label={t("close")} data-tip={t("close")}><IClose /></button>
        </div>
        <div className="modal-body">{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* The confirming button is Obsidian's: gold for a go-ahead, red for something that can't be taken back.
   Cancel takes the focus, so Enter right after opening never confirms by accident. */
export function Confirm({ title, text, okLabel, danger, onOk, onClose, children }: { title: string; text: string; okLabel: string; danger?: boolean; onOk: () => void; onClose: () => void; children?: ReactNode }) {
  return (
    <Modal title={title} onClose={onClose} className="confirm" foot={<>
      <button className="btn" data-autofocus onClick={onClose}>{t("cancel")}</button>
      <button className={`btn ${danger ? "danger" : "play"}`} onClick={() => { onOk(); onClose(); }}>{okLabel}</button>
    </>}>
      <p className="lead">{text}</p>
      {children}
    </Modal>
  );
}

/* A button's menu: items run and close it; Escape, a click elsewhere, a scroll or leaving the window close it.
   It sits on the body, so a folded corner's mask can't cut it off. */
export type MenuItem = { label: string; icon?: ReactNode; danger?: boolean; disabled?: boolean; tip?: string; run: () => void };
export function MenuButton({ label, icon, items, className = "btn icon" }: { label: string; icon: ReactNode; items: MenuItem[]; className?: string }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ right: number; top: number } | null>(null);
  useEffect(() => {
    if (!at) return;
    const away = (e: PointerEvent) => {
      const el = e.target as Element;
      if (!el.closest?.(".menu") && !btn.current?.contains(el)) setAt(null);
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setAt(null); btn.current?.focus(); } };
    const gone = () => setAt(null);
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", gone);
    window.addEventListener("resize", gone);
    document.addEventListener("scroll", gone, true);
    (document.querySelector(".menu button:not(:disabled)") as HTMLElement | null)?.focus();
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", gone);
      window.removeEventListener("resize", gone);
      document.removeEventListener("scroll", gone, true);
    };
  }, [at]);
  const toggle = () => {
    if (at) { setAt(null); return; }
    const r = btn.current!.getBoundingClientRect();
    setAt({ right: Math.max(6, window.innerWidth - r.right), top: r.bottom + 4 });
  };
  const move = (e: RKey<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const all = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    all[(i + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
  };
  return (
    <>
      <button ref={btn} className={`${className}${at ? " open" : ""}`} aria-label={label} aria-haspopup="menu" aria-expanded={!!at} data-tip={at ? undefined : label} onClick={toggle}>{icon}</button>
      {at && createPortal(
        <div className="menu" role="menu" style={{ right: at.right, top: at.top }} onKeyDown={move}>
          {items.map((it) => (
            <button key={it.label} role="menuitem" className={it.danger ? "danger" : undefined} disabled={it.disabled} data-tip={it.tip}
              onClick={() => { setAt(null); it.run(); }}>
              {it.icon}<span>{it.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`sw${on ? " on" : ""}`} onClick={() => onChange(!on)} />;
}

export function Seg<T extends string | number>({ value, options, onChange, disabled, small }: { value: T; options: { v: T; label: string; tip?: string; disabled?: boolean }[]; onChange: (v: T) => void; disabled?: boolean; small?: boolean }) {
  return (
    <div className={`seg${small ? " small" : ""}`} role="radiogroup">
      {options.map((o) => (
        <button key={String(o.v)} type="button" role="radio" aria-checked={o.v === value} className={o.v === value ? "on" : ""} disabled={disabled || o.disabled} data-tip={o.tip} onClick={() => onChange(o.v)}>{o.label}</button>
      ))}
    </div>
  );
}

/** A number field that keeps its text while typing and commits on blur or Enter. */
export function NumberField({ value, min, max, step, onChange, suffix, width }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; suffix?: string; width?: string }) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(String(value)); }, [value]);
  const commit = () => {
    const v = Number(text.replace(/,/g, ""));
    if (Number.isFinite(v)) {
      const c = Math.min(max, Math.max(min, v));
      onChange(c);
      setText(String(c));
    } else setText(String(value));
  };
  return (
    <span className="num-field" style={width ? { width } : undefined}>
      <input type="number" inputMode="decimal" value={text} min={min} max={max} step={step}
        onFocus={() => { focused.current = true; }}
        onBlur={() => { focused.current = false; commit(); }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
      {suffix && <i>{suffix}</i>}
    </span>
  );
}

/* Notices at the bottom right. */
type Notice = { id: number; text: string; error?: boolean };
let notices: Notice[] = [];
let nid = 1;
const nsubs = new Set<(n: Notice[]) => void>();
export function notify(text: string, error = false) {
  const n = { id: nid++, text, error };
  notices = [...notices, n].slice(-4);
  nsubs.forEach((f) => f(notices));
  setTimeout(() => { notices = notices.filter((x) => x !== n); nsubs.forEach((f) => f(notices)); }, error ? 6000 : 3500);
}
export function Notices() {
  const [list, setList] = useState<Notice[]>(notices);
  useEffect(() => { nsubs.add(setList); return () => { nsubs.delete(setList); }; }, []);
  return (
    <div className="notices" aria-live="polite">
      {list.map((n) => <div key={n.id} className={`notice${n.error ? " error" : ""}`}><span>{n.text}</span></div>)}
    </div>
  );
}

export function Bar({ value, color, className = "", marks }: { value: number; color?: string; className?: string; marks?: number }) {
  return (
    <div className={`bar ${className}`} style={color ? ({ "--bc": color } as CSSProperties) : undefined}>
      <i style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
      {marks ? <div className="bar-marks">{Array.from({ length: marks - 1 }, (_, i) => <b key={i} style={{ left: `${((i + 1) / marks) * 100}%` }} />)}</div> : null}
    </div>
  );
}
