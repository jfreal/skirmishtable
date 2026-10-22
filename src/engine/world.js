/**
 * The loaded killzone: map registry, board size, terrain lists, drop zones and the
 * roster. buildWorld() is the headless half of loading a map (no DOM).
 */
import { BASE_R } from '../config.js';
import { GDMAPS } from '../data/gallowdark.js';
import { VOLKUS_LAYOUTS } from '../data/volkus-layouts.js';
import { VOLKUS_TERRAIN } from '../data/volkus-ruins.js';
import { dist } from './geometry.js';
import { buildClearance, clearAt, composeFine, deriveFineLists, newGrid, rasterizeRects } from './grid.js';
import { buildNav } from './movement.js';
import { convertVolkusBag } from '../import/tts.js';

export let BW = 30, BH = 22;         // board inches (set by the loaded map)
export let MAP = null;               // current map definition
export const MAPS = {
  volkus: {
    name: "Volkus Ruins", group: "Hand-made", w: 30, h: 22, dropDepth: 6,
    terrain: VOLKUS_TERRAIN,
    objectives: [ {id:"OBJ-A", x:15.0, y:7.9}, {id:"OBJ-B", x:10.9, y:12.6}, {id:"OBJ-C", x:19.4, y:14.2} ],
    spawns: [
      [[5.35,5.6],[5.35,9.3],[5.35,10.8],[5.4,14.6],[5.35,19.6],[5.35,3.9]],
      [[24.65,18.3],[24.65,12.5],[24.65,10.9],[24.65,5.3],[24.65,3.5],[24.65,20.0]],
    ],
  },
  v1: null, v2: null, v3: null, v4: null, v5: null, v6: null,   // Approved Ops 2024, built from VOLKUS_LAYOUTS at start-up
  y1: null, y2: null, y3: null, y4: null, y5: null, y6: null,   // Approved Ops 2025
  gd1: Object.assign(GDMAPS.gd1, {group: "Gallowdark", short: "1"}),
  gd2: Object.assign(GDMAPS.gd2, {group: "Gallowdark", short: "2"}),
};
export let TERRAIN = [], OBJECTIVES = [], DROPZONES = [], DECOR = [], OVERHEAD = [];
export function mkOp(id, team, name, kind, x, y) {
  const t = {
    leader:   {apl:3, move:6, save:3, wounds:14, weapons:["srgFire","srgBlade"]},
    marksman: {apl:2, move:6, save:4, wounds:8,  weapons:["firearm","knife"]},
    brawler:  {apl:2, move:6, save:4, wounds:10, weapons:["blades"]},
  }[kind];
  return {id, team, name, kind, x, y, apl:t.apl, move:t.move, save:t.save,
          maxW:t.wounds, wounds:t.wounds, weapons:t.weapons, weapon:t.weapons[0],
          order:"conceal", ready:true, ap:t.apl, used:[], alive:true};
}
export let OPS = [];
export function spawnFree(x, y, pts) {
  if (x < BASE_R+0.1 || x > BW-BASE_R-0.1 || y < BASE_R+0.3 || y > BH-BASE_R-0.3) return false;
  if (clearAt(x, y) < BASE_R + 0.05) return false;
  return !pts.some(p => dist(p[0], p[1], x, y) < 1.3);
}
export function autoSpawn(team) { // fill the drop zone from its inner edge, dodging terrain
  const dz = DROPZONES[team];
  const horizontal = dz.w >= dz.h; // wide shallow zone => long-edge deployment
  const pts = [];
  for (let step = 0; step < 5 && pts.length < 6; step++) {
    if (horizontal) {
      const y = team === 0 ? dz.y + dz.h - BASE_R - 0.2 - step*1.3 : dz.y + BASE_R + 0.2 + step*1.3;
      for (let x = 1.2; x <= BW - 1.2 && pts.length < 6; x += 1.5)
        if (spawnFree(x, y, pts)) pts.push([x, y]);
    } else {
      const x = team === 0 ? dz.x + dz.w - BASE_R - 0.2 - step*1.3 : dz.x + BASE_R + 0.2 + step*1.3;
      for (let y = 1.2; y <= BH - 1.2 && pts.length < 6; y += 1.5)
        if (spawnFree(x, y, pts)) pts.push([x, y]);
    }
  }
  return pts;
}
export function rosterInit() {
  const defs = [
    ["A1",0,"Vekk","leader"],   ["A2",0,"Moss","marksman"], ["A3",0,"Harrow","marksman"],
    ["A4",0,"Snyde","marksman"],["A5",0,"Brand","brawler"], ["A6",0,"Kole","brawler"],
    ["B1",1,"Sarn","leader"],   ["B2",1,"Idra","marksman"], ["B3",1,"Pell","marksman"],
    ["B4",1,"Wrex","marksman"], ["B5",1,"Grum","brawler"],  ["B6",1,"Thane","brawler"],
  ];
  const spawns = MAP && MAP.spawns ? MAP.spawns : [autoSpawn(0), autoSpawn(1)];
  const idx = [0, 0];
  OPS = defs.map(([id, team, name, kind]) => {
    const p = spawns[team][idx[team]++] || [team === 0 ? 1.5 : BW - 1.5, 1.5 + idx[team] * 1.6];
    return mkOp(id, team, name, kind, p[0], p[1]);
  });
}

