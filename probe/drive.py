"""Drives a live game for the Commander probe (copied from Helldivers Arcade, file names changed).

python drive.py <outdir> step step step ...
Steps: launch | kill | wait:<log text>[:seconds] | cmd:<tour command> | key:<NAME> | click:x,y | move:x,y |
       sleep:<seconds> | shot:<name> | log:<n>
Coordinates are 1280x720 game units from the top left of the centred 16:9 area.
"""
import ctypes
import os
import subprocess
import sys
import time
from ctypes import wintypes
from pathlib import Path

from PIL import ImageGrab

user32 = ctypes.windll.user32
ctypes.windll.shcore.SetProcessDpiAwareness(2)
LOGS = Path(os.environ["APPDATA"]) / "Arrowhead/Helldivers/ObsidianLauncher/logs"
OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)
SCAN = {"ESC": 1, "ENTER": 0x1c, "SPACE": 0x39, "TAB": 0xf, "UP": 0xc8, "DOWN": 0xd0, "LEFT": 0xcb, "RIGHT": 0xcd, "W": 0x11, "A": 0x1e, "S": 0x1f, "D": 0x20,
        "E": 0x12, "Q": 0x10, "R": 0x13, "F": 0x21, "M": 0x32, "F6": 0x40, "F7": 0x41, "LALT": 0x38, "CAPS": 0x3a, "C": 0x2e, "G": 0x22, "T": 0x14, "Z": 0x2c, "X": 0x2d, "CTRL": 0x1d, "SHIFT": 0x2a, "1": 2, "2": 3, "3": 4, "4": 5}
EXT = {"UP", "DOWN", "LEFT", "RIGHT"}


class KI(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("extra", ctypes.c_size_t), ("pad", ctypes.c_ulong * 2)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("ki", KI)]


def key_event(name, up):
    flags = 0x8 | (0x2 if up else 0) | (0x1 if name in EXT else 0)
    i = INPUT(1, KI(0, SCAN[name], flags, 0, 0))
    user32.SendInput(1, ctypes.byref(i), ctypes.sizeof(i))


def window():
    found = []
    def each(h, _):
        n = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(h, n, 256)
        if n.value == "Helldivers" and user32.IsWindowVisible(h):
            found.append(h)
        return True
    user32.EnumWindows(ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)(each), 0)
    return found[0] if found else None


def alive():
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq helldivers.exe"], capture_output=True, text=True).stdout
    return "helldivers.exe" in out.lower()


def focus():
    h = window()
    if not h:
        return False
    user32.keybd_event(0x12, 0, 0, 0)
    user32.SetForegroundWindow(h)
    user32.keybd_event(0x12, 0, 2, 0)
    time.sleep(0.15)
    return user32.GetForegroundWindow() == h


def rect():
    h = window()
    r = wintypes.RECT()
    user32.GetClientRect(h, ctypes.byref(r))
    p = wintypes.POINT(0, 0)
    user32.ClientToScreen(h, ctypes.byref(p))
    return p.x, p.y, r.right, r.bottom


def to_screen(x, y):
    left, top, w, h = rect()
    s = min(w / 1280, h / 720)
    return int(left + (w - 1280 * s) / 2 + x * s), int(top + (h - 720 * s) / 2 + y * s)


USER_SCALE = 0.8


def design(x, y):
    """A point of the 1920x1080 design space, y down as on the concept boards, to the screen."""
    left, top, w, h = rect()
    s = min(w / 1920, h / 1080) * USER_SCALE
    return int(left + (w - 1920 * s) / 2 + x * s), int(top + (h - 1080 * s) / 2 + y * s)


def run(step):
    verb, _, rest = step.partition(":")
    if verb == "launch":
        for f in ("cmdprobe.log", "cmdprobe.cmd", "cmdprobe.ack"):
            try:
                (LOGS / f).unlink()
            except OSError:
                pass
        os.startfile("steam://rungameid/394510")
        print("launching")
    elif verb == "seed":
        (LOGS / "cmdprobe.boot").write_text(rest + "\n")
    elif verb == "kill":
        subprocess.run(["taskkill", "/IM", "helldivers.exe", "/F"], capture_output=True)
        print("killed")
    elif verb == "wait":
        text, _, secs = rest.partition(":")
        limit = time.time() + float(secs or 120)
        seen_game = False
        while time.time() < limit:
            f = LOGS / "cmdprobe.log"
            if f.exists() and text in f.read_text(errors="replace"):
                print("saw", text)
                return True
            now = alive()
            seen_game = seen_game or now
            if seen_game and not now:
                print("GAME GONE while waiting for", text)
                return False
            time.sleep(0.5)
        print("TIMEOUT waiting for", text)
        return False
    elif verb == "cmd":
        ack = LOGS / "cmdprobe.ack"
        if ack.exists():
            ack.unlink()
        (LOGS / "cmdprobe.cmd.tmp").write_text(rest + "\n")
        os.replace(LOGS / "cmdprobe.cmd.tmp", LOGS / "cmdprobe.cmd")
        limit = time.time() + 15
        while time.time() < limit:
            if ack.exists():
                print("ack", ack.read_text().strip())
                return True
            time.sleep(0.1)
        print("no ack for", rest)
    elif verb == "key":
        focus()
        for name in rest.split("+"):
            key_event(name, False)
        time.sleep(0.09)
        for name in reversed(rest.split("+")):
            key_event(name, True)
        time.sleep(0.25)
    elif verb == "down":
        focus()
        key_event(rest, False)
    elif verb == "up":
        focus()
        key_event(rest, True)
    elif verb in ("click", "move", "dclick", "dmove"):
        focus()
        x, y = (float(n) for n in rest.split(","))
        sx, sy = design(x, y) if verb[0] == "d" else to_screen(x, y)
        user32.SetCursorPos(sx, sy)
        time.sleep(0.2)
        if verb in ("click", "dclick"):
            user32.mouse_event(2, 0, 0, 0, 0)
            time.sleep(0.09)
            user32.mouse_event(4, 0, 0, 0, 0)
            time.sleep(0.25)
    elif verb in ("mdown", "mup"):
        focus()
        user32.mouse_event(2 if verb == "mdown" else 4, 0, 0, 0, 0)
    elif verb == "sleep":
        time.sleep(float(rest))
    elif verb == "shot":
        focus()
        time.sleep(0.1)
        left, top, w, h = rect()
        image = ImageGrab.grab(bbox=(left, top, left + w, top + h), all_screens=True)
        image.save(OUT / (rest + ".png"))
        small = image.copy()
        small.thumbnail((1376, 1376))
        small.save(OUT / (rest + "_s.png"))
        print("shot", rest, image.size, "foreground ok" if user32.GetForegroundWindow() == window() else "NOT FOREGROUND")
    elif verb == "log":
        for f in ("loader.log", "cmdprobe.log"):
            p = LOGS / f
            if p.exists():
                print("--", f)
                print("\n".join(p.read_text(errors="replace").splitlines()[-int(rest or 12):]))
    else:
        print("unknown step", step)
    return True


for s in sys.argv[2:]:
    if run(s) is False:
        print("stopping at", s)
        break
