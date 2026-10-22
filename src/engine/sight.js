/**
 * Line of sight, cover and obscuring, judged on the terrain grid.
 */
import { BASE_R, CTRL } from '../config.js';
import { dist, opGap, perimeterPts } from './geometry.js';
import { C_HEAVY, C_LIGHT, C_WALL, FEATS, G, GRES, gridWalk } from './grid.js';
import { BH, BW } from './world.js';
import { RULES } from '../rules/index.js';

export const sightStop = k => { const c = G.cls[k]; return c === C_WALL || c === C_HEAVY; };
// gridWalk with sightStop, unrolled: proving a target hidden checks hundreds of lines
export function lineBlocked(x1, y1, x2, y2) {
  const {nx, ny, cls} = G, dx = x2 - x1, dy = y2 - y1;
  let i = Math.floor(x1 / GRES), j = Math.floor(y1 / GRES);
  const ie = Math.floor(x2 / GRES), je = Math.floor(y2 / GRES);
  const si = dx > 0 ? 1 : dx < 0 ? -1 : 0, sj = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tdx = si ? GRES / Math.abs(dx) : Infinity, tdy = sj ? GRES / Math.abs(dy) : Infinity;
  let tmx = si > 0 ? ((i + 1) * GRES - x1) / dx : si < 0 ? (i * GRES - x1) / dx : Infinity;
  let tmy = sj > 0 ? ((j + 1) * GRES - y1) / dy : sj < 0 ? (j * GRES - y1) / dy : Infinity;
  for (let n = 0; n < 4000; n++) {
    if (i >= 0 && j >= 0 && i < nx && j < ny) { const c = cls[j * nx + i]; if (c === C_WALL || c === C_HEAVY) return true; }
    if (i === ie && j === je) return false;
    if (tmx < tmy) { if (tmx > 1) return false; tmx += tdx; i += si; }
    else { if (tmy > 1) return false; tmy += tdy; j += sj; }
  }
  return false;
}

