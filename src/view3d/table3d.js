/* global THREE */
/**
 * 3D table view (three.js r128 from the CDN, global THREE) — the default view. Scanned
 * meshes when the mesh pack is available, extruded footprints otherwise. Playable:
 * operatives are dragged on the table exactly as on the 2D map (same planner, same
 * rules); dragging empty table orbits the camera.
 */
import { state } from '../state.js';
import { CTRL, ENGAGE_COL, OBJ_R, TEAMCOL, TEAMCOL_LT, TEAMGREY } from '../config.js';
import { BH, BW, DECOR, DROPZONES, MAP, OBJECTIVES, OPS, TERRAIN } from '../engine/world.js';
import { chopIncrements, frontSteps } from '../engine/movement.js';
import { LEVELS, floorAt, layerZ, onLayer, ptFree } from '../engine/grid.js';
import { RULES, fmtIn } from '../rules/index.js';
import { CHARGE_SPEED, MARKER_R, SHOT_COL, dragLabelText, rangeRings, shotEye, shotHit } from '../ui/board.js';
import { engagements } from '../engine/engage.js';
import { opsState, placeMarkerAt } from '../ui/ops.js';
import { TTS_OPS } from '../data/tts-ops.js';
import { hint } from '../ui/dom.js';
import { armDrag, setBoardPicker } from '../ui/input.js';
import { SHOT_KINDS, shotsFrom } from '../engine/shots.js';
import { lineBlocked, visibilityPolygon } from '../engine/sight.js';
import { opR, perimeterPts } from '../engine/geometry.js';
import { addModels, ensureManifest, hasModels, progress, retryFailed, setRedraw, steamBytes, steamRemembered, useSteamSource } from './models.js';
import { onMinisChange, unitObject } from './units.js';
import { options } from '../ui/options.js';
import { THREAT_COL, dragThreat, threatCanvas, threatLabel, threatLevel } from '../ui/threat.js';
import { ACTIVE_STYLES, READY_STYLES, RING_T, animates, baseRing, classicBand, ringStyle, setRingStyle } from './rings.js';

/* ---------- 3D table view ----------
   The engine stays the rules authority; this view is fed by the same state and sends
   pointer input to the same drag planner as the 2D map. Terrain renders as the actual scanned TTS meshes (decimated, served
   as an artifact asset) when the map carries piece placements and the pack loads;
   otherwise every terrain rect is extruded by its height. */
