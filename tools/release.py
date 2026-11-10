"""Publishes a Commander release on GitHub: the tag, the release text and the package ZIP that Obsidian's
Install Package downloads.

python tools/release.py <version> <notes.md>

Needs internal/builds/obsidian-commander-<version>.zip (tools/pack.py) and a clean, pushed main. The
token is the one git pushes with, read from Git Credential Manager for the account Alomare and never
printed. Refuses a version whose tag or release already exists.
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = "Alomare/ObsidianCommander"
ROOT = Path(__file__).resolve().parent.parent
API = "https://api.github.com"
_token = None


def token():
    global _token
    if _token is None:
        env = {**os.environ, "GCM_INTERACTIVE": "never", "GIT_TERMINAL_PROMPT": "0"}
        out = subprocess.run(["git", "credential", "fill"], input="protocol=https\nhost=github.com\nusername=Alomare\n\n",
                             capture_output=True, text=True, env=env).stdout
        _token = next((l[len("password="):] for l in out.splitlines() if l.startswith("password=")), "")
        if not _token:
            sys.exit("no GitHub credential for Alomare in Git Credential Manager")
    return _token


def call(method, url, body=None, data=None, content_type="application/json"):
    payload = data if data is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url if url.startswith("http") else API + url, method=method, data=payload,
                                 headers={"Authorization": f"Bearer {token()}", "Accept": "application/vnd.github+json",
                                          "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "commander-release",
                                          "Content-Type": content_type})
    with urllib.request.urlopen(req, timeout=300) as r:
        raw = r.read()
    return json.loads(raw) if raw else None


def git(*args):
    env = {**os.environ, "GCM_INTERACTIVE": "never", "GIT_TERMINAL_PROMPT": "0"}
    r = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, env=env)
    if r.returncode:
        sys.exit(f"git {' '.join(args)}: {r.stderr.strip()}")
    return r.stdout.strip()


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    version, notes = sys.argv[1], Path(sys.argv[2]).read_text(encoding="utf-8")
    tag = f"v{version}"
    asset = ROOT / "internal" / "builds" / f"obsidian-commander-{version}.zip"
    if not asset.is_file():
        sys.exit(f"no {asset}: run tools/pack.py")
    if git("status", "--porcelain"):
        sys.exit("the working tree has changes")
    git("fetch", "-q", "origin")
    if git("rev-parse", "HEAD") != git("rev-parse", "origin/main"):
        sys.exit("main isn't pushed")
    try:
        call("GET", f"/repos/{REPO}/releases/tags/{tag}")
        sys.exit(f"release {tag} already exists")
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
    if tag not in git("tag", "--list", tag).split():
        git("tag", "-a", tag, "-m", f"Obsidian Commander {version}")
    git("push", "-q", "origin", tag)
    rel = call("POST", f"/repos/{REPO}/releases", {"tag_name": tag, "name": f"Obsidian Commander {version}", "body": notes, "draft": False, "prerelease": False})
    up = rel["upload_url"].split("{")[0] + f"?name={asset.name}"
    call("POST", up, data=asset.read_bytes(), content_type="application/zip")
    print(f"published {rel['html_url']} with {asset.name}")


if __name__ == "__main__":
    main()
