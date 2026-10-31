# SkirmishTable

**SkirmishTable** is a browser tabletop for **skirmish wargames**. It loads real terrain (the Volkus and Gallowdark
killzones) onto a playable 3D table, lets two players move models with a real mouse or finger,
routes every move around terrain or over it, and judges line of sight, cover and obscuring. The
game's rules are a pluggable **ruleset**: Kill Team (2024) is the reference, an Infinity-style
ruleset and a made-up house ruleset (Ashfall) show the same table playing differently. The
players stay in charge of legality; the app does the measuring.

SkirmishTable is open source and in the public domain ([the Unlicense](UNLICENSE)). The repo holds
only our own code and data; the 3D models, cards and token art come from community Tabletop
Simulator mods and are loaded by each player's browser from where the mods keep them. See
[Assets and licensing](#assets-and-licensing).

What makes it more than a top-down sketch is the terrain. Every Volkus ruin is traced from its
**Tabletop Simulator scan at 0.1"**. Walls, doorways, alcoves and the ground under upper floors
are real space, so you can tuck ("nook") an operative into terrain wherever a 28mm base actually
fits. All twelve Volkus Approved Ops layouts (2024 and 2025) are built in, checked against the
official map cards. Gallowdark AO 1–2 and a hand-made Volkus map are also included, and any TTS
save with Volkus layout bags or Gallowdark walls can be imported in the page.

## Quick start

Requires **Node 20.19+** (Node 22 recommended).

```sh
npm ci            # install exactly the locked dependencies (see note below)
npm run dev       # dev server at http://localhost:5173 with hot reload
npm test          # headless engine tests (Vitest, ~7 s)
npm run build     # production build -> dist/index.html, one self-contained file
```

Browser tests (Playwright) run against the production build:

```sh
npx playwright install chromium   # once
npm run test:e2e
```

> **npm note:** use `npm ci`, which installs from `package-lock.json`. On npm 10.x, a fresh
> `npm install` (with no lockfile) can crash with `Cannot read properties of null (reading 'edgesOut')`,
> a known npm bug with Vitest's optional peers. npm 11 doesn't have it.

The 3D table starts with block terrain and offers **Load from Steam**: your browser downloads
the exact scans and textures straight from the Steam Workshop CDN (~50 MB once, then from the
browser cache), so neither this repo nor the site ever holds them. If you build a local pack
with the tools below (`public/models/`, `public/meshpack.json`, both git-ignored), the dev
server uses that instead. Rubble and some fire steps are Unity asset bundles; the
browser reads those too (`src/import/unity.js`, with `src/import/lzma.js`), and only a bundle
that fails to read falls back to a block. `tools/model_pack.py` and `tools/meshpack.py`
rebuild the local pack.

## Rulesets

Everything game-specific lives in `src/rules/`: one module per game, switched from the Rules
panel. The table (terrain grid, fit map, routing, sight geometry, 3D view) never changes.

| | Kill Team (2024) | Infinity-style (simplified) | Ashfall (house rules) |
|---|---|---|---|
| bases | 28mm | 25mm | 32mm |
| movement paid in | whole inches | exact distance | 2″ bounds |
| move actions | Reposition 6″, Dash 3″, Charge 8″ | Move 4″ + second Move 2″ | Advance 6″, Sprint 4″, Assault 8″ |
| which moves can climb | Reposition, Charge | both | Advance, Assault |
| climb cost | height up (≥2″) + drop past 2″ | height up, drop free | flat 3″ up + 1″ down |
| cover (terrain only, never other operatives) | terrain within 1″ of target, none within 2″ | terrain within ½″ | terrain within 2″, none within 3″ |
| obscured (valid, attacker discards a success; can also be in cover) | sight-blockers >1″ from shooter and >2″ from target, none within 2″ | — | sight-blockers >3″ from both |
| orders | Conceal / Engage (on Conceal: can't Shoot, and not a valid target in cover) | — | — |

The Infinity-style ruleset is *inspired by* that game's feel, not its actual rules; Ashfall is
invented. Base size matters more than it looks: a 25mm base walks into a Volkus stronghold
through a gap a 28mm base can't use, and a 32mm base no longer fits the corner nooks.

To add a game, copy `src/rules/killteam.js`, change the numbers, and list it in
`src/rules/index.js`. Anything a ruleset can't yet express (silhouette heights for line of
sight, zones of control, reactive orders, different activation systems) is the next layer to add.

## The 3D table

The 3D table is the default view and is fully playable: grab an operative to drag it (the same
planner and rules as the 2D map, with the route drawn as ribbons on the table, climbs as arcs
with their cost, and a ghost at the landing spot); drag empty table to orbit, scroll to zoom,
**Top-down** to look straight down.

The Volkus terrain is drawn with the **exact Tabletop Simulator models**: every scan at full
resolution with its original texture, the rubble and fire-step asset bundles, the mat, the
objective markers, each placed with its full TTS position, rotation, scale and tint, with
shadows. Select an operative and the table shades everything it **can't see**, the same
visibility as the 2D map, and rings each enemy it can see (faintly if that enemy is in cover);
click an enemy to draw the sight line and the terrain giving cover. Gallowdark walls are TTS
asset bundles too but aren't packed yet; those maps use simple walls. The **2D map** keeps the
ruler. Without WebGL or the three.js CDN the page falls back to the 2D map.

## Project layout

```
index.html              page markup; three.js r128 and fonts load from CDNs
src/
  main.js               boot: wires the UI, registers maps, loads Volkus AO 1
  config.js             shared constants (inches), teams, weapons; base size and control range are set by the ruleset
  rules/                rulesets: killteam.js, infinity.js, ashfall.js, and index.js (switching, costs)
  state.js              UI state shared across modules (selection, drag, mode, ...)
  engine/               the rules engine: no DOM, runs in Node
    world.js            map registry, buildWorld() (headless map load), roster
    grid.js             0.1" terrain grid, scanned-piece composition, clearance map
    movement.js         climbing, route search, whole-inch increments
    sight.js            line of sight, cover, obscuring, shadow polygon
    geometry.js, dice.js
  import/tts.js         Tabletop Simulator importers (BSON, Volkus bags, Gallowdark)
  ui/                   SVG board, side panels, pointer input, map picker
  view3d/table3d.js     3D table: rendering, picking, the move preview
  data/                 map data; fine-pieces.js and volkus-layouts.js are generated
tests/unit/             Vitest: maps, movement, sight, rulesets, importers (Node, no browser)
tests/e2e/              Playwright: 3D and 2D drags (mouse, and finger on a phone), climb, verdict, maps, rulesets, views, undo
tools/                  Python asset pipeline (fetch, trace footprints, generate data, verify)
scripts/                build helpers and the map exporter for verification
docs/ARCHITECTURE.md    how the engine works, in detail
```

The engine never imports UI code. `buildWorld(map)` does everything a map needs for the rules
(grid, clearance, climb portals, drop zones, roster) without touching the DOM. The unit tests
and `scripts/export-maps.mjs` use it directly. In the browser, `window.skirmishtable` exposes the
engine modules and UI state for debugging, for example
`skirmishtable.movement.findPath(x1, y1, x2, y2)`.

## How it works, briefly

- **Terrain grid.** Every map is rasterized to a 0.1" grid. Each cell gets a class (wall,
  heavy, light, fire step, upper-floor overhead), a height and the terrain piece it belongs to.
  Scanned Volkus pieces are traced once, offline, into per-piece rasters. At load time they are
  placed on the board by exact inverse rotation.
