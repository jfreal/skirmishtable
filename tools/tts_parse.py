#!/usr/bin/env python3
"""Decode a Tabletop Simulator WorkshopUpload (BSON) to JSON and inventory its contents."""
import sys, json, collections
import bson

def decode(path):
    with open(path, 'rb') as f:
        raw = f.read()
    return bson.decode(raw)

URL_KEYS = {"ImageURL","ImageSecondaryURL","MeshURL","DiffuseURL","NormalURL","ColliderURL",
            "AssetbundleURL","AssetbundleSecondaryURL","FaceURL","BackURL","URL","PDFUrl","LutURL"}

def walk(obj, stats, depth=0, path=""):
    if isinstance(obj, dict):
        name = obj.get("Name")
        if name is not None and ("Transform" in obj or "GUID" in obj):
            nick = obj.get("Nickname") or ""
            stats["objects"].append({
                "path": path, "type": name, "nickname": nick[:60], "guid": obj.get("GUID"),
                "lua": len(obj.get("LuaScript") or ""),
                "xmlui": len(obj.get("XmlUI") or ""),
                "locked": obj.get("Locked"),
                "pos": ([round(obj["Transform"].get(k, 0), 2) for k in ("posX","posY","posZ")]
                        if isinstance(obj.get("Transform"), dict) else None),
                "scale": ([round(obj["Transform"].get(k, 0), 2) for k in ("scaleX","scaleY","scaleZ")]
                          if isinstance(obj.get("Transform"), dict) else None),
            })
            stats["types"][name] += 1
        for k, v in obj.items():
            if k in URL_KEYS and isinstance(v, str) and v.strip():
                stats["urls"][v] = stats["urls"].get(v) or k
            if k == "LuaScript" and isinstance(v, str) and len(v) > 0:
                stats["lua_total"] += len(v)
            walk(v, stats, depth+1, f"{path}/{obj.get('Nickname') or obj.get('Name') or k}" if k=="ContainedObjects" else path)
    elif isinstance(obj, list):
        for v in obj:
            walk(v, stats, depth+1, path)

def main(path, outdir):
    doc = decode(path)
    base = path.rsplit('/',1)[-1].rsplit('.',1)[0]
    with open(f"{outdir}/{base}.json", "w") as f:
        json.dump(doc, f, indent=1)
    stats = {"objects": [], "types": collections.Counter(), "urls": {}, "lua_total": 0}
    walk(doc.get("ObjectStates", []), stats)
    top = {
        "SaveName": doc.get("SaveName"),
        "VersionNumber": doc.get("VersionNumber"),
        "GameMode": doc.get("GameMode"),
        "top_level_keys": sorted(doc.keys()),
        "global_lua_chars": len(doc.get("LuaScript") or ""),
        "global_xmlui_chars": len(doc.get("XmlUI") or ""),
        "table": doc.get("Table"),
        "grid": {k: doc.get("Grid", {}).get(k) for k in ("Type","PosOffset","xSize","ySize")} if isinstance(doc.get("Grid"), dict) else None,
        "num_top_objects": len(doc.get("ObjectStates", [])),
        "num_all_objects": len(stats["objects"]),
        "object_type_counts": dict(stats["types"].most_common()),
        "contained_lua_chars": stats["lua_total"],
        "num_asset_urls": len(stats["urls"]),
    }
    print(json.dumps(top, indent=1, default=str))
    with open(f"{outdir}/{base}_inventory.json", "w") as f:
        json.dump({"summary": top, "objects": stats["objects"],
                   "asset_urls": stats["urls"]}, f, indent=1, default=str)

if __name__ == "__main__":
    # python tools/tts_parse.py cache/workshop/<id>.bson [outdir]  — decode + inventory any save
    import os
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from paths import PARSED_DIR, ensure_dir
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else ensure_dir(PARSED_DIR))
