/**
 * The 0.1" terrain grid: rasterizing maps, composing scanned Volkus pieces, the
 * clearance (distance) map, and grid walks used by sight and climbing.
 */
import { BASE_R } from '../config.js';
import { FINE_PIECES } from '../data/fine-pieces.js';
import { VOLKUS_PIECES } from '../data/volkus-pieces.js';
import { wallSegments } from './geometry.js';
import { BH, BW, TERRAIN } from './world.js';

/* ---------- the terrain grid: one 0.1" raster drives movement, sight and cover ----------
   Every map is rasterized here: hand-made rect maps, Gallowdark, and the fine Volkus
   footprints traced from the TTS scans (walls, doorways, alcoves, upper floors). Each
   cell holds a class, a height (half-inch steps) and the terrain feature it belongs to.
   Movement uses a clearance map — distance from each point to the nearest blocking
   terrain — so a 28mm base fits wherever the clearance is at least its radius, and
   slots into any nook the models really have. Sight walks the same cells. */
export const GRES = 0.1;
export const C_FREE = 0, C_WALL = 1, C_HEAVY = 2, C_LIGHT = 3, C_STEP = 4, C_OVER = 5;
export const CLS_PRIO = [0, 5, 4, 3, 2, 1];                    // wall > heavy > light > step > overhead
export const KIND_CLS = {wall: C_WALL, heavy: C_HEAVY, light: C_LIGHT, step: C_STEP};
export const CLS_KIND = ["", "wall", "heavy", "light", "step", "overhead"];
export const zqHeight = zq => Math.max(1, Math.ceil(zq / 2 - 1e-9)); // half-inch code -> whole climbing inches
export const FREE_EPS = 1e-6;
export let G = null, FEATS = [null];
// The base radius routing works for (G.free, ptFree, segFree): the ruleset's base after
// buildClearance, the moving operative's own base while a move is planned (useBase).
export let NAV_R = BASE_R;
export function setNavRadius(r) {
  if (r === NAV_R) return;
  NAV_R = r;
  for (let k = 0; k < G.n; k++) G.free[k] = G.clear[k] >= r - FREE_EPS ? 1 : 0;
  for (const L of LEVELS) levelFree(L);
}

/* ---------- upper floors (levels) ----------
   Each overhead patch (a Volkus upper floor) is a floor an operative can climb onto and
   stand on. A level is its own walkable layer: its floor cells (the patch, plus wall tops
   flush with it) and a clearance map over its bounding box, measured to the floor's edge
   or to a wall that rises above it, so a base fits up there just as it does on the table.
   Layer 0 is the table; layer l >= 1 is LEVELS[l - 1]. clearAt, ptFree and segFree read
   the layer in LAYER (set it with setLayer / onLayer). */
