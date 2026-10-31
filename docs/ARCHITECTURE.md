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
  Replays (`replay.js` pure, `replayer.js` the recorder and viewer) record that game after
  every change and pack the steps into `#replay=…`.
- The code came from a single-file prototype and keeps its terse style. Comments explain the
  rules reasoning where it isn't obvious.

## Rulesets (`src/rules/`)

A ruleset is a plain object (see `killteam.js`):

| field | used by |
|---|---|
| `baseMm`, `controlRange` | `setRuleset` sets `config.BASE_R` / `config.CTRL` (live ES bindings). `BASE_R` is the default base: an operative with a miniature stands on its own (see below) |
| `increment` | `legCost(L)`: `ceil(L / inc) · inc`, or `L` when 0. Route costs, clamping, the whole-inch optimiser, `straightenIncrements` and `chopIncrements` all go through it |
| `moves.primary / secondary / charge` | labels, verbs, `allow(op)` and `climb`. Game state keeps fixed ids (`reposition`, `dash`, `charge`); the planner builds both move orders and derives the climbing window from which phases may climb |
| `climbUp(h)`, `climbDown(h)` | portal and climb-leg costs |
| `dropFree` (optional) | inches of dropping that are free per action, shared by every drop in it (Kill Team: 2); without it each drop costs `climbDown(h)` |
| `cover {range, voidWithin}`, `obscure {fromShooter, fromTarget}` or `null` | `sightAnalysis` |
| `orders` | Conceal/Engage tokens and the "concealed in cover" verdict |
| `vantage {accurate: [h1, h2]}` or `null` | `judgeShot`: a Vantage Point shooter sees past light cover on a Conceal target, and gets Accurate 1 / 2 against an Engage target in cover at least `h1` / `h2` below |

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
3. `buildClearance()` builds the distance map, `buildLevels()` finds the upper floors, then the
   drop zones are set.
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
applies the board edges exactly. A base fits where `clearAt >= NAV_R` (`ptFree`).

**Base sizes.** Each operative's base is `opR(op)` (`engine/geometry.js`): `op.base` in mm when
set, else the ruleset's `BASE_R`. `op.base` comes from the operative's miniature: `units.js`
measures the model's base (the largest flat round mesh at its foot, TTS units = inches) when it
loads and snaps it to 28, 32 or 40mm (`snapBase`); plain tokens have none. Ranges (control
range, engagement, objectives), sight and cover lines measure from each base's own edge.
Routing works for one radius at a time, `NAV_R` in `grid.js`: `G.free`, `ptFree`, `segFree`
and `startTol` read it. The drag planner calls `useBase(opR(op))` (`movement.js`), which
re-derives `G.free` from the clearance map and swaps in that radius's climb portals, built the
first time a base of that size moves on the map. `buildClearance()` resets it to `BASE_R`.

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
- Control range (`planRoute`). A move can't go within control range of an enemy, so each
  enemy's range is a disc routed round like terrain: `grid.ZONES` folds it into `clearAt`
  analytically while the route is planned (and `buildField` masks its cells and climbs). A
  Charge walks clear of every zone to an entry point on the target's range (48 round it plus
  where the straight line in crosses it, ranked by a forward and a reverse field, best three
  routed), then routes *inside* that range to the goal: it can go round the enemy but not
  back out. Zones the operative starts in stay open (charging, it must stay in that one).
  Rules without a Charge (Infinity: base contact) skip it.

### Upper floors (levels)

`buildLevels()` (`grid.js`) turns each overhead patch of 80+ cells into a level: the patch's
usual height `zq` is the floor, and it floods out over overhead cells within 1" of that and
solid cells whose top is within ½" (wall tops flush with the floor). A patch mostly inside a
bigger one's floor joins it. Each level keeps its floor mask and a clearance map over its
bounding box (distance to the floor's edge or a wall rising above it), so `G.free`'s rules apply
up there too. Volkus maps get four: both strongholds at 2.5" and both large ruins at 3".

Layer 0 is the table, layer l is `LEVELS[l - 1]`. `clearAt`, `ptFree` and `segFree` read the
layer in `grid.LAYER` (`setLayer` / `onLayer`). An operative's height is `op.z` (0 on the
table), and `layerAt(x, y, z)` / `opLayer(op)` find its layer. Route points carry their layer
as a fifth element: `[x, y, climbZ, pad, layer]`.

