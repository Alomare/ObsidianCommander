// Walks the Obsidian COMMANDER tab in a release exe and takes screenshots, on the model of
// ObsidianLauncher internal/tools/walk/walk_exe.mjs (WebView2 debugging port, real mouse events).
//
//   OBSIDIAN_EXE=<Obsidian.exe> COMMANDER_ZIP=<package zip> OBSIDIAN_WALK=<scratch folder> node tools/walk_tab.mjs
//   (or COMMANDER_FETCH=1 instead of COMMANDER_ZIP: Install Package downloads the newest release from GitHub)
//
// Everything lives in the scratch folder: data, game side, webview profile. The game folder points
// nowhere, so nothing touches the game. Steps: the tab before the package, Join LAN War, the package
// installed (through the same command the Install button calls, since a native file dialog can't be
// driven), the war screens in the frame, a war created and opened, the light theme, the package menu,
// Remove All Commander Data on the scratch data. Fails on any console error, which is where a refused
// frame shows.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SP = process.env.OBSIDIAN_WALK;
const EXE = process.env.OBSIDIAN_EXE;
const ZIP = process.env.COMMANDER_ZIP;
// COMMANDER_FETCH=1: Install Package downloads the newest release from GitHub, as it does for a player.
const FETCH = process.env.COMMANDER_FETCH === "1";
if (!SP || !EXE || (!ZIP && !FETCH)) {
  console.error("Set OBSIDIAN_WALK, OBSIDIAN_EXE, and COMMANDER_ZIP or COMMANDER_FETCH=1.");
  process.exit(2);
}
const DATA = path.join(SP, "data"), APPDATA = path.join(SP, "appdata"), WEBVIEW = path.join(SP, "webview"), SHOTS = path.join(SP, "shots");
const PORT = 9556;
// The window-state plugin writes beside the real app data, outside the scratch folder: put it back after.
const WINDOW_STATE = path.join(process.env.APPDATA, "io.github.alomare.obsidianmodmanager", ".window-state.json");
const savedWindow = fs.existsSync(WINDOW_STATE) ? fs.readFileSync(WINDOW_STATE) : null;
const q = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
let cdp = null, proc = null;
let passed = 0, failed = 0;

for (const d of [DATA, APPDATA, WEBVIEW, SHOTS]) fs.rmSync(d, { recursive: true, force: true });
for (const d of [DATA, SHOTS, path.join(APPDATA, "Arrowhead", "Helldivers", "saves")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(DATA, "app.json"), q({ gameDir: path.join(SP, "no-game"), language: "en" }));

class Cdp {
  constructor(ws) {
    this.ws = ws; this.next = 1; this.pending = new Map(); this.handlers = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { ok, fail } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) fail(new Error(msg.error.message)); else ok(msg.result);
      } else if (msg.method) this.handlers.get(msg.method)?.(msg.params);
    };
  }
  send(method, params = {}) {
    return new Promise((ok, fail) => { const id = this.next++; this.pending.set(id, { ok, fail }); this.ws.send(q({ id, method, params })); });
  }
  on(e, fn) { this.handlers.set(e, fn); }
}

async function attach() {
  const start = Date.now();
  while (Date.now() - start < 60000) {
    try {
      const all = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const t = all.find((x) => x.type === "page" && !x.url.startsWith("http://127.0.0.1:") === true) ?? all.find((x) => x.type === "page");
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
        cdp = new Cdp(ws);
        cdp.on("Runtime.exceptionThrown", (e) => errors.push(`exception: ${e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text}`));
        cdp.on("Runtime.consoleAPICalled", (e) => { if (e.type === "error") errors.push(`console: ${e.args.map((a) => a.value ?? a.description).join(" ")}`); });
        cdp.on("Log.entryAdded", (e) => { if (e.entry.level === "error") errors.push(`log: ${e.entry.text} ${e.entry.url ?? ""}`); });
        await cdp.send("Runtime.enable"); await cdp.send("Log.enable"); await cdp.send("Page.enable");
        await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
        return;
      }
    } catch { /* not up yet */ }
    await sleep(300);
  }
  throw new Error("the debugging port never answered");
}

async function js(expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
async function until(expression, what, ms = 15000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < ms) {
    try { const v = await js(expression); if (v) return v; } catch (e) { last = e; }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (${last.message})` : ""}`);
}
const invoke = (cmd, args = {}) => js(`window.__TAURI_INTERNALS__.invoke(${q(cmd)}, ${q(args)})`);
async function click(sel, text) {
  const s = await until(`(() => {
    const els = [...document.querySelectorAll(${q(sel)})].filter((e) => ${text ? `e.textContent.includes(${q(text)})` : "true"});
    const e = els[0]; if (!e) return null; const r = e.getBoundingClientRect(); if (!r.width) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`, `${sel} ${text ?? ""}`, 10000);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", { type, x: s.x, y: s.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
  }
  await sleep(250);
}
async function shot(name) {
  const r = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, "base64"));
}
async function step(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); await shot(`fail-${name.replace(/\W+/g, "-")}`).catch(() => {}); }
}

