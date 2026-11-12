// Talking to Obsidian, which shows this page in an iframe (spec section 6). Only messages from the parent
// window count, and every field is checked before use.

import { useSyncExternalStore } from "react";
import { isMock } from "./api";
import { notify } from "./components/ui";
import { t } from "./strings";

export interface HostState {
  inObsidian: boolean;
  theme: "dark" | "light";
  lang: string;
  names: Record<string, string>;
  playing: string | null;
  gameRunning: boolean;
  /** Obsidian draws Import and New War in its own bar: the war list hides its own. */
  barTools: boolean;
}

const params = new URLSearchParams(location.search);
const embedded = window.parent !== window;

let state: HostState = {
  inObsidian: false,
  theme: params.get("theme") === "light" ? "light" : "dark",
  lang: "en",
  names: {},
  playing: isMock ? params.get("playing") : null,
  gameRunning: false,
  barTools: isMock && params.get("bartools") === "1",
};
const subs = new Set<() => void>();
function set(patch: Partial<HostState>) {
  state = { ...state, ...patch };
  document.documentElement.dataset.theme = state.theme;
  subs.forEach((f) => f());
}

const str = (v: unknown, max = 200): string | null => (typeof v === "string" && v.length <= max ? v : null);

function onMessage(e: MessageEvent) {
  if (!embedded || e.source !== window.parent) return;
  const d = e.data;
  if (!d || typeof d !== "object" || typeof d.type !== "string") return;
  const patch: Partial<HostState> = {};
  if ("playing" in d) patch.playing = d.playing === null ? null : str(d.playing, 64);
  if (typeof d.game_running === "boolean") patch.gameRunning = d.game_running;
  if (d.type === "obsidian:hello") {
    patch.inObsidian = true;
    if (d.theme === "dark" || d.theme === "light") patch.theme = d.theme;
    if (typeof d.bar_tools === "boolean") patch.barTools = d.bar_tools;
    const lang = str(d.lang, 16);
    if (lang) patch.lang = lang;
    if (d.names && typeof d.names === "object" && !Array.isArray(d.names)) {
      const names: Record<string, string> = {};
      for (const [k, v] of Object.entries(d.names)) {
        const s = str(v, 120);
        if (/^[a-z0-9_]{1,64}$/.test(k) && s) names[k] = s;
      }
      patch.names = names;
    }
    set(patch);
  } else if (d.type === "obsidian:state") {
    set(patch);
  } else if (d.type === "obsidian:home") {
    handlers?.home();
  } else if (d.type === "obsidian:create") {
    handlers?.create();
  } else if (d.type === "obsidian:import") {
    // Obsidian reads the file (a .json up to 16 MB) and hands over the text.
    const text = str(d.text, IMPORT_MAX);
    if (text !== null) handlers?.importText(text);
  }
}

const IMPORT_MAX = 16 * 1024 * 1024;

/** What runs when Obsidian asks for something: the war list (the Commander tab clicked while open), Create
    War and Import from the buttons in the Obsidian bar. */
export interface HostHandlers { home: () => void; create: () => void; importText: (text: string) => void }
let handlers: HostHandlers | null = null;
export function setHostHandlers(h: HostHandlers | null) {
  handlers = h;
}

/** This page takes `bar_tools`, `obsidian:create` and `obsidian:import`: Obsidian shows Import and New War in
    its bar only for a page that says so. */
const TOOLS = 1;

/** Tells Obsidian which screen shows, so Obsidian keeps the row of buttons it draws under the war list only. */
export function reportView(page: "list" | "create" | "war") {
  post({ type: "commander:view", page, tools: TOOLS });
}

function post(msg: Record<string, unknown>) {
  if (embedded) window.parent.postMessage(msg, "*");
}

export function startBridge() {
  document.documentElement.dataset.theme = state.theme;
  window.addEventListener("message", onMessage);
  post({ type: "commander:ready", tools: TOOLS });
}

export function useHost(): HostState {
  return useSyncExternalStore(
    (f) => { subs.add(f); return () => subs.delete(f); },
    () => state,
  );
}

/** True when a Play press reaches someone: Obsidian, or the mock. */
export const canPlay = () => embedded || isMock;

/** The war model for Obsidian: "enhanced" switches on the companion mod. A Vanilla war sends no `model`
    field, so older launchers get the same messages as before. */
export type PlayModel = "enhanced" | undefined;
export const playModel = (model: string | undefined | null): PlayModel => (model === "enhanced" ? "enhanced" : undefined);

export function play(war: string, name: string, model?: PlayModel) {
  if (!canPlay()) { notify(t("playOutside")); return; }
  post({ type: "commander:play", war, name, ...(model ? { model } : {}) });
  if (isMock && !embedded) set({ playing: war, gameRunning: true });
}
export function selectWar(war: string, name: string, model?: PlayModel) {
  post({ type: "commander:select", war, name, ...(model ? { model } : {}) });
  if (isMock && !embedded) set({ playing: war });
}
/** A war was made here. For an Enhanced war, Obsidian sets up the Enhanced War Client mod; older launchers
    ignore the message. */
export function warCreated(war: string, name: string, model?: PlayModel) {
  post({ type: "commander:created", war, name, ...(model ? { model } : {}) });
}
/** A war opened to LAN or closed. On Linux, Obsidian offers to open the LAN ports in a firewall that
    shuts them; older launchers ignore the message. */
export function lanChanged(open: boolean) {
  post({ type: "commander:lan", open });
}
export function officialWar() {
  post({ type: "commander:official" });
  if (isMock && !embedded) set({ playing: null, gameRunning: false });
}
export function setThemeForDev(theme: "dark" | "light") {
  set({ theme });
}
