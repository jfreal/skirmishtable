#!/usr/bin/env python3
"""Pack the exact Tabletop Simulator models for the 3D table — full resolution, with
their original textures — into public/models/ (git-ignored):

  manifest.json      key -> model file, texture files, TTS material type
  <KEY>.bin          one model: [u32 header length][JSON header][Float32 positions,
                     normals, uvs][Uint32 indices] per part
  tex/<name>.jpg|png the original diffuse textures, byte for byte (asset-bundle textures,
                     stored compressed inside Unity bundles, are re-encoded once at q95)

Covers every model a Volkus layout uses: the scanned ruins and strongholds (OBJ), the
rubble and fire-step Unity asset bundles (meshes + textures read with UnityPy), the mat
surface, the objective markers and the deployment guide planes.

Geometry is stored in Unity's (TTS's) local space: OBJ vertices with X negated, as TTS
imports them; bundle meshes as authored, with their prefab hierarchy baked in. Triangle
winding is reversed so faces are counter-clockwise in that space; the app's transform
(src/view3d/models.js) converts Unity's left-handed world to the right-handed table.

Usage: python tools/model_pack.py   (after fetch_assets.py; downloads textures and bundles)
"""
import hashlib, io, json, os, shutil, struct, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paths import CACHE, MESH_DIR, PARSED_DIR, PUBLIC_DIR, ensure_dir, url_key
from fetch_assets import download

OUT = os.path.join(PUBLIC_DIR, "models")
TEX_CACHE = os.path.join(CACHE, "textures")
BUNDLE_CACHE = os.path.join(CACHE, "bundles")

def read_obj(path):
    """Positions, uvs, normals and triangles of an OBJ, de-indexed on (v, vt, vn)."""
    V, T, N, out_idx, key_of, P, U, NN = [], [], [], [], {}, [], [], []
    with open(path, errors="ignore") as f:
        for line in f:
            if line.startswith("v "):
                p = line.split(); V.append((float(p[1]), float(p[2]), float(p[3])))
            elif line.startswith("vt "):
                p = line.split(); T.append((float(p[1]), float(p[2]) if len(p) > 2 else 0.0))
            elif line.startswith("vn "):
                p = line.split(); N.append((float(p[1]), float(p[2]), float(p[3])))
            elif line.startswith("f "):
                corners = []
                for tok in line.split()[1:]:
                    parts = (tok.split("/") + ["", ""])[:3]
                    vi = int(parts[0]); vi = vi - 1 if vi > 0 else len(V) + vi
                    ti = int(parts[1]) if parts[1] else 0; ti = ti - 1 if ti > 0 else (len(T) + ti if ti < 0 else -1)
                    ni = int(parts[2]) if parts[2] else 0; ni = ni - 1 if ni > 0 else (len(N) + ni if ni < 0 else -1)
                    k = (vi, ti, ni)
                    if k not in key_of:
                        key_of[k] = len(P)
                        P.append(V[vi]); U.append(T[ti] if ti >= 0 else (0.0, 0.0)); NN.append(N[ni] if ni >= 0 else (0.0, 0.0, 0.0))
                    corners.append(key_of[k])
                for i in range(1, len(corners) - 1):
                    out_idx.append((corners[0], corners[i], corners[i + 1]))
    P = np.array(P, np.float32); U = np.array(U, np.float32); NN = np.array(NN, np.float32)
    I = np.array(out_idx, np.uint32)
    if not np.any(NN):                      # no normals in the file: compute them
        NN = vertex_normals(P, I)
    P[:, 0] *= -1; NN[:, 0] *= -1           # TTS imports OBJ with X negated
    return P, NN, U, I[:, ::-1].copy()      # mirroring flips the winding: restore CCW

def vertex_normals(P, I):
    n = np.zeros_like(P)
    fn = np.cross(P[I[:, 1]] - P[I[:, 0]], P[I[:, 2]] - P[I[:, 0]])
    for k in range(3): np.add.at(n, I[:, k], fn)
    return (n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)).astype(np.float32)

