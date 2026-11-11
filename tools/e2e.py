"""End-to-end check of a Commander package with no game: the real server from the package ZIP, the
game requests through the real Obsidian relay, the admin API, LAN discovery and the interface.

python tools/e2e.py [--zip internal/builds/obsidian-commander-<v>.zip] [--obsidian <ObsidianLauncher checkout>]

Unpacks the ZIP into %TEMP%/cmd-e2e (the same folder each run, so Windows asks about the firewall
once), starts the server on a free loopback port, creates a war, then:
  1. game requests shaped like the protocol.md samples, as the relay forwards them (no Steam ticket);
  2. the Obsidian relay test against this war (cargo test ... relay_reaches_a_real_war -- --ignored);
  3. GM actions through the admin API, and the state they leave;
  4. Open to LAN: the UDP announcement on port 17493, the read-only routes on the LAN listener;
  5. screenshots of the interface with headless Chrome or Edge, in the scratch folder given by
     --shots (default internal/e2e-shots).
Prints PASS or FAIL for each check and exits 1 on any failure.
"""
import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TOKEN = "e2etoken0123456789"
results = []


def check(name, ok, detail=""):
    ok = bool(ok)
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail and not ok else ""))


def http(method, url, body=None, headers=None, timeout=10):
    data = body.encode() if isinstance(body, str) else body
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def admin(base, method, path, obj=None):
    h = {"X-Commander-Token": TOKEN, "Content-Type": "application/json"}
    code, text = http(method, base + path, json.dumps(obj) if obj is not None else None, h)
    return code, (json.loads(text) if text.startswith(("{", "[")) else text)


