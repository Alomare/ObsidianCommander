// A fake Commander server in the browser, for `npm run dev` with `?mock=1`. It follows the Vanilla rules of
// spec section 4 loosely and runs fast (a real second is a war minute) so changes show while developing.

import type { Api } from "./api";
import { ApiError } from "./api";
import type { Enemy, EvoCampaign, EvoSettings, Evolved, FeedEntry, Front, GmAction, Member, OrderKind, Settings, Snapshot, War, WarEvent } from "./types";
import { DEFAULT_SETTINGS } from "./settings";
import { EVO_DEFAULTS, EVO_FIELDS } from "./evolved";
import { NEIGHBOURS, PLANETS, RIM, SECTORS, START_OWNERS } from "./map/galaxy";
import evoFixture from "./mock-evolved.json";

const ACCEL = 60; // war seconds per real second at speed 1, in the mock only
interface MockWar { war: War; feed: FeedEntry[]; history: Snapshot[]; nextFeed: number; nextEvent: number; lastSnap: number; evoNext: number }
const wars = new Map<string, MockWar>();
const now = () => Date.now() / 1000;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const regionOf = (p: number, max: number) => clamp(Math.floor(p / (max / 10)) + 1, 1, 10);

let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];

const NAMES = ["redshift", "Maru", "Okonkwo", "lowflyer", "Brannigan", "sable", "J. Varga", "teapot"];
const playerId = (i: number) => (0x110000100000000n + BigInt(i * 7919 + 1066537)).toString(16);

function makeFront(enemy: Enemy, points: number, s: Settings, status: Front["status"] = "active"): Front {
  return { enemy, points, points_max: s.points_max, points_taken: 0, status, introduction_order: enemy, region: regionOf(points, s.points_max), pressure_per_hour: s.pressure_per_hour };
}

function addFeed(m: MockWar, e: Omit<FeedEntry, "id" | "time" | "war_time">, at = now()) {
  m.feed.push({ id: m.nextFeed++, time: Math.floor(at), war_time: m.war.war_time, ...e });
  if (m.feed.length > 2000) m.feed.splice(0, m.feed.length - 2000);
}
function snap(m: MockWar, at = now()) {
  m.history.push({ time: Math.floor(at), season: m.war.season, data: m.war.fronts.map((f) => ({ points: Math.round(f.points), points_taken: f.points_taken, status: f.status })) });
  m.lastSnap = at;
}

function newWar(name: string, s: Settings, id?: string): MockWar {
  const war: War = {
    id: id ?? Math.random().toString(36).slice(2, 8), name, description: "", logo: "", model: "vanilla", season: 1,
    created: Math.floor(now()), state: "running", war_time: 0, speed: 1,
    fronts: [0, 1, 2].map((e) => makeFront(e as Enemy, s.start_points, s)),
    defend_event: null, attack_events: [],
    statistics: [0, 1, 2].map((e) => ({ enemy: e as Enemy, missions: 0, successful_missions: 0, kills: 0, deaths: 0, shots: 0, hits: 0, accidentals: 0, players: 0, completed_planets: 0 })),
    members: [], settings: { ...s }, lan: { open: false, port: null }, server_time: Math.floor(now()),
  };
  const m: MockWar = { war, feed: [], history: [], nextFeed: 1, nextEvent: 1, lastSnap: 0, evoNext: 1 };
  addFeed(m, { kind: "war", text_key: "war_created", player: "gm" });
  snap(m);
  wars.set(war.id, m);
  return m;
}

function setPoints(m: MockWar, f: Front, points: number, who: string | null) {
  const before = f.region;
  f.points = clamp(points, 0, f.points_max);
  f.region = regionOf(f.points, f.points_max);
  if (f.region !== before) {
    const up = f.region > before;
    addFeed(m, { kind: "region", front: f.enemy, region: f.region, player: who, text_key: up ? "region_liberated" : "region_lost" });
    snap(m);
  }
  if (f.points >= f.points_max && !m.war.attack_events.some((e) => e.enemy === f.enemy && e.status === "active")) startAttack(m, f.enemy, m.war.settings.attack_duration, m.war.settings.attack_points);
  if (f.points <= 0 && !m.war.defend_event) startDefend(m, f.enemy, 0, m.war.settings.defend_duration, m.war.settings.defend_points);
}