def trs(pos, rot, scale):
    x, y, z, w = rot.X, rot.Y, rot.Z, rot.W
    R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                  [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                  [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    M = np.eye(4); M[:3, :3] = R @ np.diag([scale.X, scale.Y, scale.Z]); M[:3, 3] = [pos.X, pos.Y, pos.Z]
    return M

def read_bundle(path, texdir, key):
    """Visible meshes of a Unity asset bundle, in the prefab root's space, with textures."""
    import UnityPy
    from UnityPy.helpers.MeshHelper import MeshHandler
    env = UnityPy.load(path)
    objs = {o.path_id: o for o in env.objects}
    tr_of_go, comps = {}, {}
    for o in env.objects:
        if o.type.name == "GameObject":
            g = o.read()
            comps[o.path_id] = [c.path_id for c in (cc.component if hasattr(cc, "component") else cc for cc in g.m_Components)]
    transforms = {o.path_id: o.read() for o in env.objects if o.type.name == "Transform"}
    for pid, t in transforms.items(): tr_of_go[t.m_GameObject.path_id] = pid
    def world(tpid):   # product of local TRS up to (not including) the root
        t = transforms[tpid]
        if not t.m_Father.path_id: return np.eye(4)
        return world(t.m_Father.path_id) @ trs(t.m_LocalPosition, t.m_LocalRotation, t.m_LocalScale)
    parts = []
    for o in env.objects:
        if o.type.name != "MeshRenderer": continue
        r = o.read(); go = r.m_GameObject.path_id
        mf = next((objs[c].read() for c in comps.get(go, []) if c in objs and objs[c].type.name == "MeshFilter"), None)
        if not mf or not mf.m_Mesh.path_id: continue
        h = MeshHandler(objs[mf.m_Mesh.path_id].read()); h.process()
        P = np.array(h.m_Vertices, np.float32).reshape(-1, 3)
        N = np.array(h.m_Normals, np.float32).reshape(len(P), -1)[:, :3] if h.m_Normals else None
        U = np.array([(u[0], u[1]) for u in h.m_UV0], np.float32) if h.m_UV0 else np.zeros((len(P), 2), np.float32)
        M = world(tr_of_go[go])
        P = (P @ M[:3, :3].T + M[:3, 3]).astype(np.float32)
        tris = [t for sub in h.get_triangles() for t in sub]
        I = np.array(tris, np.uint32)[:, ::-1].copy()   # Unity is clockwise-front: make CCW
        N = vertex_normals(P, I) if N is None else (N @ np.linalg.inv(M[:3, :3])).astype(np.float32)
        N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-12)
        tex = None
        for mp in r.m_Materials:
            if not mp.path_id: continue
            mat = objs[mp.path_id].read()
            for name, env_ in mat.m_SavedProperties.m_TexEnvs:
                if name == "_MainTex" and env_.m_Texture.path_id:
                    t2d = objs[env_.m_Texture.path_id].read()
                    buf = io.BytesIO(); t2d.image.convert("RGB").save(buf, "JPEG", quality=95)
                    data = buf.getvalue()
                    tex = f"tex/{hashlib.sha1(data).hexdigest()[:16].upper()}.jpg"   # bundles share textures
                    out = os.path.join(texdir, os.path.basename(tex))
                    if not os.path.exists(out):
                        with open(out, "wb") as f: f.write(data)
            break
        parts.append((P, N.astype(np.float32), U, I, tex))
    return parts

def write_model(path, parts):
    header, blobs, off = {"parts": []}, [], 0
    for P, N, U, I, tex in parts:
        entry = {"tex": tex, "count": int(len(P)), "icount": int(I.size)}
        for name, arr in (("pos", P), ("nrm", N), ("uv", U), ("idx", I)):
            b = np.ascontiguousarray(arr).tobytes()
            entry[name] = off; blobs.append(b); off += len(b)
        header["parts"].append(entry)
    h = json.dumps(header, separators=(",", ":")).encode()
    h += b" " * ((4 - (4 + len(h)) % 4) % 4)
    with open(path, "wb") as f:
        f.write(struct.pack("<I", len(h))); f.write(h)
        for b in blobs: f.write(b)
    return os.path.getsize(path)

def main():
    bags = json.load(open(os.path.join(PARSED_DIR, "volkus_bags.json")))
    shutil.rmtree(OUT, ignore_errors=True)
    ensure_dir(OUT); texdir = ensure_dir(os.path.join(OUT, "tex")); ensure_dir(TEX_CACHE); ensure_dir(BUNDLE_CACHE)
    meshes, bundles = {}, {}
    for bag in bags.values():
        for o in bag["ContainedObjects"]:
            cm, ca = o.get("CustomMesh") or {}, o.get("CustomAssetbundle") or {}
            if cm.get("MeshURL"): meshes[url_key(cm["MeshURL"])] = cm
            if ca.get("AssetbundleURL"): bundles[url_key(ca["AssetbundleURL"])] = ca
    manifest, total = {"models": {}}, 0
    for key, cm in sorted(meshes.items()):
        P, N, U, I = read_obj(os.path.join(MESH_DIR, key + ".obj"))
        tex = None
        if cm.get("DiffuseURL"):
            tk = url_key(cm["DiffuseURL"]); src = os.path.join(TEX_CACHE, tk)
            download(cm["DiffuseURL"], src)
            ext = ".png" if open(src, "rb").read(4) == b"\x89PNG" else ".jpg"
            tex = f"tex/{tk}{ext}"
            dst = os.path.join(OUT, tex)
            if not os.path.exists(dst):
                with open(src, "rb") as a, open(dst, "wb") as b: b.write(a.read())
        size = write_model(os.path.join(OUT, key + ".bin"), [(P, N, U, I, tex)])
        manifest["models"][key] = {"file": key + ".bin", "material": cm.get("MaterialIndex", 0), "bytes": size,
                                   "bounds": [P.min(0).round(4).tolist(), P.max(0).round(4).tolist()]}
        total += size
        print(f"{key}  {len(P):6d} verts {len(I):6d} tris  {size / 1e6:5.2f} MB  {tex or 'no texture'}")
    for key, ca in sorted(bundles.items()):
        src = os.path.join(BUNDLE_CACHE, key + ".unity3d")
        download(ca["AssetbundleURL"], src)
        parts = read_bundle(src, texdir, key)
        size = write_model(os.path.join(OUT, key + ".bin"), parts)
        allP = np.concatenate([p[0] for p in parts])
        manifest["models"][key] = {"file": key + ".bin", "material": ca.get("MaterialIndex", 0), "bytes": size,
                                   "bounds": [allP.min(0).round(4).tolist(), allP.max(0).round(4).tolist()]}
        total += size
        print(f"{key}  bundle: {len(parts)} part(s), {sum(len(p[0]) for p in parts)} verts  {size / 1e6:5.2f} MB")
    manifest["textures"] = {"tex/" + f: os.path.getsize(os.path.join(texdir, f)) for f in sorted(os.listdir(texdir))}
    tex_bytes = sum(os.path.getsize(os.path.join(texdir, f)) for f in os.listdir(texdir))
    with open(os.path.join(OUT, "manifest.json"), "w") as f: json.dump(manifest, f, indent=1)
    print(f"models {total / 1e6:.1f} MB + textures {tex_bytes / 1e6:.1f} MB -> public/models/")

if __name__ == "__main__":
    main()