def game(base, war, form, player="110000100000001"):
    h = {"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "X-Commander-Player": player}
    code, text = http("POST", f"{base}/w/{war}/1.0/", urllib.parse.urlencode(form), h)
    return code, json.loads(text)


def browser():
    for p in (r"C:\Program Files\Google\Chrome\Application\chrome.exe", r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"):
        if os.path.isfile(p):
            return p
    return None


def shot(exe, url, out, size="1440,860"):
    profile = tempfile.mkdtemp(prefix="cmd-e2e-browser-")
    try:
        subprocess.run([exe, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--user-data-dir={profile}", f"--window-size={size}",
                        "--virtual-time-budget=6000", f"--screenshot={out}", url], capture_output=True, timeout=90)
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    return Path(out).is_file()


def main():
    ap = argparse.ArgumentParser()
    builds = sorted((REPO / "internal" / "builds").glob("obsidian-commander-*.zip"))
    ap.add_argument("--zip", default=str(builds[-1]) if builds else None)
    ap.add_argument("--obsidian", default=str(REPO.parent / "ObsidianLauncher"))
    ap.add_argument("--shots", default=str(REPO / "internal" / "e2e-shots"))
    a = ap.parse_args()
    if not a.zip:
        sys.exit("no package: run tools/pack.py first")

    # The same folder each run: Windows keys the firewall answer on the server path, so a new
    # folder would ask again at Open to LAN and leave two more rules behind.
    work = Path(tempfile.gettempdir()) / "cmd-e2e"
    shutil.rmtree(work, ignore_errors=True)
    if work.exists():
        sys.exit(f"{work} is in use: is a server from an earlier run still open?")
    work.mkdir()
    pkg = work / "package"
    with zipfile.ZipFile(a.zip) as z:
        z.extractall(pkg)
    manifest = json.loads((pkg / "commander.json").read_text())
    check("package manifest", manifest.get("protocol") == 1 and (pkg / manifest["server"]).is_file() and (pkg / manifest["ui"] / "index.html").is_file())

    proc = subprocess.Popen([str(pkg / manifest["server"]), "--data", str(work / "data"), "--port", "0", "--token", TOKEN, "--ui", str(pkg / manifest["ui"])],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        line = proc.stdout.readline().strip()
        check("ready line", line.startswith("COMMANDER READY port="), line)
        port = int(line.split("port=")[1].split()[0])
        base = f"http://127.0.0.1:{port}"

        code, war = admin(base, "POST", "/api/wars", {"name": "E2E Offensive", "model": "vanilla"})
        check("create war", code in (200, 201) and bool(war.get("id")), f"{code} {str(war)[:160]}")
        wid = war["id"]
        # The game sends the game season; `season` in the admin view is the one people see, counted from 1.
        season = war.get("game_season", war["season"])

        # 1. The game requests.
        code, st = game(base, wid, {"action": "get_campaign_status"})
        rows = st.get("campaign_status", [])
        check("get_campaign_status", code == 200 and st.get("error_code") == 0 and len(rows) == 3 and rows[0].get("season") == season, str(st)[:200])
        stats = [{"index": 4, "enemy": 1, "season": season, "missions": 1, "successful_missions": 1, "mission_difficulty": 1, "players": 1,
                  "kills": 37, "deaths": 0, "shots": 0, "hits": 0, "accidentals": 0}]
        code, st = game(base, wid, {"action": "upload_statistics", "statistics": json.dumps(stats)})
        check("upload_statistics ack", st.get("uploaded_statistics") == 4, str(st)[:200])
        before = rows[1]["points"]
        planets = [{"index": 1, "enemy": 2, "season": season, "difficulty": 4, "success": 0.700004995}]
        code, st = game(base, wid, {"action": "complete_planets", "planets": json.dumps(planets)})
        after = st.get("campaign_status", [{}, {}])[1].get("points")
        check("complete_planets credits cyborgs (enemy 2, 1-based)", st.get("completed_planets") == 1 and after is not None and after > before, f"{before} -> {after}")
        code, st = game(base, wid, {"action": "complete_planets", "planets": json.dumps(planets)})
        again = st.get("campaign_status", [{}, {}])[1].get("points")
        check("the same planet index counts once", again == after, f"{after} -> {again}")
        for action in ("get_snapshots", "get_provinggrounds", "get_usernames", "get_available_entitlements", "get_leaderboards"):
            code, st = game(base, wid, {"action": action, "season": season, "count": 10, "network": "steam", "users": "[]"})
            check(f"{action} answers", code == 200 and st.get("error_code") == 0, str(st)[:160])

        # 2. The Obsidian relay against this war.
        if Path(a.obsidian, "core").is_dir():
            env = dict(os.environ, COMMANDER_E2E=f"{base}/w/{wid}/1.0/")
            r = subprocess.run(["cargo", "test", "-q", "-p", "obsidian-core", "--lib", "relay_reaches_a_real_war", "--", "--ignored", "--nocapture"],
                               cwd=a.obsidian, env=env, capture_output=True, text=True, timeout=900)
            check("the Obsidian relay carries the game to the war, ticket stripped", r.returncode == 0 and "E2E " in r.stdout, (r.stdout + r.stderr)[-600:])
            code, w = admin(base, "GET", f"/api/wars/{wid}")
            members = [m.get("player") for m in w.get("members", [])]
            relayed = [p for p in members if p and p != "110000100000001" and all(c in "0123456789abcdef" for c in p)]
            check("the relay player header names the member", len(relayed) == 1, str(members))
        else:
            print("SKIP relay: no ObsidianLauncher checkout at", a.obsidian)

        # 3. GM actions.
        code, w = admin(base, "POST", f"/api/wars/{wid}/actions", {"action": "push", "front": 0, "regions": 2})
        check("GM push moves the bugs front two regions", code == 200 and w["fronts"][0]["region"] >= 3, str(w.get("fronts", ""))[:200])
        code, w = admin(base, "POST", f"/api/wars/{wid}/actions", {"action": "start_defend", "front": 1, "region": 2, "duration": 3600, "points_max": 2000})
        ev = w.get("defend_event") or {}
        check("GM starts a defense", code == 200 and ev.get("status") == "active" and ev.get("enemy") == 1, str(ev))
        code, st = game(base, wid, {"action": "complete_defend_mission", "event_id": ev.get("event_id"), "difficulty": 5})
        got = (st.get("defend_event") or {}).get("points", 0)
        check("a defend mission credits the event", got > 0, str(st.get("defend_event")))
        code, w = admin(base, "POST", f"/api/wars/{wid}/actions", {"action": "pause"})
        check("pause", w.get("state") == "paused", w.get("state"))
        code, w = admin(base, "POST", f"/api/wars/{wid}/actions", {"action": "resume"})
        code, nope = admin(base, "POST", f"/api/wars/{wid}/actions", {"action": "nonsense"})
        check("an unknown action is refused", code == 400, str(nope)[:120])
        code, _ = http("GET", f"{base}/api/wars/{wid}")
        check("admin needs the token", code in (401, 403), str(code))
        code, feed = admin(base, "GET", f"/api/wars/{wid}/feed")
        check("feed lists what happened", code == 200 and len(feed.get("entries", [])) >= 3, str(feed)[:200])

        # 4. LAN.
        listen = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        listen.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listen.bind(("0.0.0.0", 17493))
        listen.settimeout(8)
        code, lan = admin(base, "POST", f"/api/wars/{wid}/lan", {"open": True})
        check("open to LAN", code == 200 and lan.get("open") and lan.get("port"), str(lan))
        try:
            data, src = listen.recvfrom(4096)
            pkt = json.loads(data)
            check("LAN announcement", pkt.get("commander") == 1 and pkt.get("war") == wid and pkt.get("port") == lan["port"], str(pkt))
        except socket.timeout:
            check("LAN announcement", False, "nothing heard in 8 s")
        finally:
            listen.close()
        lan_base = f"http://127.0.0.1:{lan['port']}"
        code, w = http("GET", f"{lan_base}/api/wars/{wid}")
        check("LAN guests read the war", code == 200, str(code))
        code, _ = http("POST", f"{lan_base}/api/wars/{wid}/actions", json.dumps({"action": "pause"}), {"Content-Type": "application/json", "X-Commander-Token": TOKEN})
        check("LAN guests can't act, even with the token", code == 404, str(code))
        code, st = game(lan_base, wid, {"action": "get_campaign_status"})
        check("the game API answers on the LAN listener", code == 200 and st.get("error_code") == 0)

        # 5. Screens.
        exe = browser()
        if exe:
            out = Path(a.shots)
            out.mkdir(parents=True, exist_ok=True)
            ok1 = shot(exe, f"{base}/?token={TOKEN}", str(out / "list.png"))
            ok2 = shot(exe, f"{base}/?token={TOKEN}#/war/{wid}", str(out / "war.png"))
            ok3 = shot(exe, f"{lan_base}/?war={wid}", str(out / "lan-guest.png"))
            check("screenshots taken", ok1 and ok2 and ok3, str(out))
            print("shots in", out)
        else:
            print("SKIP screenshots: no Chrome or Edge")
        admin(base, "POST", f"/api/wars/{wid}/lan", {"open": False})
    finally:
        try:
            proc.stdin.close()
            proc.wait(timeout=5)
            check("server exits when stdin closes", proc.returncode is not None)
        except subprocess.TimeoutExpired:
            proc.kill()
            check("server exits when stdin closes", False)
        shutil.rmtree(work, ignore_errors=True)
    print(f"\n{sum(results)} of {len(results)} checks passed")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
