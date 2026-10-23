/* global THREE */
/**
 * Base rings for the 3D table: a thin see-through ring at the base edge, out to control
 * range, in a choice of styles to try (the toolbar's Ready / Active pickers). Each ring is
 * one flat disc clipped to the terrain round the base (a star polygon, ray-marched over
 * the grid), so the range shading stops where it meets a wall; a shader draws the rest.
 * Animated styles keep the 3D view rendering every frame while any is on the table.
 */
import { CTRL } from '../config.js';
import { BH, BW } from '../engine/world.js';
import { G, GRES } from '../engine/grid.js';

export const READY_STYLES = [
  ["classic", "Classic band"],
  ["thin", "Thin + range"],
  ["ripple", "Ripple"],
  ["breathe", "Breathe"],
  ["sonar", "Sonar sweep"],
];
export const ACTIVE_STYLES = [
  ["none", "Same as ready"],
  ["spin", "Spinning dashes"],
  ["glow", "Pulsing glow"],
  ["comet", "Orbiting comet"],
  ["spinglow", "Dashes + glow"],
];
const PREF = "skirmishtable.rings";
export const ringStyle = {ready: "ripple", active: "spinglow"};
try { Object.assign(ringStyle, JSON.parse(localStorage.getItem(PREF)) || {}); } catch (e) {}
export function setRingStyle(k, v) {
  ringStyle[k] = v;
  try { localStorage.setItem(PREF, JSON.stringify(ringStyle)); } catch (e) {}
}
const RI = Object.fromEntries(READY_STYLES.map(([k], i) => [k, i]));
const AI = Object.fromEntries(ACTIVE_STYLES.map(([k], i) => [k, i]));
// does this pick animate? (the classic band and the thin ring sit still)
export const animates = (ready, active) => (ready && RI[ringStyle.ready] >= 2) || (active && AI[ringStyle.active] >= 1);

// one clock for every ring material
export const RING_T = {value: 0};

