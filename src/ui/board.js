/**
 * SVG board rendering: terrain, objectives, operatives, shadows and the move overlay.
 */
import { state } from '../state.js';
import { CTRL, ENGAGE_COL, OBJ_R, TEAMCOL, TEAMGREY, TEAMNAME } from '../config.js';
import { VOLKUS_PIECES } from '../data/volkus-pieces.js';
import { isInjured } from '../engine/dice.js';
import { blobPoints, dist, opR, perimeterPts, px, wallSegments } from '../engine/geometry.js';
import { chopIncrements, climbDown, climbUp, opLayer } from '../engine/movement.js';
import { LEVELS } from '../engine/grid.js';
import { engagements } from '../engine/engage.js';
import { SHOT_KINDS, shotsFrom } from '../engine/shots.js';
import { lineBlocked, visibilityPolygon } from '../engine/sight.js';
import { BH, BW, DECOR, DROPZONES, MAP, OBJECTIVES, OPS, OVERHEAD, TERRAIN } from '../engine/world.js';
import { pump } from '../net/sync.js';
import { NS, el, svg } from './dom.js';
import { RULES, fmtIn, moveLabel } from '../rules/index.js';
import { refreshSight, renderCard, renderShots, renderVerdict, tray } from './panels.js';
import { opsState } from './ops.js';
import { TTS_OPS } from '../data/tts-ops.js';
export const MARKER_R = 0.45;   // marker tokens on the table (about 23mm across)
import { sync3DOps, sync3DOverlay, three, view3D } from '../view3d/table3d.js';