// Line-of-sight analysis between two operatives (Kill Team 2024 style). Cover lines run
// from any one point of the attacker's base to every part of the target's base, straight
// through terrain. Walls and heavy terrain block sight; light doesn't. Visible: some cover
// line is unblocked. Obscured: a cover line crosses sight-blocking terrain far from both
// operatives (Kill Team: more than 1" from the attacker's base and more than 2" from the
// target's). Cover: a cover line crosses terrain, or the base of another operative in
// `bases`, close to the target (Kill Team: within 1", void inside 2"). Bases only ever give
// cover: they never block sight or obscure. The target must be visible before any cover
// line is drawn, and the lines start from a base point that can see it: of those, the
// attacker picks the one that suits it best: not obscured first, then not in cover, then
// in cover from light terrain or bases only rather than heavy terrain. Distances come
// from the ruleset. Judged cell by cell, so a nooked operative gets cover from the actual
// wall beside it, not a whole building.
export function sightAnalysis(a, b, bases = []) {
  const rr = BASE_R - 0.02;
  const aPts = perimeterPts(a, 16, rr), bPts = perimeterPts(b, 24, rr);
  const gap = opGap(a, b), half = GRES / 2, nx = G.nx;
  const { cover, obscure } = RULES, coverOn = gap > cover.voidWithin;
  // only bases close enough to the target can hold a cover point
  const near = coverOn ? bases.filter(o => opGap(o, b) <= cover.range + 1e-9) : [];
  // Visible: any one unblocked line (each walk stops at the first wall). Not visible
  // means nothing else to judge.
  const eyeAt = seeFrom(aPts, bPts);
  if (eyeAt < 0) return {visible: false, gap, coverBy: null, obscBy: null, hardCover: false, from: aPts[0], clearLine: null};
  // Walk every cover line from (ax, ay) end to end. visit(kind, key, cx, cy, d, line)
  // hears each cover / obscuring cell (and each base crossing), when given. Gives up
  // (null) as soon as this point can no longer beat `rival`.
  const rank = r => (r.obsc ? 4 : 0) + (r.cover ? 2 : 0) + (r.hard ? 1 : 0);
  const lost = (r, q) => q && rank(r) >= rank(q);
  const linesFrom = (ax, ay, visit, rival) => {
    const r = {ax, ay, clear: 0, cover: false, hard: false, obsc: false, clearTo: null};
    for (const [bx, by] of bPts) {
      if (rival && (r.obsc || r.cover) && lost(r, rival)) return null;
      let blocked = false;
      gridWalk(ax, ay, bx, by, k => {
        const c = G.cls[k];
        if (c < C_WALL || c > C_LIGHT) return false;
        if (c !== C_LIGHT) blocked = true;
        const cx = (k % nx + 0.5) * GRES, cy = ((k / nx | 0) + 0.5) * GRES;
        const dB = dist(cx, cy, b.x, b.y) - BASE_R - half;
        if (coverOn && dB <= cover.range + 1e-9) {
          r.cover = true; if (c !== C_LIGHT) r.hard = true;
          if (visit) visit("cov", G.fid[k], cx, cy, dB, bx, by);
        }
        if (c !== C_LIGHT && obscure) {
          const dA = dist(cx, cy, a.x, a.y) - BASE_R - half;
          if (dA > obscure.fromShooter && dB > obscure.fromTarget) { r.obsc = true; if (visit) visit("obs", G.fid[k], cx, cy, Math.min(dA, dB), bx, by); }
        }
        return false;
      });
      // other operatives' bases: the stretch of this line inside a base, at its point
      // nearest the target
      for (const o of near) {
        const hit = baseCrossing(ax, ay, bx, by, o, b);
        if (hit && hit.d <= cover.range + 1e-9) {
          r.cover = true;
          if (visit) visit("cov", "op:" + o.id, hit.x, hit.y, hit.d, bx, by, o);
        }
      }
      if (!blocked) { r.clear++; if (!r.clearTo) r.clearTo = [bx, by]; }
    }
    return r;
  };
  // the attacker's pick, among the points that can see the target (at least one clear
  // line): try the point found above first, then the rest
  let best = null;
  for (let n = 0; n < aPts.length; n++) {
    const [ax, ay] = aPts[(eyeAt + n) % aPts.length];
    const r = linesFrom(ax, ay, null, best);
    if (r && r.clear && (!best || !lost(r, best))) best = r;
    if (!best.obsc && !best.cover) break;               // nothing beats an unhindered point
  }
  // one actual unblocked sight line from the chosen point, for drawing/explaining
  const clearLine = [[best.ax, best.ay], best.clearTo];
  // the chosen point again, now noting which terrain feature gave cover / obscured and
  // the cover line that crossed it nearest the target
  const cov = new Map(), obs = new Map();
  if (best.cover || best.obsc) linesFrom(best.ax, best.ay, (which, fid, x, y, d, bx, by, o) => {
    const m = which === "cov" ? cov : obs, e = m.get(fid);
    if (!e) m.set(fid, {x0: x, y0: y, x1: x, y1: y, d, at: [x, y], to: [bx, by], op: o});
    else {
      e.x0 = Math.min(e.x0, x); e.y0 = Math.min(e.y0, y); e.x1 = Math.max(e.x1, x); e.y1 = Math.max(e.y1, y);
      if (d < e.d) { e.d = d; e.at = [x, y]; e.to = [bx, by]; }
    }
  });
  const pick = m => {
    let bf = -1, be = null;
    for (const [fid, e] of m) if (!be || e.d < be.d) { bf = fid; be = e; }
    if (!be) return null;
    const line = [[best.ax, best.ay], be.to];
    if (be.op) return {id: be.op.name || be.op.id, kind: "operative", op: be.op,   // the whole base
      x: be.op.x - BASE_R, y: be.op.y - BASE_R, w: 2 * BASE_R, h: 2 * BASE_R, at: be.at, line};
    const f = FEATS[bf] || {id: "terrain", kind: "wall"};
    return {id: f.id, kind: f.kind, x: be.x0 - half, y: be.y0 - half, w: be.x1 - be.x0 + GRES, h: be.y1 - be.y0 + GRES,
            at: be.at, line};
  };
  // hardCover: some cover comes from heavy terrain or a wall, not just light terrain or bases
  return {visible: true, gap, coverBy: pick(cov), obscBy: pick(obs), hardCover: best.hard, from: [best.ax, best.ay], clearLine};
}
// Index of the first attacker point with an unblocked line to some target point, or -1.
function seeFrom(aPts, bPts) {
  for (let i = 0; i < aPts.length; i++) for (const [bx, by] of bPts)
    if (!lineBlocked(aPts[i][0], aPts[i][1], bx, by)) return i;
  return -1;
}
// Just the visibility test of sightAnalysis: can a see any part of b's base?
export function canSee(a, b) {
  const rr = BASE_R - 0.02;
  return seeFrom(perimeterPts(a, 16, rr), perimeterPts(b, 24, rr)) >= 0;
}
// Where segment (ax, ay) -> (bx, by) runs through base o: the point of that stretch nearest
// target t, and its distance from t's base edge. null if the segment misses the base.
function baseCrossing(ax, ay, bx, by, o, t) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  if (L2 < 1e-12) return null;
  const fx = ax - o.x, fy = ay - o.y;
  const B = fx * dx + fy * dy, C = fx * fx + fy * fy - BASE_R * BASE_R, disc = B * B - L2 * C;
  if (disc <= 0) return null;
  const sq = Math.sqrt(disc), t0 = Math.max(0, (-B - sq) / L2), t1 = Math.min(1, (-B + sq) / L2);
  if (t0 > t1) return null;
  const u = Math.min(t1, Math.max(t0, ((t.x - ax) * dx + (t.y - ay) * dy) / L2));
  const x = ax + dx * u, y = ay + dy * u;
  return {x, y, d: dist(x, y, t.x, t.y) - BASE_R};
}
export function inControlRange(a, b) {
  if (opGap(a,b) > CTRL) return false;
  // visible check (coarse): any clear line
  return canSee(a, b);
}
// Subtle shadow-cast visibility: sight-blocking terrain (walls & heavy) casts
// shadows from the operative's position; enemies with a clear sight line get a halo.
// What the eye point sees: rays cast through the terrain grid until they hit a wall or
// heavy terrain cell (or the board edge). Everything outside that polygon is shaded.
export function visibilityPolygon(fx, fy) {
  const N = 720, pts = [];
  let hitT = 1;
  const stop = (k, t) => { const c = G.cls[k]; if (c === C_WALL || c === C_HEAVY) { hitT = t; return true; } return false; };
  for (let n = 0; n < N; n++) {
    const ang = 2 * Math.PI * n / N, dx = Math.cos(ang), dy = Math.sin(ang);
    let t = Infinity;
    if (dx > 1e-9) t = Math.min(t, (BW - fx) / dx); else if (dx < -1e-9) t = Math.min(t, -fx / dx);
    if (dy > 1e-9) t = Math.min(t, (BH - fy) / dy); else if (dy < -1e-9) t = Math.min(t, -fy / dy);
    const ex = fx + dx * t, ey = fy + dy * t;
    hitT = 1;
    gridWalk(fx, fy, ex, ey, stop);
    pts.push([fx + (ex - fx) * hitT, fy + (ey - fy) * hitT]);
  }
  return pts;
}
