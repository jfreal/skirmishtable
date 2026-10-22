// Rulesets: the same table and terrain under Kill Team, the Infinity-style rules and the
// made-up Ashfall house rules — different bases, increments, climbing and cover.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as world from '../../src/engine/world.js';
import * as grid from '../../src/engine/grid.js';
import * as mv from '../../src/engine/movement.js';
import * as sight from '../../src/engine/sight.js';
import * as rules from '../../src/rules/index.js';
import * as config from '../../src/config.js';

beforeAll(() => world.initMaps());
afterAll(() => rules.setRuleset('killteam'));
const use = id => { rules.setRuleset(id); world.buildWorld(world.MAPS.v1); };
const total = p => mv.pathTotalInches(p);
const climbs = p => p.filter(q => q[2]).map(q => q[2]);

describe('every ruleset is complete', () => {
  for (const r of Object.values(rules.RULESETS)) {
    it(r.id, () => {
      for (const k of ['id', 'name', 'short', 'blurb', 'baseMm', 'controlRange', 'increment', 'moves', 'climbUp', 'climbDown', 'cover'])
        expect(r[k], k).toBeDefined();
      expect(r.moves.primary.allow({move: 6, wounds: 8, maxW: 8})).toBeGreaterThan(0);
      expect(r.moves.secondary.allow({move: 6, wounds: 8, maxW: 8})).toBeGreaterThan(0);
      use(r.id);
      expect(config.BASE_R).toBeCloseTo(r.baseMm / 25.4 / 2, 6);
      expect(world.OPS.every(o => grid.ptFree(o.x, o.y))).toBe(true);
    });
  }
});

describe('Kill Team', () => {
  beforeAll(() => use('killteam'));
  it('pays whole inches and climbs at least 2″', () => {
    expect(total(mv.findPath(10, 12, 12.4, 12, 0, 6, 9))).toBe(3);
    const p = mv.findPath(15.55, 4.25, 12.05, 4.25, 0, 6, 9);
    expect(climbs(p)).toEqual([2]);
    expect(total(p)).toBe(6);
  });
});

describe('Infinity-style', () => {
  beforeAll(() => use('infinity'));
  it('measures exactly, with no increments', () => {
    expect(total(mv.findPath(10, 12, 12.4, 12, 0, 6, 9))).toBeCloseTo(2.4, 6);
  });
  it('smaller 25mm bases walk into the stronghold through a gap a 28mm base can’t use', () => {
    const p = mv.findPath(10.71, 7.48, 12.05, 4.25, 0, 6, 6);
    expect(p.partial).toBeFalsy();
    expect(climbs(p)).toEqual([]);
    expect(total(p)).toBeLessThan(4);
  });
  it('both moves may climb, and a climb costs just its height', () => {
    expect([mv.climbUp(3), mv.climbDown(3)]).toEqual([3, 0]);
  });
  it('no obscuring at all', () => {
    for (const a of world.OPS.filter(o => o.team === 0)) for (const b of world.OPS.filter(o => o.team === 1))
      expect(sight.sightAnalysis(a, b).obscBy).toBeNull();
  });
});

describe('Ashfall (house rules)', () => {
  beforeAll(() => use('ashfall'));
  it('pays movement in 2″ bounds', () => {
    expect(total(mv.findPath(10, 12, 12.4, 12, 0, 6, 10))).toBe(4);
    const steps = mv.chopIncrements(mv.findPath(10, 12, 15, 12, 0, 6, 10));
    expect(steps.map(s => s.cost)).toEqual([2, 2, 2]);
  });
  it('any climb costs a flat 3″ up and 1″ down', () => {
    expect([mv.climbUp(1), mv.climbDown(1), mv.climbCost(4)]).toEqual([3, 1, 4]);
  });
  it('32mm bases no longer fit the corner nook a 28mm base does', () => {
    expect(grid.ptFree(12.05, 4.25)).toBe(false);
  });
  it('wider cover range: terrain 2″ from the target still gives cover', () => {
    expect(rules.RULES.cover.range).toBe(2);
    const s = sight.sightAnalysis({ x: 7.3, y: 1 }, { x: 12.05, y: 5.2 });
    expect(s.coverBy).not.toBeNull();
  });
});
