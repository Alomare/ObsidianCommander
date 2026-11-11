"""Builds data/galaxy-hd2.json, the Evolved war map: the HELLDIVERS 2 galaxy layout (planet names,
positions, sectors and supply lines) with each planet given a HELLDIVERS environment and a starting
owner, plus the shapes every map draws from.

Usage: python -I tools/build_galaxy.py <planets.json> <sectors.svg> [--preview <png>]
(--preview needs Pillow: run it with -P instead of -I.)

<planets.json> is the planet list of the community HELLDIVERS 2 API (api.helldivers2.dev/api/v1/planets),
saved once. Only names, sectors, positions, supply lines and biome names are read. <sectors.svg> is
the outline of every HELLDIVERS 2 sector, traced from the game map by the HELLDIVERS 2 War History
Central project (github.com/crosswaveomega/helldiversplanettable, src/data/sectors.svg): a 4000 x
4000 frame with Super Earth at the centre, y down, 2000 units to the planet position 1. The output is
plain data, so the server, the war screens and the Evolved War Engine mod all draw the same map.

Shapes: each sector keeps the traced outline (`shape`), cut into convex pieces (`pieces`) because a
game gui fills only triangle fans. `borders` holds every sector edge once: two sectors traced side by
side share one line.
"""
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

RIM = 1.0           # galaxy edge, in map units (the outer sectors end at about 0.995)
ROUND = 4           # decimals kept in the output
CURVE_STEP = 30     # SVG units between points on a traced curve
SIMPLIFY = 0.0012   # map units a dropped point may be off the outline
SHARED = 0.006      # map units within which two traced edges count as one border
SOL_SIDES = 40
SVG_NS = "{http://www.w3.org/2000/svg}"
# HELLDIVERS 2 sector name -> id in the SVG, where the SVG spells it differently.
SVG_IDS = {"altus": "atlus", "jin xi": "jinxi", "xi tauri": "xitauri", "l'estrade": "lestrade"}

# Factions: 0 Super Earth, 1 bugs, 2 cyborgs, 3 illuminates (HD1 enemy index = faction - 1).
FACTIONS = ["superearth", "bugs", "cyborgs", "illuminates"]

# HELLDIVERS 2 biome -> HELLDIVERS environment (DifficultySettings.environment_lookup, 0-based):
# 0 desert, 1 forest, 2 snow, 3 lava, 4 city.
ENV = {
    "Super Earth": 4, "Cyberstan Megafactory": 4,
    "Desert Dunes": 0, "Desert Cliffs": 0, "Desert Oasis": 0, "Rocky Canyons": 0, "Moon": 0,
    "Deadlands": 0, "Acidic Badlands": 0,
    "Plains": 1, "Ionic Jungle": 1, "Basic Swamp": 1, "Ethereal Jungle": 1, "Volcanic Jungle": 1,
    "Haunted Swamp": 1, "Deciduous Autumn Forest": 1, "Deciduous Forest": 1, "Hive World": 1, "Supercolony": 1,
    "Icy Glaciers": 2, "Tundra": 2, "Boneyard": 2,
    "Scorched Moor": 3, "Magma": 3, "Ionic Crimson": 3, "ACCESS DENIED": 3,
}

# Where each enemy starts: a direction from Super Earth (degrees, 0 = right, 90 = up) and how far
# around it the territory spreads. Cyborgs left, bugs right, Illuminate down.
TERRITORY = {
    1: {"angle": 15.0, "spread": 50.0},
    2: {"angle": 165.0, "spread": 55.0},
    3: {"angle": 270.0, "spread": 42.0},
}
FRONT_RADIUS = 0.56   # sectors whose centre lies further out than this start enemy-held
HOME = {1: "Oshaune", 2: "Cyberstan", 3: "Seasse"}  # each enemy home world, if the data has it

ROMAN = {"I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"}


