#!/usr/bin/env python3
"""Volkus TTS conventions and helpers, verified against the official map cards.

The app now uses per-piece footprints traced at 0.1" (fine_footprint.py); the coarse
rect converter below (convert_bag, piece_table) is kept for the research scripts.

Conventions, each confirmed by scoring against the map card images:
  * TTS/Unity is left-handed and imports OBJ files with X negated. Looking down,
    +x is right and +z is UP the screen, so board coords are (x, -z), not (x, z).
  * The OBJ X-flip and the z-flip are two reflections, i.e. a pure rotation of the
    raw OBJ vertices: piece angle a = alpha + 180 - rotY, applied as
    (x, z) -> (x cos a + z sin a, -x sin a + z cos a). The 3D view uses the same.
  * Some layouts sit portrait on the TTS table; the guide markers say which.
  * Objectives are mesh 2AA4 (3 per map). Mesh 9C8B is a set of 5 guide planes:
    the centreline plus drop-zone and territory lines. Guides at +/-9 along an axis
    mean that axis is the 30" one with 6" zones; +/-8 means the 22" axis with 3" zones.
  * Rubble asset bundles have no readable mesh; footprints were measured from the
    cards (median of all clean samples). Fire steps are Insignificant/Exposed
    platforms, so they become non-blocking decor, not terrain.
"""
import json, sys, math, os, collections

CELL = 0.35
BAND = 0.45
W, H = 30.0, 22.0
OBJECTIVE = "2AA481BF3BB82CD4"
GUIDE = "9C8BD76749A0A723"
SURFACE = "06EC984208223D38"
STEP_MESHES = {"F8E4285F7033E562"}
LIGHT_MESHES = {"5F6869039198593C"}     # scanned light rubble
# (w, h, cx, cz, kind, z), unscaled piece-local inches, measured from the cards
TEMPLATES = {
    "D516D672AD00F4E9": (2.42, 0.81, 0.0, 0.0, "heavy", 2),   # heavy rubble
    "D89DFA2BC6FAF24E": (2.58, 0.82, 0.0, 0.0, "heavy", 2),   # heavy rubble
    "7800BDC2BED78D48": (2.03, 0.64, 0.0, 0.0, "light", 1),   # light rubble
    "FC33155AB0F2D38C": (1.69, 0.59, 0.0, 0.0, "light", 1),   # light rubble
    "469DF7AB2CD02822": (2.14, 1.02, 0.18, 0.24, "step", 0),  # fire steps
    "E6D612B8D6752812": (2.14, 1.02, 0.18, 0.24, "step", 0),  # fire steps
}

def rot(a, x, z):
    c, s = math.cos(math.radians(a)), math.sin(math.radians(a))
    return x * c + z * s, -x * s + z * c

def load_obj(path):
    return [tuple(map(float, l.split()[1:4])) for l in open(path, errors="ignore") if l.startswith("v ")]

def key_of(o):
    cm, ca = o.get("CustomMesh") or {}, o.get("CustomAssetbundle") or {}
    url = cm.get("MeshURL") or ca.get("AssetbundleURL") or ""
    return url.rsplit("/", 2)[-2][-16:] if url else None

def frame(bag):
    """Board rotation alpha (0 landscape / 90 portrait-on-table) and deployment."""
    g = [(o["Transform"]["posX"], o["Transform"]["posZ"]) for o in bag["ContainedObjects"] if key_of(o) == GUIDE]
    if len(g) >= 3:
        rx = max(p[0] for p in g) - min(p[0] for p in g)
        rz = max(p[1] for p in g) - min(p[1] for p in g)
        along_x = rx > rz
        d = max(abs(p[0] if along_x else p[1]) for p in g)
        thirty = d > 8.5                       # +/-9 => 30" axis, 6" zones; +/-8 => 22" axis, 3" zones
        portrait = (along_x and not thirty) or (not along_x and thirty)
        return (90 if portrait else 0), ("short" if thirty else "long")
    zs = [abs(o["Transform"]["posZ"]) for o in bag["ContainedObjects"] if "Transform" in o]
    return (90 if zs and max(zs) > 11.5 else 0), "short"

def to_board(px, pz, alpha):
    X, Y = rot(alpha, px, -pz)
    return X + W / 2, Y + H / 2

