/* global THREE */
/**
 * Miniatures for the operatives on the 3D table: each side picks a Kill Team from the
 * Steam Workshop team mods (src/data/tts-teams.js) and a model per operative. Models load
 * from the Steam CDN when picked (the site hosts none) and replace the cylinders; the
 * cylinder stays as the invisible pick target, so dragging works exactly as before.
 */
import { TTS_TEAMS } from '../data/tts-teams.js';
import { BASE_R } from '../config.js';
import { BH, BW } from '../engine/world.js';
import { steamMaterial, steamParts } from './models.js';

const PREF = "skirmishtable.minis";
// per side: the team mod's id (or null for plain tokens) and the model index per operative
export const minis = { sides: [{ team: null, picks: {} }, { team: null, picks: {} }] };
try { Object.assign(minis, JSON.parse(localStorage.getItem(PREF)) || {}); } catch (e) {}
const listeners = [];
export const onMinisChange = fn => listeners.push(fn);
function changed() {
  try { localStorage.setItem(PREF, JSON.stringify(minis)); } catch (e) {}
  for (const fn of listeners) fn();
}
export const teamOf = side => TTS_TEAMS.find(t => t.id === minis.sides[side].team) || null;
export function setTeam(side, id) { minis.sides[side] = { team: id || null, picks: {} }; changed(); }
export function setPick(side, opId, index) { minis.sides[side].picks[opId] = index; changed(); }
// online: the host's picks for both sides (not saved as this browser's own choice)
export function setMinisSides(sides) { minis.sides = sides; for (const fn of listeners) fn(); }
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
        && (!best || w > best.w)) best = { w, b };
  }
  return best;
}
// One model as a template group in table space, base centred on the origin, +z mirrored
// (TTS is left-handed) and the base's diameter in `userData.diameter` (null: no base found).
const templates = {};
function template(model) {
  const key = JSON.stringify([model.base, model.parts]);
  if (templates[key]) return templates[key];
  const entries = [model.base, ...model.parts];
  return templates[key] = Promise.all(entries.map(e => steamParts(e).catch(() => []))).then(lists => {
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
    root.userData = { diameter: base ? base.w : null, centre: foot.getCenter(new THREE.Vector3()), bottom: all.min.y };
    return root;
  });
}

let renderer = null;
const ready = {}, loading = new Set();   // template key -> group, once loaded
const clones = {};                       // operative id -> its miniature
// The miniature for an operative, or null while it loads / when its side has no team.
export function unitObject(op, r) {
  renderer = r;
  const team = teamOf(op.team);
  if (!team || !team.models.length) return null;
  const model = team.models[modelIndex(op, team.models.length)];
  const key = JSON.stringify([model.base, model.parts]);
  if (!ready[key]) {
    // one redraw per model when it lands (redraws call back in here: never pile up waiters)
    if (!loading.has(key)) {
      loading.add(key);
      template(model).then(t => { ready[key] = t; loading.delete(key); for (const fn of listeners) fn(); });
    }
    return null;
  }
  // each operative keeps its clone (the table redraws on every change): only the matrix moves
  const t = ready[key];
  let obj = clones[op.id];
  if (!obj || obj.userData.key !== key) { obj = clones[op.id] = t.clone(); obj.userData = { ...t.userData, key }; }
  // fit the model's base to the ruleset's base (no base: the mod's inches), stand it on the
  // table, face the centre
  const k = t.userData.diameter ? 2 * BASE_R / t.userData.diameter : 1;
  const yaw = Math.atan2(BW / 2 - op.x, BH / 2 - op.y);   // the scans face +z once mirrored
  obj.matrixAutoUpdate = false;
  obj.matrix.makeTranslation(op.x, 0, op.y)
    .multiply(new THREE.Matrix4().makeRotationY(yaw))
    .multiply(new THREE.Matrix4().makeScale(k, k, k))
    .multiply(new THREE.Matrix4().makeTranslation(-t.userData.centre.x, -t.userData.bottom, -t.userData.centre.z));
  return obj;
}