function startDefend(m: MockWar, enemy: Enemy, region: number, duration: number, pmax: number) {
  const t = now();
  m.war.defend_event = { event_id: m.nextEvent++, enemy, region, points: 0, points_max: pmax, start_time: Math.floor(t), end_time: Math.floor(t + duration / ACCEL * 6), status: "active" };
  addFeed(m, { kind: "event", front: enemy, region, event_id: m.war.defend_event.event_id, text_key: "defend_started" });
  snap(m);
}
function startAttack(m: MockWar, enemy: Enemy, duration: number, pmax: number) {
  const t = now();
  const ev: WarEvent = { event_id: m.nextEvent++, enemy, region: 11, points: 0, points_max: pmax, start_time: Math.floor(t), end_time: Math.floor(t + duration / ACCEL * 6), status: "active", players_at_start: m.war.members.length };
  m.war.attack_events.push(ev);
  addFeed(m, { kind: "event", front: enemy, region: 11, event_id: ev.event_id, text_key: "attack_started" });
}

function endEvent(m: MockWar, ev: WarEvent, ok: boolean) {
  const f = m.war.fronts[ev.enemy];
  const s = m.war.settings;
  ev.status = ok ? "success" : "fail";
  const isAttack = ev.region === 11;
  addFeed(m, { kind: "event", front: ev.enemy, region: ev.region, event_id: ev.event_id, text_key: `${isAttack ? "attack" : "defend"}_${ok ? "success" : "fail"}` });
  if (isAttack) {
    m.war.attack_events = m.war.attack_events.filter((e) => e !== ev);
    if (ok) {
      f.status = "defeated";
      addFeed(m, { kind: "front", front: f.enemy, text_key: "front_defeated" });
      if (m.war.fronts.every((x) => x.status !== "active")) { m.war.state = "won"; addFeed(m, { kind: "season", text_key: "season_won" }); }
    } else setPoints(m, f, f.points_max * 0.8, null);
  } else {
    m.war.defend_event = null;
    if (ev.region === 0) {
      if (ok) setPoints(m, f, f.points_max / 10, null);
      else { m.war.state = "lost"; addFeed(m, { kind: "season", text_key: "season_lost" }); }
    } else if (ok) setPoints(m, f, f.points + s.defend_reward, null);
    else setPoints(m, f, f.points - f.points_max / 10, null);
  }
  snap(m);
}

function member(m: MockWar): Member {
  if (m.war.members.length < 6 && (m.war.members.length === 0 || rnd() < 0.04)) {
    const i = m.war.members.length;
    const mem: Member = { player: playerId(i), name: NAMES[i % NAMES.length], first_seen: Math.floor(now()), last_seen: Math.floor(now()), missions: 0 };
    m.war.members.push(mem);
    addFeed(m, { kind: "member", player: mem.name ?? mem.player, text_key: "member_joined" });
    return mem;
  }
  return pick(m.war.members);
}

function tick() {
  const t = now();
  for (const m of wars.values()) {
    const w = m.war;
    w.server_time = Math.floor(t);
    if (w.state !== "running") continue;
    const dt = w.speed * ACCEL;
    w.war_time += dt;
    if (w.evolved) {
      evoTick(m, dt);
      if (t - m.lastSnap > 10) snap(m, t);
      continue;
    }
    for (const f of w.fronts) {
      if (f.status !== "active") continue;
      const busy = w.defend_event?.enemy === f.enemy || w.attack_events.some((e) => e.enemy === f.enemy);
      if (!busy) setPoints(m, f, f.points - (w.settings.pressure_per_hour * dt) / 3600, null);
    }
    if (rnd() < 0.16 * w.speed) {
      const active = w.fronts.filter((f) => f.status === "active");
      if (active.length) {
        const mem = member(m);
        mem.missions++; mem.last_seen = Math.floor(t);
        const ev = w.defend_event && rnd() < 0.6 ? w.defend_event : w.attack_events.length && rnd() < 0.6 ? w.attack_events[0] : null;
        const d = 1 + Math.floor(rnd() * 8);
        const st = w.statistics[ev ? ev.enemy : pick(active).enemy];
        st.missions++; st.successful_missions += rnd() < 0.8 ? 1 : 0; st.kills += Math.floor(rnd() * 300); st.deaths += Math.floor(rnd() * 5); st.accidentals += rnd() < 0.3 ? 1 : 0;
        st.players = Math.max(st.players, Math.min(w.members.length, 4));
        if (ev) {
          const v = d * (ev.region === 11 ? w.settings.attack_mission_value : w.settings.defend_mission_value);
          ev.points = Math.min(ev.points_max, ev.points + v);
          addFeed(m, { kind: "mission", front: ev.enemy, region: ev.region, event_id: ev.event_id, player: mem.name ?? mem.player, value: v, text_key: ev.region === 11 ? "attack_mission_completed" : "defend_mission_completed" });
          if (ev.points >= ev.points_max) endEvent(m, ev, true);
        } else {
          const f = w.fronts[st.enemy];
          const v = d * w.settings.planet_value;
          st.completed_planets++;
          addFeed(m, { kind: "mission", front: f.enemy, region: f.region, player: mem.name ?? mem.player, value: v, text_key: "planet_completed" });
          setPoints(m, f, f.points + v, mem.name ?? mem.player);
        }
      }
    }
    if (w.defend_event && t >= w.defend_event.end_time) endEvent(m, w.defend_event, false);
    for (const ev of [...w.attack_events]) if (t >= ev.end_time) endEvent(m, ev, false);
    if (w.settings.director && !w.defend_event && rnd() < (w.settings.defend_chance_per_hour * dt) / 3600) {
      const f = pick(w.fronts.filter((x) => x.status === "active"));
      if (f) startDefend(m, f.enemy, f.region, w.settings.defend_duration, w.settings.defend_points);
    }
    if (t - m.lastSnap > 10) snap(m, t);
  }
}