def cells_for(verts, s, a, X0, Y0):
    y0 = min(v[1] for v in verts)
    cells = collections.defaultdict(lambda: [0.0, 0, 0])
    for x, y, z in verts:
        bx, by = rot(a, x * s, z * s)
        key = (int((bx + X0) // CELL), int((by + Y0) // CELL))
        h = (y - y0) * s
        r = cells[key]
        r[0] = max(r[0], h); r[1] += 1; r[2] |= 1 << min(11, int(h // BAND))
    return cells

def classify(cells):
    tall, low, any_ = {}, set(), set()
    for k, (h, n, mask) in cells.items():
        if n < 2: continue
        any_.add(k)
        if h >= 1.7:
            nb = max(1, min(11, int(h // BAND)))
            if bin(mask & ((1 << nb) - 1)).count("1") / nb >= 0.55: tall[k] = h  # wall, not floor slab
        elif h >= 0.6: low.add(k)
    return tall, low, any_

def components(cellmap):
    cells, comps = set(cellmap), []
    while cells:
        seed = cells.pop(); comp, fr = {seed}, [seed]
        while fr:
            cx, cy = fr.pop()
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    nb = (cx + dx, cy + dy)
                    if nb in cells: cells.remove(nb); comp.add(nb); fr.append(nb)
        comps.append(comp)
    return comps

def merge_rects(cellset):
    rem, out = set(cellset), []
    while rem:
        ix, iy = min(rem); w = 1
        while (ix + w, iy) in rem: w += 1
        h = 1
        while all((ix + dx, iy + h) in rem for dx in range(w)): h += 1
        for dy in range(h):
            for dx in range(w): rem.discard((ix + dx, iy + dy))
        out.append((ix * CELL, iy * CELL, w * CELL, h * CELL))
    return out

def footprint_rects(verts, s, a, X0, Y0, light_only=False, step_only=False):
    """Rects (x, y, w, h, kind, z) for one mesh piece placed on the board."""
    tall, low, any_ = classify(cells_for(verts, s, a, X0, Y0))
    out = []
    if step_only:
        for comp in components(any_):
            if len(comp) >= 3:
                out += [(x, y, w, h, "step", 0) for x, y, w, h in merge_rects(comp)]
        return out
    if light_only:
        for comp in components(set(tall) | low):
            if len(comp) >= 4:
                out += [(x, y, w, h, "light", 1) for x, y, w, h in merge_rects(comp)]
        return out
    for comp in components(tall):
        if len(comp) < 3: continue
        hs = sorted(tall[c] for c in comp)
        z = max(2, min(4, round(hs[len(hs) // 2])))
        out += [(x, y, w, h, "wall", z) for x, y, w, h in merge_rects(comp)]
    for comp in components(low):
        if len(comp) < 4: continue
        out += [(x, y, w, h, "light", 1) for x, y, w, h in merge_rects(comp) if w * h >= 0.5]
    return out

def template_rect(tpl, s, a, X, Y):
    tw, th, cx, cz, kind, z = tpl
    corners = [rot(a, (cx + sx * tw / 2) * s, (cz + sz * th / 2) * s) for sx in (-1, 1) for sz in (-1, 1)]
    xs, ys = [c[0] for c in corners], [c[1] for c in corners]
    return (X + min(xs), Y + min(ys), max(xs) - min(xs), max(ys) - min(ys), kind, z)

def convert_bag(bag, name, meshes):
    alpha, edge = frame(bag)
    terrain, decor, objectives, pieces, idn = [], [], [], [], [0]
    def add(r, flag):
        x, y, w_, h_, kind, z = r
        x0, y0, x1, y1 = max(0, x), max(0, y), min(W, x + w_), min(H, y + h_)
        if x1 - x0 < 0.2 or y1 - y0 < 0.2 or (x1 - x0) * (y1 - y0) < 0.12: return
        e = {"id": f"V{idn[0]}", "kind": kind, "z": z, "x": round(x0, 2), "y": round(y0, 2),
             "w": round(x1 - x0, 2), "h": round(y1 - y0, 2)}
        if flag: e[flag] = 1
        idn[0] += 1
        (decor if kind == "step" else terrain).append(e)
    for o in bag["ContainedObjects"]:
        k = key_of(o)
        if not k or k in (SURFACE, GUIDE): continue
        t = o["Transform"]
        X, Y = to_board(t["posX"], t["posZ"], alpha)
        a = alpha + 180 - t["rotY"]
        s = t["scaleX"]
        if k == OBJECTIVE:
            objectives.append({"id": f"OBJ-{len(objectives) + 1}", "x": round(X, 2), "y": round(Y, 2)})
            continue
        if k in TEMPLATES:
            add(template_rect(TEMPLATES[k], s, a, X, Y), "tpl")
            continue
        if k not in meshes: continue
        pieces.append({"k": k, "x": round(X, 3), "y": round(Y, 3), "a": round(a % 360, 2), "s": round(s, 4)})
        for r in footprint_rects(meshes[k], s, a, X, Y,
                                 light_only=k in LIGHT_MESHES, step_only=k in STEP_MESHES):
            add(r, "m")
    return {"name": name, "source": "Steam Workshop 3573927734 (KT24 Killzone Mod)",
            "w": W, "h": H, "dropEdge": edge, "dropDepth": 6 if edge == "short" else 3,
            "terrain": terrain, "decor": decor, "objectives": objectives, "pieces": pieces}

def piece_table(meshes, bags):
    """Per-piece local footprints for the in-browser importer (computed at the piece's
    typical scale so height thresholds hold; the browser rescales by s/s0)."""
    scales = collections.defaultdict(list)
    for b in bags.values():
        for o in b["ContainedObjects"]:
            k = key_of(o)
            if k in meshes and k not in (OBJECTIVE, GUIDE, SURFACE):
                scales[k].append(o["Transform"]["scaleX"])
    pieces = {}
    for k, ss in scales.items():
        s0 = sorted(ss)[len(ss) // 2]
        rects = footprint_rects(meshes[k], s0, 0, 0, 0,
                                light_only=k in LIGHT_MESHES, step_only=k in STEP_MESHES)
        pieces[k] = {"s0": round(s0, 4), "rects": [[round(x, 3), round(y, 3), round(w, 3), round(h, 3), kd, z]
                                                   for x, y, w, h, kd, z in rects]}
    return {"objective": OBJECTIVE, "guide": GUIDE, "surface": SURFACE,
            "templates": {k: list(v) for k, v in TEMPLATES.items()}, "pieces": pieces}
