#!/usr/bin/env python3
"""Fine terrain footprints from the scanned TTS meshes, for 'nooking' bases into terrain.

Instead of binning vertices, sample the triangle SURFACES densely and rasterize at 0.1".
A cell blocks a base only if there is geometry where a base would bump into it at
floor level (between the floor plate and ~1.2" up). Cells with geometry only high up
are upper floors you can stand under (Volkus 'Ceiling' terrain), not walls.

Per-piece output is a local raster in the piece's raw OBJ frame (scaled to its typical
scale s0) with one code per cell: class (wall / light / overhead) and height.
"""
import sys, os, json, math, base64, collections
import numpy as np

RES = 0.1
FLOOR_PLATE = 0.25     # below this: base plate / floor texture, walkable
BUMP_TOP = 1.2         # geometry from FLOOR_PLATE up to here blocks a base at floor level
BAND = 0.25
CLS = {"free": 0, "wall": 1, "heavy": 2, "light": 3, "step": 4, "overhead": 5}

def load_obj_tris(path):
    V, F = [], []
    with open(path, errors="ignore") as f:
        for line in f:
            if line.startswith("v "):
                p = line.split(); V.append((float(p[1]), float(p[2]), float(p[3])))
            elif line.startswith("f "):
                idx = [int(t.split("/")[0]) for t in line.split()[1:]]
                idx = [i - 1 if i > 0 else len(V) + i for i in idx]
                for k in range(1, len(idx) - 1): F.append((idx[0], idx[k], idx[k + 1]))
    return np.array(V, float), np.array(F, int)

def sample_surface(V, F, spacing):
    A, B, C = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    emax = np.max(np.stack([np.linalg.norm(B - A, axis=1), np.linalg.norm(C - B, axis=1),
                            np.linalg.norm(A - C, axis=1)]), axis=0)
    n = np.clip(np.ceil(emax / spacing).astype(int), 1, 80)
    pts = []
    for k in np.unique(n):
        sel = n == k
        ij = [(i, j) for i in range(k + 1) for j in range(k + 1 - i)]
        W = np.array([(1 - (i + j) / k, i / k, j / k) for i, j in ij])        # barycentric lattice
        P = np.einsum("pw,twc->tpc", W, np.stack([A[sel], B[sel], C[sel]], axis=1))
        pts.append(P.reshape(-1, 3))
    return np.concatenate(pts)

def local_raster(V, F, s0):
    """Classify the piece's footprint in its raw frame at scale s0. Returns (x0, z0, grid)."""
    P = sample_surface(V, F, spacing=0.03 / max(s0, 0.5))
    x, y, z = P[:, 0] * s0, (P[:, 1] - V[:, 1].min()) * s0, P[:, 2] * s0
    x0, z0 = math.floor(x.min() / RES) * RES, math.floor(z.min() / RES) * RES
    ix = ((x - x0) / RES).astype(int); iz = ((z - z0) / RES).astype(int)
    nx, nz = ix.max() + 1, iz.max() + 1
    lin = iz * nx + ix
    maxh = np.zeros(nx * nz); np.maximum.at(maxh, lin, y)
    bump = np.zeros(nx * nz, bool); bump[lin[(y >= FLOOR_PLATE) & (y <= BUMP_TOP)]] = True
    bands = np.zeros(nx * nz, np.int64)
    np.bitwise_or.at(bands, lin, np.left_shift(1, np.minimum(31, (y // BAND).astype(np.int64))))
    over = np.full(nx * nz, np.inf); hi = y >= 1.5; np.minimum.at(over, lin[hi], y[hi])
    cls = np.zeros(nx * nz, np.uint8); zz = np.zeros(nx * nz)
    for c in range(nx * nz):
        if bump[c]:
            nb = max(1, min(31, int(math.ceil(maxh[c] / BAND))))
            m = int(bands[c]); filled = bin(m & ((1 << nb) - 1)).count("1")
            k = 1                                             # contiguous filled bands from the floor plate
            while k < 32 and (m >> k) & 1: k += 1
            cont = k * BAND
            if maxh[c] >= 1.7 and filled / nb >= 0.55: cls[c], zz[c] = CLS["wall"], maxh[c]
            elif cont >= 1.7: cls[c], zz[c] = CLS["wall"], cont
            else: cls[c], zz[c] = CLS["light"], max(cont, 0.5)
        elif np.isfinite(over[c]):
            cls[c], zz[c] = CLS["overhead"], over[c]
    cls = cls.reshape(nz, nx); zz = zz.reshape(nz, nx)
    # drop specks: scan noise of 1-2 cells would block a whole base-width in C-space
    from scipy import ndimage
    solid = (cls == CLS["wall"]) | (cls == CLS["light"])
    lab, nlab = ndimage.label(solid, structure=np.ones((3, 3)))
    sizes = ndimage.sum(solid, lab, range(1, nlab + 1))
    for i, sz in enumerate(sizes, start=1):
        if sz < 3: cls[lab == i] = CLS["free"]
    return x0, z0, cls, zz

def encode(cls, zz):
    """One byte per cell: class in high nibble, height in 0.5" steps (0-15) in low nibble; RLE."""
    q = np.clip(np.round(zz * 2), 0, 15).astype(np.uint8)
    code = (cls.astype(np.uint8) << 4) | np.where(cls > 0, q, 0)
    flat = code.ravel()
    out = bytearray(); i = 0
    while i < len(flat):
        j = i
        while j < len(flat) and flat[j] == flat[i] and j - i < 255: j += 1
        out += bytes([flat[i], j - i]); i = j
    return base64.b64encode(bytes(out)).decode()

if __name__ == "__main__":
    # python tools/fine_footprint.py  ->  cache/fine/fine_pieces.json (+ .npy rasters for inspection)
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from paths import FINE_DIR, MESH_DIR, PARSED_DIR, ensure_dir
    meshdir, bagsfile = MESH_DIR, os.path.join(PARSED_DIR, "volkus_bags.json")
    outpath = os.path.join(ensure_dir(FINE_DIR), "fine_pieces.json")
    bags = json.load(open(bagsfile))
    scales = collections.defaultdict(list)
    for b in bags.values():
        for o in b["ContainedObjects"]:
            cm = o.get("CustomMesh") or {}
            if cm.get("MeshURL"):
                scales[cm["MeshURL"].rsplit("/", 2)[-2][-16:]].append(o["Transform"]["scaleX"])
    skip = {"06EC984208223D38", "9C8BD76749A0A723", "2AA481BF3BB82CD4"}   # board, guides, objectives
    table = {}
    for fn in sorted(os.listdir(meshdir)):
        key = fn[:-4]
        if not fn.endswith(".obj") or key in skip or key not in scales: continue
        s0 = sorted(scales[key])[len(scales[key]) // 2]
        V, F = load_obj_tris(os.path.join(meshdir, fn))
        x0, z0, cls, zz = local_raster(V, F, s0)
        counts = {k: int((cls == v).sum()) for k, v in CLS.items() if v and (cls == v).any()}
        table[key] = {"s0": round(s0, 4), "x0": round(x0, 3), "z0": round(z0, 3),
                      "nx": int(cls.shape[1]), "nz": int(cls.shape[0]), "rle": encode(cls, zz)}
        print(f"{key}: {cls.shape[1]}x{cls.shape[0]} cells @0.1\"  {counts}")
        np.save(os.path.join(os.path.dirname(outpath), f"fine_{key}.npy"), np.stack([cls, np.round(zz * 2)]))
    json.dump(table, open(outpath, "w"), separators=(",", ":"))
    print("wrote", outpath, os.path.getsize(outpath), "bytes")
