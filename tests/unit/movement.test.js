// Movement rules: whole-inch increments, climbing costs and timing, nooks, and route
// validity on every map.
import { describe, it, expect, beforeAll } from 'vitest';
import * as world from '../../src/engine/world.js';
import * as grid from '../../src/engine/grid.js';
import * as mv from '../../src/engine/movement.js';

beforeAll(() => world.initMaps());
const total = p => mv.pathTotalInches(p);
const climbs = p => p.filter(q => q[2]).map(q => q[2]);

describe('climb costs (core rules)', () => {
  it('up = height (at least 2"), down = height past the free 2", walking legs cost nothing extra', () => {
    expect([1, 2, 3, 4].map(h => [mv.climbUp(h), mv.climbDown(h), mv.climbCost(h)]))
      .toEqual([[2, 0, 2], [2, 0, 2], [3, 1, 4], [4, 2, 6]]);
    expect(mv.climbCost(0)).toBe(0);
  });
});

describe('hand-made Volkus Ruins', () => {
  beforeAll(() => world.buildWorld(world.MAPS.volkus));

  it('climbs straight over a 2" wall section: 2" across + 2" up + 0" down = 4"', () => {
    const p = mv.findPath(8.9, 7.0, 10.9, 7.0, 0, 6);
    expect(climbs(p)).toEqual([2]);
    expect(total(p)).toBe(4);
  });

  it('a Dash can never climb, so the same trip walks round', () => {
    const p = mv.findPath(8.9, 7.0, 10.9, 7.0, 0, -1);
    expect(climbs(p)).toEqual([]);
    expect(total(p)).toBe(10);
  });

  it('round a wall end in square turns rather than many short (each full-inch) legs', () => {
    const p = mv.findPath(9.139, 4.75, 10.611, 4.75, 0, 6);
    expect(total(p)).toBe(6);
    expect(p.length).toBeLessThanOrEqual(5);
  });

  it('route cost always equals the sum of its drawn increments', () => {
    const p = mv.findPath(2, 2, 12, 20, 0, 6);
    expect(total(p)).toBe(mv.chopIncrements(p).reduce((a, s) => a + s.cost, 0));
  });
});

describe('Volkus AO 1 (scanned terrain)', () => {
  beforeAll(() => world.buildWorld(world.MAPS.v1));

  it('walks into the stronghold corner nook', () => {
    const p = mv.findPath(10.71, 7.48, 12.05, 4.25, 0, 6, 9);
    expect(p.partial).toBeFalsy();
    expect(total(p)).toBe(5);
    expect(grid.ptFree(12.05, 4.25)).toBe(true);
  });

  it('climbs over the low wall into the stronghold (2" up, nothing down)', () => {
    const p = mv.findPath(15.55, 4.25, 12.05, 4.25, 0, 6, 9);
    expect(climbs(p)).toEqual([2]);
    expect(total(p)).toBe(6);
  });

  it('cannot get inside without climbing — a Dash-only move stops short', () => {
    const p = mv.findPath(15.55, 4.25, 12.05, 4.25, 0, -1, 3);
    expect(p.partial).toBe(true);
    expect(climbs(p)).toEqual([]);
  });

  it('dashes first when the Reposition is needed for a later climb', () => {
    const repoFirst = mv.findPath(1.9, 4.75, 6.9, 4.75, 0, 6, 9);
    const dashFirst = mv.findPath(1.9, 4.75, 6.9, 4.75, 3, 9, 9);
    expect(repoFirst.partial || total(repoFirst) > 9).toBe(true);
    expect(dashFirst.partial).toBeFalsy();
    expect(climbs(dashFirst)).toEqual([2]);
    expect(total(dashFirst)).toBe(8);
  });

  it('pointing into the corner presses the base flush into the nook', () => {
    const [gx, gy] = [12.05 + 0.4, 4.25 - 0.4];         // past both walls of the corner
    expect(mv.placeBlocked(gx, gy)).toBeTruthy();
    const [x, y] = mv.nearestFree(gx, gy);
    expect(mv.placeBlocked(x, y)).toBeNull();
    expect(grid.clearAt(x, y) - grid.NAV_R).toBeLessThan(0.03);   // touching terrain
    expect(Math.hypot(x - 12.05, y - 4.25)).toBeLessThan(0.2);
    expect(mv.findPath(10.71, 7.48, x, y, 0, 6, 9).partial).toBeFalsy();
  });

  it('a bigger base presses flush too, just further out', () => {
    const small = grid.NAV_R;
    mv.useBase(0.787);                                    // 40mm
    try {
      const [x, y] = mv.nearestFree(12.05 + 0.4, 4.25 - 0.4);
      expect(mv.placeBlocked(x, y)).toBeNull();
      expect(grid.clearAt(x, y) - 0.787).toBeLessThan(0.03);
    } finally { mv.useBase(small); }
  });

  it('a free spot is left alone; deep inside terrain gives nothing', () => {
    expect(mv.nearestFree(12.05, 4.25)).toEqual([12.05, 4.25]);
    expect(mv.nearestFree(12.05 + 3, 4.25 - 3, undefined, 0, 0.2)).toBeNull();
  });
});

