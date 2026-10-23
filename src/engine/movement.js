/**
 * Movement: climb rules, climb portals, the Lazy Theta* route field, whole-inch
 * increment optimisation, and the helpers that clamp and chop a route.
 */
import { CTRL } from '../config.js';
import { dist, opR } from './geometry.js';
import { C_LIGHT, C_WALL, FEATS, G, GRES, NAV_R, ZONES, gridWalk, ptFree, segFree, setNavRadius, setZones, startTol,
         zoneFree, zoneSegFree, zqHeight } from './grid.js';
import { BH, BW, OPS } from './world.js';
import { RULES, legCost } from '../rules/index.js';

// what stops a base (the nav radius: see useBase) landing at (x, y)
export function placeBlocked(x, y, excludeId) {
  const R = NAV_R;
  if (x<R-1e-9||x>BW-R+1e-9||y<R-1e-9||y>BH-R+1e-9) return {id:"board edge"};
  if (!ptFree(x, y)) return {id:"terrain"};
  for (const o of OPS) if (o.alive && o.id !== excludeId && dist(x,y,o.x,o.y) < R + opR(o)) return {id:o.name};
  return null;
}

/* ---------- auto-pathing on the grid ----------
   Any-angle search (Lazy Theta*) over the free cells, from the operative outwards,
   once per drag and plan; each pointer move then just reads the route to the cursor.
   Climbs are "portals": pairs of free points either side of climbable terrain, found
   by scanning straight across it in four directions. Crossing one costs the distance
   across PLUS the vertical, priced by the ruleset (Kill Team: up the terrain's height,
   at least 2", and back down past the free 2"). It's only usable while the inches being
   spent belong to a move action the ruleset lets climb (Kill Team: Reposition or
   Charge, never Dash). noclimb terrain (Gallowdark bulkheads) never is. */
