/* global THREE */
/**
 * Miniatures for the operatives on the 3D table: each side picks a Kill Team from the
 * Steam Workshop team mods (src/data/tts-teams.js) and a model per operative. Models load
 * from the Steam CDN when picked (the site hosts none) and replace the cylinders; the
 * cylinder stays as the invisible pick target, so dragging works exactly as before.
 * Each model's base is measured when it loads and becomes its operative's base size.
 */
import { TTS_TEAMS } from '../data/tts-teams.js';
import { snapBase } from '../config.js';
import { opR } from '../engine/geometry.js';
import { BH, BW, OPS } from '../engine/world.js';
import { noteFailure, steamMaterial, steamParts } from './models.js';
import { idleClone, idleFields, idleGeometry, idlePhase } from './idle.js';

const PREF = "skirmishtable.minis";
// per side: the team mod's id (or null for plain tokens) and the model index per operative
export const minis = { sides: [{ team: null, picks: {} }, { team: null, picks: {} }] };
try { Object.assign(minis, JSON.parse(localStorage.getItem(PREF)) || {}); } catch (e) {}
const listeners = [];
export const onMinisChange = fn => listeners.push(fn);
function changed() {
  try { localStorage.setItem(PREF, JSON.stringify(minis)); } catch (e) {}
  notify();
}
function notify() { const bases = syncBases(); for (const fn of listeners) fn(bases); }   // bases: an operative's base size changed
export const teamOf = side => TTS_TEAMS.find(t => t.id === minis.sides[side].team) || null;
export function setTeam(side, id) { minis.sides[side] = { team: id || null, picks: {} }; changed(); }
export function setPick(side, opId, index) { minis.sides[side].picks[opId] = index; changed(); }
// online: the host's picks for both sides (not saved as this browser's own choice)
export function setMinisSides(sides) { minis.sides = sides; notify(); }
// the model an operative shows: its pick, else the team's models dealt out in order
export function modelIndex(op, n) {
  const p = minis.sides[op.team].picks[op.id];
  return Number.isInteger(p) && p < n ? p : (parseInt(op.id.slice(1), 10) - 1) % n;
}

// Unity (TTS) local transform: T · Ry·Rx·Rz · S, as models.js places the terrain
function unityMatrix(p, r, s) {
  const d = Math.PI / 180;
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0] * d, r[1] * d, r[2] * d, "YXZ"));
  return new THREE.Matrix4().compose(new THREE.Vector3(...p), q, new THREE.Vector3(...s));
}
// The base: the largest flat, round mesh lying at the bottom of the model. Mods put it in
// different places (the parent object, or one part of a Unity bundle), and some have only
// a placeholder; then there's no base and the model keeps the mod's own size.
function findBase(meshes, all) {
  let best = null;
  const overall = all.getSize(new THREE.Vector3());
  for (const m of meshes) {
    const b = new THREE.Box3().setFromObject(m), s = b.getSize(new THREE.Vector3());
    const w = Math.max(s.x, s.z), round = Math.min(s.x, s.z) / (w || 1);
    if (s.y < 0.25 * w && round > 0.8 && w > 0.4 * Math.max(overall.x, overall.z) && b.min.y - all.min.y < 0.1 * overall.y
        && (!best || w > best.w)) best = { w, b, m };
  }
  return best;
}
// One model as a template group in table space, base centred on the origin, +z mirrored
// (TTS is left-handed) and the base's diameter in `userData.diameter` (null: no base found).
// Null when none of the miniature itself arrived: the operative keeps its cylinder.
const templates = {};
function template(model) {
  const key = JSON.stringify([model.base, model.parts]);
  if (templates[key]) return templates[key];
  const entries = [model.base, ...model.parts];
  let failed = false;
  const forget = () => { delete templates[key]; delete ready[key]; };
  return templates[key] = Promise.all(entries.map(e => steamParts(e).catch(err => {
    if (err.download && !failed) noteFailure(e.obj || e.bundle, err, 0, forget);   // once per model: Retry rebuilds it whole
    failed = failed || !!err.download;
    return [];
  }))).then(lists => {
    if (!lists.some((l, i) => l.length && (i || entries.length === 1))) return null;   // some mods put the model on the base
    const root = new THREE.Group(), inner = new THREE.Group();
    inner.matrixAutoUpdate = false;
    inner.matrix.makeScale(1, 1, -1).multiply(new THREE.Matrix4().makeScale(...model.s));
    lists.forEach((list, i) => {
      const e = entries[i], local = i ? unityMatrix(e.p, e.r, e.s) : new THREE.Matrix4();
      for (const p of list) {
        // TTS tints don't reach a bundle's own textured materials (mods tint those objects
        // black for the base underneath); untextured parts take the tint, else read grey
        const color = e.bundle && p.tex ? null : e.color || (p.tex ? null : [0.62, 0.62, 0.62]);
        const mesh = new THREE.Mesh(p.geometry, steamMaterial(p, color, e.material, renderer));
        mesh.matrixAutoUpdate = false; mesh.matrix.copy(local);
        mesh.castShadow = true; mesh.receiveShadow = true;
        inner.add(mesh);
      }
    });
    root.add(inner);
    root.updateMatrixWorld(true);
    const all = new THREE.Box3().setFromObject(inner), base = findBase(inner.children, all);
    const foot = base ? base.b : all;
    // idle motion (idle.js): every part but the base gets its displacement fields
    const fc = foot.getCenter(new THREE.Vector3()), feet = base ? base.b.max.y : all.min.y;
    const frame = { x: fc.x, z: fc.z, foot: feet, H: all.max.y - feet };
    for (const m of inner.children) {
      if (base && m === base.m) continue;
      const f = idleFields(m.geometry.attributes.position.array, m.matrixWorld.elements, frame);
      if (f) m.geometry = idleGeometry(m.geometry, f);
    }
    // TTS units are inches: the base's diameter in mm, snapped to a real base size
    const mm = base ? snapBase(base.w * 25.4) : null;
    root.userData = { diameter: base ? base.w : null, mm, centre: foot.getCenter(new THREE.Vector3()), bottom: all.min.y };
    return root;
  });
}

