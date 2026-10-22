// Base sizes per operative: a model's measured base snaps to 28/32/40mm, and that base is
// what ranges, engagement and routing use.
import { describe, it, expect, beforeAll } from 'vitest';
import * as world from '../../src/engine/world.js';
import * as mv from '../../src/engine/movement.js';
import { BASE_R, snapBase } from '../../src/config.js';
import { opGap, opR } from '../../src/engine/geometry.js';
import { engagements } from '../../src/engine/engage.js';

describe('snapBase', () => {
  it('rounds a measured base to the nearest real size', () => {
    expect([27.2, 28.9, 31, 33.5, 38, 41.9].map(snapBase)).toEqual([28, 28, 32, 32, 40, 40]);
  });
  it("doesn't trust a measurement far from every size", () => {
    expect([10, 60, 0, NaN, undefined].map(snapBase)).toEqual([null, null, null, null, null]);
  });
});

describe('per-operative bases', () => {
  // two walls with a 1.4″ gap between them: a 28mm base (1.10″) fits, a 40mm (1.57″) doesn't
  const gapMap = () => world.buildWorld({
    name: 'gap', w: 20, h: 16, objectives: [], terrain: [
      {id: 'wall N', kind: 'wall', x: 9, y: 2.5, w: 1, h: 4.8, z: 6},
      {id: 'wall S', kind: 'wall', x: 9, y: 8.7, w: 1, h: 4.8, z: 6},
    ], spawns: [[[2, 8]], [[18, 8]]],
  });
  beforeAll(() => world.initMaps());

  it('radius from op.base, else the ruleset', () => {
    expect(opR({})).toBe(BASE_R);
    expect(opR({base: 40})).toBeCloseTo(40 / 50.8, 9);
    expect(opGap({x: 0, y: 0, base: 40}, {x: 3, y: 0, base: 32})).toBeCloseTo(3 - 20 / 25.4 - 16 / 25.4, 9);
  });

  it('engagement range counts from each base edge', () => {
    world.buildWorld(world.MAPS.v1);
    const [a, b] = [world.OPS.find(o => o.id === 'A1'), world.OPS.find(o => o.id === 'B1')];
    a.x = 15; a.y = 11; b.y = 11;
    b.x = 15 + 2 * BASE_R + 1.1;                 // 28mm bases: 1.1″ apart, not engaged
    expect(engagements()).toEqual([]);
    a.base = 40;                                  // the bigger base reaches into range
    expect(engagements()).toEqual([[a, b]]);
  });

  it('a 40mm base is routed round a gap a 28mm base slips through', () => {
    gapMap();
    mv.useBase(BASE_R);
    const small = mv.findPath(7, 8, 12, 8, 0, -1);
    expect(mv.pathTotalInches(small)).toBe(5);    // straight through the gap
    mv.useBase(40 / 50.8);
    expect(mv.placeBlocked(9.5, 8, null)).toEqual({id: 'terrain'});
    const big = mv.findPath(7, 8, 12, 8, 0, -1);
    expect(big.some(([x, y]) => x > 8.4 && x < 10.6 && y > 6.6 && y < 9.4)).toBe(false);
    expect(mv.pathTotalInches(big)).toBeGreaterThan(5);
    mv.useBase(BASE_R);                           // and back: the 28mm route is unchanged
    expect(mv.pathTotalInches(mv.findPath(7, 8, 12, 8, 0, -1))).toBe(5);
  });
});