// Mesh pack: public/meshpack.json locally (built by tools/meshpack.py); the Claude artifact
// build points this at the asset uploaded to the artifact (see .env.artifact).
const MESHPACK_URL = import.meta.env.VITE_MESHPACK_URL || "meshpack.json";
export let three = null, meshPack = null, meshPackTried = false, view3D = false;
const geomCache = {};
// Rendering is on demand: nothing moves on its own, so a frame is drawn only after the
// camera, the scene or the overlay changes (at most one per animation frame). The shadow
// map is redrawn only when something that casts a shadow changed (the sun never moves).
let frameQueued = false;
export function requestRender(shadows = false) {
  if (!three) return;
  if (shadows) three.renderer.shadowMap.needsUpdate = true;
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => {
    frameQueued = false;
    if (view3D) three.renderer.render(three.scene, three.camera);
  });
}
// Animated base rings (rings.js) need a frame every tick: a loop runs while any is on the
// table in the 3D view, and stops on its own (it never redraws the shadow map).
// The charge-path markers (threatGhost) ride the same loop.
let animating = false, animLoop = false, pathAnims = [];
function setAnimating(on) {
  animating = on;
  if (!(animating || pathAnims.length) || animLoop) return;
  animLoop = true;
  const step = now => {
    if (!(animating || pathAnims.length) || !view3D || !three) { animLoop = false; return; }
    RING_T.value = now / 1000;
    for (const pa of pathAnims) tickPath(pa, now / 1000);
    requestRender();
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
// Geometries shared by every operative, marker and overlay piece (scaled per use), so a
// redraw never allocates GPU buffers. Keyed by their shape; clearGroup leaves them alone.
const sharedGeo = {};
function geo(key, make) {
  if (!sharedGeo[key]) { sharedGeo[key] = make(); sharedGeo[key].userData.shared = true; }
  return sharedGeo[key];
}
const torus = (r, tube, seg) => geo(`torus ${r} ${tube} ${seg}`, () => new THREE.TorusGeometry(r, tube, 8, seg));
// colours and canvas textures are sRGB; the renderer outputs sRGB, so convert on the way in
const lin = hex => new THREE.Color(hex).convertSRGBToLinear();
const srgb = t => { t.encoding = THREE.sRGBEncoding; return t; };
function decodeB64(s, Type) {
  const bin = atob(s), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Type(bytes.buffer);
}
async function ensureMeshPack() {
  if (meshPack || meshPackTried) return;
  meshPackTried = true;
  if (!MESHPACK_URL || MESHPACK_URL.indexOf("__") === 0) return;
  try {
    const r = await fetch(MESHPACK_URL);
    if (r.ok) { meshPack = await r.json(); if (three) build3DScene(); }
  } catch (e) {}
}
function pieceGeometry(key) {
  if (geomCache[key]) return geomCache[key];
  const p = meshPack && meshPack[key];
  if (!p) return null;
  const v16 = decodeB64(p.v, Int16Array);
  const pos = new Float32Array(v16.length);
  for (let i = 0; i < v16.length; i++) pos[i] = v16[i] / 100;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(decodeB64(p.f, Uint16Array), 1));
  g.computeVertexNormals();
  geomCache[key] = g;
  return g;
}
// the operative's name over its model: one shared material per name
const labelMats = {};
function opLabelSprite(text) {
  if (!labelMats[text]) {
    const c = document.createElement("canvas"); c.width = 128; c.height = 64;
    const x = c.getContext("2d");
    x.font = "700 44px 'Big Shoulders', 'Arial Narrow', sans-serif";
    x.textAlign = "center"; x.textBaseline = "middle";
    x.fillStyle = "#f5e9d8";
    x.fillText(text, 64, 34);
    labelMats[text] = new THREE.SpriteMaterial({map: srgb(new THREE.CanvasTexture(c)), transparent: true, depthWrite: false});
    labelMats[text].userData.shared = true;
  }
  const s = new THREE.Sprite(labelMats[text]); s.scale.set(2.4, 1.2, 1);
  return s;
}
// marker token art from the mod's links (cylinder caps carry the image), shared per image
const markerMats = {};
function markerMat(url) {
  if (!markerMats[url]) {
    const tex = srgb(new THREE.TextureLoader().setCrossOrigin("anonymous").load(url, () => { if (three) sync3DOps(); }));
    const side = new THREE.MeshStandardMaterial({color: lin(0x2a241d), roughness: 0.9});
    const cap = new THREE.MeshStandardMaterial({map: tex, roughness: 0.85});
    side.userData.shared = true; cap.userData.shared = true;
    markerMats[url] = [side, cap, cap];
    markerMats[url].userData = {shared: true};
  }
  return markerMats[url];
}
// A wound counter: "w/max" on green, amber once injured, red when nearly down. Materials
// are cached per text and shared (sync3DOps rebuilds the ops on every render).
const woundMats = {};
function woundSprite(op) {
  const f = op.wounds / op.maxW, bg = f <= 0.25 ? "#c4402f" : op.wounds < op.maxW / 2 ? "#d3a04a" : "#3f9a55";
  const key = `${op.wounds}/${op.maxW}|${bg}`;
  if (!woundMats[key]) {
    const c = document.createElement("canvas"); c.width = 128; c.height = 40;
    const x = c.getContext("2d");
    x.fillStyle = "#14110e"; x.fillRect(0, 0, 128, 40);
    x.fillStyle = bg; x.fillRect(3, 3, Math.max(4, 122 * f), 34);
    x.font = "700 28px 'Big Shoulders', 'Arial Narrow', sans-serif";
    x.textAlign = "center"; x.textBaseline = "middle"; x.fillStyle = "#f5e9d8";
    x.fillText(`${op.wounds}/${op.maxW}`, 64, 21);
    woundMats[key] = new THREE.SpriteMaterial({map: srgb(new THREE.CanvasTexture(c)), transparent: true, depthWrite: false});
    woundMats[key].userData.shared = true;
  }
  const s = new THREE.Sprite(woundMats[key]); s.scale.set(1.25, 0.39, 1);
  return s;
}
// pointer -> normalised device coordinates for the canvas
function ndc(ev) {
  const r = three.renderer.domElement.getBoundingClientRect();
  return new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
}
function tokenAt(ev) {
  if (!three || !view3D) return null;
  three.raycaster.setFromCamera(ndc(ev), three.camera);
  const bodies = [];                 // each operative's pick cylinder, inside its own group
  three.opsGroup.traverse(o => { if (o.userData.oid) bodies.push(o); });
  const hit = three.raycaster.intersectObjects(bodies, false)[0];
  if (hit) return OPS.find(o => o.id === hit.object.userData.oid);
  // A fingertip is far bigger than a token on a phone: for touch and pen, take the
  // nearest live operative whose base centre is within a finger's reach on screen.
  if (ev.pointerType !== "touch" && ev.pointerType !== "pen") return null;
  const reach = ev.pointerType === "touch" ? 28 : 14;
  let best = null, bd = reach;
  for (const op of OPS) {
    if (!op.alive) continue;
    const p = boardToScreen(op.x, op.y, (op.z || 0) + 0.35);
    const d = Math.hypot(p.x - ev.clientX, p.y - ev.clientY);
    if (d < bd) { bd = d; best = op; }
  }
  return best;
}
// screen -> board inches on the surface under the pointer: [x, y, layer], an upper floor
// (grid LEVELS, highest first) where the ray meets one with room for the moving base,
// else the table top (null when the ray misses the table plane)
function groundPick(ev) {
  three.raycaster.setFromCamera(ndc(ev), three.camera);
  const ray = three.raycaster.ray;
  if (Math.abs(ray.direction.y) < 1e-6) return null;
  const at = h => { const t = (h - ray.origin.y) / ray.direction.y; return t < 0 ? null : [ray.origin.x + ray.direction.x * t, ray.origin.z + ray.direction.z * t]; };
  for (const L of [...LEVELS].sort((a, b) => b.z - a.z)) {
    const p = at(L.z);
    if (p && floorAt(L, p[0], p[1]) && onLayer(L.l, () => ptFree(p[0], p[1]))) return [p[0], p[1], L.l];
  }
  const p = at(0);
  return p && [p[0], p[1], 0];
}
// board inches (and height) -> client pixels; used by the browser tests
export function boardToScreen(x, y, z = 0) {
  if (!three) return null;
  const v = new THREE.Vector3(x, z, y).project(three.camera), r = three.renderer.domElement.getBoundingClientRect();
  return {x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height};
}
export function topDown(on) {
  if (!three) return;
  if (on) three.camera.position.set(BW / 2, Math.max(BW, BH) * 1.25, BH / 2 + 0.01);
  else three.camera.position.set(BW/2, BH * 0.95, BH * 1.55);
  three.controls.target.set(BW / 2, 0, BH / 2);
  three.controls.update();
  requestRender();
}
function clearGroup(g) {
  while (g.children.length) {
    const o = g.children.pop();
    o.parent = null;
    if (o.userData.lift) clearGroup(o);   // an operative's group (sync3DOps); never the miniature clones in it
    if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    if (o.material && o.material.map && !o.material.userData.shared) o.material.map.dispose();
    if (o.material && !o.material.userData.shared) o.material.dispose();
  }
}
// Overlay labels (the move label changes with every pointer move): painted once per text
// and style, kept for reuse while recent, so a drag back and forth paints no canvases.
const textCache = new Map();
function cachedText(text, fg, bg, height) {
  const k = `${text}|${fg}|${bg}|${height}`;
  let s = textCache.get(k);
  if (s) textCache.delete(k);           // most recently used goes last
  else {
    s = textSprite(text, fg, bg, height);
    s.material.userData.shared = true;
    if (textCache.size >= 64) {
      const [old, o] = textCache.entries().next().value;
      textCache.delete(old); o.material.map.dispose(); o.material.dispose();
    }
  }
  textCache.set(k, s);
  const c = new THREE.Sprite(s.material);
  c.scale.copy(s.scale); c.renderOrder = s.renderOrder;
  return c;
}
function textSprite(text, fg = "#f5e9d8", bg = null, height = 0.9) {
  const font = "600 40px 'JetBrains Mono', monospace";
  const c = document.createElement("canvas"), x = c.getContext("2d");
  x.font = font;
  const w = Math.ceil(x.measureText(text).width) + 28;
  c.width = w; c.height = 64;
  x.font = font; x.textAlign = "center"; x.textBaseline = "middle";
  if (bg) { x.fillStyle = bg; x.beginPath(); x.roundRect ? x.roundRect(2, 4, w - 4, 56, 12) : x.rect(2, 4, w - 4, 56); x.fill(); }
  x.fillStyle = fg; x.fillText(text, w / 2, 34);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({map: srgb(new THREE.CanvasTexture(c)), transparent: true, depthTest: false}));
  s.scale.set(height * w / 64, height, 1);
  s.renderOrder = 10;
  return s;
}
const basicMat = {};
function flatMat(hex, opacity = 1) {
  const k = hex + "/" + opacity;
  if (!basicMat[k]) { basicMat[k] = new THREE.MeshBasicMaterial({color: lin(hex), transparent: opacity < 1, opacity}); basicMat[k].userData.shared = true; }
  return basicMat[k];
}
// a flat ribbon on (or above) the table from (x1,y1,h1) to (x2,y2,h2)
function ribbon(g, x1, y1, h1, x2, y2, h2, width, hex, opacity = 1) {
  const L = Math.hypot(x2 - x1, y2 - y1, h2 - h1);
  if (L < 1e-6) return;
  const m = new THREE.Mesh(geo("box", () => new THREE.BoxGeometry(1, 1, 1)), flatMat(hex, opacity));
  m.scale.set(width, 0.04, L);
  m.position.set((x1 + x2) / 2, (h1 + h2) / 2, (y1 + y2) / 2);
  m.lookAt(x2, h2, y2);
  g.add(m);
}
function dot(g, x, y, h, r, hex) {
  const m = new THREE.Mesh(geo("sphere", () => new THREE.SphereGeometry(1, 12, 8)), flatMat(hex));
  m.scale.setScalar(r);
  m.position.set(x, h, y); g.add(m);
}
// The move preview, mirroring the 2D overlay: each increment as a ribbon, climbs as an
// amber arc over the terrain with their cost, the landing ghost, and the move label.
// What an operative can see, drawn on the table the same way as on the 2D map: shade over
// everything its eye point can't see, and every enemy marked with its shot judgement.
function sightShade(g, eye) {
  const shape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(BW, 0), new THREE.Vector2(BW, -BH), new THREE.Vector2(0, -BH)]);
  shape.holes.push(new THREE.Path(visibilityPolygon(eye.x, eye.y).map(([x, y]) => new THREE.Vector2(x, -y))));
  const shade = new THREE.Mesh(new THREE.ShapeGeometry(shape), flatMat(0x0b0806, 0.42));
  shade.material.depthWrite = false;
  shade.rotation.x = -Math.PI / 2; shade.position.y = 0.03; shade.renderOrder = 2;
  g.add(shade);
  // every enemy, marked as on the 2D map: ring colour = the judgement (thick = valid
  // target, thin = not), the deciding sight line, where it crosses the cover, and a tag
  for (const sh of shotsFrom(eye)) {
    const o = sh.target, hex = parseInt(SHOT_COL[sh.kind].slice(1), 16), valid = SHOT_KINDS[sh.kind].valid;
    const halo = new THREE.Mesh(torus(opR(o) + 0.22, valid ? 0.08 : 0.035, 40), flatMat(hex, valid ? 1 : 0.75));
    halo.rotation.x = Math.PI / 2; halo.position.set(o.x, (o.z || 0) + 0.08, o.y);
    g.add(halo);
    if (sh.line) {
      const [[ax, ay], [bx, by]] = sh.line;
      ribbon(g, ax, ay, 0.6, bx, by, 0.6, valid ? 0.05 : 0.025, hex);
    }
    const hit = shotHit(sh);
    if (hit) dot(g, hit.at[0], hit.at[1], 0.6, 0.12, hex);
    const tag = shotTag(sh.kind);
    tag.position.set(o.x, (o.z || 0) + 3.0, o.y);
    g.add(tag);
  }
}
// the shot tags over each enemy: one shared material per judgement, so a drag doesn't
// paint a canvas per enemy per pointer move
const shotTagMat = {};
function shotTag(kind) {
  if (!shotTagMat[kind]) {
    const s = textSprite(SHOT_KINDS[kind].tag, "#f5e9d8", SHOT_COL[kind], 0.6);
    s.material.userData.shared = true;
    shotTagMat[kind] = s;
  }
  const t = shotTagMat[kind], s = new THREE.Sprite(t.material);
  s.scale.copy(t.scale); s.renderOrder = 10;
  return s;
}
// the chosen target's cover lines: every line from the attacker's best base point to the
// target's base, green where clear and red where terrain blocks it (as on the 2D map)
function targetLines(g) {
  const s = state.lastShot.sight, [ax, ay] = s.from, pts = [], cols = [];
  const ok = new THREE.Color(0x5fae4c), bad = new THREE.Color(0xcf4f37);
  for (const [bx, by] of perimeterPts(state.target, 24, opR(state.target) - 0.02)) {
    const c = lineBlocked(ax, ay, bx, by) ? bad : ok;
    pts.push(ax, 0.6, ay, bx, 0.6, by); cols.push(c.r, c.g, c.b, c.r, c.g, c.b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
  g.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({vertexColors: true, transparent: true, opacity: 0.8})));
}
const ENGAGE_HEX = parseInt(ENGAGE_COL.slice(1), 16);
const TRAIL_HEX = 0xe8822e;   // faint orange: the base's path and its outline per increment
// the red ring round a model in (or about to be in) engagement range
function engageRing(g, x, y, R, z = 0) {
  const ring = new THREE.Mesh(torus(R + 0.34, 0.09, 40), flatMat(ENGAGE_HEX));
  ring.rotation.x = Math.PI / 2; ring.position.set(x, z + 0.1, y);
  ring.userData.engaged = true;
  g.add(ring);
}
// The threat zones (ui/threat.js) laid flat on the table: the same picture as the 2D map,
// one texture kept until the zones or the style change.
let threatTex = null;
function threatSheet(g, map) {
  const p = threatCanvas(map, state.threatStyle);
  if (!threatTex || threatTex.src !== p) {
    if (threatTex) { threatTex.mat.map.dispose(); threatTex.mat.dispose(); }
    const mat = new THREE.MeshBasicMaterial({map: srgb(new THREE.CanvasTexture(p.canvas)), transparent: true, depthWrite: false});
    mat.userData.shared = true;
    threatTex = {src: p, mat};
  }
  const sheet = new THREE.Mesh(geo(`sheet ${BW}x${BH}`, () => new THREE.PlaneGeometry(BW, BH)), threatTex.mat);
  sheet.rotation.x = -Math.PI / 2; sheet.position.set(BW / 2, 0.028, BH / 2); sheet.renderOrder = 2;
  g.add(sheet);
}
// the landing ghost under threat, as on the 2D map: a ring in the colour of the worst
// threat, a line from each enemy that could reach it, and who
// A charging enemy's route to the ghost, as on the 2D map: a faint track at its floor's
// height, an arrowhead cone where it ends, and (flow / comet) markers moving along it
// towards the ghost, advanced by the animation loop.
function chargePath3D(g, o, route, hex) {
  const lift = 0.1, pts = route.map(p => [p[0], p[1], layerZ(p[4] || 0) + lift]);
  const style = state.threatPaths, cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay, ah] = pts[i - 1], [bx, by, bh] = pts[i];
    cum.push(cum[i - 1] + Math.hypot(bx - ax, by - ay, bh - ah));
    ribbon(g, ax, ay, ah, bx, by, bh, style === "arrow" ? 0.1 : 0.05, hex, style === "arrow" ? 0.85 : 0.4);
  }
  const [ax, ay, ah] = pts[pts.length - 2], [bx, by, bh] = pts[pts.length - 1];
  const cone = new THREE.Mesh(geo("cone", () => new THREE.ConeGeometry(0.22, 0.5, 12)), flatMat(hex, 0.9));
  cone.position.set(bx, bh, by);
  cone.lookAt(bx + (bx - ax), bh, by + (by - ay)); cone.rotateX(Math.PI / 2);   // the cone's tip (+y) along the last leg
  g.add(cone);
  const end = new THREE.Mesh(geo(`range ${opR(o)}`, () => new THREE.RingGeometry(opR(o) - 0.035, opR(o) + 0.035, 96)), rangeMat(hex, 0.7));
  end.rotation.x = -Math.PI / 2; end.position.set(bx, bh - lift + 0.03, by);
  g.add(end);
  const len = cum[cum.length - 1];
  if (len < 1e-6 || (style !== "flow" && style !== "comet")) return;
  // flow: short dashes every 0.7" at 2"/s; comet: three shrinking beads at CHARGE_SPEED
  const marks = style === "flow"
    ? Array.from({length: Math.max(1, Math.floor(len / 0.7))}, (_, i) => ({off: i * 0.7, m: new THREE.Mesh(geo("box", () => new THREE.BoxGeometry(1, 1, 1)), flatMat(hex))}))
    : [[0.16, 0], [0.12, 0.25], [0.085, 0.5]].map(([r, off]) => {
      const m = new THREE.Mesh(geo("sphere", () => new THREE.SphereGeometry(1, 12, 8)), flatMat(hex)); m.scale.setScalar(r);
      return {off: -off, m};
    });
  for (const k of marks) { if (style === "flow") k.m.scale.set(0.11, 0.05, 0.32); g.add(k.m); }
  const pa = {pts, cum, len, marks, speed: style === "flow" ? 2 : CHARGE_SPEED, flow: style === "flow"};
  pathAnims.push(pa);
  tickPath(pa, performance.now() / 1000);
}
function tickPath(pa, t) {
  const {pts, cum, len, marks, speed, flow} = pa;
  for (const {off, m} of marks) {
    const span = flow ? Math.floor(len / 0.7) * 0.7 || len : len;   // dashes wrap on their own spacing
    let s = ((t * speed + off) % span + span) % span;
    let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
    const u = (s - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]), [ax, ay, ah] = pts[i - 1], [bx, by, bh] = pts[i];
    m.position.set(ax + (bx - ax) * u, ah + (bh - ah) * u + 0.02, ay + (by - ay) * u);
    if (flow) m.lookAt(bx, bh + 0.02, by);
  }
}
function threatGhost(g, at, [gx, gy], R, gz, routes) {
  const lvl = threatLevel(at);
  if (!lvl) return;
  const hex = c => parseInt(c.slice(1), 16);
  for (const o of at.close) if (!at.charge.includes(o)) ribbon(g, o.x, o.y, (o.z || 0) + 0.5, gx, gy, gz + 0.5, 0.05, hex(THREAT_COL.close));
  for (const o of at.charge) {
    const route = routes && routes.get(o);
    if (route && route.length > 1) chargePath3D(g, o, route, hex(THREAT_COL.charge));
    else ribbon(g, o.x, o.y, (o.z || 0) + 0.5, gx, gy, gz + 0.5, 0.08, hex(THREAT_COL.charge));
  }
  const ring = new THREE.Mesh(torus(R + 0.22, 0.09, 40), flatMat(hex(THREAT_COL[lvl])));
  ring.rotation.x = Math.PI / 2; ring.position.set(gx, gz + 0.08, gy);
  g.add(ring);
  const lab = cachedText(threatLabel(at), "#14110e", THREAT_COL[lvl], 0.7);
  lab.position.set(gx, gz + 1.8, gy);
  g.add(lab);
}
export function sync3DOverlay() {
  if (!three) return;
  const g = three.overlayGroup;
  clearGroup(g);
  pathAnims = [];
  const d = state.drag, eye = shotEye();
  if (eye) sightShade(g, eye);
  const threat = dragThreat();
  if (threat && state.threatStyle !== "warn") threatSheet(g, threat.map);
  if (d && d.active && d.goal) {
    const lift = 0.07, BR = opR(d.op);
    if (d.path) {
      const colorOf = t => t === "dash" ? 0x8d5fa8 : t === "charge" ? ENGAGE_HEX : 0x2a4f9e;
      // the ground the base sweeps (as wide as the base) and a faint base outline at every
      // increment, as on the 2D map
      const steps = chopIncrements(d.path), R = BR;
      for (const st of steps) {
        if (!st.climb) {
          const L = Math.hypot(st.x2 - st.x1, st.y2 - st.y1);
          if (L > 1e-6) {
            const band = new THREE.Mesh(geo("trailbox", () => new THREE.PlaneGeometry(1, 1)), rangeMat(TRAIL_HEX, 0.16));
            band.scale.set(2 * R, L, 1);
            band.rotation.set(-Math.PI / 2, Math.atan2(st.x2 - st.x1, st.y2 - st.y1), 0, "YXZ");   // lay flat, then turn along the leg
            band.position.set((st.x1 + st.x2) / 2, st.z1 + 0.025, (st.y1 + st.y2) / 2);
            g.add(band);
          }
        }
        const out = new THREE.Mesh(geo(`range ${R}`, () => new THREE.RingGeometry(R - 0.035, R + 0.035, 96)), rangeMat(TRAIL_HEX, 0.6));
        out.rotation.x = -Math.PI / 2; out.position.set(st.x2, st.z2 + 0.03, st.y2);
        g.add(out);
      }
      let inch = 0;
      for (const st of frontSteps(steps, R)) {     // the increments, traced by the front of the base
        inch += st.cost;
        const hex = inch <= d.primAllow + 1e-9 || !d.p2 ? colorOf(d.p1.type) : colorOf(d.p2.type);
        if (st.gap) ribbon(g, st.gap[0], st.gap[1], st.z1 + lift, st.x1, st.y1, st.z1 + lift, 0.12, hex);
        if (st.climb) {   // a climb or a drop: walk to the face, a vertical line up (or down) it, walk on
          const col = st.kind === "drop" ? 0x3f7bb5 : 0xb5731f, at = t => [st.x1 + (st.x2 - st.x1) * t, st.y1 + (st.y2 - st.y1) * t];
          const P = st.profile.map(([t, h]) => [...at(t), h + lift]);
          for (let i = 1; i < P.length; i++) {
            const [ax, ay, ah] = P[i - 1], [bx, by, bh] = P[i];
            if (Math.hypot(bx - ax, by - ay, bh - ah) > 1e-6) ribbon(g, ax, ay, ah, bx, by, bh, ah === bh ? 0.1 : 0.07, col);
          }
          const [fx, fy, fh] = st.kind === "drop" ? P[P.length - 2] : P[1];   // where it climbed from, or dropped to
          dot(g, fx, fy, fh, 0.12, col);
          const top = Math.max(...P.map(q => q[2]));
          const lab = cachedText(st.kind === "up" ? `▲${fmtIn(st.up)}″ = ${fmtIn(st.cost)}″`
            : st.kind === "drop" ? `▼${st.climb}″ (${fmtIn(st.down)}″) = ${fmtIn(st.cost)}″`
            : `▲${fmtIn(st.up)}″ ▼${fmtIn(st.down)}″ = ${fmtIn(st.cost)}″`,
            st.kind === "drop" ? "#24507a" : "#8a5414", "#fbf6ea", 0.75);
          lab.position.set(fx, top + 1.0, fy);
          g.add(lab);
        } else {
          ribbon(g, st.x1, st.y1, st.z1 + lift, st.x2, st.y2, st.z2 + lift, 0.12, hex);
          dot(g, st.x2, st.y2, st.z2 + lift, st.partial ? 0.13 : 0.09, st.partial ? 0xefe8d8 : hex);
        }
      }
    }
    const team = (TEAMCOL[d.op.team] || "#888888").replace("#", "0x");
    const gz = d.goalZ || 0;
    const ghost = new THREE.Mesh(geo(`ghost ${BR}`, () => new THREE.CylinderGeometry(BR, BR, 1.35, 24)), flatMat(parseInt(team, 16), 0.35));
    ghost.position.set(d.goal[0], gz + 0.675, d.goal[1]);
    g.add(ghost);
    const ring = new THREE.Mesh(torus(BR + 0.08, 0.05, 32), flatMat(d.valid && d.path ? 0xf5e9d8 : 0xcf4f37));
    ring.rotation.x = Math.PI / 2; ring.position.set(d.goal[0], gz + 0.06, d.goal[1]);
    g.add(ring);
    // the ghost's engagement range: lights up red, with a ring on every enemy inside it
    const foes = d.foes || [], hot = foes.length > 0, R = BR + CTRL;
    const er = new THREE.Mesh(geo(`range ${R}`, () => new THREE.RingGeometry(R - 0.035, R + 0.035, 96)), rangeMat(hot ? ENGAGE_HEX : 0xf5e9d8, hot ? 0.95 : 0.6));
    er.rotation.x = -Math.PI / 2; er.position.set(d.goal[0], gz + 0.035, d.goal[1]);
    g.add(er);
    if (hot) {
      engageRing(g, d.goal[0], d.goal[1], BR, gz);
      for (const f of foes) engageRing(g, f.x, f.y, opR(f), f.z);
    }
    const label = cachedText(d.path ? dragLabelText() : "blocked", d.valid && d.path ? "#f5e9d8" : "#ffb4a6", "rgba(20,17,14,0.82)", 0.8);
    label.position.set(d.goal[0], gz + 2.6, d.goal[1]);
    g.add(label);
    if (threat && d.path) threatGhost(g, threat.at, d.goal, BR, gz, threat.routes);
  }
  // the chosen target: the sight line the engine found, green, or a red line if none
  if (state.sel && state.target && state.target.alive && state.lastShot) {
    const s = state.lastShot.sight;
    targetLines(g);
    for (const t of [s.coverBy, s.obscBy]) {
      if (!t) continue;
      const box = new THREE.Mesh(new THREE.BoxGeometry(t.w + 0.2, 0.08, t.h + 0.2), flatMat(t === s.obscBy ? 0x8d5fa8 : 0xa06a10, 0.55));
      box.position.set(t.x + t.w / 2, 0.05, t.y + t.h / 2);
      g.add(box);
    }
  }
  setAnimating(animating);   // runs the loop while charge-path markers move
  requestRender();
}
function init3D() {
  const box = document.getElementById("board3d");
  const renderer = new THREE.WebGLRenderer({antialias: true});
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputEncoding = THREE.sRGBEncoding;           // textures are sRGB, as in TTS
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;                   // redrawn on requestRender(true)
  renderer.localClippingEnabled = true;                    // models.js trims the guide planes
  box.appendChild(renderer.domElement);
  // a click (not an orbit drag) on the table places a pending Ops-panel marker
  let down = null;
  renderer.domElement.addEventListener("pointerdown", ev => { down = [ev.clientX, ev.clientY]; });
  renderer.domElement.addEventListener("pointerup", ev => {
    if (state.mode !== "marker" || !down || Math.hypot(ev.clientX - down[0], ev.clientY - down[1]) > 5) return;
    const p = groundPick(ev);
    if (p && p[0] >= 0 && p[1] >= 0 && p[0] <= BW && p[1] <= BH) placeMarkerAt(p[0], p[1]);
  });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x4a443c);          // light enough for the black table edge to read
  scene.add(new THREE.HemisphereLight(0xfff6ea, 0x3a332a, 0.55));
  scene.add(new THREE.AmbientLight(0xfff4e4, 0.25));
  const sun = new THREE.DirectionalLight(0xffffff, 0.95);
  sun.position.set(-14 + 15, 26, -10 + 11); // the 2D north-west sun, over the table centre
  sun.target.position.set(15, 0, 11);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, {left: -24, right: 24, top: 24, bottom: -24, near: 1, far: 80});
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
  scene.add(sun); scene.add(sun.target);
  // near plane at 1": the camera never gets closer than 6", and a far-out near plane keeps
  // depth precision for surfaces that lie on the mat (no flicker when orbiting)
  const camera = new THREE.PerspectiveCamera(48, 1, 1, 400);
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 6; controls.maxDistance = 90;
  controls.addEventListener("change", () => requestRender());
  const terrainGroup = new THREE.Group(), opsGroup = new THREE.Group(), overlayGroup = new THREE.Group();
  scene.add(terrainGroup); scene.add(opsGroup); scene.add(overlayGroup);
  three = {renderer, scene, camera, controls, terrainGroup, opsGroup, overlayGroup, box, raycaster: new THREE.Raycaster()};
  // Grab a token to move it (capture phase, so OrbitControls never sees that press);
  // anywhere else orbits as usual.
  box.addEventListener("pointerdown", ev => {
    if (!ev.isPrimary || ev.button !== 0) return;
    const op = tokenAt(ev);
    if (op && armDrag(op, ev, true)) { controls.enabled = false; ev.preventDefault(); }
  }, true);
  // On touch, OrbitControls (r128) works from touch events, not pointer events. While a token
  // is being dragged, keep those touches from it, and from the page (no scroll or zoom).
  for (const type of ["touchstart", "touchmove"]) box.addEventListener(type, ev => {
    if (state.drag && state.drag.from3d) { ev.stopPropagation(); if (ev.cancelable) ev.preventDefault(); }
  }, {capture: true, passive: false});
  window.addEventListener("pointerup", () => { controls.enabled = true; });
  window.addEventListener("pointercancel", () => { controls.enabled = true; });
  box.addEventListener("pointermove", ev => {
    if (!state.drag) renderer.domElement.style.cursor = tokenAt(ev) ? "grab" : "";
  });
  panKeys();
  resize3D();
  window.addEventListener("resize", resize3D);
  setRedraw(() => requestRender(true));   // models and textures arriving (cut-outs shape shadows too)
}
// WASD slides the camera and its target over the table, along the ground, relative to where
// the camera faces. Speed grows with zoom distance and the Options pan speed; the target
// stays over the board.
const PAN_KEYS = {KeyW: [0, 1], KeyS: [0, -1], KeyA: [-1, 0], KeyD: [1, 0]};
function panKeys() {
  const held = new Set();
  let last = 0;
  const typing = el => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  const step = t => {
    if (!held.size || !view3D) { held.clear(); last = 0; return; }
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
    last = t;
    const {camera, controls} = three;
    const fwd = new THREE.Vector3().subVectors(controls.target, camera.position).setY(0);
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1).applyQuaternion(camera.quaternion).setY(0);   // top-down
    fwd.normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    let f = 0, r = 0;
    for (const k of held) { f += PAN_KEYS[k][1]; r += PAN_KEYS[k][0]; }
    const move = fwd.multiplyScalar(f).add(right.multiplyScalar(r));
    if (move.lengthSq()) {
      move.normalize().multiplyScalar(camera.position.distanceTo(controls.target) * 0.6 * options.panSpeed * dt);
      const tx = Math.max(0, Math.min(BW, controls.target.x + move.x)) - controls.target.x;
      const tz = Math.max(0, Math.min(BH, controls.target.z + move.z)) - controls.target.z;
      controls.target.x += tx; controls.target.z += tz;
      camera.position.x += tx; camera.position.z += tz;
      controls.update();
    }
    requestAnimationFrame(step);
  };
  document.addEventListener("keydown", ev => {
    if (!PAN_KEYS[ev.code] || !view3D || ev.ctrlKey || ev.metaKey || ev.altKey || typing(ev.target) || document.querySelector("dialog[open]")) return;
    ev.preventDefault();
    if (!held.size) requestAnimationFrame(step);
    held.add(ev.code);
  });
  document.addEventListener("keyup", ev => held.delete(ev.code));
  window.addEventListener("blur", () => held.clear());
}
function resize3D() {
  if (!three) return;
  const w = three.box.clientWidth || 800, h = Math.round(w * BH / BW);
  three.renderer.setSize(w, h);
  three.camera.aspect = w / h;
  three.camera.updateProjectionMatrix();
  requestRender();
}
const MAT3D = {};
function mat3d(key, opts) { return MAT3D[key] || (MAT3D[key] = new THREE.MeshStandardMaterial({...opts, color: lin(opts.color)})); }
let sceneGen = 0;
export function build3DScene() {
  if (!three) return;
  const g = three.terrainGroup;
  while (g.children.length) g.remove(g.children[0]);
  const gen = ++sceneGen;
  // The exact TTS models (mat, terrain, rubble, objectives, guides) when the model pack is
  // available; otherwise our own board with decimated scans or extruded footprints.
  if (hasModels(MAP)) {
    addModels(g, MAP, three.renderer, BW, BH, () => gen === sceneGen);
    for (const dz of DROPZONES) {   // a light tint over the mat's own deployment art
      const zone = new THREE.Mesh(new THREE.PlaneGeometry(dz.w, dz.h),
        new THREE.MeshBasicMaterial({color: lin(dz.team === 0 ? 0xe0672f : 0x5b93a6), transparent: true, opacity: 0.08, depthWrite: false}));
      zone.rotation.x = -Math.PI / 2;
      zone.position.set(dz.x + dz.w/2, 0.015, dz.y + dz.h/2);
      g.add(zone);
    }
    finishScene();
    return;
  }
  // board, grid, drop zones, centreline
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(BW, BH), mat3d("ground", {color: 0xe9e1d1, roughness: 1}));
  ground.rotation.x = -Math.PI / 2; ground.position.set(BW/2, 0, BH/2);
  ground.receiveShadow = true;
  g.add(ground);
  const gridPts = [];
  for (let i = 1; i < BW; i++) gridPts.push(i, 0.01, 0, i, 0.01, BH);
  for (let j = 1; j < BH; j++) gridPts.push(0, 0.01, j, BW, 0.01, j);
  const gridGeo = new THREE.BufferGeometry();
  gridGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(gridPts), 3));
  g.add(new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({color: 0xd8cdb8, transparent: true, opacity: 0.55})));
  for (const dz of DROPZONES) {
    const zone = new THREE.Mesh(new THREE.PlaneGeometry(dz.w, dz.h),
      new THREE.MeshBasicMaterial({color: lin(dz.team === 0 ? 0xe0672f : 0x5b93a6), transparent: true, opacity: 0.13}));
    zone.rotation.x = -Math.PI / 2;
    zone.position.set(dz.x + dz.w/2, 0.02, dz.y + dz.h/2);
    g.add(zone);
  }
  // objectives
  for (const o of OBJECTIVES) {
    const d = new THREE.Mesh(new THREE.CylinderGeometry(OBJ_R, OBJ_R, 0.08, 28), mat3d("obj", {color: 0xcbbfa4, roughness: 1}));
    d.position.set(o.x, 0.04, o.y);
    g.add(d);
  }
  // terrain: scanned meshes where we can, extruded rects elsewhere. Pieces are stored
  // in board coords with angle a; raw OBJ vertices rotated by a about y is exactly the
  // TTS placement (the OBJ X-flip and the z-flip cancel into a rotation) — no mirror.
  const meshMode = !!(meshPack && MAP.pieces && MAP.pieces.length);
  if (meshMode) {
    const stone = mat3d("stone", {color: 0x8e8577, roughness: 1, flatShading: true});
    for (const p of MAP.pieces) {
      const geo = pieceGeometry(p.k);
      if (!geo) continue;
      const m = new THREE.Mesh(geo, stone);
      m.scale.setScalar(p.s);
      m.rotation.y = p.a * Math.PI / 180;
      m.position.set(p.x, 0, p.y);
      g.add(m);
    }
  }
  const KC = {wall: 0x3a3833, heavy: 0x41584a, light: 0x7d9c81};
  for (const t of TERRAIN) {
    if (meshMode && t.m) continue; // the scanned mesh already shows this
    const zH = Math.max(0.5, t.z || 1);
    const box = new THREE.Mesh(new THREE.BoxGeometry(t.w, zH, t.h),
      mat3d("k" + t.kind, {color: KC[t.kind] || 0x555, roughness: 1}));
    box.position.set(t.x + t.w/2, zH/2, t.y + t.h/2);
    g.add(box);
  }
  for (const d of DECOR) {        // fire steps: low platforms
    if (meshMode && d.m) continue;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(d.w, 0.4, d.h),
      mat3d("step", {color: 0xd9b765, roughness: 1}));
    slab.position.set(d.x + d.w/2, 0.2, d.y + d.h/2);
    g.add(slab);
  }
  g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  finishScene();
}
function finishScene() {
  three.camera.position.set(BW/2, BH * 0.95, BH * 1.55);
  three.controls.target.set(BW/2, 0, BH/2);
  three.controls.update();      // aims the camera at the target
  resize3D();
  sync3DOps();
}
// operative bodies: one material per colour and state (the cylinder is only a pick target
// under a miniature, so that one draws nothing)
const bodyMats = {};
function bodyMat(hex, ready, hidden) {
  const k = `${hex}|${ready}|${hidden}`;
  if (!bodyMats[k]) {
    bodyMats[k] = new THREE.MeshStandardMaterial({color: lin(hex), roughness: 0.9, transparent: !ready, opacity: ready ? 1 : 0.6});
    bodyMats[k].visible = !hidden;
    bodyMats[k].userData.shared = true;
  }
  return bodyMats[k];
}
const rangeMats = {};
function rangeMat(hex, opacity) {
  const k = hex + "/" + opacity;
  if (!rangeMats[k]) {
    rangeMats[k] = new THREE.MeshBasicMaterial({color: lin(hex), transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide});
    rangeMats[k].userData.shared = true;
  }
  return rangeMats[k];
}
// The operatives are redrawn from scratch on every render, but out of shared geometries,
// materials and per-operative miniature clones: a redraw makes plain objects, no GPU work.
export function sync3DOps() {
  if (!three) return;
  const g = three.opsGroup;
  clearGroup(g);
  for (const m of opsState.markers) {     // markers from the Ops panel: flat tokens on the table
    const t = TTS_OPS.tokens[m.k];
    if (!t) continue;
    const disc = new THREE.Mesh(geo("marker", () => new THREE.CylinderGeometry(MARKER_R, MARKER_R, 0.06, 32)), markerMat(t.img));
    disc.position.set(m.x, 0.04, m.y);
    g.add(disc);
  }
  for (const [a, b] of engagements()) {   // engaged pairs: a red ring round both and a line between
    ribbon(g, a.x, a.y, (a.z || 0) + 0.1, b.x, b.y, (b.z || 0) + 0.1, 0.07, ENGAGE_HEX);
    engageRing(g, a.x, a.y, opR(a), a.z); engageRing(g, b.x, b.y, opR(b), b.z);
  }
  let anim = false;
  for (const op of OPS) {
    if (!op.alive) continue;
    const og = new THREE.Group();     // everything of this operative's, lifted onto the floor it stands on
    og.position.y = op.z || 0; og.userData.lift = true;
    g.add(og);
    const moved = op.used.some(u => u === "reposition" || u === "dash" || u === "charge");
    const colHex = parseInt((moved || !op.ready ? TEAMGREY : TEAMCOL)[op.team].replace("#", "0x"), 16);
    // the side's miniature, when it has picked a team: the cylinder stays as the pick target,
    // and a ring in the team colour (grey once spent) marks whose it is
    const mini = unitObject(op, three.renderer), BR = opR(op);
    const body = new THREE.Mesh(geo(`body ${BR}`, () => new THREE.CylinderGeometry(BR, BR, 1.35, 20)),
      bodyMat(colHex, op.ready, !!mini));
    body.position.set(op.x, 0.675, op.y);
    body.castShadow = !mini;
    body.userData.oid = op.id;        // picked by tokenAt()
    og.add(body);
    if (mini) og.add(mini);
    if (mini && classicBand()) {
      const band = new THREE.Mesh(torus(BR + 0.06, 0.05, 32), flatMat(colHex));
      band.rotation.x = Math.PI / 2; band.position.set(op.x, 0.04, op.y);
      og.add(band);
    }
    // the base ring: thin and see-through, out to control range and cut off by terrain;
    // active (selected, or mid-activation) operatives get the picked active style in full colour
    const active = op.ready && ((state.sel && state.sel.id === op.id) || op.used.length > 0);
    const ring = op.z ? null : baseRing(op, BR, lin(active ? parseInt(TEAMCOL[op.team].slice(1), 16) : colHex), op.ready, active);
    if (ring) { og.add(ring); anim = anim || animates(op.ready, active); }
    else if (op.z) {                  // up on a floor, the table-clipped ring doesn't apply: a plain band
      const band = new THREE.Mesh(torus(BR + 0.06, 0.05, 32), flatMat(colHex));
      band.rotation.x = Math.PI / 2; band.position.set(op.x, 0.04, op.y);
      og.add(band);
    }
    if (RULES.orders && op.order === "engage") {
      const ring = new THREE.Mesh(torus(BR + 0.18, 0.07, 28), flatMat(0xff8c2e));
      ring.rotation.x = Math.PI / 2; ring.position.set(op.x, 0.08, op.y);
      og.add(ring);
    }
    if (state.sel && state.sel.id === op.id) {
      // range rings, measured from the base edge as the rules do (as on the 2D map):
      // control range (shaded disc, white ring) and 2″ (red), each labelled
      const disc = new THREE.Mesh(geo(`disc ${BR + CTRL}`, () => new THREE.CircleGeometry(BR + CTRL, 96)), rangeMat(parseInt(TEAMCOL[op.team].slice(1), 16), 0.16));
      disc.rotation.x = -Math.PI / 2; disc.position.set(op.x, 0.02, op.y);
      og.add(disc);
      for (const [r, col] of rangeRings()) {
        const R = BR + r, hex = parseInt(col.slice(1), 16);
        // over the sight shade, with a dark edge so the white ring reads on pale ground too
        for (const [w, c, o, h] of [[0.09, 0x14110e, 0.55, 0.045], [0.045, hex, 1, 0.05]]) {
          const ring = new THREE.Mesh(geo(`range ${R} ${w}`, () => new THREE.RingGeometry(R - w, R + w, 128)), rangeMat(c, o));
          ring.rotation.x = -Math.PI / 2; ring.position.set(op.x, h, op.y); ring.renderOrder = 3;
          og.add(ring);
        }
        const tag = cachedText(fmtIn(r) + "″", col, "rgba(20,17,14,0.78)", 0.42);
        tag.position.set(op.x, 0.25, op.y - R);
        og.add(tag);
      }
    }
    const label = opLabelSprite(op.id);
    label.position.set(op.x, 2.1, op.y);
    og.add(label);
    const wl = woundSprite(op);       // "12/15" over every model, as TTS wound counters show
    wl.position.set(op.x, 1.62, op.y);
    og.add(wl);
  }
  setAnimating(anim);
  requestRender(true);
}
// "Where is it?": a glow that rises round an operative, breathes a few times and fades,
// with two rings rippling out along the table one after the other (picked from the board
// overlay); about two seconds in all.
let beamFade = null;
export function flashOp3D(op) {
  if (!three || !view3D) return;
  if (!beamFade) {           // brightest at the foot, gone by the top (alphaMap reads green)
    const c = document.createElement("canvas"); c.width = 1; c.height = 64;
    const x = c.getContext("2d"), gr = x.createLinearGradient(0, 0, 0, 64);
    gr.addColorStop(0, "#000"); gr.addColorStop(0.5, "#262626"); gr.addColorStop(1, "#d0d0d0");
    x.fillStyle = gr; x.fillRect(0, 0, 1, 64);
    beamFade = new THREE.CanvasTexture(c);
  }
  const BR = opR(op), col = lin(parseInt(TEAMCOL_LT[op.team].slice(1), 16)), H = 6.5;
  const glowMat = new THREE.MeshBasicMaterial({color: col, transparent: true, opacity: 0, alphaMap: beamFade,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide});
  const g = new THREE.Group();
  g.position.set(op.x, op.z || 0, op.y);
  const glow = new THREE.Mesh(geo("beam outer", () => new THREE.CylinderGeometry(1, 1, 1, 32, 1, true)), glowMat);
  g.add(glow);
  const rings = [0, 0.28].map(delay => {
    const mat = new THREE.MeshBasicMaterial({color: col, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide});
    const ring = new THREE.Mesh(geo("beam ring", () => new THREE.RingGeometry(0.9, 1, 64)), mat);
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.06;
    g.add(ring);
    return {ring, mat, delay};
  });
  three.scene.add(g);
  const t0 = performance.now(), T = 2100;
  const step = now => {
    const t = Math.min(1, (now - t0) / T);
    const rise = 1 - Math.pow(1 - Math.min(1, t / 0.3), 3);            // shoots up, then settles
    const breathe = 0.8 + 0.2 * Math.cos(t * Math.PI * 6);              // three gentle pulses
    const R = BR + 0.35 + 0.08 * Math.sin(t * Math.PI * 6);
    glow.scale.set(R, H * rise, R); glow.position.y = H * rise / 2;
    glowMat.opacity = 0.5 * Math.sin(Math.PI * t) * breathe;
    for (const k of rings) {
      const u = Math.min(1, Math.max(0, (t - k.delay) / 0.65)), r = BR + 0.3 + u * 2.4;
      k.ring.scale.set(r, r, 1); k.mat.opacity = 0.7 * Math.sin(Math.PI * u);
    }
    requestRender();
    if (t < 1 && three) return requestAnimationFrame(step);
    three.scene.remove(g); glowMat.dispose(); rings.forEach(k => k.mat.dispose());
    requestRender();
  };
  requestAnimationFrame(step);
}
// The TTS models aren't on this server (third-party assets): say so instead of silently
// showing block terrain, and offer to load them from Steam.
const NOTE_NO_MODELS = `Block terrain: this site doesn't host the TTS models. Load them straight from Steam (${Math.round(steamBytes / 1e6)} MB, once).`;
const NOTE3D = "Drag an operative to move it · drag the table to orbit, scroll to zoom, WASD to pan · the ruler is on the 2D map.";
function showModels(note) {
  const btn = document.getElementById("loadtts");
  btn.style.display = "none";
  progress.onChange = () => {
    const pct = progress.total ? Math.min(100, Math.round(100 * progress.loaded / progress.total)) : 100;
    if (pct < 100) note.textContent = `Loading the TTS models and textures… ${pct}% of ${(progress.total / 1e6).toFixed(0)} MB`;
    else if (progress.failed) {
      // say so (blocks and cylinders stand in) rather than leave a bare table; the console has the cause
      note.textContent = `${progress.failed} download${progress.failed > 1 ? "s" : ""} from Steam failed: blocks stand in. Check the connection, or an ad/content blocker on cdn.steamusercontent.com.`;
      btn.textContent = "Retry"; btn.style.display = "";
    } else note.textContent = NOTE3D;
  };
  build3DScene(); progress.onChange();
}
export function setView(to3d) {
  view3D = to3d;
  document.getElementById("board").style.display = to3d ? "none" : "block";
  document.getElementById("board3d").style.display = to3d ? "block" : "none";
  document.getElementById("view2d").classList.toggle("active", !to3d);
  document.getElementById("view3d").classList.toggle("active", to3d);
  document.getElementById("view3dtop").style.display = to3d ? "" : "none";
  document.getElementById("ringpick").style.display = to3d ? "" : "none";
  const note = document.getElementById("v3dnote");
  if (to3d) {
    if (!window.THREE || !THREE.OrbitControls) { note.textContent = "3D libraries didn't load here — using the 2D map."; setView(false); return; }
    if (!three) init3D();
    build3DScene();
    // the exact models when the pack is there (else the decimated scans), with progress
    // (or from Steam, when this viewer chose that before)
    ensureManifest().then(m => {
      if (!m && steamRemembered()) m = useSteamSource();
      if (m && view3D) showModels(note);
      else if (!m) {
        ensureMeshPack();
        if (view3D) { note.textContent = NOTE_NO_MODELS; Object.assign(document.getElementById("loadtts"), { textContent: "Load from Steam" }).style.display = ""; }
      }
    });
    setBoardPicker(groundPick);
    note.textContent = NOTE3D;
  } else { setBoardPicker(null); note.textContent = ""; document.getElementById("loadtts").style.display = "none"; }
}