def title(name):
    """MALEVELON CREEK -> Malevelon Creek, WIDOW'S HARBOR -> Widow's Harbor, CERBERUS IIIC ->
    Cerberus IIIc; keeps numerals and codes like X-45 or LM-1 upper case."""
    out = []
    for word in name.split(" "):
        if word.upper() in ROMAN or any(c.isdigit() for c in word):
            out.append(word.upper())
        elif len(word) > 1 and word[:-1].upper() in ROMAN and word[-1].isalpha():
            out.append(word[:-1].upper() + word[-1].lower())
        elif "'" in word:
            first, *rest = word.lower().split("'")
            out.append("'".join([first.capitalize()] + [p.capitalize() if len(p) > 1 else p for p in rest]))
        elif "-" in word:
            out.append("-".join(p.capitalize() for p in word.lower().split("-")))
        else:
            out.append(word.capitalize())
    return " ".join(out)


# ---------------------------------------------------------------- sector outlines

def svg_ring(d):
    """The points of one closed SVG path (M, L, H, V, C and Z, absolute or relative), curves sampled
    every CURVE_STEP units."""
    toks = re.findall(r"[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:[eE]-?\d+)?", d)
    i, cmd = 0, None
    x = y = 0.0
    pts = []

    def num():
        nonlocal i
        v = float(toks[i])
        i += 1
        return v

    while i < len(toks):
        if toks[i].isalpha():
            cmd = toks[i]
            i += 1
            if cmd in "zZ":
                continue
        rel, c = cmd.islower(), cmd.upper()
        if c == "M" or c == "L":
            nx, ny = num(), num()
            x, y = (x + nx, y + ny) if rel else (nx, ny)
            pts.append((x, y))
            if c == "M":
                cmd = "l" if rel else "L"
        elif c == "H":
            nx = num()
            x = x + nx if rel else nx
            pts.append((x, y))
        elif c == "V":
            ny = num()
            y = y + ny if rel else ny
            pts.append((x, y))
        elif c == "C":
            a = [num() for _ in range(6)]
            if rel:
                a = [a[0] + x, a[1] + y, a[2] + x, a[3] + y, a[4] + x, a[5] + y]
            length = math.dist((x, y), a[0:2]) + math.dist(a[0:2], a[2:4]) + math.dist(a[2:4], a[4:6])
            n = max(1, round(length / CURVE_STEP))
            for k in range(1, n + 1):
                t = k / n
                m = 1 - t
                pts.append((m ** 3 * x + 3 * m * m * t * a[0] + 3 * m * t * t * a[2] + t ** 3 * a[4],
                            m ** 3 * y + 3 * m * m * t * a[1] + 3 * m * t * t * a[3] + t ** 3 * a[5]))
            x, y = a[4], a[5]
        else:
            sys.exit(f"sectors.svg: path command {cmd} isn't read")
    if len(pts) > 1 and math.dist(pts[0], pts[-1]) < 1e-6:
        pts.pop()
    return pts


def area(ring):
    return sum(ring[k][0] * ring[(k + 1) % len(ring)][1] - ring[(k + 1) % len(ring)][0] * ring[k][1] for k in range(len(ring))) / 2


def seg_dist(p, a, b):
    ax, ay = a
    dx, dy = b[0] - ax, b[1] - ay
    l2 = dx * dx + dy * dy
    t = 0 if l2 == 0 else max(0, min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2))
    return math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy)


def point_in(p, poly):
    """Whether p is inside a convex counter-clockwise polygon."""
    m = len(poly)
    return all((poly[(k + 1) % m][0] - poly[k][0]) * (p[1] - poly[k][1]) - (poly[(k + 1) % m][1] - poly[k][1]) * (p[0] - poly[k][0]) >= -1e-9
               for k in range(m))


def simplify(ring, tol):
    """Drops points that sit within tol of the line through their neighbours, a closed ring
    Douglas-Peucker split at the two points furthest apart."""
    def dp(pts):
        if len(pts) < 3:
            return pts
        k, far = 0, -1.0
        for j in range(1, len(pts) - 1):
            d = seg_dist(pts[j], pts[0], pts[-1])
            if d > far:
                k, far = j, d
        if far <= tol:
            return [pts[0], pts[-1]]
        return dp(pts[:k + 1])[:-1] + dp(pts[k:])

    n = len(ring)
    a = 0
    b = max(range(n), key=lambda j: math.dist(ring[0], ring[j]))
    first = dp(ring[a:b + 1])
    second = dp(ring[b:] + ring[:1])
    return first[:-1] + second[:-1]