// ---------------------------------------------------------------- Evolved wars, loosely after server/src/evolved.rs

const FACTION = ["Super Earth", "Bug", "Cyborg", "Illuminate"];
const ADJ = ["Swift", "Iron", "Silent", "Burning", "Righteous", "Steel", "Crimson", "Bright", "Valiant", "Patient", "Lawful", "Steadfast"];
const NOUN = ["Hammer", "Vigil", "Spear", "Liberty", "Anvil", "Lance", "Bastion", "Tide", "Dawn", "Verdict", "Charter", "Torch"];
const round2 = (v: number) => Math.round(v * 100) / 100;
const pname = (p: number) => PLANETS[p]?.name ?? "";
const bad = (msg: string) => new ApiError(400, msg);

function evo(m: MockWar): Evolved {
  if (!m.war.evolved) throw bad("not an Evolved war");
  return m.war.evolved;
}
function evoNews(m: MockWar, kind: string, text: string, planet: number | null = null) {
  const e = evo(m);
  e.news.unshift({ id: m.evoNext++, time: Math.floor(now()), war_time: m.war.war_time, kind, text, planet });
  e.news.length = Math.min(e.news.length, 15);
}

function newEvolvedWar(name: string, settings: EvoSettings, id?: string): MockWar {
  const m = newWar(name, DEFAULT_SETTINGS, id);
  m.war.model = "evolved";
  m.war.evolved = {
    galaxy: "hd2", galaxy_version: 1, owners: [...START_OWNERS], campaigns: [], orders: [], news: [],
    stats: { missions_won: 0, missions_lost: 0, operations: 0, kills: 0, deaths: 0, liberated: 0, lost: 0, defended: 0 }, settings: { ...settings },
  };
  evoNews(m, "war", "The Galactic War has begun. Super Earth calls every Helldiver to the front.");
  evoDirect(m);
  return m;
}

function fillOps(m: MockWar, c: EvoCampaign) {
  const p = PLANETS[c.planet];
  const base = 3 + Math.round((Math.hypot(p.x, p.y) / RIM) * 8) + (c.kind === "defense" ? 1 : 0);
  for (const off of [-2, 0, 2]) {
    if (c.operations.length >= 3) break;
    const difficulty = Math.min(15, Math.max(1, base + off));
    if (c.operations.some((o) => o.difficulty === difficulty)) continue;
    const n = difficulty <= 3 ? 2 : difficulty <= 6 ? 2 + Math.floor(rnd() * 2) : 3;
    c.operations.push({
      id: m.evoNext++, name: `Operation ${pick(ADJ)} ${pick(NOUN)}`, difficulty,
      lat: round2(-55 + 110 * rnd()), lon: round2(-180 + 360 * rnd()), seed: 1 + Math.floor(rnd() * 1000), variant: Math.floor(rnd() * 3), shading: Math.floor(rnd() * 3),
      missions: Array.from({ length: n }, () => ({ kind: difficulty >= 4 && rnd() < 0.2 ? 2 : 0, random: Math.floor(rnd() * 2147483646), tod: Math.floor(rnd() * 4), done: false })),
    });
  }
  c.operations.sort((a, b) => a.difficulty - b.difficulty);
}

function startLiberation(m: MockWar, planet: number) {
  const e = evo(m);
  const owner = e.owners[planet];
  if (owner === 0) throw bad(`${pname(planet)} is held by Super Earth`);
  if (e.campaigns.some((c) => c.planet === planet)) throw bad(`${pname(planet)} already has a campaign`);
  const c: EvoCampaign = {
    id: m.evoNext++, planet, kind: "liberation", faction: owner, liberation: 0, defense: 0, ends_in: null,
    regen_per_hour: e.settings.regen_per_hour, per_mission: round2(100 / e.settings.liberation_missions), missions_won: 0, missions_lost: 0, operations: [],
  };
  e.campaigns.push(c);
  evoNews(m, "campaign", `Liberation of ${pname(planet)} begins. Drive the ${FACTION[owner]} forces out of the ${SECTORS[PLANETS[planet].sector].name} sector.`, planet);
  fillOps(m, c);
}