- **Clearance map.** An exact Euclidean distance transform gives every point's distance to the
  nearest blocking terrain. A base fits wherever that distance is at least its radius (0.551").
  This one lookup is what makes nooks work.
- **Movement.** Lazy Theta* any-angle search over the grid runs once per drag and plan, then
  each pointer move just reads the route. Climbs are "portals" across climbable terrain. A final
  pass re-picks the bend points to minimise the whole-inch cost, because every straight leg is
  paid in full inches.
- **Sight.** Grid walks from the attacker's best base point to 24 points on the target's base.
  Walls and heavy terrain block sight. Cover and obscuring are judged per crossed cell, so a
  nooked operative gets cover from the wall beside it, not from the whole building.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the full picture, including the TTS
coordinate conventions and the rules decisions.

## Rules model and known simplifications

These describe Kill Team, the reference ruleset; the others change the numbers as in the table above.

- **Moves** are 1" straight increments, and a short final step still costs the full inch.
  Dragging past the Reposition allowance flows into the Dash.
- **Climbing** costs the height up (at least 2"), plus the drop back down beyond the free 2",
  plus the distance across. Climbs only happen during a Reposition or Charge, never a Dash. If a
  climb needs it, the planner dashes first and saves the Reposition for the climb. In general the
  planner tries both move orders and only allows climbing during moves the ruleset lets climb.
- **Dropping** is allowed in any move, Dash included. The free 2" is for the whole action: every
  drop in one action shares it (the down side of a climb over a wall is a drop too), and a
  second move action gets its own.
- **Low scan clutter.** Anything at base height counts as terrain, including rubble lips under
  0.5". The scans' low broken walls are therefore light terrain, and crossing one costs at least
  2". To make sub-1" clutter walk-over, change `local_raster()` in `tools/fine_footprint.py` or
  `zqHeight` / `crossingHeight` in `src/engine`.
- **Strongholds** have no open ground-floor doorway on the scans, so you get inside by climbing
  a low wall section.
- **Upper floors** (the strongholds' and large ruins' floors, 2.5" and 3" up) can be stood under
  or climbed onto. The climb starts with the base edge within 1" of the floor and ends with the
  whole base on it, all or nothing; walking off an edge is a drop. On the 3D table point at the
  floor; on the 2D map hold Shift while dragging. Up there an operative is on a Vantage Point
  (the Accurate bonus and seeing a Concealed target past light cover), it isn't engaged with
  anyone more than 1" away in 3D, and it only collides with operatives on the same floor. Line
  of sight is still judged on the table's plan. Ladders (a 1" climb) aren't modelled: the
  scanned terrain has none.
- **Other operatives** don't block routes, and players adjudicate control-range rules.
  Charges aren't checked for ending in control range.
- The battle tray, dice and actions are a light mock. The focus is measuring, terrain and sight.

## Assets and licensing

**SkirmishTable's code is released into the public domain under [the Unlicense](UNLICENSE).**
The repository contains no third-party content and never should (see `CLAUDE.md`): no models,
textures, card or token images, map cards, rules text, PDFs or Tabletop Simulator saves, not
even as test fixtures or screenshots.

The terrain, operatives, cards and tokens come from community Tabletop Simulator mods on the
Steam Workshop (the KT24 Base table *The Killzone Mod*, 3573927734; Gallowdark Approved Ops
3353224453 and 3360436479; the Yellowscribed Kill Team series). The repo keeps only:

- **link catalogs** (`src/data/tts-sources.js`, `tts-teams.js`, `tts-ops.js`): where each file
  lives on the Steam CDN or imgur, with sizes and placement numbers. Each player's browser
  downloads the files from there itself.
- **measurements we derived** (`src/data/fine-pieces.js`, `volkus-*.js`, `gallowdark.js`): piece
  positions, 0.1" footprint rasters and wall rectangles, which the movement and sight engine
  needs. Numbers only, no art.

`tools/fetch_assets.py` and `npm run fetch:saves` download the originals into `cache/`
(git-ignored) when you want to regenerate, verify, or run the import tests.

```sh
pip install -r tools/requirements.txt
python tools/fetch_assets.py      # Workshop saves, scanned meshes, map cards -> cache/
python tools/fine_footprint.py    # trace each piece at 0.1"   -> cache/fine/
python tools/build_data.py        # -> src/data/fine-pieces.js, volkus-layouts.js
python tools/convert_maps.py      # -> src/data/gallowdark.js
python tools/meshpack.py          # -> public/meshpack.json (3D fallback)
python tools/model_pack.py        # -> public/models/ (exact models + textures, ~52 MB)
npm run export:maps && python tools/verify_maps.py --year 24   # score against the cards
```

Run from a fresh download, the pipeline reproduces the committed data exactly. See
[tools/README.md](tools/README.md).

Kill Team, Volkus, Gallowdark and related names are trademarks of Games Workshop. This is an
unofficial fan project, not affiliated with or endorsed by Games Workshop. The mods' content
belongs to its owners; the Unlicense covers only this repository's own code and data.

### Loading the models from Steam

`src/data/tts-sources.js` maps each model key to its file on `cdn.steamusercontent.com`, plus
its size, bounds and TTS material. It holds links only. Steam's CDN answers any origin
(`Access-Control-Allow-Origin: *`), so `src/view3d/models.js` fetches the OBJ files and
textures directly, reads the OBJ with `src/import/obj.js` (the same conventions as
`tools/model_pack.py`, checked to match the packed models vertex for vertex), and keeps the
files in the Cache API (`skirmishtable-tts-v1`). The choice is remembered per browser.
If the mod changes, rebuild the table with `npm run tts:sources` (it fetches the save
through the Steam API).

### Dice, wounds, ranges, ops and score

Taken from how players run Kill Team in Tabletop Simulator:

- **Dice boxes**: one per side, behind a die icon in the bottom corners of the table (Ash
  left, Slate right), so the attacker and the defender can roll at once. Online you roll in
  your own box; the other one shows their rolls. Physical dice: pick how many and they land
  on a mat; press one and the whole pile comes up in your hand, shake it (it rattles), drop
  it in the box and the dice tumble, then stack into six slots by face, counted against the
  hit/save target. Pick slotted dice up (click to select several, or drag a box round them)
  and throw them again to re-roll them; each die re-rolls once (a dot marks it). Every roll goes to the log and online play. Shoot
  puts the attack dice in the shooter's box and the save dice in the target's; Fight puts
  each side's dice in its own box. Sounds are made in the browser, no files.
- **Wounds**: a counter over each model (3D) and under each token (2D), green → amber when
  injured → red; −1 W / +1 W on the operative card logs "[12/15] Name took damage".
- **Range rings** round the selected operative: control range (white) and 2″ (red), measured
  from the base edge.
- **Ops & score** panel: the season (Approved Ops 2025 / 2024), the Crit Op (pick or draw),
  each side's Tac Op and Primary, the Kill Op, a VP sheet per turning point (Crit / Tac / Kill,
  Primary counted again at half), initiative cards, the universal equipment cards, and
  **markers** (grenades, mission tokens) to drop on the table. Cards are cut from the mod's own
  card sheets and load like the models (`src/data/tts-ops.js`, built by `npm run tts:ops`;
  links to the Steam CDN and imgur). Once a VP is entered the sheet keeps the tray's VP.

All of it is shared in online games (players set their own side; the host sets the season
and Crit Op) and covered by Undo.

### Miniatures from Steam

The **Miniatures** panel swaps the cylinders for real operatives: pick a Kill Team for each
side, then a model per operative. `src/data/tts-teams.js` lists 15 team mods from the Steam
Workshop's Yellowscribed series (216 photoscanned models), again as CDN links only: each
operative is the mod's base plus the miniature as its child object. Picking a team loads its
models into the browser (`src/view3d/units.js`, Unity bundles and OBJ scans read in workers), scaled
so the base matches the ruleset's base. The invisible cylinder stays as the drag target, and
a ring in the team colour (grey once spent) sits under each model. Choices are remembered per
browser. Rebuild the catalog with `npm run tts:teams`; add a team by adding its Workshop id
to `TEAMS` in `scripts/tts-teams.mjs`.

## Deploying (GitHub Pages)

Every push to `main` runs [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml): unit
tests, `npm run build`, then it **deletes `dist/models/` and `dist/meshpack.json`** and
publishes the rest to https://jfreal.github.io/skirmishtable/. The public site never hosts
the TTS models; visitors load them from Steam. Pull requests run
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) (unit tests, build, Playwright).

## Publishing as a Claude artifact

The prototype lives as a Claude artifact (it started out as "Killzone Sandbox"). To update it from this repo:

```sh
npm run build:artifact    # -> dist-artifact/index.html (no document skeleton), and nothing else
```

Then publish that one file. Like the public site, it ships no models or mesh pack: the page
offers **Load from Steam**. `npm run build` makes a normal standalone page for any static host.

## Ideas for next steps

- Vantage on fire steps; line of sight from an upper floor over the walls below it.
- Rulesets: silhouette/model heights for true 3D line of sight (Infinity), zones of control,
  reactive orders, other activation systems; per-ruleset profiles and weapons.
- The ruler on the 3D table; true 3D line of sight against the models (Infinity silhouettes).
- Pack the Gallowdark wall bundles too.
- Operatives as obstacles in routing (enemy control range, friendly bases).
- A rules toggle for walk-over sub-1" clutter, and per-killzone terrain traits.
- Charge validation (end within control range) and fight/shoot sequencing.
- Run the route search in a Web Worker if drag-start latency matters on phones (it's ~30–40 ms on a laptop).
