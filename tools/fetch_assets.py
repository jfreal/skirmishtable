#!/usr/bin/env python3
"""Download the third-party inputs into cache/ (never committed) and extract what the
other tools need:

  cache/workshop/<id>.bson          Tabletop Simulator saves from the Steam Workshop:
                                    the KT24 Killzone Mod (Volkus) and Gallowdark
                                    Approved Ops 1 and 2
  cache/parsed/volkus_bags.json     the twelve Volkus Approved Ops layout bags
  cache/parsed/gallowdark_gdN.json  every object in each Gallowdark save
  cache/meshes/<KEY>.obj            the scanned mesh of each Volkus piece
  cache/cards/Volkus_YY_0N.img      the official map card images (for checking only)

Usage: python tools/fetch_assets.py [--force]
"""
import argparse, json, os, re, sys, urllib.parse, urllib.request
import bson  # pymongo
from paths import (CARD_DIR, GALLOWDARK_MODS, MESH_DIR, PARSED_DIR, VOLKUS_MOD, WORKSHOP_DIR,
                   ensure_dir, url_key)

API = "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/"
UA = {"User-Agent": "skirmishtable-tools/1.0"}
# Old TTS saves reference retired Steam CDN hosts; try the current ones too.
CDN_HOSTS = ["steamusercontent-a.akamaihd.net", "cdn.steamusercontent.com"]

def workshop_file_url(item_id):
    data = urllib.parse.urlencode({"itemcount": 1, "publishedfileids[0]": item_id}).encode()
    with urllib.request.urlopen(urllib.request.Request(API, data=data, headers=UA), timeout=60) as r:
        details = json.load(r)["response"]["publishedfiledetails"][0]
    if not details.get("file_url"):
        raise RuntimeError(f"Workshop item {item_id} has no downloadable file (result {details.get('result')})")
    return details["file_url"]

def download(url, path, force=False):
    if os.path.exists(path) and os.path.getsize(path) > 0 and not force:
        return path
    candidates = [url]
    u = urllib.parse.urlparse(url)
    if "steamusercontent" in u.netloc:
        candidates += [u._replace(scheme="https", netloc=h).geturl() for h in CDN_HOSTS if h != u.netloc]
    last = None
    for c in candidates:
        try:
            with urllib.request.urlopen(urllib.request.Request(c, headers=UA), timeout=120) as r:
                body = r.read()
            with open(path, "wb") as f:
                f.write(body)
            print(f"  {os.path.basename(path)}  {len(body) / 1024:.0f} KB")
            return path
        except Exception as e:  # try the next host
            last = e
    raise RuntimeError(f"could not download {url}: {last}")

def load_save(item_id, force):
    path = os.path.join(ensure_dir(WORKSHOP_DIR), f"{item_id}.bson")
    if not os.path.exists(path) or force:
        print(f"Workshop {item_id}:")
        download(workshop_file_url(item_id), path, force)
    with open(path, "rb") as f:
        raw = f.read()
    return bson.decode(raw) if raw[:1] != b"{" else json.loads(raw)

def extract_objects(root):
    """Every TTS object: the ObjectStates tree, bag contents, and objects stored as JSON
    inside Lua [[...]] strings (map-saver cards). Mirrors extractTTSObjects() in the app."""
    out = []
    def visit(o):
        if isinstance(o, list):
            for v in o: visit(v)
            return
        if not isinstance(o, dict):
            return
        if o.get("Name") and o.get("Transform"):
            out.append(o)
        for k, v in o.items():
            if k == "LuaScript" and isinstance(v, str) and len(v) > 100:
                for m in re.finditer(r"\[\[([\s\S]*?)\]\]", v):
                    s = m.group(1).strip()
                    if s.startswith("{"):
                        try:
                            j = json.loads(s)
                            if j.get("Name") and j.get("Transform"):
                                out.append(j)
                        except ValueError:
                            pass
            else:
                visit(v)
    visit(root)
    return out

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--force", action="store_true", help="download again even if cached")
    args = ap.parse_args()
    ensure_dir(PARSED_DIR); ensure_dir(MESH_DIR); ensure_dir(CARD_DIR)

    # Volkus: layout bags, their scanned meshes, and the map cards
    save = load_save(VOLKUS_MOD, args.force)
    bags = {}
    def find_bags(o):
        if isinstance(o, list):
            for v in o: find_bags(v)
        elif isinstance(o, dict):
            # the Approved Ops layouts only (the mod also has a "Map Builder" bag of spares)
            if (o.get("Name") == "Bag" and re.fullmatch(r"Volkus 2[45] 0[1-6]", o.get("Nickname") or "")
                    and len(o.get("ContainedObjects") or []) >= 15):
                bags[o["Nickname"]] = o
            for k, v in o.items():
                if k != "LuaScript": find_bags(v)
    find_bags(save)
    with open(os.path.join(PARSED_DIR, "volkus_bags.json"), "w") as f:
        json.dump(bags, f)
    print(f"Volkus: {len(bags)} layout bags -> cache/parsed/volkus_bags.json")
    meshes = {}
    for bag in bags.values():
        for o in bag["ContainedObjects"]:
            url = (o.get("CustomMesh") or {}).get("MeshURL")
            if url: meshes[url_key(url)] = url
    print(f"Volkus: {len(meshes)} scanned meshes")
    for key, url in sorted(meshes.items()):
        download(url, os.path.join(MESH_DIR, f"{key}.obj"), args.force)
    cards = {}
    def find_cards(o):
        if isinstance(o, list):
            for v in o: find_cards(v)
        elif isinstance(o, dict):
            nick = o.get("Nickname") or ""
            url = (o.get("CustomImage") or {}).get("ImageURL")
            if url and o.get("Name") != "Bag" and re.fullmatch(r"Volkus 2[45] 0[1-6]", nick):
                cards[nick] = url
            for k, v in o.items():
                if k != "LuaScript": find_cards(v)
    find_cards(save)
    print(f"Volkus: {len(cards)} map cards")
    for nick, url in sorted(cards.items()):
        download(url, os.path.join(CARD_DIR, nick.replace(" ", "_") + ".img"), args.force)

    # Gallowdark: every object in each save (convert_maps.py picks out the walls)
    for key, (item_id, name) in GALLOWDARK_MODS.items():
        objs = extract_objects(load_save(item_id, args.force))
        with open(os.path.join(PARSED_DIR, f"gallowdark_{key}.json"), "w") as f:
            json.dump(objs, f)
        print(f"{name}: {len(objs)} objects -> cache/parsed/gallowdark_{key}.json")

if __name__ == "__main__":
    sys.exit(main())