describe('random routes on every map are legal', () => {
  for (const key of ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'y1', 'y2', 'y3', 'y4', 'y5', 'y6', 'volkus', 'gd1', 'gd2']) {
    it(key, () => {
      world.buildWorld(world.MAPS[key]);
      let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      let checked = 0;
      for (let s = 0; s < 4; s++) {
        let sx, sy;
        do { sx = 1 + rnd() * (world.BW - 2); sy = 1 + rnd() * (world.BH - 2); } while (!grid.ptFree(sx, sy));
        for (const [lo, hi, cap] of [[0, 6, 9], [3, 9, 9], [0, -1, 3]]) {
          for (let q = 0; q < 6; q++) {
            const gx = Math.max(0.6, Math.min(world.BW - 0.6, sx + (rnd() - 0.5) * 18));
            const gy = Math.max(0.6, Math.min(world.BH - 0.6, sy + (rnd() - 0.5) * 18));
            if (!grid.ptFree(gx, gy)) continue;
            const raw = mv.findPath(sx, sy, gx, gy, lo, hi, cap);
            if (!raw) continue;
            mv.straightenIncrements(raw);
            const { path: p, total: t, clamped } = mv.clampPath(raw, cap);
            expect(t).toBeLessThanOrEqual(cap);
            expect(mv.pathTotalInches(p)).toBe(mv.chopIncrements(p).reduce((a, st) => a + st.cost, 0));
            for (let i = 1; i < p.length; i++) {
              const la = p[i - 1][4] || 0, lb = p[i][4] || 0;
              if (p[i][2] && la !== lb) {                                             // onto or off an upper floor
                if (grid.layerZ(lb) > grid.layerZ(la)) expect(hi).toBeGreaterThanOrEqual(0);  // a Dash may drop, not climb
                expect(grid.onLayer(la, () => grid.ptFree(p[i - 1][0], p[i - 1][1]))).toBe(true);
                expect(grid.onLayer(lb, () => grid.ptFree(p[i][0], p[i][1]))).toBe(true);
                expect(Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1])).toBeLessThanOrEqual(2 * grid.NAV_R + 1 + 1e-9);
              } else if (p[i][2]) {
                expect(hi).toBeGreaterThanOrEqual(0);                                   // never climb in a Dash
                const z = mv.crossingHeight(p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]);
                expect(Number.isFinite(z) && z > 0).toBe(true);
              } else {
                expect(la).toBe(lb);
                expect(grid.onLayer(la, () => grid.segFree(p[i - 1][0], p[i - 1][1], p[i][0], p[i][1], i === 1 ? grid.startTol(sx, sy) : 0))).toBe(true);
              }
            }
            const end = p[p.length - 1];
            if (!clamped && !raw.partial) expect(end[4] || 0).toBe(0);                  // asked for the table, ends on it
            expect(grid.onLayer(end[4] || 0, () => grid.ptFree(end[0], end[1]))).toBe(true);
            checked++;
          }
        }
      }
      expect(checked).toBeGreaterThan(20);
    });
  }
});
