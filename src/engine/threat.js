/**
 * Threat ranges: where an enemy that hasn't activated yet this turning point could hurt
 * a model that ends its move there. Two zones, both judged for the moving model's base
 * centre, so "is my ghost inside it" is the whole question:
 *   charge — the enemy charges (charge allowance, routed round and over terrain like any
 *            move) and ends within control range of the base;
 *   close  — the enemy moves as far as its action points allow and still shoots: Reposition
 *            + Dash + Shoot needs APL 3, so APL 2 gets Reposition + Shoot only. It shoots
 *            from within the cover void (Kill Team: 2"), so cover won't save the base.
 * Distances are base edge to base edge, as in the rules. The route field measures the
 * exact any-angle length, not the whole-inch increments, so a zone can be a hair bigger
 * than the dice-free truth — it errs on the side of warning.
 */
import { CTRL } from '../config.js';
import { opR } from './geometry.js';
import { C_HEAVY, C_WALL, G, GRES, NAV_R } from './grid.js';
import { Heap, NAVVER, buildField, fieldPath, opLayer, smoothPath, useBase } from './movement.js';
import { OPS } from './world.js';
import { RULES } from '../rules/index.js';

// The allowances an enemy threatens with under the current rules (0 = that zone is off).
// `moves` = how many move actions fit before the Shoot: one per action point but the last.
export function threatAllow(op) {
  const M = RULES.moves, voidIn = RULES.cover ? RULES.cover.voidWithin || 0 : 0;
  const moves = Math.max(0, (op.apl || 2) - 1);
  const close = (moves >= 1 ? M.primary.allow(op) : 0) + (moves >= 2 && M.secondary ? M.secondary.allow(op) : 0);
  return {
    charge: M.charge ? M.charge.allow(op) : 0,
    close: voidIn > 0 ? close : 0, closeOn: voidIn > 0,
    chargeReach: CTRL, closeReach: voidIn,
  };
}

// Board cells (by index) whose centre the enemy's base centre can reach within `cap`
// inches. Upper-floor cells count as the board cell under them: the zones are drawn on the
// table's footprint, and the height between floors is ignored (errs towards warning).
function reachCells(F, cap) {
  const out = new Set();
  for (let k = 0; k < F.S0; k++) {
    if (!F.closed[k] || F.g[k] > cap + 1e-9) continue;
    out.add(k < G.n ? k : Math.floor(F.Y(k) / GRES) * G.nx + Math.floor(F.X(k) / GRES));
  }
  return out;
}

// Grow a set of cells by `r` inches (centre to centre), spreading only through cells that
// don't block sight — a wall between the two bases stops the threat. Each cell carries its
// nearest source point, so distances stay Euclidean rather than the 8-neighbour octile.
function grow(cells, r, into, bit) {
  const nx = G.nx, ny = G.ny, n = G.n;
  const d = new Float64Array(n).fill(Infinity), src = new Int32Array(n).fill(-1);
  const H = new Heap();
  for (const k of cells) { d[k] = 0; src[k] = k; into[k] |= bit; }
  for (const k of cells) {         // only the frontier needs to spread
    const i = k % nx, j = k / nx | 0;
    if ((i > 0 && src[k - 1] < 0) || (i < nx - 1 && src[k + 1] < 0) || (j > 0 && src[k - nx] < 0) || (j < ny - 1 && src[k + nx] < 0))
      H.push(0, k);
  }
  while (H.k.length) {
    const k = H.pop(), dk = H.top;
    if (dk > d[k] + 1e-9) continue;
    const s = src[k], si = s % nx, sj = s / nx | 0, i = k % nx, j = k / nx | 0;
    for (let dj = -1; dj <= 1; dj++) {
      const jj = j + dj; if (jj < 0 || jj >= ny) continue;
      for (let di = -1; di <= 1; di++) {
        const ii = i + di; if ((!di && !dj) || ii < 0 || ii >= nx) continue;
        const m = jj * nx + ii, c = G.cls[m];
        if (c === C_WALL || c === C_HEAVY) continue;
        const dm = Math.hypot(ii - si, jj - sj) * GRES;
        if (dm > r + 1e-9 || dm >= d[m] - 1e-9) continue;
        d[m] = dm; src[m] = s; into[m] |= bit; H.push(dm, m);
      }
    }
  }
}

