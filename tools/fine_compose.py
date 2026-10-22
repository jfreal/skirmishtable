import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
"""Diagnostic: a Python mirror of the browser's board composition (composeFine in
src/engine/grid.js): place each piece's fine local
raster on a 0.1" board grid by inverse mapping (exact for any rotation), add rubble
templates, then report rect counts and where a 28mm base can actually stand."""
import json, math, os, base64
import numpy as np
from scipy import ndimage
import volkus_convert as V
from paths import FINE_DIR, PARSED_DIR

RES, W, H = 0.1, 30.0, 22.0
GX, GY = int(W / RES), int(H / RES)
BASE_R = 0.551

def decode(entry):
    raw = base64.b64decode(entry["rle"]); flat = []
    for i in range(0, len(raw), 2): flat += [raw[i]] * raw[i + 1]
    return np.array(flat, np.uint8).reshape(entry["nz"], entry["nx"])

def compose(bag, table):
    alpha, edge = V.frame(bag)
    cls = np.zeros((GY, GX), np.uint8); z = np.zeros((GY, GX), np.uint8); fid = np.zeros((GY, GX), np.int32)
    xs = (np.arange(GX) + 0.5) * RES; ys = (np.arange(GY) + 0.5) * RES
    BX, BY = np.meshgrid(xs, ys)
    nf = 0
    for o in bag["ContainedObjects"]:
        k = V.key_of(o)
        if not k or k in (V.SURFACE, V.GUIDE, V.OBJECTIVE): continue
        t = o["Transform"]; X0, Y0 = V.to_board(t["posX"], t["posZ"], alpha)
        a = math.radians(alpha + 180 - t["rotY"]); s = t["scaleX"]
        dx, dy = BX - X0, BY - Y0
        # inverse rotation: local = R(-a) * board offset
        lx = dx * math.cos(-a) + dy * math.sin(-a); lz = -dx * math.sin(-a) + dy * math.cos(-a)
        nf += 1
        if k in table:
            e = table[k]; eff = s / e["s0"]; codes = decode(e)
            ix = np.floor((lx / eff - e["x0"]) / RES).astype(int); iz = np.floor((lz / eff - e["z0"]) / RES).astype(int)
            m = (ix >= 0) & (ix < e["nx"]) & (iz >= 0) & (iz < e["nz"])
            c = np.zeros_like(cls); c[m] = codes[iz[m], ix[m]]
            pc, pz = c >> 4, c & 15
        elif k in V.TEMPLATES:
            tw, th, cx, cz, kind, zz = V.TEMPLATES[k]
            m = (np.abs(lx / s - cx) <= tw / 2) & (np.abs(lz / s - cz) <= th / 2)
            pc = np.where(m, {"heavy": 2, "light": 3, "step": 4}[kind], 0); pz = np.where(m, zz * 2, 0)
        else: continue
        prio = {0: 0, 5: 1, 4: 2, 3: 3, 2: 4, 1: 5}
        better = np.vectorize(prio.get)(pc) > np.vectorize(prio.get)(cls)
        cls = np.where(better, pc, cls).astype(np.uint8); z = np.where(better, pz, z).astype(np.uint8)
        fid = np.where(better & (pc > 0), nf, fid)
    return cls, z, fid, edge

def merge_rects(mask):
    rem = mask.copy(); out = []
    for j in range(rem.shape[0]):
        i = 0
        while i < rem.shape[1]:
            if not rem[j, i]: i += 1; continue
            w = 1
            while i + w < rem.shape[1] and rem[j, i + w]: w += 1
            h = 1
            while j + h < rem.shape[0] and rem[j + h, i:i + w].all(): h += 1
            rem[j:j + h, i:i + w] = False
            out.append((i, j, w, h)); i += w
    return out

if __name__ == "__main__":
    bags = json.load(open(os.path.join(PARSED_DIR, "volkus_bags.json")))
    table = json.load(open(os.path.join(FINE_DIR, "fine_pieces.json")))
    for i in range(1, 7):
        cls, z, fid, edge = compose(bags[f"Volkus 24 0{i}"], table)
        solid = (cls == 1) | (cls == 2) | (cls == 3)
        nrect = 0
        for c in (1, 2, 3, 4):
            for zz in np.unique(z[cls == c]):
                nrect += len(merge_rects((cls == c) & (z == zz)))
        # where can a 28mm base stand? clearance from solid > base radius
        dist = ndimage.distance_transform_edt(~solid) * RES
        free = dist > BASE_R
        # nook-able floor: free spots inside a piece's outline (within 1.5" of walls on 3 sides)
        lab, n = ndimage.label(free)
        inside = 0
        for f in np.unique(fid[fid > 0]):
            region = ndimage.binary_fill_holes(ndimage.binary_closing(fid == f, iterations=6))
            inside += int((region & free).sum())
        print(f"map {i}: {nrect} merged rects, solid {solid.sum()} cells, "
              f"base-standable cells inside pieces' outlines: {inside} ({inside * RES * RES:.1f} sq in), free regions {n}")
        np.save(os.path.join(FINE_DIR, f"board_v{i}.npy"), np.stack([cls, z, fid]))
