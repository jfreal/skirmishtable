// The demo scatter (most of each side off its drop zone, mostly near cover) and
// engagement range (enemy bases within control range of each other).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import * as world from '../../src/engine/world.js';
import * as grid from '../../src/engine/grid.js';
import { BASE_R } from '../../src/config.js';
import { mulberry32 } from '../../src/engine/geometry.js';
import { engagements, foesNear } from '../../src/engine/engage.js';
import * as mv from '../../src/engine/movement.js';
import * as rules from '../../src/rules/index.js';

beforeAll(() => world.initMaps());
const inZone = o => { const dz = world.DROPZONES[o.team]; return o.x >= dz.x && o.x <= dz.x + dz.w && o.y >= dz.y && o.y <= dz.y + dz.h; };

describe('demo scatter', () => {
  for (const key of ['v1', 'y4', 'volkus', 'gd1']) it(key, () => {
    world.buildWorld(world.MAPS[key]);
    const before = world.OPS.map(o => [o.x, o.y]);
    world.scatterRoster(mulberry32(7));
    let moved = 0, covered = 0;
    world.OPS.forEach((o, i) => {
      expect(grid.ptFree(o.x, o.y)).toBe(true);
      if (o.x === before[i][0] && o.y === before[i][1]) return;
      moved++;
      if (grid.clearAt(o.x, o.y) - BASE_R <= 1) covered++;
    });
    expect(moved).toBe(8);                         // 4 of 6 per side
    expect(covered).toBeGreaterThanOrEqual(6);     // 3 of those 4 near cover
    expect(world.OPS.filter(inZone).length).toBeGreaterThanOrEqual(4);
    for (const a of world.OPS) for (const b of world.OPS)
      if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(2 * BASE_R);
    expect(engagements()).toEqual([]);             // nobody starts engaged
  });
});

describe('engagement range', () => {
  it('pairs enemy bases within 1″ edge to edge', () => {
    world.buildWorld(world.MAPS.v1);
    const [a, b] = [world.OPS.find(o => o.id === 'A1'), world.OPS.find(o => o.id === 'B1')];
    a.x = 15; a.y = 11; b.x = 15 + 2 * BASE_R + 0.9; b.y = 11;
    expect(engagements()).toEqual([[a, b]]);
    expect(foesNear(15, 11, 0, 'A1')).toEqual([b]);
    b.x = 15 + 2 * BASE_R + 1.1;
    expect(engagements()).toEqual([]);
  });
});

// Routing round control range, on an empty board so only the operatives matter.
describe('control range and movement', () => {
  const R = BASE_R, reach = 2 * BASE_R + 1;           // centre distance at which 28mm bases are within 1″
  let a, b1, b2;
  beforeEach(() => {
    world.buildWorld({...world.MAPS.volkus, terrain: []});
    for (const o of world.OPS) o.alive = false;
    [a, b1, b2] = ['A1', 'B1', 'B2'].map(id => Object.assign(world.OPS.find(o => o.id === id), {alive: true}));
    a.x = 5; a.y = 11; b1.x = 14; b1.y = 11; b2.alive = false;
    mv.useBase(R);
  });
  // centre distance to `o` at every 0.02″ along the route
  const along = (p, o) => {
    const out = [];
    for (let i = 1; i < p.length; i++) for (let s = 0; s <= 50; s++)
      out.push(Math.hypot(p[i-1][0] + (p[i][0] - p[i-1][0]) * s / 50 - o.x, p[i-1][1] + (p[i][1] - p[i-1][1]) * s / 50 - o.y));
    return out;
  };
  const end = p => p[p.length - 1];

  it('a normal move goes round an enemy\'s control range, not through it', () => {
    const p = mv.planRoute(a, 23, 11, 0, 30, 30, false);
    expect(p.partial).toBeFalsy();
    expect(Math.min(...along(p, b1))).toBeGreaterThanOrEqual(reach - 1e-6);
    expect(mv.pathTotalInches(p)).toBeGreaterThan(18);
  });

  it('a normal move into control range stops outside it', () => {
    const p = mv.planRoute(a, 14 - 2 * R - 0.5, 11, 0, 30, 30, false);
    expect(p.partial).toBe(true);
    expect(Math.min(...along(p, b1))).toBeGreaterThanOrEqual(reach - 1e-6);
  });

  it('a Charge straight in is one straight leg', () => {
    const p = mv.planRoute(a, 14 - 2 * R - 0.5, 11, 0, 30, 30, true);
    expect(p.length).toBe(2);
    expect(foesNear(end(p)[0], end(p)[1], 0, 'A1')).toEqual([b1]);
  });

  it('a Charge round to the far side stays within control range once it is in', () => {
    const p = mv.planRoute(a, 14 + 2 * R + 0.5, 11, 0, 30, 30, true);
    expect(p.partial).toBeFalsy();
    expect(end(p)[0]).toBeCloseTo(14 + 2 * R + 0.5);
    const d = along(p, b1), first = d.findIndex(v => v <= reach + 1e-6);
    expect(first).toBeGreaterThan(0);
    for (const v of d.slice(first)) { expect(v).toBeLessThanOrEqual(reach + 1e-6); expect(v).toBeGreaterThanOrEqual(2 * R - 1e-6); }
  });

  it('a Charge goes round another enemy\'s control range on the way in', () => {
    b2.alive = true; b2.x = 9.5; b2.y = 11;
    const p = mv.planRoute(a, 14 - 2 * R - 0.5, 11, 0, 30, 30, true);
    expect(p.partial).toBeFalsy();
    expect(Math.min(...along(p, b2))).toBeGreaterThanOrEqual(reach - 1e-6);
    expect(foesNear(end(p)[0], end(p)[1], 0, 'A1')).toEqual([b1]);
  });

  it('rules without a Charge (Infinity) still move into base contact', () => {
    rules.setRuleset('infinity');
    try {
      world.buildWorld({...world.MAPS.volkus, terrain: []});
      const [x, b] = ['A1', 'B1'].map(id => world.OPS.find(o => o.id === id));
      for (const o of world.OPS) o.alive = o === x || o === b;
      x.x = 5; x.y = 11; b.x = 14; b.y = 11;
      mv.useBase(BASE_R);
      const p = mv.planRoute(x, 14 - 2 * BASE_R - 0.05, 11, 0, 30, 30, false);
      expect(p.length).toBe(2);
      expect(p.partial).toBeFalsy();
    } finally { rules.setRuleset('killteam'); }
  });

  it('routing leaves the zones off afterwards', () => {
    mv.planRoute(a, 23, 11, 0, 30, 30, true);
    expect(grid.ZONES).toBe(null);
    expect(grid.ptFree(14 - 2 * R - 0.5, 11)).toBe(true);
  });
});