function startDefense(m: MockWar, planet: number, faction: number, hours: number) {
  const e = evo(m);
  if (!(faction >= 1 && faction <= 3)) throw bad("`faction` must be 1 (bugs), 2 (cyborgs) or 3 (illuminates)");
  if (e.owners[planet] !== 0) throw bad(`${pname(planet)} isn't held by Super Earth`);
  if (e.campaigns.some((c) => c.planet === planet)) throw bad(`${pname(planet)} already has a campaign`);
  const c: EvoCampaign = {
    id: m.evoNext++, planet, kind: "defense", faction, liberation: 0, defense: 0, ends_in: Math.round((hours * 3600) / m.war.speed),
    regen_per_hour: 0, per_mission: round2(100 / e.settings.defense_missions), missions_won: 0, missions_lost: 0, operations: [],
  };
  e.campaigns.push(c);
  evoNews(m, "attack", `${FACTION[faction]} forces attack ${pname(planet)}. Hold the planet for ${Math.round(hours)} hours.`, planet);
  fillOps(m, c);
}

const dropCampaign = (e: Evolved, planet: number) => { e.campaigns = e.campaigns.filter((c) => c.planet !== planet); };

function liberate(m: MockWar, planet: number) {
  const e = evo(m);
  const from = e.owners[planet];
  e.owners[planet] = 0;
  dropCampaign(e, planet);
  e.stats.liberated++;
  evoNews(m, "liberated", PLANETS[planet].home ? `${pname(planet)} has fallen. The ${FACTION[from]} home world is liberated.` : `${pname(planet)} is liberated from the ${FACTION[from]} forces.`, planet);
}
function lose(m: MockWar, planet: number, faction: number) {
  const e = evo(m);
  e.owners[planet] = faction;
  dropCampaign(e, planet);
  e.stats.lost++;
  evoNews(m, "lost", `${pname(planet)} has fallen to the ${FACTION[faction]} forces.`, planet);
}
function defended(m: MockWar, c: EvoCampaign) {
  const e = evo(m);
  dropCampaign(e, c.planet);
  e.stats.defended++;
  evoNews(m, "defended", `${pname(c.planet)} holds. The ${FACTION[c.faction]} attack is broken.`, c.planet);
}

function checkOrders(m: MockWar) {
  const e = evo(m);
  for (const o of e.orders) {
    if (o.state !== "active") continue;
    if (o.kind !== "missions") {
      const held = o.planets.filter((p) => e.owners[p] === 0).length;
      o.target = o.planets.length;
      o.progress = held;
      if (o.kind === "liberate") o.state = held === o.planets.length ? "won" : o.ends_in <= 0 ? "failed" : "active";
      else o.state = held < o.planets.length ? "failed" : o.ends_in <= 0 ? "won" : "active";
    } else o.state = o.progress >= o.target ? "won" : o.ends_in <= 0 ? "failed" : "active";
    if (o.state === "won") evoNews(m, "order", `Major Order complete: ${o.brief} Super Earth thanks every Helldiver.`);
    if (o.state === "failed") evoNews(m, "order", `Major Order failed: ${o.brief}`);
  }
}

function issueOrder(m: MockWar, kind: OrderKind, planets: number[], faction: number, target: number, hours: number, brief: string | undefined, by: string) {
  const e = evo(m);
  if ((kind === "liberate" || kind === "defend") && planets.length === 0) throw bad("the order needs at least one planet");
  if (kind === "missions" && !(target >= 1 && target <= 100000)) throw bad("`target` must be between 1 and 100000 missions");
  if (!(hours >= 1 && hours <= 2000)) throw bad("`hours` must be between 1 and 2000");
  const names = planets.map(pname);
  const list = names.length <= 1 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const text = brief?.trim() || (kind === "liberate" ? `Liberate ${list}.` : kind === "defend" ? `Hold ${list} against every attack.`
    : `Win ${Math.round(target)} missions against the ${faction ? FACTION[faction] : "enemy"} forces.`);
  e.orders.unshift({ id: m.evoNext++, kind, brief: text.slice(0, 240), planets, faction, progress: 0, target: kind === "missions" ? Math.round(target) : planets.length,
    ends_in: Math.round((hours * 3600) / m.war.speed), state: "active", by });
  e.orders.length = Math.min(e.orders.length, 6);
  evoNews(m, "order", `New Major Order: ${text}`);
  checkOrders(m);
}

