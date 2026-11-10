"""Responses the probe server gives, by scenario. Each builds a fresh dict so the clock is current.

custom   a war that can't be mistaken for the official one: season 1162, distinctive points, an
         active defend event against the bugs. Completed planets move the front, so a write shows up.
minimal  only time, error_code and campaign_status, with other points: the smallest status the game
         may accept.
replay   the official answers captured on 2026-11-04, with the clock refreshed.
error    error_code 3 for every action: the game should go offline and retry.
broken   error_code 0 with no campaign_status. Expected to break the war screen; run it last.
"""
import copy
import json
import time
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures" / "official-2026-11-04"
SCENARIOS = ("custom", "minimal", "replay", "error", "broken")
CUSTOM_SEASON = 1162
ENEMIES = ("bugs", "cyborgs", "illuminates")


def load_fixture(name):
    return json.loads((FIXTURES / name).read_text())


class War:
    """The probe's whole war state. Only the custom scenario's points move."""

    def __init__(self):
        now = int(time.time())
        self.season_start = now - 3 * 86400
        self.points_max = [100000, 100000, 100000]
        self.points = [45000, 12000, 78000]
        self.points_taken = [0, 0, 0]
        self.event_id = 9001
        self.event_start = now - 3600
        self.event_end = now + 2 * 3600
        self.event_points = 1200
        self.event_points_max = 5000
        self.planets_completed = [0, 0, 0]

    def status_rows(self, season=CUSTOM_SEASON, points=None):
        points = points or self.points
        return [{"season": season, "points": points[i], "points_taken": self.points_taken[i],
                 "points_max": self.points_max[i], "status": "active", "introduction_order": i}
                for i in range(3)]

    def defend_event(self, now):
        status = "active" if now < self.event_end else "fail"
        return {"season": CUSTOM_SEASON, "event_id": self.event_id, "start_time": self.event_start,
                "end_time": self.event_end, "region": 3, "enemy": 0, "points_max": self.event_points_max,
                "points": self.event_points, "status": status}

    def statistics(self):
        rows = []
        for i in range(3):
            rows.append({"season": CUSTOM_SEASON, "season_duration": int(time.time()) - self.season_start, "enemy": i,
                         "players": 1, "total_unique_players": 1, "missions": 7 + i, "successful_missions": 5 + i,
                         "total_mission_difficulty": 20 + i, "completed_planets": self.planets_completed[i],
                         "defend_events": 1, "successful_defend_events": 0, "attack_events": 0,
                         "successful_attack_events": 0, "deaths": 11, "kills": 1162 + i, "accidentals": 3,
                         "shots": 9000, "hits": 4000})
        return rows

    def complete_planets(self, planets):
        """A planet completion gives 1000 points per difficulty level to that front, capped at max.

        Here `enemy` is the planet's own field, 1-based (1 bugs, 2 cyborgs, 3 illuminates), unlike
        every other enemy number in the protocol: probe run 5 sent enemy 2 for a cyborg planet whose
        upload_statistics said enemy 1. `success` is a fraction (0.700004995 there), `difficulty` the
        sum of (mission difficulty + 1) over the planet's missions."""
        for p in planets:
            if not isinstance(p, dict):
                continue
            enemy = p.get("enemy")
            if not isinstance(enemy, int) or not 1 <= enemy <= 3:
                continue
            enemy -= 1
            success = p.get("success")
            if not isinstance(success, (int, float)) or success <= 0:
                continue
            gain = 1000 * max(1, int(p.get("difficulty") or 1))
            self.points[enemy] = min(self.points_max[enemy], self.points[enemy] + gain)
            self.planets_completed[enemy] += 1


def base(now, code=0, message=None):
    out = {"time": now, "error_code": code}
    if message:
        out["error_message"] = message
    return out


def max_index(items):
    """The highest `index` among the queue entries the game sent; the game drops entries up to it."""
    best = None
    if isinstance(items, dict):
        items = list(items.values())
    for item in items if isinstance(items, list) else []:
        if isinstance(item, dict) and isinstance(item.get("index"), (int, float)):
            best = item["index"] if best is None else max(best, item["index"])
    return int(best) if best is not None else None


