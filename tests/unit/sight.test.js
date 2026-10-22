// Line of sight, cover and obscuring on the terrain grid.
import { describe, it, expect, beforeAll } from 'vitest';
import * as world from '../../src/engine/world.js';
import * as sight from '../../src/engine/sight.js';

beforeAll(() => { world.initMaps(); world.buildWorld(world.MAPS.v1); });
const at = (x, y) => ({ x, y });

describe('sight on Volkus AO 1', () => {
  const nooked = at(12.05, 4.25);   // tucked into the stronghold's corner

  it('a nooked operative is visible but in cover from the wall beside it', () => {
    const s = sight.sightAnalysis(at(7.3, 1), nooked);
    expect(s.visible).toBe(true);
    expect(s.coverBy && s.coverBy.id).toBe('Stronghold 1');
    expect(s.obscBy).toBeNull();
    expect(s.coverBy.w).toBeLessThan(3);   // the wall section crossed, not the whole building
  });

  it('walls block sight completely from behind the stronghold', () => {
    expect(sight.sightAnalysis(at(1, 2.4), nooked).visible).toBe(false);
  });

  it('light terrain gives cover but never blocks a sight line', () => {
    // the free-standing light rubble north of the right-hand stronghold
    expect(sight.lineBlocked(19.5, 2.5, 21.5, 2.5)).toBe(false);
  });

  it('the shadow polygon from an eye point closes around the board', () => {
    const poly = sight.visibilityPolygon(10, 11);
    expect(poly).toHaveLength(720);
    for (const [x, y] of poly) {
      expect(x).toBeGreaterThanOrEqual(-1e-6); expect(x).toBeLessThanOrEqual(world.BW + 1e-6);
      expect(y).toBeGreaterThanOrEqual(-1e-6); expect(y).toBeLessThanOrEqual(world.BH + 1e-6);
    }
  });
});