/** The director: liberation campaigns up to the setting, now and then an attack, an order when none runs. */
function evoDirect(m: MockWar) {
  const e = evo(m);
  for (let guard = 0; guard < 12; guard++) {
    const lib = e.campaigns.filter((c) => c.kind === "liberation");
    if (lib.length >= e.settings.campaigns) break;
    const front = PLANETS.filter((p) => e.owners[p.id] !== 0 && !e.campaigns.some((c) => c.planet === p.id) && NEIGHBOURS[p.id].some((q) => e.owners[q] === 0)).map((p) => p.id);
    if (!front.length) break;
    const busy = new Set(lib.map((c) => c.faction));
    const fresh = front.filter((p) => !busy.has(e.owners[p]) && !PLANETS[p].home);
    startLiberation(m, pick(fresh.length ? fresh : front));
  }
  if (rnd() < 0.003 * m.war.speed) {
    const f = 1 + Math.floor(rnd() * 3);
    const exposed = PLANETS.filter((p) => p.id !== 0 && e.owners[p.id] === 0 && !e.campaigns.some((c) => c.planet === p.id) && NEIGHBOURS[p.id].some((q) => e.owners[q] === f)).map((p) => p.id);
    if (exposed.length && !e.campaigns.some((c) => c.kind === "defense" && c.faction === f)) startDefense(m, pick(exposed), f, e.settings.defense_hours);
  }
  if (!e.orders.some((o) => o.state === "active")) {
    const lib = e.campaigns.filter((c) => c.kind === "liberation");
    if (lib.length) issueOrder(m, "liberate", [pick(lib).planet], 0, 0, e.settings.order_hours, undefined, "director");
  }
}

function evoMission(m: MockWar, c: EvoCampaign, won: boolean) {
  const e = evo(m);
  const op = c.operations.find((o) => o.missions.some((x) => !x.done));
  if (!op) return;
  const mem = member(m);
  mem.missions++; mem.last_seen = Math.floor(now());
  e.stats.kills += 20 + Math.floor(rnd() * 260);
  e.stats.deaths += Math.floor(rnd() * 4);
  if (!won) { e.stats.missions_lost++; c.missions_lost++; return; }
  e.stats.missions_won++; c.missions_won++;
  op.missions.find((x) => !x.done)!.done = true;
  let units = 0.6 + 0.08 * op.difficulty;
  if (op.missions.every((x) => x.done)) {
    units += 1;
    e.stats.operations++;
    c.operations = c.operations.filter((o) => o !== op);
    fillOps(m, c);
  }
  for (const o of e.orders) if (o.state === "active" && o.kind === "missions" && (o.faction === 0 || o.faction === c.faction)) o.progress++;
  if (c.kind === "liberation") {
    c.liberation = round2(Math.min(100, c.liberation + units * c.per_mission));
    if (c.liberation >= 100) liberate(m, c.planet);
  } else {
    c.defense = round2(Math.min(100, c.defense + units * c.per_mission));
    if (c.defense >= 100) defended(m, c);
  }
}

function evoTick(m: MockWar, dt: number) {
  const e = evo(m);
  // Countdowns are in real seconds, and a tick is one.
  for (const c of e.campaigns) if (c.ends_in != null) c.ends_in = Math.max(0, c.ends_in - 1);
  for (const o of e.orders) if (o.state === "active") o.ends_in = Math.max(0, o.ends_in - 1);
  for (const c of e.campaigns) if (c.kind === "liberation") c.liberation = round2(Math.max(0, c.liberation - (e.settings.regen_per_hour * dt) / 3600));
  if (e.campaigns.length && rnd() < 0.05 * m.war.speed) evoMission(m, pick(e.campaigns), rnd() < 0.85);
  for (const c of [...e.campaigns]) {
    if (c.kind === "defense" && c.ends_in === 0) { if (c.defense >= 100) defended(m, c); else lose(m, c.planet, c.faction); }
  }
  checkOrders(m);
  if (e.settings.director) evoDirect(m);
}

