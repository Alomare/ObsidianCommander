"""Milestone 1 in the game: a Vanilla war hosted by `obsidian commander serve`, played through the
loader war mode and the Obsidian relay.

python probe/war_run.py all --obsidian <ObsidianLauncher checkout with a built target/debug/obsidian.exe>

begin  records the real saves, purges the real library, builds a throwaway library in
       internal/war-data (API, QoL with the four skips, the probe mod as a driver), installs the
       newest package from internal/builds, and deploys.
play   starts `obsidian commander serve`, creates a war through the admin API, selects it with
       `obsidian commander play` (a separate Sandbox, the war line), redeploys the settings, then
       launches the game and checks: the loader war mode, the war map drawing the war numbers,
       a GM push showing in the game after a poll, one mission credited to the war.
end    back to the official war, purge, the real library redeployed if it was, the real saves compared.

Output: probe/runs/war-<time>/ with the logs, the server war JSON and the screenshots.

--evolved: an Evolved war with the newest Evolved War Engine build (Mods/EvolvedWarEngine/internal/builds)
in the library. Before the launch the relay is asked for evolved/state as the mod asks it; in the game
the galaxy map screen is opened and shot, and the mod log is kept.
"""
import argparse
import hashlib
import http.server
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
KIT = REPO.parent / "Bundled"
DATA = REPO / "internal" / "war-data"
STATE = REPO / "internal" / "war-state"
GAME_SIDE = Path(os.environ["APPDATA"]) / "Arrowhead/Helldivers/ObsidianLauncher"
LOGS = GAME_SIDE / "logs"
CFG = LOGS / "cmdprobe.cfg"
SAVES = [Path(os.environ["APPDATA"]) / "Arrowhead/Helldivers/saves", Path(r"C:\Program Files (x86)\Steam\userdata")]
OBS = None
OBS_REPO = None
EVOLVED = False
METHODS = False
EVO_BUILDS = REPO.parent.parent / "Mods" / "EvolvedWarEngine" / "internal" / "builds"


def obs(*args, real=False, check=False):
    cmd = [str(OBS)] + ([] if real else ["--data-dir", str(DATA)]) + [str(a) for a in args]
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=OBS_REPO)
    out = (r.stdout + r.stderr).strip()
    print(" ".join(str(a) for a in args), "=>", out[:600])
    if check and r.returncode:
        sys.exit(f"failed: {args}")
    return out


def game_running():
    return "helldivers.exe" in subprocess.run(["tasklist", "/FI", "IMAGENAME eq helldivers.exe"], capture_output=True, text=True).stdout.lower()


def hashes():
    out = {}
    for root in SAVES:
        if not root.exists():
            continue
        folders = [root] if root.name == "saves" else list(root.glob("*/394510/remote"))
        for folder in folders:
            for f in folder.rglob("*"):
                if f.is_file() and not f.name.startswith(("cmdprobe_", "helldivers_sandbox_")):
                    out[str(f)] = (hashlib.sha256(f.read_bytes()).hexdigest(), f.stat().st_mtime)
    return out


def begin():
    if game_running():
        sys.exit("the game is running; close it first")
    STATE.mkdir(parents=True, exist_ok=True)
    (STATE / "saves-before.json").write_text(json.dumps(hashes(), indent=0))
    st = obs("status", real=True)
    (STATE / "real-was-deployed.txt").write_text("no" if "the game is vanilla" in st else "yes")
    obs("purge", real=True)
    shutil.copytree(OBS_REPO / "loader" / "src", OBS.parent / "loader" / "src", dirs_exist_ok=True)
    mods = [(KIT / "ObsidianAPI", "obsidian.api"), (KIT / "ObsidianPatches", "obsidian.qol"), (HERE / "mod", "obsidian.cmdprobe")]
    if EVOLVED:
        zips = sorted(EVO_BUILDS.glob("alomare.evolvedwar-*.zip"), key=lambda p: p.stat().st_mtime)
        if not zips:
            sys.exit("no Evolved War Engine build: run Mods/pack_build.py")
        mods.append((zips[-1], "alomare.evolvedwar"))
    for folder, mod in mods:
        obs("import", folder)
        obs("enable", mod)
    for option in ("skip_intro", "skip_login", "skip_war_briefs", "skip_planet_scanning"):
        obs("set", "obsidian.qol", option, "true")
    builds = sorted((REPO / "internal" / "builds").glob("obsidian-commander-*.zip"))
    if not builds:
        sys.exit("no package: run tools/pack.py")
    obs("commander", "install", builds[-1], check=True)
    obs("deploy", check=True)


