/* global THREE */
/**
 * Idle motion for the miniatures: they breathe and shift their weight a little, so a
 * squad standing on the table looks ready rather than frozen. The scans are single
 * posed sculpts with no skeleton, so there's no rig: each vertex gets a small
 * displacement field from how high it sits on the model, computed once when the model
 * loads (`idleFields`, a pass over its vertices), and the vertex shader plays it.
 *
 * - breathing: a band round the chest swells outward and the shoulders and head rise
 * - leaning: the body above the knees tilts forward/back and side to side round a pivot
 *   just above the feet, on slower waves that never line up
 *
 * Feet and base stay put. Everything is a fraction of the model's height, so it reads
 * the same on any scale. The shadow map keeps the rest pose (it isn't redrawn per frame;
 * the motion is too small to show in it). Only the picture moves: the rules use the grid.
 */

// amplitudes, as fractions of the model's height (lean and side in radians)
export const BREATH_OUT = 0.05, BREATH_REACH = 0.18, BREATH_UP = 0.009, LEAN = 0.015, SIDE = 0.010;

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// 3x3 inverse of a column-major 4x4's linear part (row-major result, for d_local = Minv · d)
function inv3(M) {
  const a = M[0], b = M[4], c = M[8], d = M[1], e = M[5], f = M[9], g = M[2], h = M[6], i = M[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  if (!det) return null;
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
          B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
          C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}

/**
 * The idle displacement of each vertex of one mesh, in the mesh's own space.
 * pos: its positions (x,y,z…); M: the mesh's matrix into the model's frame (column-major
 * 16, as THREE.Matrix4.elements); f: the model's frame, y up, facing +z — {x, z} the centre
 * of its foot, `foot` the height its feet stand on, `H` its height above that.
 * Returns {breath, lean, side} (Float32Arrays, 3 per vertex: the displacement at a full
 * breath / one radian of lean scaled by LEAN / SIDE) and `reach`, the furthest a vertex
 * can move, or null if nothing on it moves.
 */
export function idleFields(pos, M, f) {
  const n = pos.length / 3, Mi = inv3(M), H = f.H;
  if (!Mi || !(H > 0)) return null;
  const breath = new Float32Array(n * 3), lean = new Float32Array(n * 3), side = new Float32Array(n * 3);
  const py = f.foot + 0.1 * H, reach = BREATH_REACH * H;   // lean pivot: just above the feet
  let any = false;
  const put = (out, j, dx, dy, dz) => {   // a displacement in the model's frame, back into the mesh's
    out[j] = Mi[0] * dx + Mi[1] * dy + Mi[2] * dz;
    out[j + 1] = Mi[3] * dx + Mi[4] * dy + Mi[5] * dz;
    out[j + 2] = Mi[6] * dx + Mi[7] * dy + Mi[8] * dz;
  };
  for (let v = 0, j = 0; v < n; v++, j += 3) {
    const lx = pos[j], ly = pos[j + 1], lz = pos[j + 2];
    const x = M[0] * lx + M[4] * ly + M[8] * lz + M[12];
    const y = M[1] * lx + M[5] * ly + M[9] * lz + M[13];
    const z = M[2] * lx + M[6] * ly + M[10] * lz + M[14];
    const h = (y - f.foot) / H;
    const wl = smooth(0.08, 0.7, h);                                // legs planted, torso up rigid
    if (!wl) continue;
    any = true;
    const wc = smooth(0.42, 0.6, h) * (1 - smooth(0.74, 0.92, h));  // the chest band
    const wu = smooth(0.5, 0.78, h);                                // shoulders, head, what's held up
    const dx = x - f.x, dz = z - f.z, r = Math.hypot(dx, dz);
    // outward from the centre line, capped so arms and guns held out move rigidly, not stretch
    const out = r > 1e-6 ? wc * BREATH_OUT * Math.min(r, reach) / r : 0;
    put(breath, j, dx * out, wu * BREATH_UP * H, dz * out);
    const ry = y - py, k = wl;
    put(lean, j, 0, -dz * k * LEAN, ry * k * LEAN);   // about the x axis: forward and back
    put(side, j, -ry * k * SIDE, dx * k * SIDE, 0);   // about the z axis: side to side
  }
  if (!any) return null;
  // the furthest any vertex can move (the shader's lean wave peaks at 1.3)
  let most = 0;
  for (let j = 0; j < n * 3; j += 3)
    most = Math.max(most, Math.hypot(breath[j], breath[j + 1], breath[j + 2])
      + 1.3 * Math.hypot(lean[j], lean[j + 1], lean[j + 2]) + Math.hypot(side[j], side[j + 1], side[j + 2]));
  return { breath, lean, side, reach: most };
}

// shared by every miniature: the clock (seconds) and the switch (0 still, 1 moving)
export const IDLE = { t: { value: 0 }, on: { value: 1 } };

// A copy of the geometry (sharing its buffers) carrying the fields as attributes.
export function idleGeometry(g, fields) {
  const out = new THREE.BufferGeometry();
  for (const k in g.attributes) out.setAttribute(k, g.attributes[k]);
  out.setIndex(g.index);
  for (const gr of g.groups) out.addGroup(gr.start, gr.count, gr.materialIndex);
  out.boundingSphere = g.boundingSphere && g.boundingSphere.clone();
  if (out.boundingSphere) out.boundingSphere.radius += fields.reach;   // never culled while it shows
  out.setAttribute("aBreath", new THREE.BufferAttribute(fields.breath, 3));
  out.setAttribute("aLean", new THREE.BufferAttribute(fields.lean, 3));
  out.setAttribute("aSide", new THREE.BufferAttribute(fields.side, 3));
  out.userData.idle = true;
  return out;
}

// one breath every ~4.2 s; the leans on 7.3 s (with a 3.1 s ripple) and 9.7 s waves
function patch(shader) {
  Object.assign(shader.uniforms, { uIdleT: IDLE.t, uIdleOn: IDLE.on, uIdlePhase: this.userData.idlePhase });
  shader.vertexShader = "attribute vec3 aBreath;\nattribute vec3 aLean;\nattribute vec3 aSide;\n"
    + "uniform float uIdleT;\nuniform float uIdleOn;\nuniform float uIdlePhase;\n"
    + shader.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>
  float iT = uIdleT + uIdlePhase;
  float iB = 0.5 - 0.5 * cos(iT * 1.496);
  float iL = sin(iT * 0.861) + 0.3 * sin(iT * 2.027 + 1.3);
  float iS = sin(iT * 0.648 + 2.0);
  transformed += uIdleOn * (aBreath * iB + aLean * iL + aSide * iS);`);
}
// Each operative's miniature gets its own copies of the moving parts' materials (textures
// shared), so it can breathe at its own time: `phase` seconds into the cycle.
export function idleClone(obj, phase) {
  const ph = { value: phase };
  obj.traverse(m => {
    if (!m.isMesh || !m.geometry.userData.idle) return;
    const mat = m.material.clone();
    mat.userData.idlePhase = ph;
    mat.onBeforeCompile = patch;
    m.material = mat;
  });
}
// a steady phase per operative (from its id), spread over a minute
export function idlePhase(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 6000) / 100;
}
