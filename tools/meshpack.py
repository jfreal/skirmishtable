#!/usr/bin/env python3
"""Decimate the scanned Volkus OBJ meshes (vertex clustering) and pack them into a
compact JSON: per piece, base64 Int16 vertices (0.01" units, grounded at y=0,
piece-local, unscaled) and base64 Uint16 triangle indices."""
import sys, os, json, base64, array, collections

CLUSTER = 0.15  # inches, in local mesh units times nominal scale ~1 — good enough

def load_obj(path):
    verts, faces = [], []
    with open(path, errors="ignore") as f:
        for line in f:
            if line.startswith("v "):
                p = line.split()
                verts.append((float(p[1]), float(p[2]), float(p[3])))
            elif line.startswith("f "):
                idx = [int(tok.split("/")[0]) for tok in line.split()[1:]]
                idx = [i - 1 if i > 0 else len(verts) + i for i in idx]
                for k in range(1, len(idx) - 1):  # fan-triangulate
                    faces.append((idx[0], idx[k], idx[k+1]))
    return verts, faces

def decimate(verts, faces, cell):
    y0 = min(v[1] for v in verts)
    cluster_of = {}
    clusters = []           # [sumx, sumy, sumz, n]
    vmap = [0] * len(verts)
    for i, (x, y, z) in enumerate(verts):
        key = (int(x // cell), int((y - y0) // cell), int(z // cell))
        ci = cluster_of.get(key)
        if ci is None:
            ci = len(clusters)
            cluster_of[key] = ci
            clusters.append([0.0, 0.0, 0.0, 0])
        c = clusters[ci]
        c[0] += x; c[1] += y - y0; c[2] += z; c[3] += 1
        vmap[i] = ci
    newv = [(c[0]/c[3], c[1]/c[3], c[2]/c[3]) for c in clusters]
    seen, newf = set(), []
    for a, b, c in faces:
        t = (vmap[a], vmap[b], vmap[c])
        if t[0] == t[1] or t[1] == t[2] or t[0] == t[2]: continue
        k = tuple(sorted(t))
        if k in seen: continue
        seen.add(k)
        newf.append(t)
    return newv, newf

def pack(verts, faces):
    va = array.array("h")
    for x, y, z in verts:
        va.extend((int(round(x*100)), int(round(y*100)), int(round(z*100))))
    fa = array.array("H")
    for a, b, c in faces:
        fa.extend((a, b, c))
    return {"n": len(verts),
            "v": base64.b64encode(va.tobytes()).decode(),
            "f": base64.b64encode(fa.tobytes()).decode()}

if __name__ == "__main__":
    # python tools/meshpack.py  ->  public/meshpack.json (served to the 3D view; git-ignored)
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from paths import MESH_DIR, PUBLIC_DIR, ensure_dir
    meshdir, outpath = MESH_DIR, os.path.join(ensure_dir(PUBLIC_DIR), "meshpack.json")
    skip = {"06EC984208223D38", "9C8BD76749A0A723"}  # board surface, deployment guide planes
    out = {}
    for fn in sorted(os.listdir(meshdir)):
        if not fn.endswith(".obj"): continue
        key = fn[:-4]
        if key in skip: continue
        verts, faces = load_obj(os.path.join(meshdir, fn))
        cell = CLUSTER
        nv, nf = decimate(verts, faces, cell)
        while len(nv) > 60000:  # keep Uint16-indexable
            cell *= 1.5
            nv, nf = decimate(verts, faces, cell)
        out[key] = pack(nv, nf)
        print(f"{key}: {len(verts):6d}v {len(faces):6d}f  ->  {len(nv):5d}v {len(nf):5d}f")
    js = json.dumps(out, separators=(",", ":"))
    open(outpath, "w").write(js)
    print("wrote", outpath, f"{len(js)/1024:.0f} KB")
