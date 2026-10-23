/**
 * Small geometry helpers shared by the engine and the renderer.
 */
import { BASE_R, S } from '../config.js';

/* ---------- geometry ---------- */
export const px = v => v * S;
export function dist(ax, ay, bx, by) { return Math.hypot(bx-ax, by-ay); }
// an operative's base radius: its own base (op.base, mm, from its miniature) or the ruleset's
export const opR = op => op && op.base ? op.base / 50.8 : BASE_R;
// base-edge to base-edge; with one base higher up (on an upper floor), the distance in 3D
// from the nearer base's edge to the other's
export const gap3 = (g, dz) => dz ? Math.hypot(Math.max(0, g), dz) : g;
export function opGap(a, b) { return gap3(dist(a.x,a.y,b.x,b.y) - opR(a) - opR(b), Math.abs((a.z || 0) - (b.z || 0))); }
export function perimeterPts(op, n, r = opR(op)) {
  const pts=[]; for (let i=0;i<n;i++){ const a=2*Math.PI*i/n;
    pts.push([op.x+r*Math.cos(a), op.y+r*Math.sin(a)]); } return pts;
}

/* ---------- irregular rubble footprints (visual only; gameplay uses the rects) ---------- */
export function hashSeed(s) { let h = 2166136261; for (const c of s) h = ((h ^ c.charCodeAt(0)) * 16777619) >>> 0; return h; }
export function mulberry32(a) { return function() { a |= 0; a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
// A wall's height sections as sub-rects along its long axis.
export function wallSegments(t) {
  if (t._segRects) return t._segRects;
  const vert = t.h > t.w;
  const list = t.segs || [[vert ? t.h : t.w, t.z]];
  const out = [];
  let cur = 0;
  for (const [len, z] of list) {
    out.push(vert ? {x: t.x, y: t.y + cur, w: t.w, h: len, z}
                  : {x: t.x + cur, y: t.y, w: len, h: t.h, z});
    cur += len;
  }
  t._segRects = out;
  return out;
}
export function blobPoints(t) {
  if (t._blob) return t._blob;
  const rnd = mulberry32(hashSeed(t.id));
  const cx = t.x + t.w/2, cy = t.y + t.h/2;
  const edges = [
    [t.x, t.y, t.x+t.w, t.y], [t.x+t.w, t.y, t.x+t.w, t.y+t.h],
    [t.x+t.w, t.y+t.h, t.x, t.y+t.h], [t.x, t.y+t.h, t.x, t.y],
  ];
  const pts = [];
  for (const [x1, y1, x2, y2] of edges) {
    const L = Math.hypot(x2-x1, y2-y1);
    const n = Math.max(2, Math.round(L / 0.55));
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const X = x1 + (x2-x1)*u, Y = y1 + (y2-y1)*u;
      const jf = i === 0 ? 0.04 : 0.06 + rnd() * 0.2; // jagged, biased inward
      pts.push([X + (cx-X)*jf, Y + (cy-Y)*jf]);
    }
  }
  t._blob = pts;
  return pts;
}