function evoAct(m: MockWar, a: GmAction) {
  const e = evo(m);
  const planetOk = (p: unknown) => { if (typeof p !== "number" || !(p >= 0 && p < PLANETS.length)) throw bad(`\`planet\` must be a planet number below ${PLANETS.length}`); return p; };
  switch (a.action) {
    case "evo_planet": {
      const p = planetOk(a.planet);
      if (!(a.owner >= 0 && a.owner <= 3)) throw bad("`owner` must be 0 (Super Earth), 1 (bugs), 2 (cyborgs) or 3 (illuminates)");
      dropCampaign(e, p);
      e.owners[p] = a.owner;
      evoNews(m, "gm", `${pname(p)} is now held by ${a.owner === 0 ? "Super Earth" : `the ${FACTION[a.owner]} forces`}.`, p);
      checkOrders(m);
      break;
    }
    case "evo_campaign": {
      const p = planetOk(a.planet);
      if (a.kind === "defense") startDefense(m, p, a.faction ?? 0, a.hours ?? e.settings.defense_hours);
      else startLiberation(m, p);
      break;
    }
    case "evo_end_campaign": {
      const c = e.campaigns.find((x) => x.id === a.campaign);
      if (!c) throw bad("no such campaign");
      if (c.kind === "liberation" && a.won) liberate(m, c.planet);
      else if (c.kind === "liberation") { dropCampaign(e, c.planet); evoNews(m, "campaign", `The liberation of ${pname(c.planet)} is called off.`, c.planet); }
      else if (a.won) defended(m, c);
      else lose(m, c.planet, c.faction);
      checkOrders(m);
      break;
    }
    case "evo_order": issueOrder(m, a.kind, a.planets ?? [], a.faction ?? 0, a.target ?? 0, a.hours ?? e.settings.order_hours, a.brief, "gm"); break;
    case "evo_cancel_order": {
      const o = e.orders.find((x) => x.id === a.order && x.state === "active");
      if (!o) throw bad("no such active order");
      o.state = "cancelled";
      evoNews(m, "order", `Major Order withdrawn: ${o.brief}`);
      break;
    }
    case "evo_news": {
      const text = a.text.trim();
      if (!text || text.length > 400) throw bad("`text` must be 1 to 400 characters");
      evoNews(m, "gm", text);
      break;
    }
    case "evo_settings": {
      const next = { ...e.settings, ...a.settings };
      for (const f of EVO_FIELDS) {
        const v = next[f.key];
        if (f.kind !== "bool" && !(typeof v === "number" && v >= f.min && v <= f.max)) throw bad(`\`${f.key}\` must be between ${f.min} and ${f.max}`);
      }
      e.settings = next;
      break;
    }
  }
}

/** The fixture from the Evolved War Engine tests: a fresh war with three liberations, a defense and an order. */
function seedEvolved() {
  const fx = evoFixture as unknown as Pick<Evolved, "campaigns" | "orders" | "news" | "stats" | "settings">;
  const m = newEvolvedWar("Second Galactic War", { ...EVO_DEFAULTS, ...fx.settings }, "uzreeg");
  const e = evo(m);
  const t = now();
  m.war.season = 2;
  m.war.description = "The HELLDIVERS 2 galaxy, after the fall of the first Galactic War. Liberate the sectors around Super Earth, then push into enemy space.";
  m.war.war_time = 5 * 3600 + 1210;
  e.campaigns = copy(fx.campaigns);
  e.orders = copy(fx.orders);
  e.stats = copy(fx.stats);
  // The fixture news all carry one time; spread them over the last hours, newest first.
  e.news = copy(fx.news).map((n, i) => ({ ...n, time: Math.floor(t - 240 - i * 2400) }));
  m.evoNext = 25;
  m.war.members = NAMES.slice(0, 4).map((n, i) => ({ player: playerId(i + 20), name: n, first_seen: Math.floor(t - 6 * 3600), last_seen: Math.floor(t - i * 2500 - 30), missions: i < 2 ? 1 : 0 }));
}

