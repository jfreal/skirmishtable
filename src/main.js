/**
 * Boot: registers the built-in maps, wires the UI, picks the Kill Team rules, loads the
 * default killzone and opens the 3D table.
 */
import './styles.css';
import * as world from './engine/world.js';
import * as grid from './engine/grid.js';
import * as movement from './engine/movement.js';
import * as sight from './engine/sight.js';
import { state } from './state.js';
import { renderAll } from './ui/board.js';
import { loadMap, useRuleset, wireControls } from './ui/controls.js';
import { logLine } from './ui/dom.js';
import { renderMinis } from './ui/minis.js';
import { mayControl, mayPlay, maySetUp, net, online, wireNet } from './net/sync.js';
import { diceTrays, wireDice } from './ui/dicetray.js';
import { wireDiceBox } from './ui/dicebox.js';
import { wireOps } from './ui/ops.js';
import { wireHud } from './ui/hud.js';
import { wireShare } from './net/share.js';
import { wireReplay } from './net/replayer.js';
import { wireInput } from './ui/input.js';
import { wireThreatPicker } from './ui/threat.js';
import { wireOptions } from './ui/options.js';
import { wireSidePanel } from './ui/sidepanel.js';
import * as table3d from './view3d/table3d.js';
import * as rules from './rules/index.js';
import { onMinisChange } from './view3d/units.js';

wireInput();
wireHud();
wireControls();
table3d.wireViewToggle();
wireThreatPicker(() => renderAll());
wireOptions();
wireSidePanel();
onMinisChange(bases => { if (bases) { renderAll(); renderMinis(); } });   // a model measured: rings, reach and fit follow its base

/* ---------- go ---------- */
world.initMaps();
useRuleset("killteam", false);
loadMap("v1");
logLine("Volkus Approved Ops map 1 — every piece's footprint is traced from the Tabletop Simulator scans at 0.1″, so doorways, alcoves and the ground under upper floors are real space: drag an operative into a nook and it stays there if a 28mm base fits. All twelve Volkus Approved Ops layouts (2024 and 2025) are built in — no import needed; pick one in the killzone list.");
logLine("Rules: Kill Team (2024). The Rules panel switches to an Infinity-style ruleset or the made-up Ashfall house rules — the same table, terrain and routing, different movement, climbing and cover.");
logLine("Try: drag an operative on the 3D table — over a wall it climbs, into a nook it fits. Drag empty table to orbit; Top-down looks straight down.");
renderAll();
renderMinis();
wireDice(side => mayPlay() && (!online() || net.seat === side));   // a dice box per side: online, roll in your own
wireDiceBox();
wireOps(side => mayControl({ team: side }), maySetUp);   // online: your own side's ops; the host sets the mission
wireNet();                      // host or join if the address says so (#host= / #room=)
wireShare();                    // or open a shared snapshot (#game=)
wireReplay();                   // record this game; or open a replay (#replay=)
if (window.THREE && THREE.OrbitControls) table3d.setView(true);   // the 3D table is the default view

// Debug/test handle: live views of the engine modules and UI state, for the browser
// console and the Playwright tests (e.g. skirmishtable.movement.findPath(...)).
window.skirmishtable = { world, grid, movement, sight, rules, table3d, state, loadMap, useRuleset, renderAll, diceTrays };