// How far the ring may reach from (x, y) at each angle before it meets blocking terrain
// (walls, heavy, light) or the table edge, as a disc geometry. Cached per position (shared,
// so clearGroup leaves it alone); reset when the map changes.
const N = 120, MARGIN = 0.25;
let discG = null;
const discCache = new Map();
function dropDiscs() { for (const g of discCache.values()) g.dispose(); discCache.clear(); }
function clippedDisc(x, y, BR) {
  if (discG !== G) { dropDiscs(); discG = G; }
  const key = `${x.toFixed(3)},${y.toFixed(3)},${BR},${CTRL}`;
  let g = discCache.get(key);
  if (g) return g;
  const max = BR + CTRL + MARGIN, {nx, ny, cls} = G, out = new Float32Array(N);
  for (let a = 0; a < N; a++) {
    const th = a / N * Math.PI * 2, ux = Math.cos(th), uy = Math.sin(th);
    let t = BR;
    for (; t < max; t += 0.04) {
      const px = x + ux * t, py = y + uy * t;
      if (px < 0 || py < 0 || px > BW || py > BH) break;
      const i = Math.floor(px / GRES), j = Math.floor(py / GRES);
      if (i < 0 || j < 0 || i >= nx || j >= ny) break;
      const c = cls[j * nx + i];
      if (c >= 1 && c <= 3) break;
    }
    out[a] = Math.max(BR + 0.07, Math.min(max, t)); // the base-edge line always shows
  }
  if (discCache.size > 400) dropDiscs();
  g = discGeometry(out);
  g.userData.shared = true;
  discCache.set(key, g);
  return g;
}
// the clipped disc: a fan round the centre, local x/y = table x/y offsets
function discGeometry(r) {
  const pos = new Float32Array((N + 1) * 3), idx = [];
  for (let a = 0; a < N; a++) {
    const th = a / N * Math.PI * 2;
    pos[(a + 1) * 3] = Math.cos(th) * r[a];
    pos[(a + 1) * 3 + 2] = Math.sin(th) * r[a];
    idx.push(0, a + 1, (a + 1) % N + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

const VERT = `
varying vec2 vP;
void main() {
  vP = position.xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
// e = distance out from the base edge; uCtrl = control range from that edge
const FRAG = `
uniform float uT, uBR, uCtrl;
uniform vec3 uCol;
uniform int uReady, uActive;
varying vec2 vP;
const float PI = 3.14159265;
float band(float d, float w, float aa) { return 1.0 - smoothstep(w, w + aa, abs(d)); }
void main() {
  float r = length(vP), e = r - uBR, aa = max(fwidth(r), 0.004);
  if (e < -0.03) discard;
  float th = atan(vP.y, vP.x), u = th / (2.0 * PI) + 0.5;
  float t = uT;
  float inside = 1.0 - smoothstep(uCtrl - aa, uCtrl + aa, e);
  float a = 0.0; vec3 col = uCol;
  // every style but the classic band: the thin line at the base edge
  if (uReady != 0) a = max(a, 0.9 * band(e - 0.015, 0.012, aa));
  if (uReady == 1) {            // thin: faint range fill and a fine range line
    a = max(a, 0.09 * inside);
    a = max(a, 0.45 * band(e - uCtrl, 0.008, aa));
  } else if (uReady == 2) {     // ripple: a wave rolls out to control range and fades
    float p = fract(t / 2.2);
    float w = band(e - p * uCtrl, 0.03, aa * 2.0) * pow(1.0 - p, 1.4) * smoothstep(0.0, 0.08, p);
    a = max(a, 0.05 * inside);
    a = max(a, 0.75 * w * inside);
    a = max(a, 0.22 * band(e - uCtrl, 0.006, aa));
  } else if (uReady == 3) {     // breathe: the range fill swells and settles
    float b = 0.5 + 0.5 * sin(t * 2.0);
    a = max(a, (0.04 + 0.12 * b) * inside * (1.0 - 0.6 * e / uCtrl));
    a = max(a, (0.2 + 0.3 * b) * band(e - uCtrl, 0.008, aa));
  } else if (uReady == 4) {     // sonar: a beam sweeps the range, leaving a fading wake
    float d = fract(u - t * 0.25);
    a = max(a, 0.04 * inside);
    a = max(a, 0.32 * pow(1.0 - d, 6.0) * inside);
    a = max(a, 0.3 * band(e - uCtrl, 0.007, aa));
  }
  if (uActive == 1 || uActive == 4) {   // spinning dashes just outside the base
    float dash = smoothstep(0.42, 0.48, fract(u * 14.0 - t * 0.9)) * (1.0 - smoothstep(0.88, 0.94, fract(u * 14.0 - t * 0.9)));
    float m = band(e - 0.1, 0.045, aa) * dash;
    a = max(a, m); col = mix(col, vec3(1.0), 0.3 * m);
  }
  if (uActive == 2 || uActive == 4) {   // a soft glow hugging the base, pulsing
    float pulse = 0.65 + 0.35 * sin(t * 3.5);
    float g = exp(-max(e, 0.0) / 0.2) * pulse;
    a = max(a, 0.8 * g); col = mix(col, vec3(1.0), 0.3 * g);
  }
  if (uActive == 3) {                   // a comet orbiting the base with a long tail
    float d = fract(u - t * 0.6);
    float tail = pow(1.0 - d, 5.0);
    float m = band(e - 0.1, 0.05, aa) * tail;
    float g = exp(-max(e, 0.0) / 0.16) * (0.25 + 0.5 * tail);
    a = max(a, max(m, 0.6 * g)); col = mix(col, vec3(1.0), 0.5 * m);
  }
  if (a < 0.003) discard;
  gl_FragColor = linearToOutputTexel(vec4(col, a));
}`;

// Materials are shared per (colour, ready, active, base): the base radius and range go in uniforms.
const mats = {};
function ringMat(col, ready, active, BR) {
  const k = `${col.getHexString()}|${ready}|${active}|${BR}|${CTRL}`;
  if (!mats[k]) {
    mats[k] = new THREE.ShaderMaterial({
      uniforms: {uT: RING_T, uBR: {value: BR}, uCtrl: {value: CTRL}, uCol: {value: col.clone()},
        uReady: {value: ready}, uActive: {value: active}},
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      extensions: {derivatives: true},
    });
    mats[k].userData.shared = true;
  }
  return mats[k];
}
export const classicBand = () => ringStyle.ready === "classic";
// The ring under an operative (null when the classic band, which table3d draws, is all).
// col: linear THREE.Color; ready / active: whether the picked styles apply (a spent
// operative gets only the plain base line).
export function baseRing(op, BR, col, ready, active) {
  const rs = RI[ringStyle.ready] || 0, as = active ? AI[ringStyle.active] || 0 : 0;
  if (rs === 0 && as === 0) return null;
  const m = new THREE.Mesh(clippedDisc(op.x, op.y, BR), ringMat(col, rs === 0 ? 0 : ready ? rs : -1, as, BR));
  m.position.set(op.x, 0.035, op.y);
  m.renderOrder = 1;
  return m;
}