// One enemy's two zones, for a mover with base radius r, as bits in per-cell masks.
// Returns its route field (kept for chargeRoute), or null when it threatens nothing.
function enemyZones(e, r, bit, charge, close) {
  const a = threatAllow(e), cap = Math.max(a.charge, a.close);
  if (!a.charge && !a.closeOn) return null;
  useBase(opR(e));                 // the enemy routes its own base
  const F = buildField(e.x, e.y, 0, Infinity, cap + 0.5, opLayer(e));   // climbing allowed throughout: errs towards warning
  if (a.charge > 0) grow(reachCells(F, a.charge), r + opR(e) + a.chargeReach, charge, bit);
  if (a.closeOn) grow(reachCells(F, Math.max(a.close, 0.1)), r + opR(e) + a.closeReach, close, bit);   // no moves: shoots from where it stands
  return F;
}

// Every live, ready (not yet activated) enemy of mover.team: per-cell bitmasks of who can
// charge the mover's base centred there, and who can shoot it from inside the cover void.
// Cached until an enemy, the mover's base size, the map or the rules change.
let memo = {key: null, map: null};
export function threatMap(mover) {
  const foes = OPS.filter(o => o.alive && o.ready && o.team !== mover.team).slice(0, 31), r = opR(mover);
  const key = `${NAVVER}|${RULES.id}|${r}|${G && G.n}|` +
    foes.map(o => `${o.id}@${o.x.toFixed(3)},${o.y.toFixed(3)},${o.z || 0},${o.wounds},${o.apl},${opR(o)}`).join(";");
  if (memo.key === key && memo.map && memo.map.g === G) return memo.map;
  const charge = new Uint32Array(G.n), close = new Uint32Array(G.n), prevR = NAV_R;
  let fields;
  try { fields = foes.map((o, i) => enemyZones(o, r, 1 << i, charge, close)); }
  finally { useBase(prevR); }
  memo = {key, map: {g: G, foes, fields, r, routes: new Map(), charge, close, version: (memo.map ? memo.map.version : 0) + 1}};
  return memo.map;
}

// Which enemies threaten a base centred at (x, y): {charge: [ops], close: [ops]}.
export function threatsAt(map, x, y) {
  const i = Math.min(G.nx - 1, Math.max(0, Math.floor(x / GRES))), j = Math.min(G.ny - 1, Math.max(0, Math.floor(y / GRES)));
  const k = j * G.nx + i, pick = bits => map.foes.filter((_, n) => bits & (1 << n));
  return {charge: pick(map.charge[k]), close: pick(map.close[k])};
}

// no wall or heavy terrain on the board cells between two points (what grow() spreads through)
function clearRun(x1, y1, x2, y2) {
  const n = Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (GRES / 2));
  for (let s = 1; s < n; s++) {
    const x = x1 + (x2 - x1) * s / n, y = y1 + (y2 - y1) * s / n;
    const c = G.cls[Math.floor(y / GRES) * G.nx + Math.floor(x / GRES)];
    if (c === C_WALL || c === C_HEAVY) return false;
  }
  return true;
}
// The route enemy e would charge along to reach the mover's base centred at (gx, gy): the
// shortest one in its threat field to any spot within control range of that base with a
// clear run to it, as the charge zone itself is judged. [[x, y, climbZ, pad, layer], ...]
// from the enemy's base centre to where it would end, or null if none is found.
export function chargeRoute(map, e, gx, gy) {
  const n = map.foes.indexOf(e), F = map.fields && map.fields[n], a = threatAllow(e);
  if (!F || !a.charge) return null;
  const key = `${gx.toFixed(3)},${gy.toFixed(3)}`, hit = map.routes.get(e);
  if (hit && hit.key === key) return hit.path;
  const reach = map.r + opR(e) + a.chargeReach;
  let bk = -1, bg = Infinity;
  for (let k = 0; k < F.S0; k++) {
    if (!F.closed[k] || F.g[k] > a.charge + 1e-9 || F.g[k] >= bg) continue;
    const x = F.X(k), y = F.Y(k);
    if (Math.hypot(x - gx, y - gy) > reach || !clearRun(x, y, gx, gy)) continue;
    bk = k; bg = F.g[k];
  }
  let path = null;
  if (bk >= 0) {
    const prevR = NAV_R;
    try { useBase(opR(e)); path = smoothPath(fieldPath(F, bk), F.tol); }
    finally { useBase(prevR); }
  }
  map.routes.set(e, {key, path});
  return path;
}
