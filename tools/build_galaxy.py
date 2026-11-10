"""Builds data/galaxy-hd2.json, the Evolved war map: the HELLDIVERS 2 galaxy layout (planet names,
positions, sectors and supply lines) with each planet given a HELLDIVERS environment and a starting
owner, plus the shapes every map draws from.

Usage: python -P tools/build_galaxy.py <planets.json> [--preview <png>]

<planets.json> is the planet list of the community HELLDIVERS 2 API (api.helldivers2.dev/api/v1/planets),
saved once. Only names, sectors, positions, supply lines and biome names are read. The output is
plain data, so the server, the war screens and the Evolved War Engine mod all draw the same map.

Shapes: every planet gets a Voronoi cell inside the galaxy rim, and a sector is the union of the
cells of its planets. The cells are convex, so a game gui (triangle fans only) can fill them, and the
sector borders are the cell edges between planets of different sectors.
"""
import json
import math
import sys
from pathlib import Path

RIM = 1.06          # galaxy edge, in map units (planets reach about 0.95)
RIM_SIDES = 96
ROUND = 4           # decimals kept in the output

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
    """MALEVELON CREEK -> Malevelon Creek; keeps numerals and codes like X-45 or LM-1 upper case."""
    out = []
    for word in name.split(" "):
        if word.upper() in ROMAN or any(c.isdigit() for c in word):
            out.append(word.upper())
        elif "'" in word:
            out.append("'".join(p.capitalize() for p in word.lower().split("'")))
        elif "-" in word:
            out.append("-".join(p.capitalize() for p in word.lower().split("-")))
        else:
            out.append(word.capitalize())
    return " ".join(out)


def clip(poly, px, py, qx, qy):
    """Keeps the part of a convex polygon (list of (x, y, tag)) closer to p than to q. The new
    edge along the bisector gets q's tag through the vertex that starts it."""
    mx, my = (px + qx) / 2, (py + qy) / 2
    nx, ny = qx - px, qy - py

    def side(x, y):
        return (x - mx) * nx + (y - my) * ny  # <= 0 keeps

    out = []
    n = len(poly)
    for i in range(n):
        ax, ay, at = poly[i]
        bx, by, _ = poly[(i + 1) % n]
        sa, sb = side(ax, ay), side(bx, by)
        if sa <= 0:
            out.append((ax, ay, at))
        if (sa <= 0) != (sb <= 0):
            t = sa / (sa - sb)
            x, y = ax + (bx - ax) * t, ay + (by - ay) * t
            # Entering the kept side: the edge from here keeps a's tag. Leaving: the edge from the
            # crossing runs along the bisector, tagged with q.
            out.append((x, y, at if sa > 0 else None))
    # Fix the tags: an edge whose start came from leaving the kept side lies on the bisector.
    fixed = []
    for i, (x, y, t) in enumerate(out):
        fixed.append((x, y, "Q" if t is None else t))
    return fixed


def cell_of(i, pts):
    px, py = pts[i]
    poly = [(RIM * math.cos(2 * math.pi * k / RIM_SIDES), RIM * math.sin(2 * math.pi * k / RIM_SIDES), -1)
            for k in range(RIM_SIDES)]
    order = sorted(range(len(pts)), key=lambda j: (pts[j][0] - px) ** 2 + (pts[j][1] - py) ** 2)
    for j in order:
        if j == i:
            continue
        qx, qy = pts[j]
        # A neighbour further than twice the farthest corner can't cut the cell.
        reach = max(math.hypot(x - px, y - py) for x, y, _ in poly)
        if math.hypot(qx - px, qy - py) > 2 * reach:
            break
        poly = [(x, y, j if t == "Q" else t) for x, y, t in clip(poly, px, py, qx, qy)]
    return poly


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    src = Path(args[0])
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

    cells = [cell_of(k, pts) for k in range(len(raw))]

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

    # Sector borders: cell edges between planets of different sectors, and the rim.
    borders, rim = [], []
    for k, poly in enumerate(cells):
        n = len(poly)
        for e in range(n):
            ax, ay, tag = poly[e]
            bx, by, _ = poly[(e + 1) % n]
            if tag == -1:
                rim.append((ax, ay, bx, by))
            elif isinstance(tag, int) and tag > k and raw[tag]["sector"] != raw[k]["sector"]:
                borders.append((ax, ay, bx, by, sid[raw[k]["sector"]], sid[raw[tag]["sector"]]))

    def r(v):
        return round(v, ROUND)

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
            "cell": [r(v) for x, y, _ in cells[k] for v in (x, y)],
        })
    out = {
        "galaxy": "hd2",
        "version": 1,
        "about": "HELLDIVERS 2 galaxy layout: planet names, positions, sectors and supply lines. Environments and starting owners are set for HELLDIVERS (2015).",
        "factions": FACTIONS,
        "rim": RIM,
        "homes": {FACTIONS[f]: k for f, k in homes.items()},
        "sectors": [{"id": i, "name": s["name"], "x": r(s["cx"]), "y": r(s["cy"]), "owner": s["owner"],
                     "planets": s["planets"]} for i, s in enumerate(sectors)],
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
          f"{len(borders)} border edges; owners {dict(zip(FACTIONS, counts))}; homes {homes}; {dest.stat().st_size // 1024} KB")
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

    for p in g["planets"]:
        c = cols[p["owner"]]
        pts = [px(p["cell"][i], p["cell"][i + 1]) for i in range(0, len(p["cell"]), 2)]
        d.polygon(pts, fill=c + (40 if p["owner"] == 0 else 70,))
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
