"""Checks a package signature the way Obsidian does before it installs a download, so a release never
goes out with a signature that Obsidian would refuse.

python tools/verify_sig.py <zip> [<zip>.sig]

The public key is the one in the Obsidian Launcher (`PACKAGE_KEY` in core/src/commander/package.rs,
the same as `plugins.updater.pubkey` in tauri.conf.json); OBSIDIAN_PACKAGE_KEY replaces it for a test.
The signature is the minisign file `tauri signer sign` writes, in base64. Needs PyNaCl.
"""
import base64
import hashlib
import os
import sys
from pathlib import Path

KEY = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IENFMDk3NEVCQ0Q4M0YwMTAKUldRUThJUE42M1FKem84YlozRG44OUJuenJvRzNGeE9sajE4R2NpeHFXY3NoZEtUdEtuSmtIbFkK"


def lines(b64):
    return base64.b64decode(b64).decode("utf-8").splitlines()


def verify(data, sig_b64, key_b64):
    from nacl.signing import VerifyKey

    key = base64.b64decode(lines(key_b64)[1])
    if key[:2] != b"Ed" or len(key) != 42:
        return "the public key is not a minisign key"
    sig_lines = lines(sig_b64)
    sig = base64.b64decode(sig_lines[1])
    if len(sig) != 74 or sig[:2] not in (b"Ed", b"ED"):
        return "the file is not a minisign signature"
    if sig[2:10] != key[2:10]:
        return "the signature was made with another key"
    message = hashlib.blake2b(data, digest_size=64).digest() if sig[:2] == b"ED" else data
    verify_key = VerifyKey(key[10:])
    try:
        verify_key.verify(message, sig[10:])
        # The second signature covers the first and the trusted comment, as minisign checks it.
        comment = sig_lines[2][len("trusted comment: "):].encode("utf-8")
        verify_key.verify(sig[10:] + comment, base64.b64decode(sig_lines[3]))
    except Exception:
        return "the signature does not match the file"
    return None


def main():
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    zip_path = Path(sys.argv[1])
    sig_path = Path(sys.argv[2]) if len(sys.argv) == 3 else Path(str(zip_path) + ".sig")
    why = verify(zip_path.read_bytes(), sig_path.read_text(encoding="utf-8").strip(), os.environ.get("OBSIDIAN_PACKAGE_KEY", KEY))
    if why:
        sys.exit(f"{sig_path.name}: {why}")
    print(f"{sig_path.name} is a valid signature of {zip_path.name}")


if __name__ == "__main__":
    main()