def drive(out, *steps):
    r = subprocess.run([sys.executable, str(HERE / "drive.py"), str(out), *steps], text=True, capture_output=True)
    print(r.stdout.strip())
    return r.stdout


def admin(base, token, method, path, obj=None):
    req = urllib.request.Request(base + path, data=json.dumps(obj).encode() if obj is not None else None, method=method,
                                 headers={"X-Commander-Token": token, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def play():
    if game_running():
        sys.exit("the game is running; close it first")
    out = HERE / "runs" / time.strftime("war-%Y%m%d-%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    serve = subprocess.Popen([str(OBS), "--data-dir", str(DATA), "commander", "serve"], cwd=OBS_REPO, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        line = serve.stdout.readline().strip()
        print(line)
        url = line.split("War server: ", 1)[1]
        base, token = url.split("/?token=")
        relay_line = serve.stdout.readline().strip()
        print(relay_line)
        war = admin(base, token, "POST", "/api/wars", {"name": "Probe War", "model": "evolved" if EVOLVED else "vanilla"})
        wid = war["id"]
        print("war", wid, "season", war["season"], "model", war.get("model"), [f["points"] for f in war["fronts"]])
        obs("commander", "play", wid, "--name", "Probe War", check=True)
        if EVOLVED:
            return play_evolved(out, base, token, wid, war)
        obs("deploy")
        settings = (GAME_SIDE / "settings.txt").read_text()
        war_line = next((l for l in settings.splitlines() if l.startswith("war\t")), None)
        print("settings war line:", war_line)
        if not war_line:
            sys.exit("no war line in settings.txt")
        relay_url = war_line.split("\t")[2]
        # The probe mod drives the game; the URL is the relay URL, the same the loader sets.
        CFG.write_text(f"url={relay_url}\nisolate_save=0\nblock_telemetry=0\nno_tutorial=1\n")
        log = drive(out, "launch", "wait:PROBE ready:300", "wait:STATE menu:900", f"wait:POLL season={war.get('game_season', war['season'])}:240", "sleep:5", "cmd:state", "shot:ship")
        if "TIMEOUT" in log or "GAME GONE" in log:
            print("stopped early")
            return
        drive(out, "cmd:menu campaign", "sleep:10", "shot:war-start", "cmd:close", "sleep:3")
        # A GM push: the bugs front two regions forward, a defense on the cyborgs.
        admin(base, token, "POST", f"/api/wars/{wid}/actions", {"action": "push", "front": 0, "regions": 3})
        admin(base, token, "POST", f"/api/wars/{wid}/actions", {"action": "start_defend", "front": 1, "region": 2, "duration": 7200, "points_max": 3000})
        drive(out, "cmd:poll", "sleep:12", "cmd:state", "cmd:menu campaign", "sleep:10", "shot:war-after-push", "cmd:close", "sleep:3")
        # One mission on the illuminates front, won, then the uploads.
        log = drive(out, "cmd:menu campaign", "sleep:10", "cmd:close", "sleep:4", "cmd:campaign_mission 3", "wait:MISSION READY #1:900", "shot:mission", "cmd:win",
                    "wait:STATE mission_end:180", "sleep:5")
        if "TIMEOUT" not in log and "GAME GONE" not in log:
            steps = []
            for _ in range(10):
                steps += ["cmd:ready", "sleep:6"]
            drive(out, *steps)
            drive(out, "wait:SHIP AGAIN:600", "sleep:30", "cmd:state", "shot:ship-after", "cmd:menu campaign", "sleep:10", "shot:war-after-mission", "cmd:close")
        final = admin(base, token, "GET", f"/api/wars/{wid}")
        feed = admin(base, token, "GET", f"/api/wars/{wid}/feed")
        (out / "war.json").write_text(json.dumps(final, indent=1))
        (out / "feed.json").write_text(json.dumps(feed, indent=1))
        print("fronts now", [(f["points"], f["region"]) for f in final["fronts"]], "members", [m.get("player") for m in final.get("members", [])])
        print("feed kinds", [e.get("text_key") or e.get("kind") for e in feed.get("entries", [])][-12:])
    finally:
        drive(out, "log:120", "kill")
        try:
            CFG.unlink()
        except OSError:
            pass
        for name in ("cmdprobe.log", "loader.log", "alomareevolvedwar.log"):
            if (LOGS / name).exists():
                shutil.copy2(LOGS / name, out / name)
        names = GAME_SIDE / "commander-names.txt"
        if names.exists():
            shutil.copy2(names, out / "commander-names.txt")
        try:
            serve.stdin.write("\n")
            serve.stdin.close()
            serve.wait(timeout=10)
        except Exception:
            serve.kill()
        print("run folder:", out)


def http_get(url):
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            return r.status, r.read()[:240]
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:240]
    except Exception as e:  # noqa: BLE001 - any failure is a finding here
        return None, str(e).encode()


def play_evolved(out, base, token, wid, war):
    """The Evolved war: the relay asked as the mod asks it, then the galaxy map screen in the game."""
    time.sleep(1.5)  # `serve` takes the new route from the state file every half second
    st = json.loads((DATA / "commander" / "state.json").read_text())
    relay = f"http://127.0.0.1:{st['relayPort']}/{st['token']}/"
    for name, url in (("server", f"{base}/w/{wid}/evolved/state"), ("relay", relay + "evolved/state"), ("relay war api", relay + "1.0/")):
        code, body = http_get(url)
        print(f"{name}: {code} {body[:160]!r}")
    obs("deploy")
    settings = (GAME_SIDE / "settings.txt").read_text()
    war_line = next((l for l in settings.splitlines() if l.startswith("war\t")), None)
    print("settings war line:", war_line)
    if not war_line:
        sys.exit("no war line in settings.txt")
    CFG.write_text(f"url={war_line.split(chr(9))[2]}\nisolate_save=0\nblock_telemetry=0\nno_tutorial=1\n")
    log = drive(out, "launch", "wait:PROBE ready:300", "wait:STATE menu:300", f"wait:POLL season={war.get('game_season', war['season'])}:240", "sleep:12", "cmd:state", "shot:ship")
    if "TIMEOUT" in log or "GAME GONE" in log:
        drive(out, "shot:stuck")
        print("stopped early")
        return
    if METHODS:
        methods_check(out, war_line)
    tour(out, base, token, wid)
    final = admin(base, token, "GET", f"/api/wars/{wid}")
    (out / "war.json").write_text(json.dumps(final, indent=1))


def tour(out, base, token, wid):
    """Every level of the Evolved map in the game: the galaxy, a sector under the pointer, then keys down
    to an operation, back up, and a mouse click into the same sector."""
    drive(out, "cmd:menu campaign", "sleep:9", "shot:t1-galaxy")
    log = (LOGS / "alomareevolvedwar.log").read_text(errors="replace") if (LOGS / "alomareevolvedwar.log").exists() else ""
    screens = [l for l in log.splitlines() if " screen l=" in l]
    if not screens:
        print("no screen line in the mod log; the tour stops")
        drive(out, "cmd:close")
        return
    ext = dict(kv.split("=") for kv in screens[-1].split("screen ", 1)[1].split())
    l, b, r, t = (float(ext[k]) for k in ("l", "b", "r", "t"))
    print("mod screen", l, b, r, t)
    galaxy = json.loads((REPO / "data" / "galaxy-hd2.json").read_text(encoding="utf-8"))
    state = admin(base, token, "GET", f"/api/wars/{wid}")
    camps = (state.get("evolved") or {}).get("campaigns") or []
    pid = camps[0]["planet"] if camps else 0
    p = galaxy["planets"][pid]
    h = t - b
    gx, gy, gs = (l + r) / 2, b + h * 0.465, h * 0.41

    def design(mx, my):
        # drive.py dmove takes the mod frame (1920x1080, y down, at ui_scale 0.8).
        fx, fy = gx + mx * gs, gy + my * gs
        return f"{fx:.1f},{1080 - fy:.1f}"

    # Just beside the campaign mark, inside the same sector.
    target = design(p["x"] + 0.012, p["y"] - 0.012)
    print("hover and click at", target, "planet", p["name"])
    drive(out, f"dmove:{target}", "sleep:1.5", "shot:t2-hover")
    drive(out, "key:D", "sleep:0.5", "key:E", "sleep:4", "shot:t3-sector")
    drive(out, "key:D", "sleep:0.5", "key:E", "sleep:4", "shot:t4-planet")
    drive(out, "key:D", "sleep:0.5", "key:E", "sleep:4", "shot:t5-operation")
    drive(out, "key:Q", "sleep:1.5", "key:Q", "sleep:1.5", "key:Q", "sleep:3", "shot:t6-back")
    drive(out, f"dclick:{target}", "sleep:4", "shot:t7-click-sector", "key:Q", "sleep:2", "cmd:close", "sleep:2")


def methods_check(out, war_line):
    # What the game's Http sends for each method: a listener on this PC keeps method, path and body size.
    seen = []

    class Listener(http.server.BaseHTTPRequestHandler):
        def answer(self):
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n) if n else b""
            seen.append(f"{self.command} {self.path} body={len(body)}")
            reply = f"ok-{self.command}".encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(reply)))
            self.end_headers()
            self.wfile.write(reply)

        do_GET = do_POST = answer

        def log_message(self, *args):
            pass

    listener = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Listener)
    threading.Thread(target=listener.serve_forever, daemon=True).start()
    lp = listener.server_address[1]
    relay_game = war_line.split(chr(9))[2][: -len("1.0/")]
    drive(out, f"cmd:httpm GET http://127.0.0.1:{lp}/probe-get", "sleep:3", f"cmd:httpm POST http://127.0.0.1:{lp}/probe-post", "sleep:3",
          f"cmd:httpm GET {relay_game}evolved/state", "sleep:3", f"cmd:httpm POST {relay_game}evolved/state", "sleep:3")
    print("listener saw:", seen)
    listener.shutdown()


