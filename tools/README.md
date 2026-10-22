# Asset pipeline

These Python scripts turn the Tabletop Simulator mods into the compact data the app ships with,
and check the result against the official map cards. Everything downloaded or produced in bulk
goes to `cache/` (git-ignored). Only `src/data/*.js` (measurements and links) is committed;
`public/models/` and `public/meshpack.json` (the 3D terrain) are built locally and git-ignored.
They're third-party content: never commit them (see `CLAUDE.md`).

```sh
pip install -r tools/requirements.txt     # numpy, scipy, pillow, pymongo (bson), UnityPy
```

| step | command | output |
|---|---|---|
| 1. fetch | `python tools/fetch_assets.py` | `cache/workshop/*.bson`, `cache/parsed/volkus_bags.json`, `cache/parsed/gallowdark_gd{1,2}.json`, `cache/meshes/*.obj`, `cache/cards/*.img` |
| 2. trace | `python tools/fine_footprint.py` | `cache/fine/fine_pieces.json` (+ `.npy` rasters to inspect) |
| 3. data | `python tools/build_data.py` | `src/data/fine-pieces.js`, `src/data/volkus-layouts.js` |
| 4. Gallowdark | `python tools/convert_maps.py` | `src/data/gallowdark.js` |
| 5. 3D meshes | `python tools/meshpack.py` | `public/meshpack.json` (decimated fallback) |
| 5b. exact models | `python tools/model_pack.py` | `public/models/` (full-res meshes + original textures, ~52 MB) |
| 6. verify | `npm run export:maps` then `python tools/verify_maps.py --year 24` (or `25`) | `cache/verify/<year>/verify_v*.png`, `verify_report.json` |

Steps 3 and 4 regenerate the committed data. From a fresh download they reproduce it exactly, so
any diff means the mod or the tracing changed.

## What each script does

- **fetch_assets.py** looks up each Workshop item's file through the public Steam
  `GetPublishedFileDetails` API and downloads the WorkshopUpload saves (BSON). From the Volkus save
  it extracts the twelve "Volkus 2x 0y" layout bags, downloads every scanned piece mesh they
  reference, and downloads the map-card tiles. For the Gallowdark saves it extracts every object,
  including objects stored as JSON inside Lua strings. Old saves point at retired Steam CDN
  hosts, so the current hosts are tried too.
- **fine_footprint.py** traces each piece's footprint at 0.1" from its mesh triangles. The
  classification rules are in `docs/ARCHITECTURE.md`.
- **build_data.py** writes the generated JS modules. It recodes the fire-step mesh as
  non-blocking and keeps the scanned light rubble as light terrain.
- **convert_maps.py** converts Gallowdark wall pieces to rects; hatchways become two stubs around
  an open access point. It matches `convertGallowdark` in the app.
- **meshpack.py** decimates each scanned mesh by vertex clustering and packs it as base64 Int16
  vertices (0.01" units) and Uint16 indices: the light fallback for the 3D view.
- **model_pack.py** packs the exact TTS models for the 3D table: every scanned mesh at full
  resolution with its original diffuse texture (byte for byte), the rubble and fire-step Unity
  asset bundles (meshes, prefab hierarchy and textures read with UnityPy), the mat, objective
  markers and deployment guides. Geometry stays in Unity local space (OBJ X negated, winding
  reversed); `manifest.json` lists each model's file, TTS material type, size and bounds.
- **verify_maps.py** scores the app's maps against the card images:
  - terrain overlap F1 on a 0.25" lattice
  - objective error against the card's skull rings
  - deployment edge from the card's drop-zone strips

  It also writes an overlay image per map.
- **fine_compose.py** is a diagnostic Python mirror of the browser's board composition, with
  rect counts and nook area per map.
- **tts_parse.py** decodes any save to JSON and inventories its objects and asset URLs.
- **volkus_convert.py** holds the shared TTS/Volkus conventions (piece keys, frame,
  board transform, card-measured rubble templates), plus the earlier coarse rect converter.

`research/` holds the one-off investigations that established those conventions:
- `audit_cards.py` scores transform hypotheses (mirroring, rotation) against the cards.
- `audit_scale.py` sweeps the scale.
- `measure_templates.py` measures the rubble footprints from the cards.

They take explicit paths: `python tools/research/audit_cards.py cache/parsed/volkus_bags.json cache/meshes cache/cards`.

## Sources

- KT24 Base table *The Killzone Mod*, Steam Workshop 3573927734 (Volkus layouts, scans, cards)
- Gallowdark Approved Ops 1 and 2, Steam Workshop 3353224453 and 3360436479

This is third-party content (the scans are of Games Workshop terrain, and the cards are Games
Workshop's), which is why it stays in `cache/`.
