// Every built-in killzone builds headlessly, matches its map card's deployment, and
// starts with all operatives on open ground.
import { describe, it, expect, beforeAll } from 'vitest';
import * as world from '../../src/engine/world.js';
import * as grid from '../../src/engine/grid.js';
import { BASE_R } from '../../src/config.js';

beforeAll(() => world.initMaps());

// deployment edge per map, checked against the official card images (tools/verify_maps.py)
const CARD_DEPLOYMENT = {
  v1: 'short', v2: 'short', v3: 'short', v4: 'long', v5: 'long', v6: 'long',
  y1: 'short', y2: 'short', y3: 'short', y4: 'long', y5: 'long', y6: 'long',
};

describe('built-in maps', () => {
  it('registers all twelve Volkus layouts plus the hand-made and Gallowdark maps', () => {
    const keys = Object.keys(world.MAPS).filter(k => world.MAPS[k]);
    expect(keys).toEqual(['volkus', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'y1', 'y2', 'y3', 'y4', 'y5', 'y6', 'gd1', 'gd2']);
  });

  for (const [key, edge] of Object.entries(CARD_DEPLOYMENT)) {
    it(`${key}: card deployment, 3 objectives, 14 traced pieces, roster on free ground`, () => {
      world.buildWorld(world.MAPS[key]);
      expect(world.MAP.fine).toBe(true);
      expect(world.MAP.dropEdge).toBe(edge);
      expect(world.OBJECTIVES).toHaveLength(3);
      expect(grid.FEATS.length - 1).toBe(14);
      expect(world.TERRAIN.length).toBeGreaterThan(900);   // merged footprint rects
      expect(world.OPS).toHaveLength(12);
      for (const op of world.OPS) {
        expect(grid.ptFree(op.x, op.y)).toBe(true);
        const dz = world.DROPZONES[op.team];
        expect(op.x).toBeGreaterThanOrEqual(dz.x); expect(op.x).toBeLessThanOrEqual(dz.x + dz.w);
        expect(op.y).toBeGreaterThanOrEqual(dz.y); expect(op.y).toBeLessThanOrEqual(dz.y + dz.h);
      }
    });
  }

  it('Gallowdark maps keep every hatchway open: free space is one connected area', () => {
    for (const key of ['gd1', 'gd2']) {
      world.buildWorld(world.MAPS[key]);
      expect(componentAreas()[0]).toBeGreaterThan(430);
      expect(componentAreas()).toHaveLength(1);
    }
  });

  it('Volkus strongholds are enclosed: their interiors are separate free areas (reached by climbing)', () => {
    world.buildWorld(world.MAPS.v1);
    const areas = componentAreas();
    expect(areas[0]).toBeGreaterThan(350);
    expect(areas.slice(1, 3).every(a => a > 15)).toBe(true);
  });

  it('a 28mm base fits exactly where the clearance is at least its radius', () => {
    world.buildWorld(world.MAPS.v1);
    expect(grid.clearAt(12.05, 4.25)).toBeGreaterThanOrEqual(BASE_R);   // the stronghold corner nook
    expect(grid.ptFree(12.05, 4.25)).toBe(true);
    expect(grid.ptFree(BASE_R - 0.01, 10)).toBe(false);                 // past the board edge
  });
});

// areas (sq in) of the 8-connected free-cell components, largest first
function componentAreas() {
  const { nx, ny, n, free } = grid.G, lab = new Int32Array(n).fill(-1), sizes = [];
  for (let k = 0; k < n; k++) {
    if (!free[k] || lab[k] >= 0) continue;
    const id = sizes.length, st = [k]; let sz = 0; lab[k] = id;
    while (st.length) {
      const u = st.pop(); sz++;
      const i = u % nx, j = (u / nx) | 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const m = jj * nx + ii;
        if (free[m] && lab[m] < 0) { lab[m] = id; st.push(m); }
      }
    }
    sizes.push(sz * grid.GRES * grid.GRES);
  }
  return sizes.sort((a, b) => b - a).filter(a => a > 1);
}
