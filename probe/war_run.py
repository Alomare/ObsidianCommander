"""Milestone 1 in the game: a Vanilla war hosted by `obsidian commander serve`, played through the
loader's war mode and Obsidian's relay.

python probe/war_run.py all --obsidian <ObsidianLauncher checkout with a built target/debug/obsidian.exe>

begin  records the real saves, purges the real library, builds a throwaway library in
       internal/war-data (API, QoL with the four skips, the probe mod as a driver), installs the
       newest package from internal/builds, and deploys.
play   starts `obsidian commander serve`, creates a war through the admin API, selects it with
       `obsidian commander play` (a Sandbox of its own, the war line), redeploys the settings, then
       launches the game and checks: the loader's war mode, the war map drawing the war's numbers,
       a GM push showing in the game after a poll, one mission credited to the war.
end    back to the official war, purge, the real library redeployed if it was, the real saves compared.

Output: probe/runs/war-<time>/ with the logs, the server's war JSON and the screenshots.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
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
    for folder, mod in ((KIT / "ObsidianAPI", "obsidian.api"), (KIT / "ObsidianPatches", "obsidian.qol"), (HERE / "mod", "obsidian.cmdprobe")):
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
        war = admin(base, token, "POST", "/api/wars", {"name": "Probe War", "model": "vanilla"})
        wid = war["id"]
        print("war", wid, "season", war["season"], [f["points"] for f in war["fronts"]])
        obs("commander", "play", wid, "--name", "Probe War", check=True)
        obs("deploy")
        settings = (GAME_SIDE / "settings.txt").read_text()
        war_line = next((l for l in settings.splitlines() if l.startswith("war\t")), None)
        print("settings war line:", war_line)
        if not war_line:
            sys.exit("no war line in settings.txt")
        relay_url = war_line.split("\t")[2]
        # The probe mod drives the game; its URL is the relay's, the same the loader sets.
        CFG.write_text(f"url={relay_url}\nisolate_save=0\nblock_telemetry=0\nno_tutorial=1\n")
        log = drive(out, "launch", "wait:PROBE ready:300", "wait:STATE menu:900", f"wait:POLL season={war['season']}:240", "sleep:5", "cmd:state", "shot:ship")
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
        for name in ("cmdprobe.log", "loader.log"):
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
    global OBS, OBS_REPO
    ap = argparse.ArgumentParser()
    ap.add_argument("verb", choices=("all", "begin", "play", "end"))
    ap.add_argument("--obsidian", required=True)
    a = ap.parse_args()
    OBS_REPO = Path(a.obsidian)
    OBS = OBS_REPO / "target" / "debug" / "obsidian.exe"
    if not OBS.exists():
        sys.exit(f"no {OBS}")
    if a.verb in ("all", "begin"):
        begin()
    if a.verb in ("all", "play"):
        play()
    if a.verb in ("all", "end"):
        end()


if __name__ == "__main__":
    main()