export const climbUp = h => RULES.climbUp(h);
export const climbDown = h => RULES.climbDown(h);
export const climbCost = h => h > 0 ? climbUp(h) + climbDown(h) : 0;   // walking legs: no climb, no cost
export let PORTALS = [], EPX = new Float64Array(0), EPY = new Float64Array(0), EP_CELLS = [], CELL_SP = new Map(), NAVVER = 0;
export const FIELDS = new Map();
const NAVS = new Map();               // base radius -> its portals (a bigger base needs wider gaps)
// Tallest terrain a base passes over on a straight crossing (its middle and both
// flanks); Infinity if any of it can't be climbed.
export function crossingHeight(ax, ay, bx, by) {
  const L = dist(ax, ay, bx, by); if (L < 1e-9) return 0;
  const f = NAV_R * 0.82;                      // the base's flanks
  const qx = -(by - ay) / L * f, qy = (bx - ax) / L * f;
  let zq = 0, bad = false;
  for (const s of [0, -1, 1]) {
    gridWalk(ax + qx * s, ay + qy * s, bx + qx * s, by + qy * s, k => {
      const c = G.cls[k];
      if (c < C_WALL || c > C_LIGHT) return false;
      const f = FEATS[G.fid[k]];
      if (f && f.noclimb) { bad = true; return true; }
      if (G.zq[k] > zq) zq = G.zq[k];
      return false;
    });
    if (bad) return Infinity;
  }
  return zq ? zqHeight(zq) : 0;
}
export function findPortals() {
  PORTALS = [];
  const MAX_ACROSS = 5, STEP = 0.05, SPACING = 0.5, NEAR = 0.45, buckets = new Map();
  const bk = (x, y) => (Math.floor(x) + 2) * 64 + Math.floor(y) + 2;
  const dup = (ax, ay, bx, by) => {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const l = buckets.get(bk(ax + dx, ay + dy)); if (!l) continue;
      for (const P of l)
        if ((Math.hypot(P.ax - ax, P.ay - ay) < NEAR && Math.hypot(P.bx - bx, P.by - by) < NEAR) ||
            (Math.hypot(P.ax - bx, P.ay - by) < NEAR && Math.hypot(P.bx - ax, P.by - ay) < NEAR)) return true;
    }
    return false;
  };
  const add = (ax, ay, bx, by) => {
    const len = Math.hypot(bx - ax, by - ay);
    if (len > MAX_ACROSS) return;
    const z = crossingHeight(ax, ay, bx, by);
    if (!isFinite(z) || z <= 0 || dup(ax, ay, bx, by)) return;
    const P = {ax, ay, bx, by, z, len};
    PORTALS.push(P);
    for (const [x, y] of [[ax, ay], [bx, by]]) {
      const key = bk(x, y); let l = buckets.get(key); if (!l) buckets.set(key, l = []); l.push(P);
    }
  };
  const C = [[0, 0], [BW, 0], [0, BH], [BW, BH]];
  for (const [dx, dy] of [[1, 0], [0, 1], [Math.SQRT1_2, Math.SQRT1_2], [Math.SQRT1_2, -Math.SQRT1_2]]) {
    const qx = -dy, qy = dx;
    const os = C.map(c => c[0] * qx + c[1] * qy), ss = C.map(c => c[0] * dx + c[1] * dy);
    const o1 = Math.max(...os), s0 = Math.min(...ss), s1 = Math.max(...ss);
    for (let o = Math.min(...os) + SPACING / 2; o < o1; o += SPACING) {
      let lx = 0, ly = 0, have = false, inside = false;
      for (let s = s0; s <= s1; s += STEP) {
        const x = dx * s + qx * o, y = dy * s + qy * o;
        if (x < 0 || y < 0 || x > BW || y > BH) { have = false; inside = false; continue; }
        if (ptFree(x, y)) {
          if (inside && have) add(lx, ly, x, y);
          lx = x; ly = y; have = true; inside = false;
        } else {
          inside = true;
          if (have && Math.hypot(x - lx, y - ly) > MAX_ACROSS) have = false;
        }
      }
    }
  }
}
// free cells near a point that a base can slide to in a straight line
export function attachCells(x, y, radii, tol, free = G.free) {
  for (const r of radii) {
    const out = [], ri = Math.ceil(r / GRES), ci = Math.floor(x / GRES), cj = Math.floor(y / GRES);
    for (let j = Math.max(0, cj - ri); j <= Math.min(G.ny - 1, cj + ri); j++)
      for (let i = Math.max(0, ci - ri); i <= Math.min(G.nx - 1, ci + ri); i++) {
        const k = j * G.nx + i;
        if (!free[k]) continue;
        const cx = (i + 0.5) * GRES, cy = (j + 0.5) * GRES;
        if (dist(x, y, cx, cy) <= r && segFree(x, y, cx, cy, tol)) out.push(k);
      }
    if (out.length) return out;
  }
  return [];
}
// A new map: drop every base size's portals and build the ruleset base's.
export function buildNav() { NAVS.clear(); FIELDS.clear(); NAVVER++; navFor(NAV_R); }
// Plan for a base of radius r (an operative's own base, opR(op)): route over its free
// cells and through its portals, built the first time that size moves on this map.
export function useBase(r) {
  setNavRadius(r);
  const N = NAVS.get(r);
  if (N) ({PORTALS, EPX, EPY, EP_CELLS, CELL_SP} = N);
  else navFor(r);
}
function navFor(r) {
  findPortals();
  const NE = PORTALS.length * 2, NC = G.n;
  EPX = new Float64Array(NE); EPY = new Float64Array(NE); EP_CELLS = []; CELL_SP = new Map();
  PORTALS.forEach((P, p) => { EPX[2 * p] = P.ax; EPY[2 * p] = P.ay; EPX[2 * p + 1] = P.bx; EPY[2 * p + 1] = P.by; });
  for (let e = 0; e < NE; e++) {
    const cells = attachCells(EPX[e], EPY[e], [0.3, 0.6], 0);
    EP_CELLS.push(cells);
    for (const k of cells) { let l = CELL_SP.get(k); if (!l) CELL_SP.set(k, l = []); l.push(NC + 1 + e); }
  }
  NAVS.set(r, {PORTALS, EPX, EPY, EP_CELLS, CELL_SP});
}
export function Heap() { this.k = []; this.v = []; this.top = 0; }
Heap.prototype.push = function(key, val) {
  const K = this.k, V = this.v; let i = K.length; K.push(key); V.push(val);
  while (i > 0) { const p = (i - 1) >> 1; if (K[p] <= key) break; K[i] = K[p]; V[i] = V[p]; i = p; }
  K[i] = key; V[i] = val;
};
Heap.prototype.pop = function() {
  const K = this.k, V = this.v, tk = K[0], tv = V[0], lk = K.pop(), lv = V.pop(), n = K.length;
  if (n) {
    let i = 0;
    for (;;) { let l = 2 * i + 1; if (l >= n) break; if (l + 1 < n && K[l + 1] < K[l]) l++; if (K[l] >= lk) break; K[i] = K[l]; V[i] = V[l]; i = l; }
    K[i] = lk; V[i] = lv;
  }
  this.top = tk; return tv;
};
// Shortest-route field from (sx, sy). Nodes: every grid cell, then the start, then the
// portal endpoints. climbLo..climbHi is the Reposition/Charge phase's window in inches
// from the start of the whole move: a climb may only start at/after climbLo (arriving
// earlier burns "pad" inches waiting at the wall) and must finish by climbHi
// (climbHi < 0 = no climbing at all). Nodes beyond `bound` inches aren't expanded.
export function buildField(sx, sy, lo, hi, bound) {
  const nx = G.nx, ny = G.ny, NC = G.n, S0 = NC, N = NC + 1 + EPX.length;
  const g = new Float64Array(N).fill(Infinity), par = new Int32Array(N).fill(-1);
  const vz = new Uint8Array(N), vpad = new Uint8Array(N), closed = new Uint8Array(N);
  // control range zones (planRoute): their own free cells, and no climb into or across one
  const free = ZONES ? zoneFree() : G.free;
  const epOK = ZONES ? PORTALS.map(P => zoneSegFree(P.ax, P.ay, P.bx, P.by)) : null;
  const tol = startTol(sx, sy), sCells = attachCells(sx, sy, [0.3, 0.9, 1.7], tol, free), sSet = new Set(sCells);
  const X = k => k < NC ? (k % nx + 0.5) * GRES : k === S0 ? sx : EPX[k - NC - 1];
  const Y = k => k < NC ? ((k / nx | 0) + 0.5) * GRES : k === S0 ? sy : EPY[k - NC - 1];
  const nb = [];
  const nbrs = k => {
    nb.length = 0;
    if (k < NC) {
      const i = k % nx, j = k / nx | 0;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj; if (jj < 0 || jj >= ny) continue;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di; if ((!di && !dj) || ii < 0 || ii >= nx) continue;
          const m = jj * nx + ii; if (!free[m]) continue;
          if (di && dj && !free[j * nx + ii] && !free[jj * nx + i]) continue; // no squeezing through a pinch
          nb.push(m);
        }
      }
      const sp = CELL_SP.get(k); if (sp) for (const s of sp) if (!epOK || epOK[(s - NC - 1) >> 1]) nb.push(s);
      if (sSet.has(k)) nb.push(S0);
    } else for (const m of (k === S0 ? sCells : EP_CELLS[k - NC - 1])) if (free[m]) nb.push(m);
    return nb;
  };
  const H = new Heap();
  g[S0] = 0; par[S0] = S0; H.push(0, S0);
  while (H.k.length) {
    const k = H.pop(), gk = H.top;
    if (closed[k] || gk > g[k] + 1e-9) continue;
    const kx = X(k), ky = Y(k);
    if (k !== S0 && !vz[k]) {           // lazy: confirm the straight run from the assumed parent
      const p = par[k];
      if (!segFree(X(p), Y(p), kx, ky, p === S0 ? tol : 0)) {
        let bg = Infinity, bp = -1;
        for (const m of nbrs(k)) if (closed[m]) { const c = g[m] + dist(X(m), Y(m), kx, ky); if (c < bg) { bg = c; bp = m; } }
        if (bp < 0) continue;
        g[k] = bg; par[k] = bp;
      }
    }
    if (g[k] > bound) continue;
    closed[k] = 1;
    const p = (k === S0 || vz[k]) ? k : par[k], ppx = X(p), ppy = Y(p), gp = g[p];
    for (const m of nbrs(k)) {
      if (closed[m]) continue;
      const c = gp + dist(ppx, ppy, X(m), Y(m));
      if (c < g[m] - 1e-9) { g[m] = c; par[m] = p; vz[m] = 0; vpad[m] = 0; H.push(c, m); }
    }
    if (k > S0 && hi >= 0) {            // a portal endpoint: climb up and over to its mate
      const e = k - NC - 1, mate = NC + 1 + (e ^ 1), P = PORTALS[e >> 1];
      if (!closed[mate] && (!epOK || epOK[e >> 1])) {
        const base = Math.max(g[k], lo), c = base + P.len + climbCost(P.z);
        if (c <= hi + 1e-9 && c < g[mate] - 1e-9) {
          g[mate] = c; par[mate] = k; vz[mate] = P.z;
          vpad[mate] = Math.max(0, Math.ceil(base - g[k] - 1e-9));
          H.push(c, mate);
        }
      }
    }
  }
  return {g, par, vz, vpad, closed, X, Y, S0, NC, N, tol};
}
export function getField(sx, sy, lo, hi, bound) {
  if (ZONES && ZONES.inside) return buildField(sx, sy, lo, hi, bound);   // small, and new every pointer move
  const key = `${NAVVER}|${NAV_R}|${ZONES ? ZONES.key : ""}|${sx}|${sy}|${lo}|${hi}|${bound}`;
  let F = FIELDS.get(key);
  if (!F) { if (FIELDS.size >= 6) FIELDS.clear(); F = buildField(sx, sy, lo, hi, bound); FIELDS.set(key, F); }
  return F;
}
export function fieldPath(F, k) {
  const rev = [];
  for (let u = k, n = 0; n < 100000; n++) {
    rev.push([F.X(u), F.Y(u), F.vz[u], F.vpad[u]]);
    if (u === F.S0) break;
    u = F.par[u];
  }
  rev.reverse(); rev[0] = [F.X(F.S0), F.Y(F.S0), 0, 0];
  return rev;
}
// pull the route taut: skip any walking points a straight run can cut past; climbs stay put
export function smoothPath(p, tol) {
  const out = [p[0]];
  let i = 0;
  while (i < p.length - 1) {
    if (p[i + 1][2]) { out.push(p[i + 1]); i++; continue; }
    let lim = i + 1; while (lim + 1 < p.length && !p[lim + 1][2]) lim++;
    let j = i + 1;
    for (let k = lim; k > i + 1; k--)
      if (segFree(p[i][0], p[i][1], p[k][0], p[k][1], i === 0 ? tol : 0)) { j = k; break; }
    out.push(p[j]); i = j;
  }
  return out;
}
// Increments: under Kill Team a straight leg of length L costs ceil(L) inches (the ruleset's
// increment; see legCost), so a route
// that hugs a rounded corner in many short legs wastes inches. Re-pick the bend points
// to minimise the rounded total: candidates are the route's own points plus the square
// corners where extended legs meet (the turn a player makes round a wall end), joined
// by straight free legs — or, across a climb, by one straight climb from any point
// before the terrain to any point after it. The climb timing window applies in the
// same whole inches the move is paid in.
export function lineMeet(a, b, c, d) {   // where line a->b (ahead of b) meets line c->d (behind c)
  const d1x = b[0] - a[0], d1y = b[1] - a[1], d2x = d[0] - c[0], d2y = d[1] - c[1];
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return null;
  const ex = c[0] - a[0], ey = c[1] - a[1];
  const t = (ex * d2y - ey * d2x) / den, u = (ex * d1y - ey * d1x) / den;
  const L1 = Math.hypot(d1x, d1y), L2 = Math.hypot(d2x, d2y);
  if (t < 1 - 1e-9 || u > 1e-9 || (t - 1) * L1 > 3 || -u * L2 > 3) return null;
  return [a[0] + t * d1x, a[1] + t * d1y];
}
export function optimizeIncrements(p, tol, lo, hi) {
  if (lo === undefined) { lo = 0; hi = Infinity; }
  const n = p.length;
  if (n <= 2) return p;
  const sec = [], firstOf = [];          // walking sections between climbs
  for (let i = 0, s = 0; i < n; i++) { if (i > 0 && p[i][2]) { s++; firstOf[s] = i; } sec.push(s); }
  const cand = p.map((q, i) => ({x: q[0], y: q[1], key: i, sec: sec[i], v: i}));
  for (let i = 0; i < n - 1; i++) {
    if (p[i + 1][2]) continue;
    for (let j = i + 2; j < Math.min(n - 1, i + 7); j++) {
      if (p[j + 1][2] || sec[j] !== sec[i] || p[j][2]) break;
      const X = lineMeet(p[i], p[i + 1], p[j], p[j + 1]);
      if (X && X[0] > 0 && X[1] > 0 && X[0] < BW && X[1] < BH)
        cand.push({x: X[0], y: X[1], key: (i + 1 + j) / 2, sec: sec[i], v: -1});
    }
  }
  cand.sort((a, b) => a.key - b.key || b.v - a.v);
  const m = cand.length, C = new Float64Array(m).fill(Infinity), Lx = new Float64Array(m).fill(Infinity);
  const prev = new Int32Array(m).fill(-1), vz = new Float64Array(m), vp = new Float64Array(m);
  C[0] = 0; Lx[0] = 0;
  for (let a = 0; a < m; a++) {
    if (!isFinite(C[a])) continue;
    const A = cand[a];
    for (let b = a + 1; b < m; b++) {
      const B = cand[b];
      if (B.key <= A.key) continue;
      if (B.sec > A.sec + 1) break;
      const L = dist(A.x, A.y, B.x, B.y);
      let c, z = 0, pad = 0;
      if (B.sec === A.sec) {
        if (!segFree(A.x, A.y, B.x, B.y, A.v === 0 ? tol : 0)) continue;
        c = C[a] + legCost(L);
      } else {
        const k = firstOf[B.sec], orig = dist(p[k - 1][0], p[k - 1][1], p[k][0], p[k][1]);
        if (L > orig + 2.5) continue;
        z = crossingHeight(A.x, A.y, B.x, B.y);
        if (!isFinite(z) || z <= 0 || !zoneSegFree(A.x, A.y, B.x, B.y)) continue;
        const base = Math.max(C[a], lo);
        pad = base - C[a];
        c = base + legCost(L) + climbCost(z);
        if (c > hi + 1e-9) continue;
      }
      const lx = Lx[a] + L;
      if (c < C[b] - 1e-9 || (c < C[b] + 1e-9 && lx < Lx[b] - 1e-9)) { C[b] = c; Lx[b] = lx; prev[b] = a; vz[b] = z; vp[b] = pad; }
    }
  }
  const end = cand.findIndex(c => c.v === n - 1);
  if (end < 0 || !isFinite(C[end])) return p;
  const out = [];
  for (let u = end; u >= 0; u = prev[u]) out.push([cand[u].x, cand[u].y, vz[u], vp[u]]);
  out.reverse();
  return pathTotalInches(out) <= pathTotalInches(p) ? out : p;
}
// The field's cheapest connection to (gx, gy): among closed cells near it, the cheapest with
// a free straight run to it. {c: cost, k: cell}, k = -1 if none.
export function reachField(F, gx, gy) {
  const ci = Math.floor(gx / GRES), cj = Math.floor(gy / GRES);
  for (const r of [0.35, 0.9, 1.7]) {
    const ri = Math.ceil(r / GRES), cand = [];
    for (let j = Math.max(0, cj - ri); j <= Math.min(G.ny - 1, cj + ri); j++)
      for (let i = Math.max(0, ci - ri); i <= Math.min(G.nx - 1, ci + ri); i++) {
        const k = j * G.nx + i;
        if (!F.closed[k]) continue;
        const x = (i + 0.5) * GRES, y = (j + 0.5) * GRES, d = dist(x, y, gx, gy);
        if (d <= r) cand.push([F.g[k] + d, k, x, y]);
      }
    cand.sort((a, b) => a[0] - b[0]);
    for (const [c, k, x, y] of cand) if (segFree(x, y, gx, gy)) return {c, k};
  }
  return {c: Infinity, k: -1};
}
// Route from the operative to the goal: [[x, y, climbZ, padInches], ...]. cap = the
// move's whole allowance. If the goal can't be reached at all, the route heads for the
// reachable spot nearest it and is flagged .partial.
export function findPath(sx, sy, gx, gy, climbLo, climbHi, cap) {
  if (climbLo === undefined) { climbLo = 0; climbHi = Infinity; }
  const tol = startTol(sx, sy);
  if (segFree(sx, sy, gx, gy, tol)) return [[sx, sy, 0, 0], [gx, gy, 0, 0]];
  const F = getField(sx, sy, climbLo, climbHi, cap === undefined ? 80 : cap + 4);
  const bk = reachField(F, gx, gy).k;
  if (bk >= 0) {
    const path = fieldPath(F, bk);
    path.push([gx, gy, 0, 0]);
    return optimizeIncrements(smoothPath(path, tol), tol, climbLo, climbHi);
  }
  const lim = cap === undefined ? Infinity : cap;
  let nd = Infinity, nk = -1;
  for (let k = 0; k < F.N; k++) {
    if (!F.closed[k] || F.g[k] > lim + 1e-9) continue;
    const d = dist(F.X(k), F.Y(k), gx, gy);
    if (d < nd - 1e-9 || (d < nd + 1e-9 && F.g[k] < F.g[nk])) { nd = d; nk = k; }
  }
  if (nk < 0) return null;
  const path = optimizeIncrements(smoothPath(fieldPath(F, nk), tol), tol, climbLo, climbHi);
  path.partial = true;
  return path;
}
// Slide interior bend points forward along their incoming direction so each straight
// leg ends on a whole inch — the way a human places turns. Partial increments then
// only occur at the final drop point (or hard against a climb). A slide is kept only
// if both adjacent legs stay clear and the rounded total doesn't get worse.
export function straightenIncrements(path) {
  const inc = RULES.increment;
  if (!(inc > 0)) return path;               // measured exactly: nothing to round
  for (let i = 1; i < path.length - 1; i++) {
    if (path[i][2] || path[i+1][2]) continue; // never move a climb's endpoints
    const [ax, ay] = path[i-1], [bx, by] = path[i], [cx, cy] = path[i+1];
    const L1 = dist(ax, ay, bx, by);
    if (L1 < 1e-9) continue;
    const ext = legCost(L1) - L1;
    if (ext < 1e-6) continue; // already whole
    const ux = (bx - ax) / L1, uy = (by - ay) / L1;
    const nx = bx + ux * ext, ny = by + uy * ext;
    if (nx < NAV_R || nx > BW - NAV_R || ny < NAV_R || ny > BH - NAV_R) continue;
    if (!segFree(ax, ay, nx, ny) || !segFree(nx, ny, cx, cy)) continue;
    if (legCost(dist(nx, ny, cx, cy)) > legCost(dist(bx, by, cx, cy))) continue;
    path[i][0] = nx; path[i][1] = ny;
  }
  return path;
}
export function pathTotalInches(path) {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const d = dist(path[i-1][0], path[i-1][1], path[i][0], path[i][1]);
    total += legCost(d) + climbCost(path[i][2] || 0) + (path[i][3] || 0);
  }
  return total;
}
// Truncate a path at a rounded-inch cap. Each whole leg costs ceil(len); a partial
// final leg may use exactly the remaining whole inches. Returns {path, total, clamped}.
export function clampPath(path, cap) {
  const out = [path[0]];
  let rounded = 0, clamped = false;
  for (let i = 1; i < path.length; i++) {
    const [x1, y1] = path[i-1], [x2, y2] = path[i];
    const z = path[i][2] || 0, pad = path[i][3] || 0;
    const L = dist(x1, y1, x2, y2);
    const c = legCost(L) + climbCost(z) + pad;
    if (rounded + c <= cap) { out.push([x2, y2, z, pad]); rounded += c; continue; }
    if (!z) { // a walk leg can be partially used; a climb is all-or-nothing
      const allowed = cap - rounded;
      if (allowed > 1e-9 && L > 0) {
        const t = Math.min(1, allowed / L);
        out.push([x1 + (x2-x1)*t, y1 + (y2-y1)*t, 0, 0]);
        rounded += allowed;
      }
    }
    clamped = true;
    break;
  }
  return { path: out, total: rounded, clamped };
}
// Chop a route into the actual movement increments: straight steps of at most 1",
// direction changes only between steps. A final sub-inch step still costs a full inch.
export function chopIncrements(path) {
  const steps = [];
  for (let i = 1; i < path.length; i++) {
    const [x1, y1] = path[i-1], [x2, y2] = path[i];
    const z = path[i][2] || 0, pad = path[i][3] || 0;
    const L = dist(x1, y1, x2, y2);
    if (L < 1e-9 && !z) continue;
    if (z) { // climb up and over: one indivisible step costing across + up + down (+ any burned wait)
      steps.push({x1, y1, x2, y2, climb: z, pad, cost: legCost(L) + climbCost(z) + pad});
      continue;
    }
    // steps of the ruleset's increment; measured-exactly rules are drawn in 1" ticks
    // that cost exactly their length
    const inc = RULES.increment, step = inc > 0 ? inc : 1;
    const ux = (x2-x1)/L, uy = (y2-y1)/L;
    const n = Math.ceil(L / step - 1e-9);
    let sx = x1, sy = y1;
    for (let k = 0; k < n; k++) {
      const end = Math.min((k+1) * step, L);
      const ex = k === n-1 ? x2 : x1 + ux*end, ey = k === n-1 ? y2 : y1 + uy*end;
      const len = end - k * step;
      steps.push({x1:sx, y1:sy, x2:ex, y2:ey, partial: inc > 0 && len < step - 1e-6, cost: inc > 0 ? step : len});
      sx = ex; sy = ey;
    }
  }
  return steps;
}

