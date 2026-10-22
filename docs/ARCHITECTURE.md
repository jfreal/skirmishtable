# SkirmishTable architecture

This is how the engine works, with the numbers that matter and why things are the way they are.
All distances are in inches. The board's origin is top-left, with x to the right and y down.

## Modules and layering

```
main.js ──► ui/*, view3d/table3d ──► engine/* ──► rules/*, data/*, config.js
                                         ▲
                                   import/tts.js (pure converters)
```

- `engine/*` and `import/tts.js` never touch the DOM and never import UI code. They run in
  Node (the unit tests and `scripts/export-maps.mjs`).
- ES module bindings can only be reassigned by the module that declares them. Engine state
  (`world.MAP`, `world.TERRAIN`, `grid.G`, `world.OPS`, ...) is therefore owned and reassigned by
  one module, and everyone else reads the live binding. UI state that several UI modules
  reassign (selection, target, drag, mode) lives in the `state` object in `src/state.js`.
- `net/*` is online play (see `docs/MULTIPLAYER.md`): `renderAll()` ends with `pump()`, which
  sends the whole game when it changed; `protocol.js` is pure and unit-tested.
  Share links (`link.js` pure, `share.js` the button) pack the same game into `#game=…`.
- The code came from a single-file prototype and keeps its terse style. Comments explain the
  rules reasoning where it isn't obvious.

## Rulesets (`src/rules/`)

A ruleset is a plain object (see `killteam.js`):

| field | used by |
|---|---|
| `baseMm`, `controlRange` | `setRuleset` sets `config.BASE_R` / `config.CTRL` (live ES bindings) — the fit map, routing, sight, melee and objectives all read them |
| `increment` | `legCost(L)`: `ceil(L / inc) · inc`, or `L` when 0. Route costs, clamping, the whole-inch optimiser, `straightenIncrements` and `chopIncrements` all go through it |
| `moves.primary / secondary / charge` | labels, verbs, `allow(op)` and `climb`. Game state keeps fixed ids (`reposition`, `dash`, `charge`); the planner builds both move orders and derives the climbing window from which phases may climb |
| `climbUp(h)`, `climbDown(h)` | portal and climb-leg costs |
| `cover {range, voidWithin}`, `obscure {beyond}` or `null` | `sightAnalysis` |
| `orders` | Conceal/Engage tokens and the "concealed in cover" verdict |

Switching rules reloads the map, because the clearance threshold, climb portals and cached
route fields depend on the base size and costs.

## Loading a map

`buildWorld(map)` (`engine/world.js`) is the headless half:

1. `newGrid()` allocates the 0.1" grid for the board size.
2. The grid is filled by one of two paths:
   - **Fine maps** (Volkus layouts, imported Volkus bags): `composeFine(map.place)` lays each
     piece's traced raster onto the board, then `deriveFineLists()` merges cells into rectangles
     for drawing (`TERRAIN`, `DECOR` for fire steps, `OVERHEAD`).
   - **Rect maps** (hand-made Volkus Ruins, Gallowdark): `rasterizeRects()` fills the cells
     each terrain rect covers. Walls are filled per height section.
3. `buildClearance()` builds the distance map, then the drop zones are set.
4. `buildNav()` finds the climb portals, then `rosterInit()` places the operatives.

`loadMap()` (`ui/controls.js`) adds the UI half: viewBox, static SVG layer, panels and 3D scene.

## The terrain grid (`engine/grid.js`)

Each cell holds:

| field | meaning |
|---|---|
| `cls` | 0 free, 1 wall, 2 heavy, 3 light, 4 fire step, 5 upper-floor overhead |
| `zq`  | height in half inches (0–15). Climbing uses whole inches, `zqHeight(zq) = ceil(zq/2)`, minimum 1 |
| `fid` | the terrain feature (piece) the cell belongs to → `FEATS[fid].id`, e.g. "Stronghold 1" |
| `src` | 1 if the cell came from a scanned mesh (the 3D view shows the mesh instead of a box) |

When pieces overlap, the class priority is wall > heavy > light > step > overhead, and the
taller cell wins within the same class. Walls, heavy and light terrain block a base. Walls and
heavy terrain block sight. Steps and overhead block neither.

**Composing scanned pieces.** Each piece's raster (`data/fine-pieces.js`) lives in the piece's own
raw OBJ frame, scaled to its typical scale `s0`. For every board cell inside the piece's rotated
bounding box, the board offset is rotated back by R(−a) and divided by `s/s0`, then looked up.
That's exact for any rotation and any scale. The rubble bundles in the mod have no readable
mesh, so they use rectangles measured from the map cards (`VOLKUS_PIECES.templates`).

