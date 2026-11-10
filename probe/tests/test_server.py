"""Offline checks of the probe server: python -m unittest discover -s probe/tests"""
import json
import socket
import sys
import tempfile
import unittest
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import scenarios  # noqa: E402
import server  # noqa: E402

TICKET = "14000000DEADBEEFCAFE0123456789"


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class ProbeServer(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.port = free_port()
        self.srv, self.probe = server.serve(self.port, "custom", self.tmp.name)

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.tmp.cleanup()

    def post(self, **fields):
        body = urllib.parse.urlencode(fields).encode()
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/1.0/", data=body,
                                     headers={"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "sign": "abc"})
        return json.loads(urllib.request.urlopen(req, timeout=5).read())

    def switch(self, name):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/admin/scenario?name={name}", data=b"", method="POST")
        try:
            return json.loads(urllib.request.urlopen(req, timeout=5).read())
        except urllib.error.HTTPError as e:
            return json.loads(e.read())

    def auth(self):
        return json.dumps({"data": TICKET, "online_id": "110000100000000", "issuer_id": 256, "platform": "win32"})

    def log_lines(self):
        return [json.loads(l) for l in (Path(self.tmp.name) / "requests.jsonl").read_text().splitlines()]

    def test_custom_status_is_not_the_official_war(self):
        r = self.post(action="get_campaign_status")
        self.assertEqual(r["error_code"], 0)
        self.assertEqual([s["season"] for s in r["campaign_status"]], [scenarios.CUSTOM_SEASON] * 3)
        self.assertEqual(r["defend_event"]["event_id"], 9001)
        self.assertIn("statistics", r)

    def test_scenarios(self):
        self.assertTrue(self.switch("minimal")["ok"])
        self.assertEqual(sorted(self.post(action="get_campaign_status")), ["campaign_status", "error_code", "time"])
        self.switch("error")
        self.assertEqual(self.post(action="get_campaign_status")["error_code"], 3)
        self.switch("broken")
        self.assertNotIn("campaign_status", self.post(action="get_campaign_status"))
        self.switch("replay")
        r = self.post(action="get_campaign_status")
        self.assertEqual(r["campaign_status"][0]["season"], 162)
        self.assertFalse(self.switch("nonsense")["ok"])

    def test_writes_acknowledge_the_highest_index(self):
        stats = json.dumps([{"index": 3, "kills": 1}, {"index": 5, "kills": 2}])
        r = self.post(action="upload_statistics", auth=self.auth(), statistics=stats)
        self.assertEqual(r["uploaded_statistics"], 5)
        r = self.post(action="upload_leaderboard_statistics", auth=self.auth(), statistics=json.dumps([{"index": 2}]))
        self.assertEqual(r["uploaded_leaderboard_statistics"], 2)
        # The tamper report has no statistics, so no index: the game keeps its own.
        r = self.post(action="upload_statistics", auth=self.auth(), c="1234")
        self.assertNotIn("uploaded_statistics", r)

    def test_completed_planets_move_the_front(self):
        before = [s["points"] for s in self.post(action="get_campaign_status")["campaign_status"]]
        # As the game sent it in probe run 5, for a cyborg planet: enemy is 1-based here.
        planets = json.dumps([{"difficulty": 4, "enemy": 2, "index": 1, "season": 1162, "success": 0.700004995}])
        r = self.post(action="complete_planets", auth=self.auth(), planets=planets)
        self.assertEqual(r["completed_planets"], 1)
        after = [s["points"] for s in r["campaign_status"]]
        self.assertEqual(after, [before[0], before[1] + 4000, before[2]])
        failed = json.dumps([{"difficulty": 4, "enemy": 1, "index": 2, "season": 1162, "success": 0}])
        r = self.post(action="complete_planets", auth=self.auth(), planets=failed)
        self.assertEqual(r["campaign_status"][0]["points"], before[0])

    def test_ticket_never_reaches_the_log(self):
        self.post(action="upload_statistics", auth=self.auth(), statistics="[]")
        text = (Path(self.tmp.name) / "requests.jsonl").read_text()
        self.assertNotIn(TICKET, text)
        entry = [e for e in self.log_lines() if e.get("action") == "upload_statistics"][0]
        self.assertTrue(entry["fields"]["auth"]["redacted"])
        self.assertEqual(entry["fields"]["auth"]["data_length"], len(TICKET))
        self.assertTrue(entry["headers"]["sign"])

    def test_unknown_action(self):
        self.assertEqual(self.post(action="drop_tables")["error_code"], 3)


class Helpers(unittest.TestCase):
    def test_max_index(self):
        self.assertEqual(scenarios.max_index([{"index": 1}, {"index": 4}, {"x": 9}]), 4)
        self.assertIsNone(scenarios.max_index([]))
        self.assertIsNone(scenarios.max_index(None))
        self.assertEqual(scenarios.max_index({"a": {"index": 2}}), 2)

    def test_snapshot_data_is_a_json_string(self):
        r = scenarios.respond("custom", scenarios.War(), "get_snapshots", {})
        self.assertIsInstance(r["snapshots"][0]["data"], str)
        self.assertEqual(len(json.loads(r["snapshots"][0]["data"])), 3)


if __name__ == "__main__":
    unittest.main()