let gStatic, gObj, gOps, gOverlay, gTags;
// how climbing this terrain is priced under the current ruleset
function climbText(z) {
  const M = RULES.moves, can = [M.primary, M.secondary, M.charge].filter(m => m && m.climb).map(m => m.label);
  return `${fmtIn(climbUp(z))}" up + ${fmtIn(climbDown(z))}" down + the distance across (${can.join("/")} only)`;
}
export function buildStatic() {
  svg.innerHTML = "";
  gStatic = el("g", {});
  // heat glow for the Engage order
  const grad = el("radialGradient", {id:"hotglow"}, gStatic);
  for (const [off, col, op] of [["35%","#ff8c2e",0.9],["65%","#ff9d3d",0.45],["100%","#ff9d3d",0]]) {
    const s = document.createElementNS(NS, "stop");
    s.setAttribute("offset", off); s.setAttribute("stop-color", col); s.setAttribute("stop-opacity", op);
    grad.appendChild(s);
  }
  // paper board
  el("rect", {x:0, y:0, width:px(BW), height:px(BH), fill:"#e9e1d1", rx:4}, gStatic);
  // inch grid
  for (let i = 1; i < BW; i++) el("line", {x1:px(i), y1:0, x2:px(i), y2:px(BH), stroke:"#d8cdb8", "stroke-width":i%5?0.5:1}, gStatic);
  for (let j = 1; j < BH; j++) el("line", {x1:0, y1:px(j), x2:px(BW), y2:px(j), stroke:"#d8cdb8", "stroke-width":j%5?0.5:1}, gStatic);
  // centreline runs between the drop zones
  if (MAP && MAP.dropEdge === "long")
    el("line", {x1:0, y1:px(BH/2), x2:px(BW), y2:px(BH/2), stroke:"#a89a80", "stroke-width":1, "stroke-dasharray":"6 5"}, gStatic);
  else
    el("line", {x1:px(BW/2), y1:0, x2:px(BW/2), y2:px(BH), stroke:"#a89a80", "stroke-width":1, "stroke-dasharray":"6 5"}, gStatic);
  // drop zones
  for (const dz of DROPZONES) {
    el("rect", {x:px(dz.x), y:px(dz.y), width:px(dz.w), height:px(dz.h),
      fill: dz.team===0 ? "#e0672f" : "#5b93a6", opacity:0.14}, gStatic);
    el("text", {x:px(dz.x+dz.w/2), y: dz.y < BH/2 ? px(Math.min(1.1, dz.y+dz.h-0.4)) : px(BH-0.5),
      "text-anchor":"middle", fill: dz.team===0?"#b4571f":"#4a7a8c",
      "font-family":"'Big Shoulders',sans-serif", "font-size":15, "font-weight":700,
      "letter-spacing":"2"}, gStatic).textContent = TEAMNAME[dz.team].toUpperCase() + " DROP ZONE";
  }
  // terrain: walls as clean strips, rubble as irregular ruin footprints
  el("clipPath", {id:"boardclip"}, gStatic).appendChild(
    (() => { const r = document.createElementNS(NS, "rect");
      r.setAttribute("x", 0); r.setAttribute("y", 0);
      r.setAttribute("width", px(BW)); r.setAttribute("height", px(BH)); return r; })());
  if (MAP && MAP.fine) renderFineTerrain();
  else {
    // height-scaled cast shadows first (sun from the north-west), then bodies
    const gShadow = el("g", {opacity:0.16, "clip-path":"url(#boardclip)"}, gStatic);
    for (const t of TERRAIN) {
      if (t.kind === "wall") {
        for (const s of wallSegments(t)) { // shadow per height section
          const off = s.z * 0.14;
          el("rect", {x:px(s.x+off), y:px(s.y+off), width:px(s.w), height:px(s.h), fill:"#33291d"}, gShadow);
        }
      } else {
        const off = t.z * 0.14;
        el("polygon", {points: blobPoints(t).map(p => px(p[0]+off) + "," + px(p[1]+off)).join(" "),
          fill:"#33291d"}, gShadow);
      }
    }
    const WALL_FILL = {2:"#45413a", 3:"#2b2a26", 4:"#15140f"};
    // fire steps first, under the walls: Vantage platforms that are Insignificant and
    // Exposed — they never block movement, sight or give cover, so they aren't TERRAIN
    for (const d of DECOR) {
      const r = el("rect", {x:px(d.x), y:px(d.y), width:px(d.w), height:px(d.h), rx:2,
        fill:"#d9b765", "fill-opacity":0.45, stroke:"#b08d3a", "stroke-width":1, "stroke-dasharray":"3 2"}, gStatic);
      const tip = document.createElementNS(NS, "title");
      tip.textContent = "Fire step · Vantage platform (Insignificant, Exposed) — doesn't block movement or sight";
      r.appendChild(tip);
    }
    for (const t of TERRAIN) {
      let elBody;
      if (t.kind === "wall") {
        const vert = t.h > t.w;
        for (const s of wallSegments(t)) {
          const seg = el("rect", {x:px(s.x), y:px(s.y), width:px(s.w), height:px(s.h),
            fill: t.hatch ? "#5a5244" : (WALL_FILL[s.z] || "#2b2a26"), "data-tid":t.id}, gStatic);
          const tip = document.createElementNS(NS, "title");
          tip.textContent = t.hatch
            ? `Hatchway frame · the opening between the stubs is an open access point`
            : t.noclimb
            ? `Bulkhead wall · ${s.z}" tall · blocks sight & movement · too tall to climb`
            : `Ruin wall section · ${s.z}" tall · blocks sight · climb over: ${climbText(s.z)}`;
          seg.appendChild(tip);
          if (!t.noclimb && (vert ? s.h : s.w) >= 0.9)
            el("text", {x: px(vert ? s.x + s.w + 0.15 : s.x + s.w/2),
              y: px(vert ? s.y + s.h/2 : s.y + s.h + 0.42) + (vert ? 4 : 0),
              "text-anchor": vert ? "start" : "middle", fill:"#8b8072",
              "font-family":"'JetBrains Mono',monospace", "font-size":10, "font-weight":600,
              "pointer-events":"none"}, gStatic).textContent = s.z + '"';
        }
        continue;
      } else {
        const fill = t.kind === "heavy" ? (t.z >= 3 ? "#354b3b" : "#41584a") : "#7d9c81";
        elBody = el("polygon", {points: blobPoints(t).map(p => px(p[0]) + "," + px(p[1])).join(" "),
          fill, stroke: t.kind === "heavy" ? "#324437" : "#5d7a62", "stroke-width":1.5,
          "stroke-linejoin":"round", "data-tid": t.id}, gStatic);
        el("text", {x:px(t.x + t.w/2), y:px(t.y + t.h/2)+4, "text-anchor":"middle",
          fill: t.kind === "heavy" ? "#c8dccd" : "#26352a",
          "font-family":"'JetBrains Mono',monospace", "font-size":11, "font-weight":600,
          "pointer-events":"none"}, gStatic).textContent = t.z + '"';
      }
      const tip = document.createElementNS(NS, "title");
      tip.textContent = t.kind === "heavy"
        ? `Heavy terrain · ${t.z}" tall · blocks sight, obscures at range, gives cover · climb over: ${climbText(t.z)}`
        : `Light terrain · ${t.z}" tall · gives cover, doesn't block sight · climb over: ${climbText(t.z)}`;
      elBody.appendChild(tip);
    }
  }
  gObj = el("g", {});
  gOverlay = el("g", {"pointer-events":"none"});
  gOps = el("g", {});
  gTags = el("g", {"pointer-events":"none"});   // shot tags, above the tokens
}
// Fine maps: the terrain grid drawn as merged cell rectangles, one SVG path per kind
// and height so thousands of footprint cells stay a handful of DOM nodes.
function renderFineTerrain() {
  const f1 = v => +px(v).toFixed(1);
  const rp = (r, o = 0) => `M${f1(r.x + o)} ${f1(r.y + o)}h${f1(r.w)}v${f1(r.h)}h${-f1(r.w)}z`;
  const tip = (node, text) => { const t = document.createElementNS(NS, "title"); t.textContent = text; node.appendChild(t); return node; };
  const pat = el("pattern", {id:"ovhatch", width:7, height:7, patternUnits:"userSpaceOnUse", patternTransform:"rotate(45)"}, gStatic);
  el("rect", {width:7, height:7, fill:"#c9d7e4"}, pat);
  el("line", {x1:1, y1:0, x2:1, y2:7, stroke:"#9fb5cb", "stroke-width":2}, pat);
  if (OVERHEAD.length)
    tip(el("path", {d: OVERHEAD.map(r => rp(r)).join(""), fill:"url(#ovhatch)", opacity:0.8}, gStatic),
      `Upper floor · open ground underneath, and operatives can climb up onto it (${RULES.moves.primary.label}${RULES.moves.charge ? "/" + RULES.moves.charge.label : ""}: the height, ` +
      `at least 2"; dropping off is free up to 2" an action) — hold Shift while dragging to aim for the floor, or point at it on the 3D table. Up here is a Vantage Point; sight is still judged on the table's plan`);
  const byKZ = new Map();
  for (const t of TERRAIN) { const key = t.kind + "|" + t.z; if (!byKZ.has(key)) byKZ.set(key, []); byKZ.get(key).push(t); }
  const gShadow = el("g", {opacity:0.16, "clip-path":"url(#boardclip)"}, gStatic);
  for (const [key, list] of byKZ) {        // a smear from the foot to the tip, so thin walls read as height
    const z = +key.split("|")[1], d = list.map(t => rp(t)).join("");
    for (let f = 1; f <= 3; f++) {
      const o = (px(z * 0.14 * f / 3)).toFixed(1);
      el("path", {d, fill:"#33291d", transform:`translate(${o} ${o})`}, gShadow);
    }
  }
  if (DECOR.length)
    tip(el("path", {d: DECOR.map(r => rp(r)).join(""), fill:"#d9b765", "fill-opacity":0.6, stroke:"#b08d3a", "stroke-width":0.6}, gStatic),
      "Fire step · Vantage platform (Insignificant, Exposed) — doesn't block movement or sight");
  const WALL_FILL = z => z <= 2 ? "#4a453d" : z === 3 ? "#2e2c28" : z === 4 ? "#1f1e1a" : "#121110";
  const order = [...byKZ.keys()].sort((a, b) => {
    const rank = {light: 0, heavy: 1, wall: 2};
    const [ka, za] = a.split("|"), [kb, zb] = b.split("|");
    return rank[ka] - rank[kb] || za - zb;
  });
  for (const key of order) {
    const [kind, zs] = key.split("|"), z = +zs, list = byKZ.get(key);
    const fill = kind === "wall" ? WALL_FILL(z) : kind === "heavy" ? (z >= 3 ? "#354b3b" : "#41584a") : "#86a389";
    const text = kind === "wall"
      ? `Ruin wall · ${z}" tall · blocks sight · climb over: ${climbText(z)}`
      : kind === "heavy"
      ? `Heavy terrain · ${z}" tall · blocks sight, obscures at range, gives cover · climb over: ${climbText(z)}`
      : `Light terrain · ${z}" tall · gives cover, doesn't block sight · climb over: ${climbText(z)}`;
    tip(el("path", {d: list.map(t => rp(t)).join(""), fill, stroke: fill, "stroke-width":0.6, "data-kind":kind}, gStatic), text);
  }
  for (const p of MAP.place || []) {        // rubble heights, as on the rect maps
    const tpl = VOLKUS_PIECES.templates[p.k];
    if (!tpl || tpl[4] === "step") continue;
    const r = p.a * Math.PI / 180, cx = tpl[2] * p.s, cz = tpl[3] * p.s;
    const X = p.x + cx * Math.cos(r) + cz * Math.sin(r), Y = p.y - cx * Math.sin(r) + cz * Math.cos(r);
    el("text", {x:px(X), y:px(Y)+4, "text-anchor":"middle", fill: tpl[4] === "heavy" ? "#c8dccd" : "#26352a",
      "font-family":"'JetBrains Mono',monospace", "font-size":11, "font-weight":600, "pointer-events":"none"}, gStatic).textContent = tpl[5] + '"';
  }
}
function renderObjectives() {
  gObj.innerHTML = "";
  for (const o of OBJECTIVES) {
    const contest = [0, 0];
    for (const op of OPS) {
      if (!op.alive) continue;
      if (dist(op.x, op.y, o.x, o.y) - opR(op) - OBJ_R <= CTRL + 1e-9) contest[op.team] += op.apl;
    }
    const owner = contest[0] > contest[1] ? 0 : contest[1] > contest[0] ? 1 : -1;
    el("circle", {cx:px(o.x), cy:px(o.y), r:px(OBJ_R), fill:"#cbbfa4", stroke:"#8a7c60", "stroke-width":2}, gObj);
    el("circle", {cx:px(o.x), cy:px(o.y), r:px(OBJ_R)+4, fill:"none",
      stroke: owner===-1 ? "#8a7c60" : TEAMCOL[owner], "stroke-width": owner===-1?1:3,
      "stroke-dasharray": owner===-1 ? "3 4" : "none", opacity:.9}, gObj);
    el("text", {x:px(o.x), y:px(o.y)+4, "text-anchor":"middle", fill:"#5a5040",
      "font-family":"'JetBrains Mono',monospace", "font-size":10, "font-weight":600}, gObj)
      .textContent = owner===-1 ? "—" : `${contest[owner]}APL`;
  }
}
function star4(cx, cy, ro, ri) { // four-pointed spiked star (official engage icon)
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const a = Math.PI * i / 4 - Math.PI / 2;
    const r = i % 2 === 0 ? ro : ri;
    pts.push((cx + r * Math.cos(a)).toFixed(1) + "," + (cy + r * Math.sin(a)).toFixed(1));
  }
  return pts.join(" ");
}
// the red ring round a model in (or about to be in) engagement range
function engageRing(parent, x, y, R) {
  el("circle", {cx:px(x), cy:px(y), r:px(R)+12, fill:"none", stroke:ENGAGE_COL, "stroke-width":7, opacity:.25, "pointer-events":"none"}, parent);
  el("circle", {cx:px(x), cy:px(y), r:px(R)+12, fill:"none", stroke:ENGAGE_COL, "stroke-width":2.5,
    class:"engpulse", "data-engaged":"1", "pointer-events":"none"}, parent);
}
// The rings round the selected operative, out from its base edge: control range (white,
// solid) and the distance inside which terrain gives no cover (Kill Team 2″; red, dashed).
// [inches, colour, dash]; shared with the 3D table.
export function rangeRings() {
  const out = [[CTRL, "#f5e9d8", "none"]], far = RULES.cover ? RULES.cover.voidWithin : 2;
  if (far > CTRL + 1e-9) out.push([far, "#d0442c", "6 4"]);
  return out;
}
const BASE_TRAIL = "#e8822e";   // faint orange: the base's path and its outline per increment
function renderOps() {
  gOps.innerHTML = "";
  // markers placed from the Ops panel (grenades, mission tokens), under the operatives
  for (const m of opsState.markers) {
    const t = TTS_OPS.tokens[m.k];
    if (!t) continue;
    const r = px(MARKER_R);
    el("circle", {cx:px(m.x), cy:px(m.y), r:r + 1.5, fill:"#14110e", opacity:.6, "pointer-events":"none"}, gOps);
    el("image", {href:t.img, x:px(m.x) - r, y:px(m.y) - r, width:2 * r, height:2 * r,
      "clip-path":"circle(50%)", "pointer-events":"none"}, gOps).appendChild(
      document.createElementNS(NS, "title")).textContent = t.name;
  }
  // engaged pairs: a red ring round both models and a line between them
  for (const [a, b] of engagements()) {
    el("line", {x1:px(a.x), y1:px(a.y), x2:px(b.x), y2:px(b.y), stroke:ENGAGE_COL, "stroke-width":2.5,
      "stroke-dasharray":"5 3", opacity:.8, "pointer-events":"none"}, gOps);
    for (const o of [a, b]) engageRing(gOps, o.x, o.y, opR(o));
  }
  for (const op of OPS) {
    if (!op.alive) continue;
    const g = el("g", {"data-oid": op.id, cursor:"pointer", style:"touch-action:none"}, gOps);
    const R = opR(op);
    // generous invisible hit target so tokens are grabbable on touch screens
    el("circle", {cx:px(op.x), cy:px(op.y), r:px(R + 0.5), fill:"rgba(0,0,0,0)"}, g);
    if (state.sel && state.sel.id === op.id) {
      // range rings, measured from the base edge as the rules do (as on the 3D table):
      // control range (shaded, solid) and the 2″ inside which cover doesn't count (red)
      el("circle", {cx:px(op.x), cy:px(op.y), r:px(R+CTRL), fill:TEAMCOL[op.team], opacity:.12, "pointer-events":"none"}, g);
      for (const [r, col, dash] of rangeRings())
        el("circle", {cx:px(op.x), cy:px(op.y), r:px(R + r), fill:"none", stroke:col, "data-ring": r,
          "stroke-width":1.5, "stroke-dasharray":dash, opacity:.85, "pointer-events":"none"}, g);
      for (const [r, col] of rangeRings())
        el("text", {x:px(op.x), y:px(op.y - R - r) + 11, "text-anchor":"middle", fill:col, stroke:"#14110e",
          "stroke-width":2.5, "paint-order":"stroke", "font-family":"'JetBrains Mono',monospace", "font-size":9.5,
          "font-weight":700, "pointer-events":"none"}, g).textContent = fmtIn(r) + "″";
      el("circle", {cx:px(op.x), cy:px(op.y), r:px(R)+2.5, fill:"none", stroke:"#f5e9d8", "stroke-width":2, opacity:.9}, g);
    }
    const moved = op.used.some(u => u === "reposition" || u === "dash" || u === "charge");
    const fill = moved || !op.ready ? TEAMGREY[op.team] : TEAMCOL[op.team];
    if (RULES.orders && op.order === "engage") { // hot ember glow — active and dangerous (dimmed once expended)
      const glow = el("circle", {cx:px(op.x), cy:px(op.y), r:px(R)+11, fill:"url(#hotglow)"}, g);
      if (op.ready) glow.setAttribute("class", "hotpulse");
      else glow.setAttribute("opacity", "0.3");
    }
    el("circle", {cx:px(op.x), cy:px(op.y), r:px(R), fill,
      stroke:"#14110e", "stroke-width":1.5, opacity: op.ready ? 1 : 0.55}, g);
    el("text", {x:px(op.x), y:px(op.y)+4, "text-anchor":"middle", fill:"#14110e",
      "font-family":"'Big Shoulders',sans-serif", "font-size":13, "font-weight":800,
      opacity: op.ready ? 1 : 0.55}, g).textContent = op.id;
    // order token, official style: orange chip with a white icon while ready
    // (spiked star = Engage, dome = Conceal), flipped to its dark face when expended.
    // Rulesets without orders get a plain ready/expended dot.
    const tx = px(op.x + R * 0.82), ty = px(op.y - R * 0.82);
    const tr = 7.5;
    const chip = op.ready ? "#e8722e" : "#332619";
    const icon = op.ready ? "#fff3e4" : "#a97844";
    el("circle", {cx:tx, cy:ty, r:RULES.orders ? tr : 4.5, fill:chip, stroke:"#14110e", "stroke-width":1}, g);
    if (!RULES.orders) {}
    else if (op.order === "engage")
      el("polygon", {points: star4(tx, ty, tr - 1.8, 2.1), fill:icon}, g);
    else
      el("path", {d:`M ${(tx-4.2).toFixed(1)} ${(ty+2.4).toFixed(1)} a 4.2 4.2 0 0 1 8.4 0 z`, fill:icon}, g);
    if (isInjured(op)) el("circle", {cx:px(op.x-R*0.8), cy:px(op.y+R*0.8), r:4, fill:"#d3a04a", stroke:"#14110e", "stroke-width":1}, g);
    if (op.z) {                       // up on a floor: a pale double rim and its height
      el("circle", {cx:px(op.x), cy:px(op.y), r:px(R)+4.5, fill:"none", stroke:"#cfe3ff", "stroke-width":1.6,
        "stroke-dasharray":"2 2", "pointer-events":"none"}, g);
      el("text", {x:px(op.x - R * 0.9), y:px(op.y - R * 0.75), "text-anchor":"middle", fill:"#cfe3ff", stroke:"#14110e",
        "stroke-width":3, "paint-order":"stroke", "font-family":"'JetBrains Mono',monospace", "font-size":10, "font-weight":700,
        "pointer-events":"none"}, g).textContent = `▲${fmtIn(op.z)}″`;
    }
    // wound counter under the token
    const wt = el("text", {x:px(op.x), y:px(op.y + R) + 12, "text-anchor":"middle",
      fill: op.wounds <= op.maxW / 4 ? "#e0573f" : isInjured(op) ? "#d3a04a" : "#9fd3a8",
      stroke:"#14110e", "stroke-width":3, "paint-order":"stroke", "font-size":11, "font-weight":700,
      "font-family":"'Big Shoulders',sans-serif", "pointer-events":"none"}, g);
    wt.textContent = `${op.wounds}/${op.maxW}`;
  }
}
// Where the valid-shots view looks from: the landing spot while dragging (nothing while
// the drag has no legal landing), else the selected operative. Shared with the 3D table.
export function shotEye() {
  const d = state.drag;
  if (d && d.active) return d.valid && d.path && d.goal ? {x: d.goal[0], y: d.goal[1], z: d.goalZ || 0, team: d.op.team, op: d.op, landing: true} : null;
  return state.sel && state.sel.alive ? {x: state.sel.x, y: state.sel.y, z: state.sel.z || 0, team: state.sel.team, op: state.sel, landing: false} : null;
}
// one colour per shot judgement, on the 2D map, the 3D table and the side panel
export const SHOT_COL = {clear: "#3f9a3a", cover: "#d79a1e", obscured: "#8d5fa8", concealed: "#a8873f", engaged: "#b5523b", hidden: "#857b70"};
// What the deciding line meets: the obscuring terrain, or the cover whenever the target is
// in it; nothing for a clear shot or one that isn't visible.
export function shotHit(sh) {
  return sh.kind === "obscured" ? sh.sight.obscBy : sh.inCover ? sh.sight.coverBy : null;
}
function renderShadows(eye) {
  const g = el("g", {opacity:0.15, "clip-path":"url(#boardclip)", "pointer-events":"none"}, gOverlay);
  const poly = visibilityPolygon(eye.x, eye.y).map(p => px(p[0]).toFixed(1) + " " + px(p[1]).toFixed(1));
  el("path", {d: `M0 0H${px(BW)}V${px(BH)}H0Z M${poly.join(" L")}Z`,
    fill:"#33291d", "fill-rule":"evenodd"}, g);
  // Every enemy, marked by how a shot at it is judged (base-to-base cover lines, so a
  // model peeking around a corner still counts): solid ring = a valid target, dashed =
  // not one. The line is the one that decides the call — a clear line, the cover line
  // through the cover or obscuring terrain (dot = where it crosses); none to an enemy it
  // can't see.
  for (const sh of shotsFrom(eye)) {
    const o = sh.target, col = SHOT_COL[sh.kind], k = SHOT_KINDS[sh.kind];
    if (sh.line) {
      const [[ax, ay], [bx, by]] = sh.line;
      el("line", {x1:px(ax), y1:px(ay), x2:px(bx), y2:px(by), stroke: col,
        "stroke-width": 1.6, "stroke-dasharray": k.valid ? "none" : "3 4", opacity: 0.85}, gOverlay);
    }
    const hit = shotHit(sh);
    if (hit) el("circle", {cx:px(hit.at[0]), cy:px(hit.at[1]), r:3.5, fill:col, stroke:"#14110e", "stroke-width":1}, gOverlay);
    const oR = opR(o);
    if (sh.kind === "clear")
      el("circle", {cx:px(o.x), cy:px(o.y), r:px(oR)+8, fill:"none", stroke:col, "stroke-width":5, opacity:0.25}, gOverlay);
    el("circle", {cx:px(o.x), cy:px(o.y), r:px(oR)+4, fill:"none", stroke:col,
      "stroke-width": k.valid ? 2.5 : 1.5, "stroke-dasharray": k.valid ? "none" : "4 3", opacity: k.valid ? 1 : 0.8}, gOverlay);
    el("text", {x:px(o.x), y:px(o.y + oR)+16, "text-anchor":"middle", fill:col, stroke:"#f5efe2", "stroke-width":3,
      "paint-order":"stroke", "font-family":"'JetBrains Mono',monospace", "font-size":9.5, "font-weight":600,
      "data-shot": sh.kind}, gTags).textContent = k.tag;
  }
}
// The move label: "Reposition 5" / 6"", or both actions when the move chains into the second.
export function dragLabelText() {
  const d = state.drag;
  const chained = d.total > d.primAllow + 1e-9 && d.p2;
  let txt = chained
    ? `${moveLabel(d.p1.type)} ${fmtIn(d.primAllow)}" + ${moveLabel(d.p2.type)} ${fmtIn(d.total - d.primAllow)}"/${fmtIn(d.secAllow)}"`
    : `${moveLabel(d.p1.type)} ${fmtIn(d.total)}" / ${fmtIn(d.primAllow)}"`;
  if (d.goalZ) txt += ` ▲${fmtIn(d.goalZ)}″ ${LEVELS[d.goalLayer - 1].name}`;
  else if (d.path && opLayer(d.op)) txt += " ▼ table";
  if (d.partial) txt += " (closest reachable)";
  else if (d.clamped && d.total >= d.primAllow + d.secAllow - 1e-9) txt += " (max)";
  if (!d.valid) txt += ` — ${d.why || "occupied"}`;
  else if (d.foes && d.foes.length) txt += ` → ${d.foes.map(f => f.name).join(", ")}`;
  return txt;
}
export function renderOverlay(cursor) {
  gOverlay.innerHTML = ""; gTags.innerHTML = "";
  const eye = shotEye();
  renderShots(eye);
  if (view3D && three) { sync3DOverlay(); return; }   // the 3D table draws its own
  // visibility and valid shots: from the drag ghost while moving, else from the selected operative
  if (eye) renderShadows(eye);
  // ruler
  if (state.mode === "ruler" && state.rulerPts.length) {
    const [p1] = state.rulerPts, p2 = state.rulerPts[1] || cursor;
    if (p2) {
      el("line", {x1:px(p1[0]), y1:px(p1[1]), x2:px(p2[0]), y2:px(p2[1]), stroke:"#c9a1e0", "stroke-width":2}, gOverlay);
      const d = dist(p1[0],p1[1],p2[0],p2[1]);
      el("text", {x:px((p1[0]+p2[0])/2), y:px((p1[1]+p2[1])/2)-8, "text-anchor":"middle", fill:"#8d5fa8",
        "font-family":"'JetBrains Mono',monospace", "font-size":13, "font-weight":600}, gOverlay)
        .textContent = d.toFixed(2) + '"';
    }
  }
  // drag movement path (auto-routed around terrain, clamped at the combined allowance)
  if (state.drag && state.drag.active && state.drag.goal) {
    const R = opR(state.drag.op);
    if (state.drag.path) {
      const colorOf = t => t === "dash" ? "#8d5fa8" : t === "charge" ? ENGAGE_COL : "#2a4f9e"; // secondary violet, charge red, main move blue
      const chained = state.drag.total > state.drag.primAllow + 1e-9 && state.drag.p2;
      // the route as its actual movement increments: straight steps, turns between steps
      const steps = chopIncrements(state.drag.path);
      // the ground the base sweeps (as wide as the base) and a faint base outline at every
      // increment, so it's clear how the base itself gets round terrain and other models
      const swept = el("g", {opacity:0.9}, gOverlay);
      for (const st of steps) if (!st.climb)
        el("line", {x1:px(st.x1), y1:px(st.y1), x2:px(st.x2), y2:px(st.y2), stroke:BASE_TRAIL,
          "stroke-width":px(2 * R), "stroke-linecap":"round", opacity:0.13}, swept);
      for (const st of steps)
        el("circle", {cx:px(st.x2), cy:px(st.y2), r:px(R), fill:"none", stroke:BASE_TRAIL,
          "stroke-width":1.2, opacity:0.55, "data-trail":"1"}, swept);
      let inch = 0;
      for (const st of steps) {
        inch += st.cost;
        const c = inch <= state.drag.primAllow + 1e-9 || !state.drag.p2 ? colorOf(state.drag.p1.type) : colorOf(state.drag.p2.type);
        if (st.climb) { // a climb (over a wall, or onto a floor) or a drop: bold amber rungs + the height paid
          el("line", {x1:px(st.x1), y1:px(st.y1), x2:px(st.x2), y2:px(st.y2),
            stroke: st.kind === "drop" ? "#3f7bb5" : "#b5731f", "stroke-width":3, "stroke-dasharray":"3 3"}, gOverlay);
          // climb label sits below the rungs on a light backing, clear of the move label above
          const lx = px((st.x1+st.x2)/2), ly = px(Math.max(st.y1, st.y2)) + 22;
          const ltxt = (st.kind === "up" ? `▲${fmtIn(st.up)}″ up onto the floor`
            : st.kind === "drop" ? `▼ drop ${st.climb}″ (${fmtIn(st.down)}″ counted)`
            : `▲${fmtIn(st.up)}″ up ▼${fmtIn(st.down)}″ down`) + ` + across = ${fmtIn(st.cost)}″${st.pad ? ` (incl. ${fmtIn(st.pad)}″ wait)` : ""}`;
          el("rect", {x: lx - ltxt.length * 3.85 - 6, y: ly - 13, width: ltxt.length * 7.7 + 12, height: 18, rx: 4,
            fill:"#fbf6ea", "fill-opacity":0.92, stroke:"#b5731f", "stroke-width":1}, gOverlay);
          el("text", {x: lx, y: ly, "text-anchor":"middle", fill:"#8a5414",
            "font-family":"'JetBrains Mono',monospace", "font-size":12, "font-weight":600}, gOverlay)
            .textContent = ltxt;
          el("circle", {cx:px(st.x2), cy:px(st.y2), r:3.2, fill:"#efe8d8", stroke:"#b5731f", "stroke-width":1.5}, gOverlay);
        } else {
          el("line", {x1:px(st.x1), y1:px(st.y1), x2:px(st.x2), y2:px(st.y2),
            stroke:c, "stroke-width":2}, gOverlay);
          if (Math.abs(inch - state.drag.primAllow) < 1e-6 && chained) // handover between the two move actions
            el("circle", {cx:px(st.x2), cy:px(st.y2), r:5.5, fill:"#efe8d8", stroke:colorOf(state.drag.p2.type), "stroke-width":2}, gOverlay);
          else if (st.partial) // short increment — still costs the full inch
            el("circle", {cx:px(st.x2), cy:px(st.y2), r:3.2, fill:"#efe8d8", stroke:c, "stroke-width":1.5}, gOverlay);
          else
            el("circle", {cx:px(st.x2), cy:px(st.y2), r:2.2, fill:c}, gOverlay);
        }
      }
      const col = !state.drag.valid ? "#cf4f37" : chained ? colorOf(state.drag.p2.type) : colorOf(state.drag.p1.type);
      el("circle", {cx:px(state.drag.goal[0]), cy:px(state.drag.goal[1]), r:px(R), fill:TEAMCOL[state.drag.op.team],
        "fill-opacity":0.35, stroke:col, "stroke-width":1.5, "stroke-dasharray":"3 3"}, gOverlay);
      // the ghost's engagement range: lights up red, with a ring on every enemy inside it
      const foes = state.drag.foes || [], hot = foes.length > 0;
      el("circle", {cx:px(state.drag.goal[0]), cy:px(state.drag.goal[1]), r:px(R + CTRL), fill: hot ? ENGAGE_COL : "none",
        "fill-opacity":0.12, stroke: hot ? ENGAGE_COL : "#f5e9d8", "stroke-width": hot ? 2 : 1.2,
        "stroke-dasharray": hot ? "none" : "4 3", opacity: hot ? 0.95 : 0.8}, gOverlay);
      if (hot) {
        engageRing(gOverlay, state.drag.goal[0], state.drag.goal[1], R);
        for (const f of foes) engageRing(gOverlay, f.x, f.y, opR(f));
      }
      const lbl = el("text", {x:px(state.drag.goal[0])+16, y:px(state.drag.goal[1])-12, fill:col,
        "font-family":"'JetBrains Mono',monospace", "font-size":13, "font-weight":600}, gOverlay);
      lbl.textContent = dragLabelText();
    } else {
      el("line", {x1:px(state.drag.sx), y1:px(state.drag.sy), x2:px(state.drag.goal[0]), y2:px(state.drag.goal[1]),
        stroke:"#cf4f37", "stroke-width":2, "stroke-dasharray":"6 4"}, gOverlay);
      el("circle", {cx:px(state.drag.goal[0]), cy:px(state.drag.goal[1]), r:px(R), fill:"none",
        stroke:"#cf4f37", "stroke-width":1.5, "stroke-dasharray":"3 3"}, gOverlay);
      el("text", {x:px(state.drag.goal[0])+16, y:px(state.drag.goal[1])-12, fill:"#cf4f37",
        "font-family":"'JetBrains Mono',monospace", "font-size":13, "font-weight":600}, gOverlay)
        .textContent = "blocked";
    }
  }
  // sight lines
  if (state.lastShot && state.sel && state.target && state.target.alive) {
    const s = state.lastShot.sight;
    const bPts = perimeterPts(state.target, 24, opR(state.target) - 0.02);
    const [ax, ay] = s.from;
    for (const [bx, by] of bPts) {
      const blocked = lineBlocked(ax, ay, bx, by);
      el("line", {x1:px(ax), y1:px(ay), x2:px(bx), y2:px(by),
        stroke: blocked ? "#cf4f37" : "#4d7a3f", opacity: blocked ? 0.18 : 0.3, "stroke-width":1}, gOverlay);
    }
    for (const t of [s.coverBy, s.obscBy]) {
      if (!t) continue;
      el("rect", {x:px(t.x)-3, y:px(t.y)-3, width:px(t.w)+6, height:px(t.h)+6, fill:"none",
        stroke: t === s.obscBy ? "#8d5fa8" : "#a06a10", "stroke-width":2, "stroke-dasharray":"5 4"}, gOverlay);
    }
  }
}
export function renderTray() {
  document.getElementById("tpv").textContent = tray.tp;
  document.getElementById("cpa").textContent = tray.cp[0];
  document.getElementById("cpb").textContent = tray.cp[1];
  document.getElementById("vpa").textContent = tray.vp[0];
  document.getElementById("vpb").textContent = tray.vp[1];
}
export function renderAll(cursor) {
  refreshSight();               // the chosen target's call, as things stand after this change
  renderObjectives(); renderOps(); renderOverlay(cursor); renderTray(); renderCard(); renderVerdict();
  if (view3D && three) sync3DOps();
  pump();                       // online: send the game if this render follows a change
}