def end():
    if game_running():
        subprocess.run(["taskkill", "/IM", "helldivers.exe", "/F"], capture_output=True)
        time.sleep(3)
    try:
        CFG.unlink()
    except OSError:
        pass
    obs("commander", "official")
    obs("purge")
    st = obs("status")
    if "Deployed: nothing" not in st and "the game is vanilla" not in st:
        print("WARNING: the war library still looks deployed")
    if (STATE / "real-was-deployed.txt").read_text() == "yes":
        obs("deploy", real=True)
    obs("status", real=True)
    before = json.loads((STATE / "saves-before.json").read_text())
    after = hashes()
    changed = sorted(k for k in set(before) | set(after) if (before.get(k) or [None])[0] != (after.get(k) or [None])[0])
    print("REAL SAVES CHANGED" if changed else "real saves identical", changed[:10])
    for k in changed:
        b, a = before.get(k), after.get(k)
        print("  ", k, "mtime before", b and time.ctime(b[1]), "after", a and time.ctime(a[1]))


def main():
    global OBS, OBS_REPO, EVOLVED, METHODS
    ap = argparse.ArgumentParser()
    ap.add_argument("verb", choices=("all", "begin", "play", "end"))
    ap.add_argument("--obsidian", required=True)
    ap.add_argument("--evolved", action="store_true")
    ap.add_argument("--methods", action="store_true", help="with --evolved: what the game Http sends for GET and POST")
    a = ap.parse_args()
    EVOLVED = a.evolved
    METHODS = a.methods
    OBS_REPO = Path(a.obsidian)
    OBS = OBS_REPO / "target" / "debug" / "obsidian.exe"
    if not OBS.exists():
        sys.exit(f"no {OBS}")
    if a.verb in ("all", "begin"):
        begin()
    try:
        if a.verb in ("all", "play"):
            play()
    finally:
        # The real library comes back even when the play step fails.
        if a.verb in ("all", "end"):
            end()


if __name__ == "__main__":
    main()