**Clearance.** Felzenszwalb–Huttenlocher squared EDT, columns then rows, from every cell centre
to the nearest blocking cell. Half a cell is subtracted to reach that cell's edge, and the result
is capped by the board edges. `clearAt(x, y)` interpolates bilinearly over cell centres and
applies the board edges exactly. A base fits where `clearAt >= BASE_R` (`ptFree`).

**`segFree`** (a base slides along a segment without overlapping terrain) is sphere-traced. At
each sample, the clearance minus the base radius is how far the base can safely advance (minimum
0.03"), so open ground costs a handful of lookups. `tol` lets a base that starts a hair too tight
ease out over the first 0.35".

**`gridWalk`** (Amanatides & Woo) visits every cell a segment crosses, passing the entry
parameter `t`. Sight, shadows and climb heights all use it.

## Movement (`engine/movement.js`)

### Rules

- A straight leg of length L costs `ceil(L)` inches. Routes are drawn as their actual 1"
  increments (`chopIncrements`), and a hollow node marks a short increment that still costs a
  full inch.
- A climb up and over terrain of height h costs `ceil(across) + climbUp(h) + climbDown(h)`, where
  `climbUp = max(2, h)` and `climbDown = max(0, h − 2)`.
- Climbs are only allowed while the inches being spent belong to the Reposition or Charge. The
  drag planner tries both orders (Reposition then Dash, Dash then Reposition). Each plan gives the
  search a window `[climbLo, climbHi]` in inches from the start of the whole move. A climb must
  start at or after `climbLo`; arriving earlier burns "pad" inches waiting at the wall. It must
  finish by `climbHi`. `climbHi < 0` means no climbing (Dash only).

### Climb portals

`findPortals()` scans straight lines across the board in four directions (0°, 90°, ±45°), 0.5"
apart, in 0.05" steps. Wherever a free run is interrupted by blocked space and resumes within 5",
the last free point and the next free point become a portal pair. `crossingHeight` walks three
parallel lines (the base's middle and its flanks at ±0.45") and takes the tallest solid cell. It
returns Infinity if any cell belongs to noclimb terrain (Gallowdark bulkheads). Near-duplicates
(both ends within 0.45") are dropped. Each endpoint is attached to free cells within 0.3–0.6"
that it can slide to.

### Route field (Lazy Theta*)

The nodes are every grid cell, plus the start, plus the portal endpoints. `buildField` runs a
Dijkstra-ordered Lazy Theta* outward from the operative:

- Relaxations assume line of sight to the parent's parent, giving any-angle routes. On expansion
  the assumption is checked with `segFree`, falling back to the best closed neighbour if it fails.
- A node reached by a climb keeps the climb as its parent edge, so it's never "shortcut" across
  the wall.
- A portal endpoint relaxes the climb to its mate when the window allows.
- Expansion stops past `cap + 4` inches.

The field is cached per (start, window, cap). One drag computes at most two fields, one per
plan, at roughly 25–45 ms each. Every pointer move after that is a cheap lookup:

- **Goal connection:** among closed cells within 0.35", then 0.9", then 1.7" of the goal, take
  the cheapest with a free straight run to the goal.
- **Unreachable goal** (enclosed, or beyond the bound): route to the reachable spot nearest the
  goal and flag the path `.partial`. The UI shows "closest reachable".
- `smoothPath` pulls the route taut between climbs.

### Whole-inch optimisation

Theta* routes hug rounded corners in several short legs, and each one costs a full inch.
`optimizeIncrements` re-picks the bend points with a small dynamic program:

- **Candidates:** the route's points, plus the points where extended legs meet. That's the
  square turn a player makes round a wall end. Extensions are at most 3", for leg pairs up to 5
  apart.
- **Transitions:** straight free legs (cost `ceil(L)`), or, across a climb, one straight climb
  from any point before the terrain to any point after it. The climb leg may be up to 2.5" longer
  than the original, and its height is recomputed.
- The climb timing window is enforced in whole inches here, the same units the move is paid in.
- The result is kept only if its rounded total is no worse.

`straightenIncrements` then slides bends forward so each leg ends on a whole inch.
`clampPath` truncates at the allowance; a climb is all or nothing.

## Sight (`engine/sight.js`)

`sightAnalysis(a, b)` works like this (Kill Team 2024 cover lines: any one point of the
attacker's base to every part of the target's base, drawn straight through terrain):

1. **Visible:** some line from one of 16 points on the attacker's base to one of 24 points on
   the target's base crosses no wall or heavy cell. Both bases are taken 0.02" inside their
   edge. Each of these checks stops at the first wall, so proving a target hidden is cheap.
   Not visible ends the analysis.
2. Cover lines start only from a base point that can see the target (at least one clear
   line). Of those, the attacker picks the one that suits it best: **not obscured** first, then
   **not in cover**. From each point every cover line (blocked ones included) is walked through every
   cell:
   - **Cover:** a crossed wall, heavy or light cell within 1" (control range) of the target's
     base edge, when the operatives are more than 2" apart.
   - **Obscured:** a crossed wall or heavy cell more than 1" from both bases. Light never
     obscures.

   Points stop early once they can't beat the best so far, and the search stops at the first
   point with neither.
3. The chosen point is walked once more to report, per judgement, the crossed cells' bounding
   box for the feature closest to the target (what the UI highlights; its `id` names the piece),
   the crossing point `at`, and the cover `line` that decides it.

## Valid shots (`engine/shots.js`)

`judgeShot(eye, target)` turns `sightAnalysis` into one of five calls: `clear`, `cover`,
`obscured`, `concealed` (Kill Team: Conceal order and in cover, so not a valid target) or
`hidden` (not visible), plus the deciding line (none for `hidden`: nothing to draw one to). `shotsFrom(eye)` judges every live enemy and
reuses the answer until the eye, an enemy, the map or the rules change. While an operative is
selected or dragged (`board.shotEye()`: the landing spot during a drag), the 2D map and the 3D
table mark every enemy in the colour of its call with the deciding line, and the Valid shots
panel lists them, valid targets first.

`visibilityPolygon(x, y)` casts 720 rays to the first wall or heavy cell (or the board edge) for
the shadow overlay.

## Volkus data and TTS conventions

These were all verified against the official map cards (`tools/verify_maps.py`):

- TTS is Unity: left-handed, OBJ files imported with X negated, and from above +z points up the
  screen. Board position = R(alpha)·(x, −z) + (15, 11).
- The OBJ X-flip and the z-flip are two reflections, which together make a pure rotation. A
  piece's raw OBJ vertices are rotated by `a = alpha + 180 − rotY` with
  `(x, z) → (x cos a + z sin a, −x sin a + z cos a)`. three.js `rotation.y` uses the same matrix,
  so the 3D view places meshes identically.
- The deployment guide planes (mesh `9C8BD76749A0A723`) sit at ±9 along the 30" axis
  (short-edge deployment, 6" zones) or ±8 along the 22" axis (long-edge, 3" zones). If the
  guides run along TTS z, the layout sits portrait on the table, so alpha = 90.
- Volkus 2025 layouts 1–3 are stored rotated 180° relative to their cards
  (`VOLKUS_CARD_TURN`). It's the same map either way; the turn just makes the board match the card.
- Objectives are mesh `2AA481BF3BB82CD4`, three per layout.

**Footprint tracing** (`tools/fine_footprint.py`):

- The triangle surfaces are sampled densely and binned at 0.1".
- A cell blocks a base only if there is geometry between 0.25" (the floor plate) and 1.2" up.
- A blocking cell is **wall** if its geometry reaches 1.7" and fills at least 55% of the 0.25"
  height bands, or if it rises contiguously for 1.7". Otherwise it is **light**, at least 0.5"
  tall.
- A cell with no geometry at base height but geometry 1.5"+ up is an **overhead**, an upper floor
  you can stand under.
- Specks under 3 cells are removed.
- `tools/build_data.py` recodes the fire-step mesh as non-blocking steps and keeps the scanned
  light rubble as light terrain only.

## 3D table

`view3d/table3d.js` is the default view and shares input with the 2D map: `ui/input.js` exposes
`armDrag`, `clickOp` and `setBoardPicker`. The 3D view arms drags from a capture-phase
pointerdown raycast against the operative meshes (so OrbitControls never starts an orbit), and
swaps in a board picker that intersects the pointer ray with the table plane. The planner is
unchanged; `sync3DOverlay()` draws its result (ribbons per increment, climb arcs, ghost, label)
and the current sight line. `boardToScreen(x, y, z)` projects board inches for the browser tests.

**Exact models.** When `models/manifest.json` exists (built by `tools/model_pack.py`),
`view3d/models.js` draws every object of a Volkus layout bag as TTS models it: full-resolution
mesh, original texture, TTS tint, and the object's full transform. The bag items carry the TTS
position, Unity Euler rotation (applied in Unity's Z-X-Y order, i.e. three.js `'YXZ'`) and
non-uniform scale; the layout's frame matrix `L` maps TTS world to the table:
`[c,0,-s,BW/2; 0,1,0,-top; -s,0,-c,BH/2]` (c, s of the frame angle; `top` = the mat surface's
upper face, so the table top is y = 0). The mirror in `L` turns Unity's left-handed world
right-handed, which is why the packed geometry has its winding reversed. Materials are
`MeshStandardMaterial` with roughness/metalness by TTS material type, PNG cut-outs use
`alphaTest`, output is sRGB, and a 4096 shadow map gives contact shadows. Models stream in as
they download (with a progress note). Maps without bag data (Gallowdark, hand-made) and pages
without the pack fall back to the decimated `meshpack.json`, then to extruded footprints.

**Sight on the table.** With an operative selected (or a drag ghost), `sightShade` lays a dark
sheet over the table with the `visibilityPolygon` cut out, so what it can't see is shaded,
exactly as on the 2D map; every enemy gets a ring, tag and deciding line in the colour of its
shot call (see Valid shots), and the selected target gets its sight lines and the cover terrain. The rules are the
same 2D line-of-sight judgement — the models are the picture, the 0.1" grid is the rules.

three.js r128 and OrbitControls load from CDNs as globals.

**Drawing on demand.** Nothing on the table moves by itself, so there is no render loop:
`requestRender()` draws one frame on the next animation frame after the camera (OrbitControls
`change`), the operatives, the overlay, a resize or an arriving model or texture changes
something. The 4096 shadow map is redrawn only with `requestRender(true)` (operatives or
terrain changed); orbiting and dragging reuse it, since the sun is fixed. `sync3DOps()` and
`sync3DOverlay()` still rebuild their groups from state on every call, but out of shared
geometries (scaled per use), cached materials and labels, and one miniature clone per
operative, so a redraw allocates nothing on the GPU. OBJ scans are parsed in the same workers
as Unity bundles, and photo textures are decoded off the main thread (`createImageBitmap`,
except Safari); on touch devices they're capped at 2048² (a 4096² texture with mipmaps is
~90 MB of GPU memory).

## Performance (laptop, Chromium)

| step | time |
|---|---|
| load a Volkus map (compose, clearance, portals, roster) | 20–60 ms |
| route field per drag plan | 25–45 ms |
| route query per pointer move | ~0.3 ms (≤ 2.5 ms) |
| sight between two operatives | ~0.2 ms clear, ~0.7–1 ms hidden or in cover (≤ 6 ms) |
| valid shots, 6 enemies, per drag move | ~4 ms (≤ 11 ms) |
| shadow polygon | ~2–3 ms |

3D table (desktop Chromium, RTX 2080 SUPER, Volkus AO 1, local pack, both sides with miniatures):

| | before (render loop) | after (on demand) |
|---|---|---|
| frames drawn while idle | every frame (60/s on a 60 Hz screen) | none |
| main thread per drag pointer move | ~4 ms | ~2 ms |
| `renderAll()` with the 3D table showing | 6–9 ms (`sync3DOps` 4–5 ms) | ~2 ms (`sync3DOps` 0.15 ms) |
| main thread blocked while loading (long tasks) | 2.7–4 s, worst single freeze 0.3–1.7 s | ~1 s, worst ~0.2 s |
| GPU texture memory on a phone | ~725 MB | ~370 MB |

## Tests

- `tests/unit` (Vitest, Node) covers the three rulesets (increments, climb costs, base sizes
  changing which nooks fit, cover ranges) and:
  - every built-in map: card deployment, objectives, roster on free ground, connectivity
  - climb costs, nooks, climbing into strongholds, Dash-first planning
  - randomized route legality on every map: free legs, finite climbs, cost equals the drawn
    increments, within the cap
  - sight, cover and obscuring on a nooked target
  - valid shots on small test boards under all three rulesets: heavy vs light, the cover
    distance, the 2" void, Conceal, and the attacker's choice of base point
  - the BSON and Gallowdark importers, on the real Workshop saves (`npm run fetch:saves`
    downloads them into the git-ignored `cache/`; without them those tests skip)
- `tests/e2e` (Playwright, built page) drives a real mouse: drag into a nook, climb with its
  label, a target verdict, the map picker, undo and the 3D view.