// Wiring: event listeners and button handlers (called once from main.js).
export function wireViewToggle() {
  onMinisChange(() => { if (view3D) sync3DOps(); });   // a team picked, or a model finished loading
  // the cached canvas labels may have been painted before the web fonts arrived: repaint
  if (document.fonts) document.fonts.addEventListener("loadingdone", () => {
    const old = [...Object.values(labelMats), ...Object.values(woundMats), ...Object.values(shotTagMat).map(s => s.material),
      ...[...textCache.values()].map(s => s.material)];
    for (const c of [labelMats, woundMats, shotTagMat]) for (const k in c) delete c[k];
    textCache.clear();
    if (three) { sync3DOps(); sync3DOverlay(); }
    for (const m of old) { m.map.dispose(); m.dispose(); }
  });
  document.getElementById("view2d").onclick = () => setView(false);
  document.getElementById("view3d").onclick = () => setView(true);
  document.getElementById("loadtts").onclick = () => { retryFailed(); useSteamSource(); showModels(document.getElementById("v3dnote")); };
  // base ring styles to try: ready operatives / the active one
  for (const [id, k, list] of [["ringready", "ready", READY_STYLES], ["ringactive", "active", ACTIVE_STYLES]]) {
    const sel = document.getElementById(id);
    sel.innerHTML = list.map(([v, label]) => `<option value="${v}"${ringStyle[k] === v ? " selected" : ""}>${label}</option>`).join("");
    sel.onchange = () => { setRingStyle(k, sel.value); if (three) sync3DOps(); };
  }
  let top = false;
  document.getElementById("view3dtop").onclick = ev => {
    top = !top; topDown(top);
    ev.currentTarget.classList.toggle("active", top);
  };
}
