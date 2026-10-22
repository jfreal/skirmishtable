#!/usr/bin/env python3
"""Audit: score TTS->2D transform hypotheses against the official map card images.

For each map and hypothesis (mesh X-flip on OBJ import, board rotation), build an
occupancy mask from every terrain piece (mesh columns with any height, rubble
templates) and compute IoU with the card's terrain pixels."""
import json, sys, math, os, collections
from PIL import Image

W, H, RES = 30.0, 22.0, 0.25
GW, GH = int(W / RES), int(H / RES)
OBJECTIVE = "2AA481BF3BB82CD4"
GUIDE = "9C8BD76749A0A723"
SURFACE = "06EC984208223D38"
TEMPLATES = {
    "D516D672AD00F4E9": (2.2, 1.6), "D89DFA2BC6FAF24E": (2.2, 1.6),
    "7800BDC2BED78D48": (1.8, 1.3), "FC33155AB0F2D38C": (1.8, 1.3),
    "469DF7AB2CD02822": (1.9, 1.1), "E6D612B8D6752812": (1.9, 1.1),
    "F8E4285F7033E562": (1.9, 1.1),
}

def load_obj(path):
    return [tuple(map(float, l.split()[1:4])) for l in open(path, errors="ignore") if l.startswith("v ")]

def board_xy(wx, wz, rot):
    """TTS world (x,z) -> landscape board (X,Y), Y down. Unity top view: +x right, +z up.
    rot = extra board rotation in degrees (0/180 landscape, 90/-90 portrait)."""
    a, b = wx, -wz                      # top-down, Y-down screen
    if rot == 90: a, b = -b, a
    elif rot == -90: a, b = b, -a
    elif rot == 180: a, b = -a, -b
    return a + W / 2, b + H / 2

def piece_world(v, s, roty, px, pz, xflip):
    x, y, z = v
    if xflip: x = -x
    th = math.radians(roty)
    c, sn = math.cos(th), math.sin(th)
    return (x * c + z * sn) * s + px, (-x * sn + z * c) * s + pz

def occupancy(bag, meshes, xflip, rot):
    occ = set()
    objs = []
    for o in bag["ContainedObjects"]:
        t = o.get("Transform", {})
        cm, ca = o.get("CustomMesh") or {}, o.get("CustomAssetbundle") or {}
        url = cm.get("MeshURL") or ca.get("AssetbundleURL") or ""
        if not url: continue
        key = url.rsplit("/", 2)[-2][-16:]
        px, pz, ry, s = t["posX"], t["posZ"], t["rotY"], t["scaleX"]
        if key in (SURFACE, GUIDE): continue
        if key == OBJECTIVE:
            objs.append(board_xy(px, pz, rot)); continue
        if key in TEMPLATES:
            tw, th = TEMPLATES[key]
            for i in range(-6, 7):
                for j in range(-6, 7):
                    lx, lz = tw / 2 * i / 6, th / 2 * j / 6
                    wx, wz = piece_world((lx, 0, lz), s, ry, px, pz, False)
                    X, Y = board_xy(wx, wz, rot)
                    occ.add((int(X / RES), int(Y / RES)))
            continue
        if key not in meshes: continue
        for v in meshes[key]:
            wx, wz = piece_world(v, s, ry, px, pz, xflip)
            X, Y = board_xy(wx, wz, rot)
            occ.add((int(X / RES), int(Y / RES)))
    occ = {(i, j) for i, j in occ if 0 <= i < GW and 0 <= j < GH}
    return occ, objs

def card_mask(path):
    im = Image.open(path).convert("RGB").resize((GW, GH), Image.BILINEAR)
    m = set()
    for j in range(GH):
        for i in range(GW):
            r, g, b = im.getpixel((i, j))
            lum = 0.3 * r + 0.59 * g + 0.11 * b
            orange = r > 150 and r - b > 60
            if lum < 140 and not orange:
                m.add((i, j))
    return m

def dilate(cells, k=1):
    out = set()
    for i, j in cells:
        for di in range(-k, k + 1):
            for dj in range(-k, k + 1):
                out.add((i + di, j + dj))
    return out

if __name__ == "__main__":
    bags = json.load(open(sys.argv[1]))
    meshdir, carddir = sys.argv[2], sys.argv[3]
    meshes = {fn[:-4]: load_obj(os.path.join(meshdir, fn)) for fn in os.listdir(meshdir) if fn.endswith(".obj")}
    results = {}
    for i in range(1, 7):
        bag = bags[f"Volkus 24 0{i}"]
        card = card_mask(os.path.join(carddir, f"Volkus_24_0{i}.img"))
        cardD = dilate(card, 1)
        row = []
        for rot in (0, 180, 90, -90):
            for xflip in (False, True):
                occ, objs = occupancy(bag, meshes, xflip, rot)
                hit = len(occ & cardD) / max(1, len(occ))      # how much of ours lands on card terrain
                cover = len(card & dilate(occ, 1)) / max(1, len(card))  # how much card terrain we cover
                row.append((round(2 * hit * cover / max(1e-9, hit + cover), 3), rot, xflip, round(hit, 3), round(cover, 3)))
        row.sort(reverse=True)
        results[i] = row
        print(f"map {i}: best F1={row[0][0]} rot={row[0][1]} xflip={row[0][2]}  | runner-up F1={row[1][0]} rot={row[1][1]} xflip={row[1][2]}")
        for r in row[:4]:
            print("      ", r)
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "cache", "parsed", "audit_best.json")
    json.dump({i: r[0] for i, r in results.items()}, open(out, "w"))