**Level portals** (`findLevelPortals`) join each floor to the layers below it (the table and
lower floors). Lines are scanned across the floor's box as for climb portals. Where a free spot
on the lower layer, not more than 0.3" in under the floor, comes within `2·r + 1"` of a spot on
the floor where the base fits (base edges within 1" horizontally), with nothing taller than the
floor between, the two become a portal with `lvl: true`, `la` / `lb` and `z` = the climb in
whole inches. Up costs `across + climbUp(z)` and needs the climbing window; down costs
`across + climbDown(z)` and is allowed in any move (a Dash may drop). `optimizeIncrements` may
move a level climb's ends to any route points that pass the same test (`levelHopOK`).

**Costs.** `legCosts(path)` prices every leg: walk, up, down and pad. With `RULES.dropFree`,
drops share one allowance per action, and `path.split` (set by the drag planner to the first
action's allowance) is where the second action's allowance starts. `pathTotalInches`,
`clampPath` and `chopIncrements` all go through it. The search itself prices each drop on its
own (`climbDown`), which can only be cheaper, and the clamp then applies the real total.

**Route nodes** are every layer's cells (layer l's from `LOFF[l]`), then the start, then the
portal endpoints. Walking edges stay within a layer; only portals change layers. Control
ranges are kept per layer, and a Charge stays on its target's layer once it's in.

**Elsewhere.** `foesNear` and `opGap` measure in 3D (`gap3`), so an operative on a floor
isn't engaged with one on the table beneath it. `standing(p)` reports an operative on a level as
on a Vantage Point at the level's height, which feeds the existing Vantage rules in `judgeShot`.
The 3D table lifts the operative's model, the ghost and the route ribbons to their heights,
and its board picker returns the floor under the pointer (`[x, y, layer]`). The 2D map aims
for the operative's own layer, or the highest floor with Shift.

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
attacker's base to every part of the target's base, drawn straight through terrain). The app
is top-down, so "visible" stays a base-to-base check rather than one from the shooter's head
to the target's model.

1. **Visible:** some line from one of 16 points on the attacker's base to one of 24 points on
   the target's base crosses no wall or heavy cell. Both bases are taken 0.02" inside their
   edge. Each of these checks stops at the first wall, so proving a target hidden is cheap.
   Not visible ends the analysis. `canSee(a, b)` is this step on its own.
2. Within `cover.voidWithin` of the attacker (Kill Team: 2") the target is neither obscured nor
   in cover, and the analysis just reports a clear line.
3. Otherwise cover lines start only from a base point that can see the target (at least one
   clear line). Of those, the attacker picks the one that suits it best: **not obscured** first,
   then **not in cover**, then in light rather than heavy cover (that matters for Vantage, below).
   From each point every cover line (blocked ones included) is walked through every cell:
   - **Obscured:** a crossed wall or heavy cell more than `obscure.fromShooter` from the
     attacker's base edge *and* more than `obscure.fromTarget` from the target's (Kill Team:
     1" and 2"). Light never obscures. Infinity has no obscuring (`obscure: null`).
   - **Cover:** a crossed wall, heavy or light cell within `cover.range` of the target's base
     edge (Kill Team: 1"). `hardCover` says whether any of it is a wall or heavy terrain.
   Other operatives' bases don't count for any of this.

   Points stop early once they can't beat the best so far, and the search stops at the first
   point with neither.
4. The chosen point is walked once more to report, per judgement, the crossed cells' bounding
   box for the feature closest to the target (what the UI highlights; its `id` names the piece),
   the crossing point `at`, and the cover `line` that decides it.

## Valid shots (`engine/shots.js`)

First the shooter: `cannotShoot(eye)` says why the operative can't take a Shoot action at all,
or null: it is on Conceal (rulesets with `orders`), or an enemy is within its control range
(`foesNear`). The valid-shots panel and the verdict say so, and Shoot is disabled.

Then each target. `judgeShot(eye, target)` follows the Kill Team 2024 "valid target?" steps in
order and returns one of six calls, plus the deciding line (none when the target isn't visible):

1. `engaged`: an operative friendly to the shooter (same `team`, not the shooter itself) is within
   the target's engagement range (`foesNear` in `engage.js`). In melee, so not a valid target.
2. `hidden`: not visible, not a valid target.
3. Within 2": `clear` (see Sight step 2).
4. Further away a target can be obscured, in cover, or both (`obscured`, `inCover`):
   - in cover on Conceal: `concealed`, not a valid target, unless the cover is only light
     terrain and the shooter stands on a Vantage Point (`vantage: true`). Heavy cover always
     protects a Concealed target.
   - anything else is valid. The call is `obscured` if obscured, else `cover` if in cover,
     else `clear`. When an obscured target is shot, the attacker's crits count as normal
     successes and one success is discarded. In cover, the target keeps one defence die as a
     normal success without rolling it (`save`). On Engage in cover, a Vantage Point gives
     the shot Accurate 1 if the target is at least `vantage.accurate[0]` (2") lower, or
     Accurate 2 at `vantage.accurate[1]` (4") (`accurate`).

   Heights and Vantage Points come from `standing(p)`. TODO: the engine has no model heights or
   terrain traits yet, so this only reads `z` / `vantage` set on the eye or target and is
   0 / false otherwise.

The result also carries `obscured`, `inCover`, `save`, `accurate`, `vantage`, `engagedBy` and `range`.
`shotsFrom(eye)` judges every live enemy (never a friendly) and
reuses the answer until the eye, any operative, the map or the rules change. While an operative is
selected or dragged (`board.shotEye()`: the landing spot during a drag), the 2D map and the 3D
table mark every enemy in the colour of its call (`SHOT_COL`) with the deciding line, and the Valid shots
panel lists them, valid targets first. The chosen target's judgement is `state.lastShot`
(`panels.refreshSight()`, again on every `renderAll`). The verdict panel explains it. `doShoot`
checks `cannotShoot` and judges again. It refuses an invalid target, applies Accurate and the
obscured penalty, and rolls the cover save when `save`.

`visibilityPolygon(x, y)` casts 720 rays to the first wall or heavy cell (or the board edge) for
the shadow overlay.

## Engagement range and charges (`engine/engage.js`)

Two enemy operatives are engaged when their bases are within control range (Kill Team 1″,
edge to edge). In rulesets with a charge move, a Reposition or Dash can't end there: dragging
into an enemy's engagement range turns the drag into a Charge (Move + 2″, 1AP) when the
operative hasn't moved yet this activation, and the landing is refused otherwise. A Charge
must end engaged, and an operative on Conceal flips to Engage when it charges. While dragging,
the ghost shows its engagement ring, which turns red along with a ring on every enemy inside
it; engaged pairs keep a red ring round both models and a line between them (2D and 3D).

**Demo set-up.** For now `loadMap` calls `scatterRoster()`: four of each side's six operatives
start at random free spots off their drop zone, three of them within 1″ of terrain, none within
2″ of an enemy. `?deploy=zones` in the address keeps everyone in the drop zones. `buildWorld`
itself still deploys into the drop zones, so the headless tests are unaffected.

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
