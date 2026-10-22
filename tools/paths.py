"""Shared locations and small helpers for the asset pipeline.

Everything fetched from the Steam Workshop (saves, scanned meshes, map card images)
and everything derived from it in bulk lives under cache/, which is git-ignored.
Only the compact tables the app needs are written into src/data/ and committed."""
import json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "cache")
WORKSHOP_DIR = os.path.join(CACHE, "workshop")   # raw TTS saves (BSON)
PARSED_DIR = os.path.join(CACHE, "parsed")       # extracted layout bags / map objects
MESH_DIR = os.path.join(CACHE, "meshes")         # scanned Volkus piece meshes (OBJ)
CARD_DIR = os.path.join(CACHE, "cards")          # official Volkus map card images
FINE_DIR = os.path.join(CACHE, "fine")           # per-piece footprint rasters
EXPORT_DIR = os.path.join(CACHE, "export")       # maps exported by `npm run export:maps`
VERIFY_DIR = os.path.join(CACHE, "verify")       # card-check overlays and reports
SRC_DATA = os.path.join(ROOT, "src", "data")
PUBLIC_DIR = os.path.join(ROOT, "public")

VOLKUS_MOD = "3573927734"                        # KT24 Base table The Killzone Mod
GALLOWDARK_MODS = {                              # key -> (workshop id, name)
    "gd1": ("3353224453", "Gallowdark AO1"),
    "gd2": ("3360436479", "Gallowdark AO2"),
}

def url_key(url, n=16):
    """Steam UGC URLs end in a content hash; its last n characters identify the asset."""
    parts = [p for p in (url or "").split("/") if p]
    return parts[-1][-n:] if parts else None

def ensure_dir(path):
    os.makedirs(path, exist_ok=True)
    return path

def write_js_module(path, header, name, value):
    """Write `export const NAME = <json>;` with a generated-file header."""
    with open(path, "w") as f:
        f.write("/**\n * " + header.replace("\n", "\n * ") + "\n */\n")
        f.write(f"export const {name} = " + json.dumps(value, separators=(",", ":")) + ";\n")
    print("wrote", os.path.relpath(path, ROOT), f"({os.path.getsize(path) / 1024:.1f} KB)")
