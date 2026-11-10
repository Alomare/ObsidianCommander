import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { FeedEntry, Snapshot, War } from "./types";

const POLL_MS = 2500;
const HISTORY_MS = 30000;

/** The war, its feed and history, polled with cheap GETs while the page is visible. */
export function useWarData(id: string) {
  const [war, setWar] = useState<War | null>(null);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0); // server time minus local time, seconds
  const lastFeed = useRef<number | undefined>(undefined);
  const lastHistory = useRef(0);

  const loadWar = useCallback(async () => {
    try {
      const w = await api.getWar(id);
      setWar(w);
      setOffset(w.server_time - Date.now() / 1000);
      setError(null);
      return w;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [id]);

  const loadFeed = useCallback(async () => {
    try {
      const items = await api.feed(id, lastFeed.current, 200);
      if (items.length) {
        lastFeed.current = items[items.length - 1].id;
        setFeed((old) => {
          const seen = new Set(old.map((e) => e.id));
          const merged = [...old, ...items.filter((e) => !seen.has(e.id))];
          return merged.slice(-500);
        });
      }
    } catch { /* the war poll reports errors */ }
  }, [id]);

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await api.history(id));
      lastHistory.current = Date.now();
    } catch { /* optional */ }
  }, [id]);

  useEffect(() => {
    setWar(null); setFeed([]); setHistory([]); lastFeed.current = undefined;
    let alive = true;
    let timer = 0;
    const run = async () => {
      if (!document.hidden) {
        await Promise.all([loadWar(), loadFeed()]);
        if (Date.now() - lastHistory.current > HISTORY_MS) await loadHistory();
      }
      if (alive) timer = window.setTimeout(run, POLL_MS);
    };
    run();
    return () => { alive = false; clearTimeout(timer); };
  }, [id, loadWar, loadFeed, loadHistory]);

  /** After an action: the answer is the new war; feed and history follow at once. */
  const accept = useCallback((w: War) => {
    setWar(w);
    setOffset(w.server_time - Date.now() / 1000);
    loadFeed();
    loadHistory();
  }, [loadFeed, loadHistory]);

  return { war, feed, history, error, offset, accept, reload: loadWar };
}

/** The clock, ticking each `ms`. */
export function useNow(ms = 1000): number {
  const [n, setN] = useState(Date.now());
  useEffect(() => {
    const i = setInterval(() => setN(Date.now()), ms);
    return () => clearInterval(i);
  }, [ms]);
  return n;
}

/** A number that eases to its new value instead of jumping. */
export function useTween(target: number, ms = 700): number {
  const [v, setV] = useState(target);
  const from = useRef(target);
  const cur = useRef(target);
  useEffect(() => {
    from.current = cur.current;
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      cur.current = from.current + (target - from.current) * e;
      setV(cur.current);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    if (document.documentElement.dataset.motion === "off" || Math.abs(target - cur.current) < 1e-9) {
      cur.current = target; setV(target);
    } else raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}