function seedWars() {
  const s = DEFAULT_SETTINGS;
  const a = newWar("Autumn Offensive", s, "k3x9q2");
  a.war.season = 4;
  a.war.description = "Three fronts at full pressure. Defenses every few hours, played on Friday nights.";
  a.war.war_time = 3 * 86400 + 4231;
  const target = [36500, 14200, 64800];
  // Three days of hourly history, a random walk that ends where the fronts are now.
  a.history = [];
  const start = now() - 72 * 3600;
  const walk = target.map((end) => {
    const pts: number[] = [];
    let p = s.start_points;
    for (let i = 0; i < 72; i++) {
      const pull = (end - p) / (72 - i);
      p = clamp(p + pull + (rnd() - 0.45) * 2400, 0, s.points_max);
      pts.push(p);
    }
    pts[71] = end;
    return pts;
  });
  for (let i = 0; i < 72; i++) a.history.push({ time: Math.floor(start + i * 3600), season: 4, data: walk.map((w) => ({ points: Math.round(w[i]), points_taken: 0, status: "active" })) });
  a.war.fronts = target.map((p, e) => makeFront(e as Enemy, p, s));
  a.war.members = NAMES.slice(0, 5).map((n, i) => ({ player: playerId(i), name: i === 3 ? null : n, first_seen: Math.floor(start + i * 9000), last_seen: Math.floor(now() - i * 4000 - 60), missions: 30 - i * 5 }));
  a.war.statistics = [
    { enemy: 0, missions: 48, successful_missions: 39, kills: 15840, deaths: 121, shots: 98000, hits: 41000, accidentals: 17, players: 5, completed_planets: 31 },
    { enemy: 1, missions: 22, successful_missions: 14, kills: 5210, deaths: 88, shots: 51000, hits: 19400, accidentals: 9, players: 4, completed_planets: 12 },
    { enemy: 2, missions: 61, successful_missions: 55, kills: 9930, deaths: 64, shots: 83000, hits: 40100, accidentals: 4, players: 5, completed_planets: 47 },
  ];
  a.nextEvent = 8;
  const t = now();
  a.war.defend_event = { event_id: 7, enemy: 0, region: 4, points: 1650, points_max: 3000, start_time: Math.floor(t - 3600), end_time: Math.floor(t + 2 * 3600 + 1234), status: "active" };
  a.feed = [];
  const past: [number, Omit<FeedEntry, "id" | "time" | "war_time">][] = [
    [72 * 3600, { kind: "war", text_key: "war_created", player: "gm" }],
    [71 * 3600, { kind: "member", player: "redshift", text_key: "member_joined" }],
    [70 * 3600, { kind: "member", player: "Maru", text_key: "member_joined" }],
    [52 * 3600, { kind: "region", front: 2, region: 4, text_key: "region_liberated" }],
    [40 * 3600, { kind: "region", front: 1, region: 2, text_key: "region_lost" }],
    [30 * 3600, { kind: "gm", front: 1, value: 1, player: "gm", text_key: "gm_push" }],
    [20 * 3600, { kind: "event", front: 2, region: 6, event_id: 6, text_key: "defend_started" }],
    [18 * 3600, { kind: "mission", front: 2, region: 6, event_id: 6, player: "Okonkwo", value: 900, text_key: "defend_mission_completed" }],
    [17 * 3600, { kind: "event", front: 2, region: 6, event_id: 6, text_key: "defend_success" }],
    [4 * 3600, { kind: "region", front: 0, region: 3, text_key: "region_liberated" }],
    [3600, { kind: "event", front: 0, region: 4, event_id: 7, text_key: "defend_started" }],
    [1800, { kind: "mission", front: 0, region: 4, event_id: 7, player: "redshift", value: 1050, text_key: "defend_mission_completed" }],
    [900, { kind: "mission", front: 2, region: 7, player: "Maru", value: 1500, text_key: "planet_completed" }],
    [400, { kind: "mission", front: 0, region: 4, event_id: 7, player: "lowflyer", value: 600, text_key: "defend_mission_completed" }],
  ];
  for (const [ago, e] of past) addFeed(a, e, t - ago);
  a.lastSnap = t;

  const b = newWar("LAN Night", { ...s, points_max: 30000, start_points: 3000, pressure_per_hour: 300 }, "p7m2wd");
  b.war.state = "paused";
  b.war.season = 1;
  // `&internet=1`: this war is open to the internet too, for screenshots of Share.
  b.war.lan = new URLSearchParams(location.search).get("internet") === "1"
    ? { open: true, port: 17494, internet: true, invite: "K7M2P-9XQ4T" }
    : { open: true, port: 17494 };
  b.war.fronts[2].status = "hidden";
  setPoints(b, b.war.fronts[0], 21000, null);
  setPoints(b, b.war.fronts[1], 9000, null);
  b.war.members = NAMES.slice(5, 8).map((n, i) => ({ player: playerId(i + 10), name: n, first_seen: Math.floor(t - 86400), last_seen: Math.floor(t - 7200), missions: 4 + i }));

  const c = newWar("Training Ground", s, "r8c1fa");
  c.war.state = "won";
  c.war.season = 2;
  c.war.fronts.forEach((f) => { f.status = "defeated"; f.points = f.points_max; f.region = 10; });

  seedEvolved();
}

let started = false;
function ensure() {
  if (started) return;
  started = true;
  seedWars();
  setInterval(tick, 1000);
}

const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const delay = <T,>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(copy(v)), 60 + Math.random() * 90));
function get(id: string): MockWar {
  ensure();
  const m = wars.get(id);
  if (!m) throw new ApiError(404, "No such war");
  return m;
}