// Demo set-up: most of each side (`count` of 6) moves off its drop zone to random
// free spots across the board, `covered` of them within `near` (1") of terrain
// that gives cover, the rest in the open. Never within 2" of an enemy, so nobody starts
// engaged, but plenty start within charge reach. The rest stay where rosterInit put them.
export function scatterRoster(rng = Math.random, count = 4, covered = 3, near = 1) {
  const m = near + 0.25;   // stay clear of the board edge, or the edge would count as "terrain"
  const okAt = (op, x, y, wantCover) => {
    if (x < BASE_R + m || x > BW - BASE_R - m || y < BASE_R + m || y > BH - BASE_R - m) return false;
    const c = clearAt(x, y);
    if (c < BASE_R + 0.05) return false;                          // the base must fit
    if (wantCover !== (c - BASE_R <= near)) return false;          // terrain within 1" of the base edge
    const dz = DROPZONES[1 - op.team];
    if (x >= dz.x && x <= dz.x + dz.w && y >= dz.y && y <= dz.y + dz.h) return false;
    return !OPS.some(o => o !== op && o.alive &&
      dist(o.x, o.y, x, y) < 2 * BASE_R + (o.team === op.team ? 0.3 : 2));
  };
  for (const team of [0, 1]) {
    const side = OPS.filter(o => o.team === team);
    for (let i = side.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [side[i], side[j]] = [side[j], side[i]]; }
    side.slice(0, count).forEach((op, k) => {
      const wantCover = k < covered;
      for (let tries = 0; tries < 4000; tries++) {
        const x = rng() * BW, y = rng() * BH;
        if (okAt(op, x, y, wantCover)) { op.x = +x.toFixed(2); op.y = +y.toFixed(2); return; }
      }
    });
  }
}

/* ---------- maps & the Tabletop Simulator importer ---------- */
// Engine side of loading a map — no DOM: the terrain grid and its clearance map, climb
// portals, drop zones and the starting roster. Headless tests call this directly.
export function buildWorld(map) {
  MAP = map;
  BW = MAP.w; BH = MAP.h;
  OBJECTIVES = JSON.parse(JSON.stringify(MAP.objectives || []));
  newGrid();
  if (MAP.fine) {                                        // pieces' traced footprints -> grid -> draw lists
    composeFine(MAP.place);
    ({terrain: TERRAIN, decor: DECOR, overhead: OVERHEAD} = deriveFineLists());
  } else {
    TERRAIN = JSON.parse(JSON.stringify(MAP.terrain));   // fresh copies: no stale caches
    DECOR = JSON.parse(JSON.stringify(MAP.decor || [])); // fire steps: drawn, never block
    OVERHEAD = [];
    rasterizeRects();
  }
  buildClearance();
  const dd = MAP.dropDepth || 6;
  DROPZONES = MAP.dropEdge === "long" // long-edge deployment: shallow zones top & bottom
    ? [{team:0, x:0, y:0, w:BW, h:dd}, {team:1, x:0, y:BH-dd, w:BW, h:dd}]
    : [{team:0, x:0, y:0, w:dd, h:BH}, {team:1, x:BW-dd, y:0, w:dd, h:BH}];
  buildNav();
  rosterInit();
}
// Register the built-in Volkus layouts (Approved Ops 2024 and 2025) as fine maps.
export function initMaps() {
  for (const [key, L] of Object.entries(VOLKUS_LAYOUTS))
    MAPS[key] = Object.assign(convertVolkusBag({Nickname: L.nick, items: L.items}, L.name, "Steam Workshop 3573927734 (KT24 Killzone Mod)"),
      {group: L.nick.startsWith("Volkus 25") ? "Volkus 2025" : "Volkus 2024", short: L.name.replace(/^.*AO /, "")});
}