def convex_pieces(ring):
    """Cuts a counter-clockwise ring into convex pieces: ear clipping, then neighbouring triangles
    merged while the result stays convex (Hertel-Mehlhorn)."""
    n = len(ring)

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    def inside(p, a, b, c):
        return cross(a, b, p) >= -1e-12 and cross(b, c, p) >= -1e-12 and cross(c, a, p) >= -1e-12

    idx = list(range(n))
    tris = []
    guard = 0
    while len(idx) > 3 and guard < 10000:
        guard += 1
        m = len(idx)
        for k in range(m):
            i0, i1, i2 = idx[(k - 1) % m], idx[k], idx[(k + 1) % m]
            a, b, c = ring[i0], ring[i1], ring[i2]
            if cross(a, b, c) <= 1e-12:
                continue
            if any(inside(ring[j], a, b, c) for j in idx if j not in (i0, i1, i2)):
                continue
            tris.append([i0, i1, i2])
            idx.pop(k)
            break
        else:
            sys.exit("sectors.svg: a sector outline can't be cut into triangles")
    tris.append(idx[:])

    def convex(poly):
        m = len(poly)
        return all(cross(ring[poly[k]], ring[poly[(k + 1) % m]], ring[poly[(k + 2) % m]]) >= -1e-10 for k in range(m))

    polys = tris
    merged = True
    while merged:
        merged = False
        for p in range(len(polys)):
            for q in range(p + 1, len(polys)):
                a, b = polys[p], polys[q]
                for ka in range(len(a)):
                    u, v = a[ka], a[(ka + 1) % len(a)]
                    if v in b and b[(b.index(v) + 1) % len(b)] == u:
                        # a runs u -> v, b runs v -> u: join b into a along that edge.
                        kb = b.index(u)
                        rest = [b[(kb + 1 + t) % len(b)] for t in range(len(b) - 2)]
                        joined = a[:ka + 1] + rest + a[ka + 1:]
                        if convex(joined):
                            polys[p] = joined
                            polys.pop(q)
                            merged = True
                        break
                if merged:
                    break
            if merged:
                break
    return [[ring[k] for k in poly] for poly in polys]


def sector_shapes(svg_path, sector_names):
    """{sector index: ring} in map units, y up, counter-clockwise."""
    root = ET.parse(svg_path).getroot()
    paths = {p.get("id"): p.get("d") for p in root.iter(SVG_NS + "path")}
    circles = {c.get("id"): c for c in root.iter(SVG_NS + "circle")}

    def to_map(p):
        return ((p[0] - 2000) / 2000, (2000 - p[1]) / 2000)

    out = {}
    for s, name in enumerate(sector_names):
        key = SVG_IDS.get(name.lower(), name.lower())
        if key in paths:
            ring = [to_map(p) for p in svg_ring(paths[key])]
        elif key in circles:
            c = circles[key]
            cx, cy, r = float(c.get("cx")), float(c.get("cy")), float(c.get("r"))
            ring = [to_map((cx + r * math.cos(2 * math.pi * k / SOL_SIDES), cy - r * math.sin(2 * math.pi * k / SOL_SIDES)))
                    for k in range(SOL_SIDES)]
        else:
            sys.exit(f"sectors.svg has no outline for {name}")
        if area(ring) < 0:
            ring.reverse()
        if key not in circles:
            ring = simplify(ring, SIMPLIFY)
        out[s] = ring
    return out


