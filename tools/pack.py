"""Builds the Commander package ZIP that Obsidian installs (docs/spec-m1.md, section 1).

python tools/pack.py [--no-build]

Builds the server (cargo build --release) and the interface (npm run build) unless --no-build, then
writes internal/builds/obsidian-commander-<version>.zip:

    commander.json, commander-server.exe, ui/..., LICENSE, THIRD-PARTY-NOTICES.txt

The version comes from the server crate. The interface mock file stays out: it only serves `?mock=1`
during development.
"""
import argparse
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SERVER = REPO / "server"
UI = REPO / "ui"
OUT = REPO / "internal" / "builds"
PROTOCOL = 1


def version():
    text = (SERVER / "Cargo.toml").read_text(encoding="utf-8")
    m = re.search(r'^version\s*=\s*"([^"]+)"', text, re.M)
    if not m:
        sys.exit("no version in server/Cargo.toml")
    return m.group(1)


def run(cmd, cwd):
    print(">", " ".join(cmd))
    r = subprocess.run(cmd, cwd=cwd, shell=sys.platform == "win32")
    if r.returncode:
        sys.exit(f"failed: {' '.join(cmd)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-build", action="store_true")
    a = ap.parse_args()
    if not a.no_build:
        run(["cargo", "build", "--release"], SERVER)
        run(["npm", "run", "build"], UI)
    exe = SERVER / "target" / "release" / "commander-server.exe"
    dist = UI / "dist"
    if not exe.is_file() or not (dist / "index.html").is_file():
        sys.exit("build the server and the interface first")
    v = version()
    OUT.mkdir(parents=True, exist_ok=True)
    out = OUT / f"obsidian-commander-{v}.zip"
    manifest = {"name": "Obsidian Commander", "version": v, "protocol": PROTOCOL, "server": "commander-server.exe", "ui": "ui"}
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("commander.json", json.dumps(manifest, indent=2) + "\n")
        z.write(exe, "commander-server.exe")
        for f in sorted(dist.rglob("*")):
            if f.is_file() and "mock" not in f.name.lower():
                z.write(f, "ui/" + f.relative_to(dist).as_posix())
        for name in ("LICENSE", "THIRD-PARTY-NOTICES.txt"):
            z.write(REPO / name, name)
    print(f"wrote {out} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