/* ---------- control range ----------
   A move can't go within control range of an enemy operative (Kill Team: 1″, base edge to
   base edge), so every enemy's control range is routed round like terrain. A Charge may
   go into one, but from then on must stay within it: it can move round that enemy, not
   back out. A zone the operative starts in is left open (it may walk out of it), or, when
   charging, is the one it must stay inside. Rules without a Charge (Infinity) skip all this. */
function withZones(z, fn) {
  const prev = ZONES; setZones(z);
  try { return fn(); } finally { setZones(prev); }
}
const zoneKey = out => out.map(z => `${z.x},${z.y},${z.r}`).join(";");
// the zones for the part of a Charge that has to stay within control range of enemy T
const insideOf = T => ({out: [], inside: {x: T.x, y: T.y, rIn: opR(T), rOut: opR(T) + CTRL}});
// drop the joint between two straight legs that line up (a charge straight in)
function mergeStraight(p, j) {
  if (j <= 0 || j >= p.length - 1 || p[j][2] || p[j + 1][2] || p[j][3] || p[j + 1][3]) return p;
  const ax = p[j][0] - p[j - 1][0], ay = p[j][1] - p[j - 1][1], bx = p[j + 1][0] - p[j][0], by = p[j + 1][1] - p[j][1];
  if (Math.abs(ax * by - ay * bx) > 1e-6 * Math.hypot(ax, ay) * Math.hypot(bx, by) || ax * bx + ay * by < 0) return p;
  return p.slice(0, j).concat(p.slice(j + 1));
}
// findPath, then straightenIncrements, under zones z
const routeIn = (z, sx, sy, gx, gy, lo, hi, cap) => withZones(z, () => {
  const p = findPath(sx, sy, gx, gy, lo, hi, cap);
  return p && straightenIncrements(p);
});
// Route `op` (from where it stands, with the nav radius set by useBase) to (gx, gy) under
// the control range rules, increments straightened; arguments as findPath. charge = the
// move is a Charge.
export function planRoute(op, gx, gy, lo, hi, cap, charge) {
  const sx = op.x, sy = op.y, R = NAV_R;
  if (!RULES.moves.charge) return routeIn(null, sx, sy, gx, gy, lo, hi, cap);   // no Charge (Infinity): base contact is a move
  const foes = OPS.filter(o => o.alive && o.team !== op.team && o.id !== op.id);
  const reach = o => R + opR(o) + CTRL;                           // centre distance of "within control range"
  const within = (o, x, y) => dist(x, y, o.x, o.y) <= reach(o) + 1e-9;
  const startIn = foes.filter(o => within(o, sx, sy));
  if (charge && startIn.length) {
    const T = startIn.find(o => within(o, gx, gy)) || startIn[0];
    return routeIn(insideOf(T), sx, sy, gx, gy, lo, hi, cap);
  }
  const outList = foes.filter(o => !startIn.includes(o)).map(o => ({x: o.x, y: o.y, r: opR(o) + CTRL}));
  const A = {out: outList, inside: null, key: zoneKey(outList)};
  const direct = routeIn(A, sx, sy, gx, gy, lo, hi, cap);
  const targets = charge ? foes.filter(o => !startIn.includes(o) && within(o, gx, gy)) : [];
  if (!targets.length) return direct;
  // Charge: walk (clear of every zone) to a point on the target's control range, then
  // within it to the goal. Entry points: round the zone, plus where the straight line in
  // crosses it; ranked by the two route fields, the best few routed for real.
  const bound = cap === undefined ? 80 : cap + 4;
  const FA = withZones(A, () => getField(sx, sy, lo, hi, bound));
  const cands = [];
  for (const T of targets) {
    const rho = reach(T), pts = [];
    for (let a = 0; a < 48; a++) pts.push([T.x + rho * Math.cos(a * Math.PI / 24), T.y + rho * Math.sin(a * Math.PI / 24)]);
    const dx = gx - sx, dy = gy - sy, fx = sx - T.x, fy = sy - T.y, qa = dx * dx + dy * dy, qb = 2 * (fx * dx + fy * dy);
    const disc = qb * qb - 4 * qa * (fx * fx + fy * fy - rho * rho);
    if (qa > 1e-12 && disc >= 0) {
      const t = (-qb - Math.sqrt(disc)) / (2 * qa);
      if (t > 0 && t < 1) pts.push([sx + t * dx, sy + t * dy]);
    }
    const B = insideOf(T);
    const FB = withZones(B, () => getField(gx, gy, 0, hi, bound));
    for (const [x, y] of pts) {
      if (x < R || y < R || x > BW - R || y > BH - R) continue;
      const ca = withZones(A, () => ptFree(x, y) ? reachField(FA, x, y).c : Infinity);
      if (!isFinite(ca) || ca > bound) continue;
      const cb = withZones(B, () => ptFree(x, y) ? reachField(FB, x, y).c : Infinity);
      if (isFinite(cb)) cands.push({T, x, y, c: ca + cb});
    }
  }
  cands.sort((a, b) => a.c - b.c);
  let best = null;
  for (const {T, x, y} of cands.slice(0, 3)) {
    const pa = routeIn(A, sx, sy, x, y, lo, hi, cap);
    if (!pa || pa.partial) continue;
    const ta = pathTotalInches(pa);
    const pb = routeIn(insideOf(T), x, y, gx, gy, Math.max(0, lo - ta), hi - ta, cap === undefined ? undefined : cap - ta);
    if (!pb) continue;
    const p = mergeStraight(pa.concat(pb.slice(1)), pa.length - 1);
    if (pb.partial) p.partial = true;
    const tot = pathTotalInches(p);
    if (!best || (!p.partial && best.p.partial) || (!!p.partial === !!best.p.partial && tot < best.tot - 1e-9)) best = {p, tot};
  }
  return best ? best.p : direct;
}