def shared_borders(shapes):
    """Every sector edge once: an edge that runs within SHARED of an edge of a sector drawn before
    belongs to that border already. Each edge is [x1, y1, x2, y2, sector, other or -1 at the rim]."""
    edges = {s: [(ring[k], ring[(k + 1) % len(ring)]) for k in range(len(ring))] for s, ring in shapes.items()}

    def near(p, s):
        return any(seg_dist(p, a, b) <= SHARED for a, b in edges[s])

    out = []
    order = sorted(shapes)
    for i, s in enumerate(order):
        for a, b in edges[s]:
            mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
            if any(near(a, t) and near(b, t) and near(mid, t) for t in order[:i]):
                continue
            other = next((t for t in order if t != s and near(mid, t)), -1)
            out.append([a[0], a[1], b[0], b[1], s, other])
    return out


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        sys.exit(__doc__)
    src = Path(args[0])
    svg = Path(args[1])
    preview = Path(args[args.index("--preview") + 1]) if "--preview" in args else None
    raw = json.loads(src.read_text(encoding="utf-8"))
    raw.sort(key=lambda p: p["index"])

    # Sectors: Sol first, then by name. Planets of an unnamed sector join the nearest named one.
    named = sorted({p["sector"] for p in raw if p["sector"] not in ("TBD", "")} - {"Sol"})
    sector_names = ["Sol"] + named
    sid = {n: i for i, n in enumerate(sector_names)}
    pts = [(p["position"]["x"], p["position"]["y"]) for p in raw]
    for k, p in enumerate(raw):
        if p["sector"] not in sid:
            near = min((j for j in range(len(raw)) if raw[j]["sector"] in sid and j != k),
                       key=lambda j: math.dist(pts[j], pts[k]))
            p["sector"] = raw[near]["sector"]

    # Supply lines, undirected, and every planet reachable from Super Earth: a planet with no
    # line joins its nearest neighbour, and an island joins the main group at its closest pair.
    index_of = {p["index"]: k for k, p in enumerate(raw)}
    links = set()
    for k, p in enumerate(raw):
        for w in p["waypoints"]:
            if w in index_of and index_of[w] != k:
                links.add(tuple(sorted((k, index_of[w]))))

    def groups():
        adj = {k: set() for k in range(len(raw))}
        for a, b in links:
            adj[a].add(b)
            adj[b].add(a)
        seen, out = set(), []
        for s in range(len(raw)):
            if s in seen:
                continue
            stack, g = [s], []
            seen.add(s)
            while stack:
                v = stack.pop()
                g.append(v)
                for w in adj[v]:
                    if w not in seen:
                        seen.add(w)
                        stack.append(w)
            out.append(g)
        return out

    added = 0
    while True:
        gs = groups()
        if len(gs) == 1:
            break
        main_g = max(gs, key=len)
        others = [g for g in gs if g is not main_g]
        g = min(others, key=len)
        a, b = min(((a, b) for a in g for b in main_g), key=lambda ab: math.dist(pts[ab[0]], pts[ab[1]]))
        links.add(tuple(sorted((a, b))))
        added += 1

    shapes = sector_shapes(svg, sector_names)

    # Sector centres (mean of the planets) and the starting owner of each sector.
    sectors = []
    for name in sector_names:
        members = [k for k, p in enumerate(raw) if p["sector"] == name]
        cx = sum(pts[k][0] for k in members) / len(members)
        cy = sum(pts[k][1] for k in members) / len(members)
        sectors.append({"name": name, "planets": members, "cx": cx, "cy": cy})

    def owner_of_sector(s):
        r = math.hypot(s["cx"], s["cy"])
        if r < FRONT_RADIUS:
            return 0
        ang = math.degrees(math.atan2(s["cy"], s["cx"])) % 360
        best, best_d = 0, 1e9
        for f, t in TERRITORY.items():
            d = abs((ang - t["angle"] + 180) % 360 - 180)
            if d <= t["spread"] and d < best_d:
                best, best_d = f, d
        return best

    owner = [0] * len(raw)
    for s in sectors:
        s["owner"] = owner_of_sector(s)
        for k in s["planets"]:
            owner[k] = s["owner"]
    homes = {}
    for f, name in HOME.items():
        for k, p in enumerate(raw):
            if title(p["name"]).lower() == name.lower():
                homes[f] = k
                owner[k] = f

    borders = shared_borders(shapes)
    pieces = {s: convex_pieces(ring) for s, ring in shapes.items()}
    outside = [raw[k]["name"] for k in range(len(raw))
               if not any(point_in(pts[k], piece) for piece in pieces[sid[raw[k]["sector"]]])]

    def r(v):
        return round(v, ROUND)

    def flat(ring):
        return [r(v) for x, y in ring for v in (x, y)]

    planets = []
    for k, p in enumerate(raw):
        biome = (p.get("biome") or {}).get("name") or "Moon"
        planets.append({
            "id": k,
            "hd2": p["index"],
            "name": title(p["name"]),
            "sector": sid[p["sector"]],
            "x": r(pts[k][0]),
            "y": r(pts[k][1]),
            "biome": biome,
            "env": ENV.get(biome, 0),
            "hazards": [h["name"] for h in p.get("hazards") or [] if h.get("name") not in (None, "None")],
            "owner": owner[k],
        })
    out = {
        "galaxy": "hd2",
        "version": 2,
        "about": "HELLDIVERS 2 galaxy layout: planet names, positions, sectors and supply lines, and the sector outlines traced from the game map by the HELLDIVERS 2 War History Central project. Environments and starting owners are set for HELLDIVERS (2015).",
        "factions": FACTIONS,
        "rim": RIM,
        "homes": {FACTIONS[f]: k for f, k in homes.items()},
        "sectors": [{"id": i, "name": s["name"], "x": r(s["cx"]), "y": r(s["cy"]), "owner": s["owner"],
                     "planets": s["planets"], "shape": flat(shapes[i]), "pieces": [flat(p) for p in pieces[i]]}
                    for i, s in enumerate(sectors)],
        "planets": planets,
        "links": sorted([list(l) for l in links]),
        "borders": [[r(a), r(b), r(c), r(d), s1, s2] for a, b, c, d, s1, s2 in borders],
    }
    dest = Path(__file__).resolve().parent.parent / "data" / "galaxy-hd2.json"
    with open(dest, "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    counts = [sum(1 for o in owner if o == f) for f in range(4)]
    print(f"{dest}: {len(planets)} planets, {len(sectors)} sectors, {len(links)} links ({added} added to join islands), "
          f"{len(borders)} border edges, {sum(len(v) for v in shapes.values())} outline points in "
          f"{sum(len(v) for v in pieces.values())} convex pieces; owners {dict(zip(FACTIONS, counts))}; homes {homes}; {dest.stat().st_size // 1024} KB")
    print(f"  planets outside the outline of their own sector: {', '.join(outside) or 'none'}")
    for i, s in enumerate(sectors):
        ang = math.degrees(math.atan2(s["cy"], s["cx"])) % 360
        print(f"  {i:2d} {s['name']:<12} r={math.hypot(s['cx'], s['cy']):.2f} a={ang:5.1f} owner={FACTIONS[s['owner']]}")
    if preview:
        draw_preview(out, preview)


def draw_preview(g, path):
    from PIL import Image, ImageDraw
    size = 1400
    img = Image.new("RGB", (size, size), (6, 10, 14))
    d = ImageDraw.Draw(img, "RGBA")
    cols = [(255, 170, 20), (70, 220, 160), (230, 80, 70), (40, 150, 250)]

    def px(x, y):
        return (size / 2 + x * size * 0.46, size / 2 - y * size * 0.46)

    for s in g["sectors"]:
        c = cols[s["owner"]]
        for piece in s["pieces"]:
            pts = [px(piece[i], piece[i + 1]) for i in range(0, len(piece), 2)]
            d.polygon(pts, fill=c + (40 if s["owner"] == 0 else 70,), outline=(255, 0, 255, 40))
    for a, b, c2, e, _, _ in g["borders"]:
        d.line([px(a, b), px(c2, e)], fill=(255, 255, 255, 120), width=2)
    for a, b in g["links"]:
        pa, pb = g["planets"][a], g["planets"][b]
        d.line([px(pa["x"], pa["y"]), px(pb["x"], pb["y"])], fill=(255, 255, 255, 60), width=1)
    for p in g["planets"]:
        x, y = px(p["x"], p["y"])
        c = cols[p["owner"]]
        d.ellipse([x - 4, y - 4, x + 4, y + 4], fill=c + (255,))
    for s in g["sectors"]:
        x, y = px(s["x"], s["y"])
        d.text((x - 20, y + 6), s["name"].upper(), fill=(255, 255, 255, 170))
    img.save(path)
    print("preview", path)


if __name__ == "__main__":
    main()