function act(m: MockWar, a: GmAction) {
  const w = m.war;
  const gm = "gm";
  if (a.action.startsWith("evo_")) { evoAct(m, a); return; }
  switch (a.action) {
    case "set_points": setPoints(m, w.fronts[a.front], a.points, gm); addFeed(m, { kind: "gm", front: a.front, value: Math.round(a.points), player: gm, text_key: "gm_set_points" }); break;
    case "push": {
      const f = w.fronts[a.front];
      addFeed(m, { kind: "gm", front: a.front, value: a.regions, player: gm, text_key: "gm_push" });
      setPoints(m, f, f.points + (a.regions * f.points_max) / 10, gm);
      break;
    }
    case "set_status": w.fronts[a.front].status = a.status; addFeed(m, { kind: "gm", front: a.front, player: gm, text_key: a.status === "active" ? "front_introduced" : a.status === "hidden" ? "front_hidden" : "front_defeated" }); snap(m); break;
    case "start_defend": if (w.defend_event) throw new ApiError(409, "A defense already runs"); startDefend(m, a.front as Enemy, a.region, a.duration, a.points_max); break;
    case "start_attack": startAttack(m, a.front as Enemy, a.duration, a.points_max); break;
    case "set_event": {
      const ev = w.defend_event?.event_id === a.event_id ? w.defend_event : w.attack_events.find((e) => e.event_id === a.event_id);
      if (ev) { ev.points = clamp(a.points, 0, ev.points_max); addFeed(m, { kind: "gm", event_id: ev.event_id, front: ev.enemy, value: Math.round(a.points), player: gm, text_key: "gm_set_event" }); }
      break;
    }
    case "end_event": {
      const ev = w.defend_event?.event_id === a.event_id ? w.defend_event : w.attack_events.find((e) => e.event_id === a.event_id);
      if (ev) endEvent(m, ev, a.result === "success");
      break;
    }
    case "pause": w.state = "paused"; addFeed(m, { kind: "gm", player: gm, text_key: "gm_pause" }); break;
    case "resume": w.state = "running"; addFeed(m, { kind: "gm", player: gm, text_key: "gm_resume" }); break;
    case "set_speed": w.speed = clamp(a.speed, 0.5, 10); addFeed(m, { kind: "gm", player: gm, value: w.speed, text_key: "gm_set_speed" }); break;
    case "end_season": w.state = a.result; addFeed(m, { kind: "season", player: gm, text_key: a.result === "won" ? "season_won" : "season_lost" }); break;
    case "new_season":
      w.season++; w.state = "running"; w.defend_event = null; w.attack_events = [];
      w.fronts = w.fronts.map((f) => makeFront(f.enemy, w.settings.start_points, w.settings, f.status === "hidden" ? "hidden" : "active"));
      addFeed(m, { kind: "season", player: gm, value: w.season, text_key: "season_started" });
      snap(m);
      break;
  }
}

export const mockApi: Api = {
  info: () => { ensure(); return delay({ version: "0.1.0-mock", protocol: 1, wars: [...wars.values()].map((m) => m.war) }); },
  createWar: (b) => {
    ensure();
    return delay((b.model === "evolved" ? newEvolvedWar(b.name, { ...EVO_DEFAULTS, ...b.evolved }) : newWar(b.name, { ...DEFAULT_SETTINGS, ...b.settings })).war);
  },
  getWar: async (id) => delay(get(id).war),
  patchWar: async (id, b) => {
    const m = get(id);
    if (b.name) m.war.name = b.name;
    if (b.description != null) m.war.description = b.description.trim();
    if (b.logo !== undefined) m.war.logo = b.logo ?? "";
    if (b.settings) {
      m.war.settings = { ...m.war.settings, ...b.settings };
      m.war.fronts.forEach((f) => { f.points_max = m.war.settings.points_max; f.pressure_per_hour = m.war.settings.pressure_per_hour; f.region = regionOf(f.points, f.points_max); });
      addFeed(m, { kind: "gm", player: "gm", text_key: "gm_settings" });
    }
    return delay(m.war);
  },
  deleteWar: async (id) => { get(id); wars.delete(id); return delay(undefined); },
  action: async (id, a) => { const m = get(id); act(m, a); m.war.server_time = Math.floor(now()); return delay(m.war); },
  feed: async (id, after, limit = 200) => delay(get(id).feed.filter((e) => after == null || e.id > after).slice(-limit)),
  history: async (id, from) => delay(get(id).history.filter((s) => from == null || s.time >= from)),
  lan: async (id, open, internet, newInvite) => { const m = get(id); const on = open && (internet ?? !!m.war.lan.internet); m.war.lan = { open, port: open ? 17494 : null, internet: on, invite: on ? (newInvite ? "W8RX3-HJ6LD" : m.war.lan.invite ?? "K7M2P-9XQ4T") : null }; return delay(m.war.lan); },
  exportWar: async (id) => new Blob([JSON.stringify(get(id), null, 1)], { type: "application/json" }),
  importWar: async (file: any) => {
    ensure();
    const src = file?.war ?? file;
    if (!src || !Array.isArray(src.fronts) || !src.settings) throw new ApiError(400, "Not a war");
    const m = newWar(String(src.name ?? "Imported War"), { ...DEFAULT_SETTINGS, ...src.settings });
    Object.assign(m.war, copy(src), { id: m.war.id, lan: { open: false, port: null } });
    if (Array.isArray(file?.history)) m.history = file.history;
    if (Array.isArray(file?.feed)) m.feed = file.feed;
    return delay(m.war);
  },
};
