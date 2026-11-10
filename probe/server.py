"""Commander probe server: answers the HD1 war API on loopback and writes down every request.

python server.py [--port 17491] [--scenario custom] [--out runs/<time>] [--tls]

The game posts form fields to /1.0/; see docs/protocol.md. Every request goes to requests.jsonl in
the output folder, with the Steam ticket in `auth` replaced by the ticket size and keys. JSON fields
(planets, statistics, users) are decoded beside the raw text.

Control, from the same machine only:
  GET  /admin/state              scenario, request count and the war points
  POST /admin/scenario?name=...  switch scenario (custom, minimal, replay, error, broken)

--tls serves HTTPS with a throwaway self-signed certificate made by openssl, for the case where the
game refuses plain HTTP.
"""
import argparse
import json
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scenarios  # noqa: E402

JSON_FIELDS = ("planets", "statistics", "users")
MAX_BODY = 4 * 1024 * 1024


def redact_auth(text):
    """Keeps the shape of the auth blob, never the ticket."""
    try:
        blob = json.loads(text)
    except ValueError:
        return {"redacted": True, "length": len(text), "json": False}
    out = {"redacted": True, "length": len(text), "keys": sorted(blob) if isinstance(blob, dict) else None}
    if isinstance(blob, dict):
        for key in ("platform", "issuer_id"):
            if key in blob:
                out[key] = blob[key]
        if isinstance(blob.get("data"), str):
            out["data_length"] = len(blob["data"])
    return out


def decode_form(body):
    """Form fields as plain strings, plus <name>_json for the JSON ones."""
    fields = {k: v[0] for k, v in parse_qs(body, keep_blank_values=True).items()}
    params = dict(fields)
    for name in JSON_FIELDS:
        if name in fields:
            try:
                params[name + "_json"] = json.loads(fields[name])
            except ValueError:
                params[name + "_json"] = None
    return fields, params


class Probe:
    def __init__(self, out_dir, scenario):
        self.out = Path(out_dir)
        self.out.mkdir(parents=True, exist_ok=True)
        self.scenario = scenario
        self.war = scenarios.War()
        self.count = 0
        self.lock = threading.Lock()
        self.log_path = self.out / "requests.jsonl"

    def record(self, entry):
        with self.lock:
            self.count += 1
            entry["n"] = self.count
            with self.log_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def set_scenario(self, name):
        if name not in scenarios.SCENARIOS:
            return False
        with self.lock:
            self.scenario = name
        self.record({"t": time.time(), "admin": "scenario", "scenario": name})
        return True


def make_handler(probe):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "CommanderProbe/0.1"

        def log_message(self, *args):
            pass

        def send_json(self, code, obj):
            data = json.dumps(obj, separators=(",", ":")).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return data

        def read_body(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                return None
            return self.rfile.read(length).decode("utf-8", errors="replace") if length else ""

        def do_GET(self):
            url = urlparse(self.path)
            if url.path == "/admin/state":
                self.send_json(200, {"scenario": probe.scenario, "requests": probe.count, "points": probe.war.points})
                return
            probe.record({"t": time.time(), "method": "GET", "path": self.path})
            self.send_json(404, {"error": "not found"})

        def do_POST(self):
            url = urlparse(self.path)
            body = self.read_body()
            if body is None:
                self.send_json(413, {"error": "too large"})
                return
            if url.path.startswith("/commander/"):
                # The companion mod channel (HD2-model probe): echo what arrived.
                try:
                    got = json.loads(body) if body else None
                except ValueError:
                    got = None
                probe.record({"t": time.time(), "method": "POST", "path": self.path, "commander": got,
                              "content_type": self.headers.get("Content-Type"), "bytes": len(body)})
                self.send_json(200, {"ok": True, "path": url.path, "echo": got, "war": {"planet": "cmdwar_planet_1", "liberation": 0.42}})
                return
            if url.path == "/admin/scenario":
                name = parse_qs(url.query).get("name", [""])[0]
                ok = probe.set_scenario(name)
                self.send_json(200 if ok else 400, {"ok": ok, "scenario": probe.scenario})
                return

            fields, params = decode_form(body)
            action = fields.get("action", "")
            entry = {
                "t": time.time(), "method": "POST", "path": self.path, "action": action,
                "scenario": probe.scenario,
                "headers": {"content_type": self.headers.get("Content-Type"),
                            "sign": bool(self.headers.get("sign")),
                            "sign_length": len(self.headers.get("sign") or ""),
                            "user_agent": self.headers.get("User-Agent")},
                "fields": {k: (redact_auth(v) if k == "auth" else v) for k, v in fields.items() if k not in JSON_FIELDS},
            }
            for name in JSON_FIELDS:
                if name in fields:
                    entry["fields"][name] = params.get(name + "_json") if params.get(name + "_json") is not None else fields[name]
            if not url.path.rstrip("/").endswith("/1.0"):
                entry["note"] = "unexpected path"
            with probe.lock:
                scenario = probe.scenario
                reply = scenarios.respond(scenario, probe.war, action, params)
            data = self.send_json(200, reply)
            entry["reply_bytes"] = len(data)
            entry["reply_error_code"] = reply.get("error_code")
            entry["reply_keys"] = sorted(reply)
            probe.record(entry)

    return Handler


def make_cert(folder):
    """A self-signed loopback certificate, made fresh for each run and kept in the run folder."""
    cert, key = folder / "probe-cert.pem", folder / "probe-key.pem"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
                    "-subj", "/CN=127.0.0.1", "-keyout", str(key), "-out", str(cert)],
                   check=True, capture_output=True)
    return cert, key


def serve(port, scenario, out_dir, tls=False):
    """Starts the server on 127.0.0.1 in a thread; returns (server, probe)."""
    probe = Probe(out_dir, scenario)
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(probe))
    if tls:
        import ssl
        cert, key = make_cert(probe.out)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    probe.record({"t": time.time(), "admin": "start", "port": port, "scenario": scenario, "tls": tls})
    return server, probe


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=17491)
    ap.add_argument("--scenario", default="custom", choices=scenarios.SCENARIOS)
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent / "runs" / time.strftime("%Y%m%d-%H%M%S")))
    ap.add_argument("--tls", action="store_true")
    a = ap.parse_args()
    server, probe = serve(a.port, a.scenario, a.out, a.tls)
    scheme = "https" if a.tls else "http"
    print(f"probe server on {scheme}://127.0.0.1:{a.port}/1.0/  scenario={a.scenario}  log={probe.log_path}")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
