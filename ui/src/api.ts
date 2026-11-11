// The admin API client (docs/spec-m1.md, section 5). `?mock=1` swaps in the fake server in mock.ts.

import type { EvoSettings, FeedEntry, GmAction, Info, Settings, Snapshot, War } from "./types";

export interface Api {
  info(): Promise<Info>;
  createWar(body: { name: string; model: "vanilla" | "evolved"; settings?: Partial<Settings>; evolved?: Partial<EvoSettings> }): Promise<War>;
  getWar(id: string): Promise<War>;
  patchWar(id: string, body: { name?: string; description?: string; logo?: string | null; settings?: Partial<Settings> }): Promise<War>;
  deleteWar(id: string): Promise<void>;
  action(id: string, body: GmAction): Promise<War>;
  feed(id: string, after?: number, limit?: number): Promise<FeedEntry[]>;
  history(id: string, from?: number): Promise<Snapshot[]>;
  /** Opens or closes a war to the local network; `internet` also lets callers from outside reach it. */
  lan(id: string, open: boolean, internet?: boolean): Promise<{ open: boolean; port: number | null; internet?: boolean }>;
  exportWar(id: string): Promise<Blob>;
  importWar(file: unknown): Promise<War>;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// The token comes once in the URL; it then leaves the address bar and stays for the life of this page.
const params = new URLSearchParams(location.search);
let token: string | null = params.get("token");
try {
  if (token) sessionStorage.setItem("commander-token", token);
  else token = sessionStorage.getItem("commander-token");
} catch { /* storage blocked: the token lives in memory only */ }
if (params.has("token")) {
  params.delete("token");
  const q = params.toString();
  history.replaceState(null, "", location.pathname + (q ? `?${q}` : "") + location.hash);
}

export const hasToken = () => !!token;
export const isMock = new URLSearchParams(location.search).get("mock") === "1";

async function call<T>(method: string, path: string, body?: unknown, raw = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers["X-Commander-Token"] = token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = j.error ?? j.message ?? j.error_message ?? msg;
    } catch { /* not JSON */ }
    throw new ApiError(res.status, msg);
  }
  if (raw) return (await res.blob()) as T;
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const enc = encodeURIComponent;

/** The server may answer a list bare or wrapped; take either. */
function listOf<T>(v: unknown, ...keys: string[]): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === "object") {
    for (const k of keys) {
      const x = (v as Record<string, unknown>)[k];
      if (Array.isArray(x)) return x as T[];
    }
  }
  return [];
}

function normSnapshot(s: any): Snapshot {
  let data = s?.data;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { data = []; }
  }
  return { time: Number(s?.time) || 0, season: s?.season, data: Array.isArray(data) ? data : [] };
}

const http: Api = {
  info: () => call("GET", "api/info"),
  createWar: (b) => call("POST", "api/wars", b),
  getWar: (id) => call("GET", `api/wars/${enc(id)}`),
  patchWar: (id, b) => call("PATCH", `api/wars/${enc(id)}`, b),
  deleteWar: (id) => call("DELETE", `api/wars/${enc(id)}`),
  action: (id, b) => call("POST", `api/wars/${enc(id)}/actions`, b),
  feed: async (id, after, limit = 200) => {
    const q = new URLSearchParams();
    if (after != null) q.set("after", String(after));
    q.set("limit", String(limit));
    return listOf<FeedEntry>(await call("GET", `api/wars/${enc(id)}/feed?${q}`), "feed", "entries", "items");
  },
  history: async (id, from) => {
    const q = from != null ? `?from=${from}` : "";
    return listOf(await call("GET", `api/wars/${enc(id)}/history${q}`), "snapshots", "history").map(normSnapshot);
  },
  lan: (id, open, internet) => call("POST", `api/wars/${enc(id)}/lan`, internet === undefined ? { open } : { open, internet }),
  exportWar: (id) => call("GET", `api/wars/${enc(id)}/export`, undefined, true),
  importWar: (file) => call("POST", "api/wars/import", file),
};

let impl: Api = http;
export async function initApi(): Promise<void> {
  if (isMock) impl = (await import("./mock")).mockApi;
}
export const api: Api = new Proxy({} as Api, { get: (_t, k) => (impl as any)[k] });
