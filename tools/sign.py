"""Signs a Commander package ZIP with the key Obsidian updates are signed with. Obsidian installs a
downloaded package only when the release holds this signature.

python tools/sign.py <version> [--obsidian <ObsidianLauncher checkout>] [--key <private key file>]

Reads internal/builds/obsidian-commander-<version>.zip and writes obsidian-commander-<version>.zip.sig
beside it. The password of the key is asked for here and handed to the signer through the
environment of that one process: it is never printed, stored or put on a command line. The key file
defaults to internal/release/obsidian-updater.key in the ObsidianLauncher checkout beside this
repository, and the signer is the Tauri CLI installed there (app/node_modules).
"""
import argparse
import getpass
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("version")
    ap.add_argument("--obsidian", type=Path, default=ROOT.parent / "ObsidianLauncher")
    ap.add_argument("--key", type=Path)
    args = ap.parse_args()
    zip_path = ROOT / "internal" / "builds" / f"obsidian-commander-{args.version}.zip"
    if not zip_path.is_file():
        sys.exit(f"no {zip_path}: run tools/pack.py")
    key = args.key or args.obsidian / "internal" / "release" / "obsidian-updater.key"
    app = args.obsidian / "app"
    if not key.is_file():
        sys.exit(f"no key file at {key}")
    if not (app / "node_modules" / "@tauri-apps" / "cli").is_dir():
        sys.exit(f"the Tauri CLI isn't installed in {app}: run npm ci there")
    npx = shutil.which("npx")
    if not npx:
        sys.exit("npx isn't on the PATH (Node.js)")
    password = os.environ["TAURI_SIGNING_PRIVATE_KEY_PASSWORD"] if "TAURI_SIGNING_PRIVATE_KEY_PASSWORD" in os.environ else getpass.getpass("Password of the updater key: ")
    env = {**os.environ, "TAURI_SIGNING_PRIVATE_KEY_PASSWORD": password}
    env.pop("TAURI_SIGNING_PRIVATE_KEY", None)
    sig = Path(str(zip_path) + ".sig")
    sig.unlink(missing_ok=True)
    r = subprocess.run([npx, "tauri", "signer", "sign", "-f", str(key), str(zip_path)], cwd=app, env=env, capture_output=True, text=True)
    if r.returncode or not sig.is_file():
        # The signer's own words, without the lines that would repeat the signature.
        why = (r.stderr or r.stdout).strip().splitlines()
        sys.exit("signing failed: " + (why[-1] if why else "no output") + " (a wrong password is the usual reason)")
    print(f"{sig.name} written. Next: python tools/release.py {args.version} internal/release-{args.version}.md")


if __name__ == "__main__":
    main()
