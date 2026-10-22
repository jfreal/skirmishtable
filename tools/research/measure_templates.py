import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
"""Measure rubble/fire-step footprints (asset bundles have no readable mesh) from the
official card images: find the dark blob at each piece's board position and measure
its extent along the piece's local axes, normalised by the piece's TTS scale."""
import json, os, math, statistics, collections
from PIL import Image

W, H = 30.0, 22.0
NAMES = {"D516D672AD00F4E9": "heavy rubble A", "D89DFA2BC6FAF24E": "heavy rubble B",
         "7800BDC2BED78D48": "light rubble A", "FC33155AB0F2D38C": "light rubble B",
         "469DF7AB2CD02822": "fire steps A", "E6D612B8D6752812": "fire steps B",
         "F8E4285F7033E562": "fire steps C"}
ALPHA = {1: 0, 2: 90, 3: 0, 4: 0, 5: 0, 6: 0}

def R(a, x, z):
    c, s = math.cos(math.radians(a)), math.sin(math.radians(a))
    return x * c + z * s, -x * s + z * c

def to_board(px, pz, alpha):
    X, Y = R(alpha, px, -pz)
    return X + W / 2, Y + H / 2

bags = json.load(open(sys.argv[1]))
meas = collections.defaultdict(list)
for i in range(1, 7):
    im = Image.open(os.path.join(sys.argv[2], f"Volkus_24_0{i}.img")).convert("RGB")
    pw, ph = im.size
    sx, sy = pw / W, ph / H
    px_ = im.load()
    def dark(u, v):
        if not (0 <= u < pw and 0 <= v < ph): return False
        r, g, b = px_[u, v]
        lum = 0.3 * r + 0.59 * g + 0.11 * b
        # card terrain fill is green-grey (~96,112,96); label boxes darker green.
        # excludes blue grid lines, black wall lines, orange rings, board, zones.
        return 40 <= lum <= 140 and g >= r - 5 and b <= g + 10 and b - r < 35
    for o in bags[f"Volkus 24 0{i}"]["ContainedObjects"]:
        cm, ca = o.get("CustomMesh") or {}, o.get("CustomAssetbundle") or {}
        url = cm.get("MeshURL") or ca.get("AssetbundleURL") or ""
        if not url: continue
        key = url.rsplit("/", 2)[-2][-16:]
        if key not in NAMES: continue
        t = o["Transform"]
        X, Y = to_board(t["posX"], t["posZ"], ALPHA[i])
        a = ALPHA[i] + 180 - t["rotY"]
        cu, cv = int(X * sx), int(Y * sy)
        # flood fill the dark blob nearest the centre, within a 3" window
        seed = None
        for rr in range(0, 12):
            for du in range(-rr, rr + 1):
                for dv in (-rr, rr):
                    if dark(cu + du, cv + dv): seed = (cu + du, cv + dv); break
                if seed: break
            if seed: break
        if not seed: continue
        lim = 3.0
        blob, stack = {seed}, [seed]
        while stack:
            u, v = stack.pop()
            for du, dv in ((1,0),(-1,0),(0,1),(0,-1)):
                n = (u + du, v + dv)
                if n in blob or not dark(*n): continue
                if abs(n[0] / sx - X) > lim or abs(n[1] / sy - Y) > lim: continue
                blob.add(n); stack.append(n)
        # extent in piece-local axes (inverse rotation), back to unscaled template units
        loc = [R(-a, u / sx - X, v / sy - Y) for u, v in blob]
        lw = max(p[0] for p in loc) - min(p[0] for p in loc)
        lh = max(p[1] for p in loc) - min(p[1] for p in loc)
        s = t["scaleX"]
        capped = any(abs(u / sx - X) > lim - 0.15 or abs(v / sy - Y) > lim - 0.15 for u, v in blob)
        if capped or len(blob) < 20:
            continue   # merged with neighbouring terrain or nothing found: not a clean sample
        cxl = (max(q[0] for q in loc) + min(q[0] for q in loc)) / 2
        czl = (max(q[1] for q in loc) + min(q[1] for q in loc)) / 2
        meas[key].append((round(lw / s, 2), round(lh / s, 2), round(cxl / s, 2), round(czl / s, 2)))
out = {}
for key, vals in meas.items():
    vals = [v for v in vals if v[0] > 1.0]  # drop fragments (label box only)
    if not vals: continue
    med = lambda k: round(statistics.median(v[k] for v in vals), 2)
    out[key] = [med(0), med(1), med(2), med(3)]
    print(f"{NAMES[key]:16s} {key}: median {out[key]}  samples {vals}")
json.dump(out, open(sys.argv[3], "w"), indent=1)