async function main() {
  proc = spawn(EXE, [], { env: { ...process.env, OBSIDIAN_DATA_DIR: DATA, OBSIDIAN_APPDATA: APPDATA, WEBVIEW2_USER_DATA_FOLDER: WEBVIEW,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` }, stdio: "ignore" });
  try {
    await attach();
    await until(`document.querySelector('.tabs [role=tab]') != null`, "the window", 30000);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false });
    await step("Commander tab before the package", async () => {
      await click(".tabs [role=tab][aria-label=Commander]");
      await until(`document.querySelector('.cmd-intro h1')?.textContent`, "the intro");
      await shot("01-intro");
    });
    await step("Join LAN War lists nothing on an empty network", async () => {
      await click(".cmd-intro .btn", "Join LAN War");
      await until(`document.querySelector('.cmd-join-dialog') != null`, "the dialog");
      await shot("02-join-scanning");
      await until(`document.querySelector('.cmd-found-empty')?.textContent.includes('No war found')`, "the end of the scan", 12000);
      await shot("03-join-none");
      await click(".cmd-join-dialog .close");
      await until(`document.querySelector('.cmd-join-dialog') == null`, "the dialog closing", 5000);
    });
    let server = null;
    await step(FETCH ? "Install Package downloads the release from GitHub, and the war screens load" : "package installs and the war screens load in the frame", async () => {
      if (FETCH) {
        await click(".cmd-intro .btn.play", "Install Package");
        await sleep(600);
        await shot("04a-downloading");
        await until(`document.querySelector('iframe.cmd-frame') != null`, "the download and install", 120000);
        const v = await invoke("commander_state");
        if (!v.installed) throw new Error("not installed");
        console.log(`  installed ${v.installed.version} from GitHub`);
      } else {
        const v = await invoke("commander_install", { path: ZIP });
        if (!v.installed) throw new Error("not installed");
        await click(".tabs [role=tab][aria-label=Home]");
        await sleep(400);
        await click(".tabs [role=tab][aria-label=Commander]");
      }
      await until(`document.querySelector('iframe.cmd-frame')?.src`, "the frame", 25000);
      server = await invoke("commander_state").then((s) => s.server);
      if (!server) throw new Error("no server");
      await sleep(3500);
      await shot("04-shell-list");
    });
    await step("a war created on the server opens in the frame", async () => {
      const base = `http://127.0.0.1:${server.port}`;
      const r = await fetch(`${base}/api/wars`, { method: "POST", headers: { "X-Commander-Token": server.token, "Content-Type": "application/json" }, body: q({ name: "Walk Offensive", model: "vanilla" }) });
      const war = await r.json();
      await fetch(`${base}/api/wars/${war.id}/actions`, { method: "POST", headers: { "X-Commander-Token": server.token, "Content-Type": "application/json" }, body: q({ action: "push", front: 0, regions: 3 }) });
      await fetch(`${base}/api/wars/${war.id}/actions`, { method: "POST", headers: { "X-Commander-Token": server.token, "Content-Type": "application/json" }, body: q({ action: "start_defend", front: 1, region: 2, duration: 7200, points_max: 3000 }) });
      await sleep(3500);
      await shot("05-shell-list-one-war");
      await js(`(() => { const f = document.querySelector('iframe.cmd-frame'); f.src = f.src.split('#')[0] + '#/war/${war.id}'; })()`);
      await sleep(4000);
      await shot("06-shell-war");
    });
    await step("the light theme", async () => {
      await invoke("set_app_settings", { settings: { ...(await invoke("get_app_settings")), theme: "light" } }).catch(() => null);
      await js(`document.documentElement.dataset.theme = 'light'`);
      await click(".tabs [role=tab][aria-label=Home]");
      await sleep(300);
      await click(".tabs [role=tab][aria-label=Commander]");
      await sleep(2500);
      await shot("07-shell-light");
    });
    await step("the package menu, and Remove Package asks first", async () => {
      await click(".cmd-pkg");
      await until(`document.querySelector('.ctx') != null`, "the menu");
      await shot("08-package-menu");
      await click(".ctx button", "Remove Package");
      await until(`document.querySelector('.modal.confirm') != null`, "the question");
      await shot("09-remove-package-asks");
      await click(".modal.confirm .btn", "Cancel");
      await until(`document.querySelector('.modal.confirm') == null`, "the question closing", 5000);
      if (!(await invoke("commander_state")).installed) throw new Error("Cancel removed the package");
    });
    await step("Remove All Commander Data lists what goes, then leaves nothing", async () => {
      const before = await invoke("commander_footprint");
      if (!before.package || before.hosted < 1) throw new Error(`footprint ${q(before)}`);
      await click(".cmd-pkg");
      await click(".ctx button", "Remove All Commander Data");
      await until(`document.querySelector('.cmd-wipe li') != null`, "the list");
      await shot("10-wipe-dialog");
      await click(".modal.confirm .btn.danger");
      await until(`document.querySelector('.cmd-intro') != null`, "the intro again", 20000);
      await sleep(800);
      await shot("11-after-wipe");
      const after = await invoke("commander_footprint");
      if (after.package != null || after.hosted || after.joined || after.bytes) throw new Error(`left ${q(after)}`);
      if (fs.existsSync(path.join(DATA, "commander"))) throw new Error("the commander folder is still there");
      if ((await invoke("commander_state")).server) throw new Error("the server still runs");
      if (await js("document.querySelector('.cmd-left') != null")) throw new Error("the intro still reports Commander data");
    });
    await step("no console errors (a refused frame shows here)", async () => {
      const real = errors.filter((e) => !/favicon/i.test(e));
      if (real.length) throw new Error(real.slice(0, 5).join(" | "));
    });
  } finally {
    proc.kill();
    await sleep(800);
    if (savedWindow) fs.writeFileSync(WINDOW_STATE, savedWindow); else fs.rmSync(WINDOW_STATE, { force: true });
    console.log(`\n${passed} passed, ${failed} failed. Shots in ${SHOTS}`);
    process.exit(failed ? 1 : 0);
  }
}
main().catch((e) => { console.error(e); proc?.kill(); process.exit(1); });
