// The demo scatter (most of each side off its drop zone, mostly near cover) and
// engagement range (enemy bases within control range of each other).
import { describe, it, expect, beforeAll } from 'vitest';
import * as world from '../../src/engine/world.js';
import * as grid from '../../src/engine/grid.js';
import { BASE_R } from '../../src/config.js';
import { mulberry32 } from '../../src/engine/geometry.js';
import { engagements, foesNear } from '../../src/engine/engage.js';

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