def respond(scenario, war, action, params):
    """The JSON body for one request. params holds the decoded form fields."""
    now = int(time.time())
    if scenario == "error":
        return base(now, 3, "Missing or invalid arguments")

    if scenario == "replay":
        return replay(now, action, params)

    if action == "get_campaign_status":
        if scenario == "broken":
            return base(now)
        if scenario == "minimal":
            out = base(now)
            out["campaign_status"] = war.status_rows(points=[55000, 25000, 61000])
            return out
        out = base(now)
        out["campaign_status"] = war.status_rows()
        out["defend_event"] = war.defend_event(now)
        out["attack_events"] = []
        out["statistics"] = war.statistics()
        return out

    if action == "get_snapshots":
        out = base(now)
        out["introduction_order"] = [0, 1, 2]
        out["points_max"] = list(war.points_max)
        rows = [{"points": war.points[i], "points_taken": war.points_taken[i], "status": "active"} for i in range(3)]
        out["snapshots"] = [{"season": CUSTOM_SEASON, "time": war.season_start, "data": json.dumps(rows)}]
        out["defend_events"] = [war.defend_event(now)]
        out["attack_events"] = []
        return out

    if action == "get_defend_event_by_id":
        out = base(now)
        out["defend_event"] = war.defend_event(now)
        return out
    if action == "get_attack_event_by_id":
        return base(now, 3, "Missing or invalid arguments")
    if action == "get_season_statistics":
        out = base(now)
        out["statistics"] = war.statistics()
        return out
    if action == "get_provinggrounds":
        return replay(now, action, params)
    if action == "get_available_entitlements":
        return replay(now, action, params)
    if action in ("get_leaderboards", "get_leaderboards_provinggrounds"):
        out = base(now)
        out["leaderboards"] = []
        out["user_leaderboards"] = []
        return out
    if action == "get_top_of_leaderboard_provinggrounds":
        out = base(now)
        out["experts"] = []
        return out
    if action == "get_usernames":
        out = base(now)
        out["usernames"] = []
        return out

    # Writes. Each answer carries the highest queue index taken, as the official server's does.
    if action == "complete_planets":
        planets = params.get("planets_json")
        war.complete_planets(planets if isinstance(planets, list) else [])
        out = base(now)
        out["campaign_status"] = war.status_rows()
        idx = max_index(planets)
        if idx is not None:
            out["completed_planets"] = idx
        return out
    if action == "upload_statistics":
        out = base(now)
        idx = max_index(params.get("statistics_json"))
        if idx is not None:
            out["uploaded_statistics"] = idx
        return out
    if action == "upload_leaderboard_statistics":
        out = base(now)
        idx = max_index(params.get("statistics_json"))
        if idx is not None:
            out["uploaded_leaderboard_statistics"] = idx
        return out
    if action == "upload_leaderboard_provinggrounds_statistics":
        out = base(now)
        idx = max_index(params.get("statistics_json"))
        if idx is not None:
            out["uploaded_leaderboard_provinggrounds_statistics"] = idx
        return out
    if action in ("complete_defend_mission", "complete_attack_mission"):
        war.event_points = min(war.event_points_max, war.event_points + 250)
        return respond(scenario, war, "get_campaign_status", {})

    return base(now, 3, "Missing or invalid arguments")


def replay(now, action, params):
    season = params.get("season")
    if action == "get_campaign_status":
        name = "get_campaign_status_season_161.json" if season == "161" else "get_campaign_status.json"
    elif action == "get_snapshots":
        name = "get_snapshots_season_161.json"
    elif action == "get_season_statistics":
        name = "get_season_statistics_season_161.json"
    elif action == "get_provinggrounds":
        name = "get_provinggrounds.json"
    elif action == "get_available_entitlements":
        name = "get_available_entitlements.json"
    else:
        return base(now, 3, "Missing or invalid arguments")
    out = copy.deepcopy(load_fixture(name))
    out["time"] = now
    return out