let renderer = null;
const ready = {}, loading = new Set();   // template key -> group, once loaded
const clones = {};                       // operative id -> its miniature
const modelOf = op => { const team = teamOf(op.team); return team && team.models.length ? team.models[modelIndex(op, team.models.length)] : null; };
const keyOf = model => JSON.stringify([model.base, model.parts]);
function load(model) {
  // one redraw per model when it lands (redraws call back in here: never pile up waiters)
  const key = keyOf(model);
  if (key in ready || loading.has(key)) return;   // ready[key] null: it didn't download
  loading.add(key);
  template(model).then(t => { ready[key] = t; loading.delete(key); notify(); });
}
// Each operative's base (op.base, mm) is its miniature's, once the model has loaded and
// a base was found on it; plain tokens (no team) use the ruleset's. True if any changed.
export function syncBases() {
  if (!window.THREE) return false;
  let any = false;
  for (const op of OPS) {
    const model = modelOf(op);
    let mm;
    if (model) {
      const key = keyOf(model);
      if (!(key in ready)) { load(model); continue; }   // keep the base it has until this one is measured
      mm = (ready[key] && ready[key].userData.mm) || undefined;
    }
    if (op.base !== mm) { if (mm) op.base = mm; else delete op.base; any = true; }
  }
  return any;
}
// The miniature for an operative, or null while it loads / when its side has no team.
// Expended operatives' miniatures lose most of their colour. Every part gets its own material
// (the idle-moving ones already have one) with a shader tweak, switched by one uniform per
// operative, so marking one expended or ready again recompiles nothing.
const SPENT_GLSL = `#include <map_fragment>
  float spL = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(spL) * 0.8, uSpent * 0.8);`;
function spentClone(obj) {
  const u = { value: 0 };
  obj.traverse(m => {
    if (!m.isMesh) return;
    const idle = !!m.geometry.userData.idle, prev = idle ? m.material.onBeforeCompile : null;
    const mat = idle ? m.material : m.material.clone();   // idleClone already gave this one its own
    mat.onBeforeCompile = function (shader, r) {
      if (prev) prev.call(this, shader, r);
      shader.uniforms.uSpent = u;
      shader.fragmentShader = "uniform float uSpent;\n" + shader.fragmentShader.replace("#include <map_fragment>", SPENT_GLSL);
    };
    mat.customProgramCacheKey = () => idle ? "idle+spent" : "spent";   // the two patches compile apart
    m.material = mat;
  });
  return u;
}
export function unitObject(op, r) {
  renderer = r;
  const model = modelOf(op);
  if (!model) return null;
  const key = keyOf(model);
  if (!(key in ready)) { load(model); return null; }
  const t = ready[key];
  if (!t) return null;                   // didn't download: the cylinder stands in
  // each operative keeps its clone (the table redraws on every change): only the matrix moves
  let obj = clones[op.id];
  if (!obj || obj.userData.src !== t) {
    obj = clones[op.id] = t.clone(); obj.userData = { ...t.userData, key, src: t };
    idleClone(obj, idlePhase(op.team + op.id));   // breathes in its own time
    obj.userData.spent = spentClone(obj);
  }
  obj.userData.spent.value = op.ready ? 0 : 1;    // greyed out once expended
  // fit the model's base to the operative's base (no base: the mod's inches), stand it on
  // the table, face the centre
  const k = t.userData.diameter ? 2 * opR(op) / t.userData.diameter : 1;
  const yaw = Math.atan2(BW / 2 - op.x, BH / 2 - op.y);   // the scans face +z once mirrored
  obj.matrixAutoUpdate = false;
  obj.matrix.makeTranslation(op.x, 0, op.y)
    .multiply(new THREE.Matrix4().makeRotationY(yaw))
    .multiply(new THREE.Matrix4().makeScale(k, k, k))
    .multiply(new THREE.Matrix4().makeTranslation(-t.userData.centre.x, -t.userData.bottom, -t.userData.centre.z));
  return obj;
}
