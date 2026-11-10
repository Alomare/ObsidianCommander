"""Runs the Commander probe in the game, start to finish.

python run.py all [--tls] [--broken]   begin, play, end in one go
python run.py begin                    record the saves, purge the real library, deploy the probe
python run.py play [--tls] [--broken]  start the server, run the game through the scenarios
python run.py all --mission            instead of the scenarios: one campaign mission on the custom
                                       war, won through Obsidian API, then the uploads on the ship
python run.py end                      purge the probe, redeploy the real library, compare the saves

Deploys into a throwaway Obsidian data folder (internal/probe-data) with Obsidian API, Obsidian
Patches (the four skips on) and the probe mod, the way the live tests of the app do. Needs a built
ObsidianModManager/target/debug/obsidian.exe and no game running. Output: probe/runs/<time>/.
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
OBS_REPO = REPO.parent / "ObsidianLauncher"
KIT = REPO.parent / "Bundled"
OBS = OBS_REPO / "target" / "debug" / "obsidian.exe"
DATA = REPO / "internal" / "probe-data"
STATE = REPO / "internal" / "probe-state"
LOGS = Path(os.environ["APPDATA"]) / "Arrowhead/Helldivers/ObsidianLauncher/logs"
CFG = LOGS / "cmdprobe.cfg"
SAVES = [Path(os.environ["APPDATA"]) / "Arrowhead/Helldivers/saves",
         Path(r"C:\Program Files (x86)\Steam\userdata")]
PORT = 17491

sys.path.insert(0, str(HERE))


def obs(*args, real=False):
    cmd = [str(OBS)] + ([] if real else ["--data-dir", str(DATA)]) + [str(a) for a in args]
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=OBS_REPO)
    print(" ".join(str(a) for a in args), "=>", (r.stdout + r.stderr).strip()[:800])
    return r


def game_running():
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq helldivers.exe"], capture_output=True, text=True).stdout
    return "helldivers.exe" in out.lower()


def hashes():
    """Every file of the real saves: the local folder and the Steam Cloud folders of the game."""
    out = {}
    for root in SAVES:
        if not root.exists():
            continue
        folders = [root] if root.name == "saves" else list(root.glob("*/394510/remote"))
        for folder in folders:
            for f in folder.rglob("*"):
                if f.is_file() and not f.name.startswith("cmdprobe_"):
                    out[str(f)] = hashlib.sha256(f.read_bytes()).hexdigest()
    return out


def begin():
    if game_running():
        sys.exit("the game is running; close it first")
    if not OBS.exists():
        sys.exit(f"no {OBS}; build ObsidianModManager first")
    STATE.mkdir(parents=True, exist_ok=True)
    (STATE / "saves-before.json").write_text(json.dumps(hashes(), indent=0))
    r = subprocess.run([str(OBS), "status"], capture_output=True, text=True, cwd=OBS_REPO)
    print(r.stdout.strip()[:600])
    # A vanilla game stays vanilla afterwards: only a library that was deployed goes back.
    (STATE / "real-was-deployed.txt").write_text("no" if "the game is vanilla" in r.stdout else "yes")
    obs("purge", real=True)
    # The exe takes the loader beside it first, a copy made by the last build.
    shutil.copytree(OBS_REPO / "loader" / "src", OBS.parent / "loader" / "src", dirs_exist_ok=True)
    for folder, mod in ((KIT / "ObsidianAPI", "obsidian.api"), (KIT / "ObsidianPatches", "obsidian.qol"),
                        (HERE / "mod", "obsidian.cmdprobe")):
        obs("import", folder)
        obs("enable", mod)
    for option in ("skip_intro", "skip_login", "skip_war_briefs", "skip_planet_scanning"):
        obs("set", "obsidian.qol", option, "true")
    obs("list")
    obs("deploy")
    obs("status")


def drive(out, *steps):
    r = subprocess.run([sys.executable, str(HERE / "drive.py"), str(out), *steps], text=True, capture_output=True)
    print(r.stdout.strip())
    if r.returncode:
        print(r.stderr.strip()[-2000:])
    return r.stdout


def scenario(name):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/admin/scenario?name={name}", data=b"", method="POST")
    try:
        print("scenario", urllib.request.urlopen(req, timeout=5).read().decode())
    except OSError as e:
        print("scenario switch failed:", e)


def look(out, tag):
    """Fresh status under the current scenario, the war screen, then back to the ship."""
    drive(out, "cmd:poll", "sleep:12", "cmd:state", f"cmd:menu campaign", "sleep:10", f"shot:war-{tag}",
          "cmd:cache", "cmd:close", "sleep:3")


def mission_run(out):
    """One real campaign mission on the custom war: roll the planets, launch, win through the API,
    hurry the end screens, then watch the uploads on the ship."""
    log = drive(out, "cmd:menu campaign", "sleep:10", "cmd:close", "sleep:4", "cmd:save",
                # Cyborgs: the custom war defend event sits on the bugs front, and while it runs the
                # war screen puts the planets of that front in the event region, so mission end reports no
                # completed planet there (calculate_region of the points differs). Seen in run 4.
                "cmd:campaign_mission 2","wait:MISSION READY:900", "shot:mission", "cmd:win",
                "wait:STATE mission_end:180", "sleep:6", "shot:mission-end")
    if "TIMEOUT" in log or "GAME GONE" in log:
        print("mission stopped early")
        return
    # The end screens count down by themselves (120 s, then 60 s for a completed planet); ready
    # players cut them short. Keep marking ready until the ship is back.
    steps = []
    for i in range(24):
        steps += ["cmd:ready", "sleep:8"]
        if i in (2, 8):
            steps.append(f"shot:end-{i}")
    drive(out, *steps)
    drive(out, "wait:SHIP AGAIN:600", "sleep:5", "cmd:state")
    # Each upload is a separate job; a wait that times out ends only that drive call.
    for callback in ("upload_statistics_callback", "completed_planets_callback", "leaderboard_stats_callback"):
        drive(out, f"wait:CALLBACK {callback}:150")
    drive(out, "sleep:10", "cmd:save", "cmd:state", "shot:ship-after")
    drive(out, "cmd:menu campaign", "sleep:10", "shot:war-after", "cmd:cache", "cmd:close", "sleep:3")


def finish_mission(out, tag):
    """Win, hurry the end screens, back to the ship."""
    drive(out, "cmd:win", "wait:STATE mission_end:180", "sleep:6", f"shot:{tag}-end")
    steps = []
    for _ in range(20):
        steps += ["cmd:ready", "sleep:8"]
    drive(out, *steps)
    drive(out, "wait:SHIP AGAIN:600", "sleep:15", "cmd:state", f"shot:{tag}-ship")


def hd2_run(out):
    """The HD2-model probes (docs/probe.md), safest first."""
    # A. The mod HTTP channel.
    drive(out, "cmd:http first", "wait:HTTP decoded:60", "sleep:2")
    # B. Planets rolled, then three of them made custom.
    drive(out, "cmd:menu campaign", "sleep:10", "shot:war-stock", "cmd:close", "sleep:4",
          "cmd:custom_planets 2", "cmd:planets")
    # C, D. Globe tinted, hidden, shown; the screen muted with the custom panel over it.
    drive(out, "cmd:menu campaign", "sleep:8", "cmd:tint on", "sleep:3", "shot:war-tint",
          "cmd:globe hide", "sleep:3", "shot:war-hidden", "cmd:globe show", "cmd:tint off", "sleep:3",
          "cmd:overlay mute", "sleep:3", "shot:war-overlay", "cmd:overlay off", "sleep:2", "shot:war-after-overlay",
          "cmd:close", "sleep:4")
    # B2. A region change rerolls the planets; the custom ones have to come back.
    scenario("minimal")
    drive(out, "cmd:poll", "sleep:12", "cmd:menu campaign", "sleep:10", "cmd:close", "sleep:3", "cmd:planets")
    scenario("custom")
    drive(out, "cmd:poll", "sleep:12", "cmd:menu campaign", "sleep:10", "cmd:close", "sleep:3", "cmd:planets", "cmd:save")
    # F. A custom planet through the pods and the countdown.
    log = drive(out, "cmd:pod_launch 2", "sleep:2", "cmd:menu_state", "sleep:3", "cmd:menu_state", "shot:pod",
                "sleep:5", "cmd:menu_state", "wait:MISSION READY:900", "shot:pod-mission")
    if "TIMEOUT" not in log and "GAME GONE" not in log:
        finish_mission(out, "pod")
        drive(out, "cmd:planets", "cmd:save")
    # E. Lobby data sizes (an engine refusal could be native, so after the main checks).
    drive(out, "cmd:lobby", "sleep:2")
    # G. A defend event mission on the stock path.
    log = drive(out, "cmd:event_mission", "wait:MISSION READY:900", "shot:event-mission")
    if "TIMEOUT" not in log and "GAME GONE" not in log:
        finish_mission(out, "event")
    drive(out, "cmd:http last", "wait:HTTP decoded:60", "cmd:save")


def play(tls, broken, mission=False):
    import server
    if game_running():
        sys.exit("the game is running; close it first")
    out = HERE / "runs" / time.strftime("%Y%m%d-%H%M%S")
    srv, probe = server.serve(PORT, "custom", out, tls=tls)
    if tls:
        # Plain HTTP is the only door of the admin channel, so a TLS run keeps a second server for it.
        print("TLS run: scenario switches need --tls off; this run stays on custom")
    scheme = "https" if tls else "http"
    CFG.write_text(f"url={scheme}://127.0.0.1:{PORT}/1.0/\nisolate_save=1\nblock_telemetry=1\n")
    try:
        log = drive(out, "launch", "wait:PROBE ready:300", "wait:STATE menu:900", "wait:POLL season=1162:240",
                    "sleep:5", "cmd:state", "cmd:save", "shot:ship")
        if "TIMEOUT" in log or "GAME GONE" in log:
            print("stopped early; see", out)
        elif mission == "hd2":
            hd2_run(out)
        elif mission == "event":
            log = drive(out, "cmd:event_mission", "wait:MISSION READY #1:900", "sleep:3", "shot:event-mission")
            if "TIMEOUT" not in log and "GAME GONE" not in log:
                finish_mission(out, "event")
                drive(out, "sleep:20", "cmd:save")
        elif mission:
            mission_run(out)
        else:
            look(out, "custom")
            if not tls:
                for name in ("minimal", "error", "replay") + (("broken",) if broken else ()):
                    scenario(name)
                    look(out, name)
    finally:
        drive(out, "log:200", "kill")
        try:
            CFG.unlink()
        except OSError:
            pass
        for name in ("cmdprobe.log", "loader.log"):
            src = LOGS / name
            if src.exists():
                shutil.copy2(src, out / name)
        srv.shutdown()
    print("run folder:", out)


def end():
    if game_running():
        subprocess.run(["taskkill", "/IM", "helldivers.exe", "/F"], capture_output=True)
        time.sleep(3)
    try:
        CFG.unlink()
    except OSError:
        pass
    obs("purge")
    if (STATE / "real-was-deployed.txt").read_text() == "yes":
        obs("deploy", real=True)
    obs("status", real=True)
    before = json.loads((STATE / "saves-before.json").read_text())
    after = hashes()
    changed = sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))
    print("REAL SAVES CHANGED" if changed else "real saves identical", changed[:20])
    probe_saves = sorted(str(p) for p in SAVES[0].glob("cmdprobe_*")) if SAVES[0].exists() else []
    print("probe saves:", probe_saves)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("verb", choices=("all", "begin", "play", "end"))
    ap.add_argument("--tls", action="store_true")
    ap.add_argument("--broken", action="store_true")
    ap.add_argument("--mission", action="store_true", help="play one campaign mission instead of the scenario tour")
    ap.add_argument("--hd2", action="store_true", help="the HD2-model probes instead of the scenario tour")
    ap.add_argument("--event", action="store_true", help="only a defend event mission on the stock path")
    a = ap.parse_args()
    if a.verb in ("all", "begin"):
        begin()
    if a.verb in ("all", "play"):
        play(a.tls, a.broken, "hd2" if a.hd2 else "event" if a.event else a.mission)
    if a.verb in ("all", "end"):
        end()


if __name__ == "__main__":
    main()