export let LEVELS = [], LAYER = 0;
export function setLayer(l) { LAYER = l; }
export function onLayer(l, fn) {
  const prev = LAYER; LAYER = l;
  try { return fn(); } finally { LAYER = prev; }
}
// a layer's grid window: the whole board for the table, its bounding box for a level
export const layerBox = l => l ? LEVELS[l - 1] : {i0: 0, j0: 0, w: G.nx, h: G.ny, clear: G.clear, free: G.free};
export const layerZ = l => l ? LEVELS[l - 1].z : 0;            // standing height, inches
export const layerZq = l => l ? LEVELS[l - 1].zq : 0;
// which layer an operative standing at (x, y) with height z is on (0 when none fits)
export function layerAt(x, y, z) {
  if (!z) return 0;
  for (const L of LEVELS) if (Math.abs(L.z - z) < 0.01 && floorAt(L, x, y)) return L.l;
  return 0;
}
export function floorAt(L, x, y) {
  const i = Math.floor(x / GRES) - L.i0, j = Math.floor(y / GRES) - L.j0;
  return i >= 0 && j >= 0 && i < L.w && j < L.h && !!L.floor[j * L.w + i];
}
function levelFree(L) {
  for (let k = 0; k < L.w * L.h; k++) L.free[k] = L.clear[k] >= NAV_R - FREE_EPS ? 1 : 0;
}
// Find the levels: overhead patches (8-connected, biggest first) at their usual height,
// flooded out over overhead cells within 1" of it and solid cells whose top is within ½"
// of it. A patch mostly inside a bigger one's floor joins it.
export function buildLevels() {
  LEVELS = [];
  const {nx, ny, n, cls, zq} = G, seen = new Uint8Array(n), claim = new Int32Array(n), comps = [];
  for (let k = 0; k < n; k++) if (cls[k] === C_OVER && !seen[k]) {
    const cells = [k], hist = new Map(); seen[k] = 1;
    for (let q = 0; q < cells.length; q++) {
      const u = cells[q], i = u % nx, j = u / nx | 0;
      hist.set(zq[u], (hist.get(zq[u]) || 0) + 1);
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const v = jj * nx + ii;
        if (!seen[v] && cls[v] === C_OVER) { seen[v] = 1; cells.push(v); }
      }
    }
    if (cells.length < 80) continue;                         // under a base's area: a beam or a ledge
    let zf = 0, best = -1;
    for (const [z, c] of hist) if (c > best) { best = c; zf = z; }
    comps.push({cells, zf});
  }
  comps.sort((a, b) => b.cells.length - a.cells.length);
  for (const {cells, zf} of comps) {
    if (cells.filter(k => claim[k]).length > cells.length / 2) continue;
    const id = LEVELS.length + 1, isFloor = v => !claim[v] &&
      (cls[v] === C_OVER ? Math.abs(zq[v] - zf) <= 2 : cls[v] >= C_WALL && cls[v] <= C_LIGHT && Math.abs(zq[v] - zf) <= 1);
    const fl = cells.filter(isFloor);
    for (const k of fl) claim[k] = id;
    for (let q = 0; q < fl.length; q++) {
      const u = fl[q], i = u % nx, j = u / nx | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const v = jj * nx + ii;
        if (isFloor(v)) { claim[v] = id; fl.push(v); }
      }
    }
    let i0 = nx, j0 = ny, i1 = 0, j1 = 0;
    for (const k of fl) { const i = k % nx, j = k / nx | 0; i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j); }
    i0--; j0--; i1++; j1++;                                  // a rim of no floor round it
    const w = i1 - i0 + 1, h = j1 - j0 + 1, floor = new Uint8Array(w * h);
    for (const k of fl) floor[((k / nx | 0) - j0) * w + (k % nx) - i0] = 1;
    const clear = clearance(floor, w, h, i0, j0);
    let top = 0; for (let k = 0; k < w * h; k++) top = Math.max(top, clear[k]);
    if (top < 0.45) { for (const k of fl) claim[k] = 0; continue; }   // no base fits up there
    const f = FEATS[G.fid[cells[0]]];
    const L = {l: id, zq: zf, z: zf / 2, i0, j0, w, h, floor, clear, free: new Uint8Array(w * h),
               fid: G.fid[cells[0]], name: f ? f.id : "Upper floor", vantage: true};
    levelFree(L);
    LEVELS.push(L);
  }
}
// Control range zones (movement.planRoute sets them while a move is routed): `out` discs
// the base may not come within (centre at least r + NAV_R from it), and at most one
// `inside` disc it must stay within (centre within rOut + NAV_R, clear of the enemy's
// base rIn). Analytic, folded into clearAt, so segFree/ptFree respect them exactly.
export let ZONES = null;
export function setZones(z) { ZONES = z; }
export function zoneClear(x, y) {
  let c = 1e3;
  for (const z of ZONES.out) if ((z.l || 0) === LAYER) c = Math.min(c, Math.hypot(x - z.x, y - z.y) - z.r);
  const I = ZONES.inside;
  if (I && (I.l || 0) !== LAYER) return -1;                    // a Charge stays on its target's layer
  if (I) { const d = Math.hypot(x - I.x, y - I.y); c = Math.min(c, d - I.rIn, I.rOut + 2 * NAV_R - d); }
  return c;
}
// layer l's free cells with the zones applied (a copy; the layer's own stay terrain-only)
export function zoneFree(l = 0) {
  const B = layerBox(l), {i0: oi, j0: oj, w, h} = B, I = ZONES.inside, f = I ? new Uint8Array(w * h) : B.free.slice();
  if (I && (I.l || 0) !== l) return f;
  const fix = (x0, y0, x1, y1) => {
    const i0 = Math.max(0, Math.floor(x0 / GRES) - oi), i1 = Math.min(w - 1, Math.floor(x1 / GRES) - oi);
    const j0 = Math.max(0, Math.floor(y0 / GRES) - oj), j1 = Math.min(h - 1, Math.floor(y1 / GRES) - oj);
    onLayer(l, () => {
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const k = j * w + i;
        f[k] = B.free[k] && zoneClear((oi + i + 0.5) * GRES, (oj + j + 0.5) * GRES) >= NAV_R - FREE_EPS ? 1 : 0;
      }
    });
  };
  if (I) { const r = I.rOut + NAV_R; fix(I.x - r, I.y - r, I.x + r, I.y + r); }
  else for (const z of ZONES.out) if ((z.l || 0) === l) { const r = z.r + NAV_R; fix(z.x - r, z.y - r, z.x + r, z.y + r); }
  return f;
}
// a straight run (a climb's crossing) that keeps to the zones
export function zoneSegFree(x1, y1, x2, y2) {
  if (!ZONES) return true;
  const L = Math.hypot(x2 - x1, y2 - y1), n = Math.max(1, Math.ceil(L / 0.05));
  for (let s = 0; s <= n; s++) if (zoneClear(x1 + (x2 - x1) * s / n, y1 + (y2 - y1) * s / n) < NAV_R - FREE_EPS) return false;
  return true;
}
export function newGrid() {
  const nx = Math.ceil(BW / GRES - 1e-9), ny = Math.ceil(BH / GRES - 1e-9), n = nx * ny;
  G = {nx, ny, n, cls: new Uint8Array(n), zq: new Uint8Array(n), fid: new Int32Array(n),
       src: new Uint8Array(n), clear: new Float32Array(n), free: new Uint8Array(n)};
}
export function gridPut(k, c, zq, fid, src) {
  const cur = G.cls[k];
  if (CLS_PRIO[c] > CLS_PRIO[cur] || (c === cur && zq > G.zq[k])) {
    G.cls[k] = c; G.zq[k] = zq; G.fid[k] = fid; G.src[k] = src;
  }
}
// rect maps: each TERRAIN rect (walls per height section) fills the cells it covers
export function rasterizeRects() {
  FEATS = [null];
  for (const t of TERRAIN) {
    const fid = FEATS.length; FEATS.push(t);
    const c = KIND_CLS[t.kind] || C_WALL;
    for (const s of (t.kind === "wall" ? wallSegments(t) : [t])) {
      const zq = Math.min(15, Math.round((s.z || t.z || 1) * 2));
      const i0 = Math.max(0, Math.round(s.x / GRES)), j0 = Math.max(0, Math.round(s.y / GRES));
      const i1 = Math.min(G.nx, Math.max(i0 + 1, Math.round((s.x + s.w) / GRES)));
      const j1 = Math.min(G.ny, Math.max(j0 + 1, Math.round((s.y + s.h) / GRES)));
      for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) gridPut(j * G.nx + i, c, zq, fid, 0);
    }
  }
}
// fine maps: each placed piece's local raster (traced from its scan) is mapped onto the
// board by inverse rotation — exact for any angle. Rubble bundles use their card templates.
export const FINE_CACHE = {};
export function fineCodes(k) {
  if (FINE_CACHE[k]) return FINE_CACHE[k];
  const [, , , nx, nz, rle] = FINE_PIECES[k], bin = atob(rle), out = new Uint8Array(nx * nz);
  for (let i = 0, p = 0; i < bin.length; i += 2) { const r = bin.charCodeAt(i + 1); out.fill(bin.charCodeAt(i), p, p + r); p += r; }
  return FINE_CACHE[k] = out;
}
export function composeFine(place) {
  FEATS = [null];
  const count = {};
  for (const p of place) {
    const fine = FINE_PIECES[p.k], tpl = VOLKUS_PIECES.templates[p.k];
    if (!fine && !tpl) continue;
    const base = VOLKUS_PIECES.names[p.k] || (tpl[4] === "heavy" ? "Heavy rubble" : tpl[4] === "light" ? "Light rubble" : "Fire step");
    count[base] = (count[base] || 0) + 1;
    const fid = FEATS.length;
    FEATS.push({id: `${base} ${count[base]}`, kind: tpl ? tpl[4] : "wall", piece: p.k});
    const r = p.a * Math.PI / 180, ca = Math.cos(r), sa = Math.sin(r);
    let eff = 1, lx0, lz0, lx1, lz1;
    if (fine) {
      eff = p.s / fine[0];
      lx0 = fine[1] * eff; lz0 = fine[2] * eff;
      lx1 = (fine[1] + fine[3] * GRES) * eff; lz1 = (fine[2] + fine[4] * GRES) * eff;
    } else {
      const [tw, th, cx, cz] = tpl;
      lx0 = (cx - tw / 2) * p.s; lx1 = (cx + tw / 2) * p.s; lz0 = (cz - th / 2) * p.s; lz1 = (cz + th / 2) * p.s;
    }
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const [u, v] of [[lx0, lz0], [lx1, lz0], [lx0, lz1], [lx1, lz1]]) {
      const X = p.x + u * ca + v * sa, Y = p.y - u * sa + v * ca;   // R(a), as in the importer
      bx0 = Math.min(bx0, X); bx1 = Math.max(bx1, X); by0 = Math.min(by0, Y); by1 = Math.max(by1, Y);
    }
    const i0 = Math.max(0, Math.floor(bx0 / GRES)), i1 = Math.min(G.nx - 1, Math.floor(bx1 / GRES));
    const j0 = Math.max(0, Math.floor(by0 / GRES)), j1 = Math.min(G.ny - 1, Math.floor(by1 / GRES));
    const codes = fine ? fineCodes(p.k) : null;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = (i + 0.5) * GRES - p.x, dy = (j + 0.5) * GRES - p.y;
      const lx = dx * ca - dy * sa, lz = dx * sa + dy * ca;            // R(-a): board -> piece frame
      let c, zq;
      if (fine) {
        const ix = Math.floor((lx / eff - fine[1]) / GRES), iz = Math.floor((lz / eff - fine[2]) / GRES);
        if (ix < 0 || iz < 0 || ix >= fine[3] || iz >= fine[4]) continue;
        const code = codes[iz * fine[3] + ix];
        c = code >> 4; zq = code & 15;
        if (!c) continue;
      } else {
        const [tw, th, cx, cz, kind, z] = tpl;
        if (Math.abs(lx / p.s - cx) > tw / 2 || Math.abs(lz / p.s - cz) > th / 2) continue;
        c = KIND_CLS[kind]; zq = z * 2;
      }
      gridPut(j * G.nx + i, c, zq, fid, fine ? 1 : 0);
    }
  }
}
// Draw lists for a fine map: greedy rectangles over runs of cells with the same class,
// climbing height and source (scanned mesh or template, so the 3D view knows which
// footprints its meshes already show).
export function deriveFineLists() {
  const {nx, ny, n, cls, zq, src} = G;
  const gid = new Int32Array(n).fill(-1), groups = [], gk = new Map();
  for (let k = 0; k < n; k++) {
    const c = cls[k]; if (!c) continue;
    const Z = c === C_OVER || c === C_STEP ? 0 : zqHeight(zq[k]);
    const key = c * 1000 + Z * 10 + src[k];
    let g = gk.get(key);
    if (g === undefined) { g = groups.length; groups.push({c, Z, src: src[k]}); gk.set(key, g); }
    gid[k] = g;
  }
  const used = new Uint8Array(n);
  const terrain = [], decor = [], overhead = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, g0 = gid[k];
    if (g0 < 0 || used[k]) continue;
    let w = 1; while (i + w < nx && gid[k + w] === g0 && !used[k + w]) w++;
    let h = 1;
    grow: while (j + h < ny) {
      for (let d = 0; d < w; d++) { const q = (j + h) * nx + i + d; if (gid[q] !== g0 || used[q]) break grow; }
      h++;
    }
    for (let dj = 0; dj < h; dj++) used.fill(1, (j + dj) * nx + i, (j + dj) * nx + i + w);
    const gr = groups[g0];
    const r = {id: "F" + (terrain.length + decor.length + overhead.length), kind: CLS_KIND[gr.c], z: gr.Z,
               x: +(i * GRES).toFixed(2), y: +(j * GRES).toFixed(2), w: +(w * GRES).toFixed(2), h: +(h * GRES).toFixed(2), fine: 1};
    if (gr.src) r.m = 1;
    (gr.c === C_OVER ? overhead : gr.c === C_STEP ? decor : terrain).push(r);
  }
  return {terrain, decor, overhead};
}
// Clearance: exact Euclidean distance transform (Felzenszwalb & Huttenlocher) from every
// cell centre to the nearest blocking cell, less half a cell to reach its edge; capped
// by the board edges.
export function edt1d(f, d, v, z, len) {
  let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < len; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
}
// Exact distance (inches) from every cell centre of a w x h window at cell (i0, j0) to the
// nearest cell that isn't `open`, less half a cell to reach its edge; capped by the
// board edges.
export function clearance(open, w, h, i0, j0) {
  const INF = 1e10, n = w * h, f = new Float64Array(n), out = new Float32Array(n);
  for (let k = 0; k < n; k++) f[k] = open[k] ? INF : 0;
  const m = Math.max(w, h), a = new Float64Array(m), b = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < h; j++) a[j] = f[j * w + i];
    edt1d(a, b, v, z, h);
    for (let j = 0; j < h; j++) f[j * w + i] = b[j];
  }
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) a[i] = f[j * w + i];
    edt1d(a, b, v, z, w);
    for (let i = 0; i < w; i++) f[j * w + i] = b[i];
  }
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i, x = (i0 + i + 0.5) * GRES, y = (j0 + j + 0.5) * GRES;
    const d = f[k] >= INF / 2 ? 1e3 : Math.sqrt(f[k]) * GRES - GRES / 2;
    out[k] = Math.min(d, x, BW - x, y, BH - y);
  }
  return out;
}
// A scanned cell blocks if the model touches it anywhere, so its traced edge sits on
// average half a cell outside the real wall: bases measure to the middle of it instead,
// and press flush against the model rather than stopping ~0.05" short.
export const SCAN_SLACK = GRES / 2;
export function buildClearance() {
  const {n, cls, src} = G, open = new Uint8Array(n), scan = new Uint8Array(n);
  let scanned = false;
  for (let k = 0; k < n; k++) {
    const b = cls[k] >= 1 && cls[k] <= 3;
    open[k] = b && !src[k] ? 0 : 1;
    scan[k] = b && src[k] ? 0 : 1;
    if (b && src[k]) scanned = true;
  }
  const c = clearance(open, G.nx, G.ny, 0, 0);
  if (scanned) {
    const cs = clearance(scan, G.nx, G.ny, 0, 0);
    for (let k = 0; k < n; k++) {
      const x = (k % G.nx + 0.5) * GRES, y = ((k / G.nx | 0) + 0.5) * GRES;
      c[k] = Math.min(c[k], cs[k] + SCAN_SLACK, x, BW - x, y, BH - y);
    }
  }
  G.clear.set(c);
  for (let k = 0; k < n; k++) G.free[k] = G.clear[k] >= BASE_R - FREE_EPS ? 1 : 0;
  NAV_R = BASE_R; ZONES = null; LAYER = 0; LEVELS = [];
}
// clearance at any point: bilinear over cell centres, board edges exact
export function clearAt(x, y) {
  const L = LAYER ? LEVELS[LAYER - 1] : null;
  const oi = L ? L.i0 : 0, oj = L ? L.j0 : 0, nx = L ? L.w : G.nx, ny = L ? L.h : G.ny, clear = L ? L.clear : G.clear;
  const u = x / GRES - 0.5 - oi, v = y / GRES - 0.5 - oj, i = Math.floor(u), j = Math.floor(v), fx = u - i, fy = v - j;
  const i0 = i < 0 ? 0 : i >= nx ? nx - 1 : i, i1 = i + 1 < 0 ? 0 : i + 1 >= nx ? nx - 1 : i + 1;
  const j0 = j < 0 ? 0 : j >= ny ? ny - 1 : j, j1 = j + 1 < 0 ? 0 : j + 1 >= ny ? ny - 1 : j + 1;
  const val = (clear[j0 * nx + i0] * (1 - fx) + clear[j0 * nx + i1] * fx) * (1 - fy)
            + (clear[j1 * nx + i0] * (1 - fx) + clear[j1 * nx + i1] * fx) * fy;
  const c = Math.min(val, x, BW - x, y, BH - y);
  return ZONES ? Math.min(c, zoneClear(x, y)) : c;
}
export function ptFree(x, y) { return clearAt(x, y) >= NAV_R - FREE_EPS; }
// A base sliding along a segment never overlaps blocking terrain. Sphere-traced: the
// clearance says how far it can safely advance, so open ground costs a handful of
// lookups. tol lets a base that starts a hair too tight (placed by hand) ease out.
export function segFree(x1, y1, x2, y2, tol) {
  const L = Math.hypot(x2 - x1, y2 - y1), ux = L > 0 ? (x2 - x1) / L : 0, uy = L > 0 ? (y2 - y1) / L : 0;
  for (let t = 0, n = 0; n < 4000; n++) {
    let c = clearAt(x1 + ux * t, y1 + uy * t) - NAV_R;
    if (tol && t < 0.35) c += tol * (1 - t / 0.35);
    if (c < -FREE_EPS) return false;
    if (t >= L) return true;
    t = Math.min(L, t + Math.max(0.03, c));
  }
  return false;
}
export function startTol(x, y) { const c = clearAt(x, y); return c >= NAV_R - FREE_EPS ? 0 : NAV_R - c + 0.02; }
// Walk the cells a segment passes through (Amanatides & Woo). visit(k, tEnter) returns
// true to stop; gridWalk then returns true.
export function gridWalk(x1, y1, x2, y2, visit) {
  const nx = G.nx, ny = G.ny, dx = x2 - x1, dy = y2 - y1;
  let i = Math.floor(x1 / GRES), j = Math.floor(y1 / GRES);
  const ie = Math.floor(x2 / GRES), je = Math.floor(y2 / GRES);
  const si = dx > 0 ? 1 : dx < 0 ? -1 : 0, sj = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tdx = si ? GRES / Math.abs(dx) : Infinity, tdy = sj ? GRES / Math.abs(dy) : Infinity;
  let tmx = si > 0 ? ((i + 1) * GRES - x1) / dx : si < 0 ? (i * GRES - x1) / dx : Infinity;
  let tmy = sj > 0 ? ((j + 1) * GRES - y1) / dy : sj < 0 ? (j * GRES - y1) / dy : Infinity;
  let t = 0;
  for (let n = 0; n < 4000; n++) {
    if (i >= 0 && j >= 0 && i < nx && j < ny && visit(j * nx + i, t)) return true;
    if (i === ie && j === je) return false;
    if (tmx < tmy) { if (tmx > 1) return false; t = tmx; tmx += tdx; i += si; }
    else { if (tmy > 1) return false; t = tmy; tmy += tdy; j += sj; }
  }
  return false;
}
