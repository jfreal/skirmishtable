// Line of sight, cover and obscuring on the terrain grid.
import { describe, it, expect, beforeAll } from 'vitest';
import * as world from '../../src/engine/world.js';
import * as sight from '../../src/engine/sight.js';

beforeAll(() => { world.initMaps(); world.buildWorld(world.MAPS.v1); });
const at = (x, y) => ({ x, y });

describe('sight on Volkus AO 1', () => {
  const nooked = at(12.05, 4.25);   // tucked into the stronghold's corner

  it('a base flush against a scanned wall gets no cover from it when shot from its own side', () => {
    // the base presses into the wall's traced cells; its sight samples must not
    const s = sight.sightAnalysis(at(7.71, 8.83), at(9.0, 4.0));
    expect(s.visible).toBe(true);
    expect(s.coverBy).toBeNull();
    expect(s.hardCover).toBe(false);
  });

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

  it('a sight cone fans between the tangents to the whole target base', () => {
    const b = {...nooked, base: 32}, R = 32 / 50.8, d = Math.hypot(b.x - 7.3, b.y - 1);
    const rays = sight.sightCone(7.3, 1, b, 16);
    expect(rays).toHaveLength(17);
    const tangent = Math.sqrt(d * d - R * R);
    expect(rays[0].far).toBeCloseTo(tangent, 3);
    expect(rays[16].far).toBeCloseTo(tangent, 3);
    expect(rays[8].far).toBeCloseTo(d + R, 3);   // the middle ray runs through the centre
    expect(sight.sightCone(b.x, b.y, b)).toBeNull();
  });

  it('a sight cone from behind the stronghold is stopped all the way across', () => {
    const rays = sight.sightCone(1, 2.4, nooked);
    expect(rays.every(r => r.stop !== null)).toBe(true);
    const shade = sight.coneShadows(1, 2.4, rays);
    expect(shade).toHaveLength(1);
    expect(shade[0]).toHaveLength(2 * rays.length);
  });

  it('cone shadows cover each stopped run, half way out to the clear rays', () => {
    const ray = (a, stop) => ({ux: Math.cos(a), uy: Math.sin(a), far: 10, stop});
    const rays = [ray(0, null), ray(0.1, 4), ray(0.2, 4), ray(0.3, null), ray(0.4, 6)];
    const shade = sight.coneShadows(0, 0, rays);
    expect(shade).toHaveLength(2);
    expect(shade[0]).toHaveLength(8);                           // 2 stopped rays + 2 half-way rays
    expect(Math.atan2(shade[0][0][1], shade[0][0][0])).toBeCloseTo(0.05, 6);
    expect(Math.hypot(...shade[0][0])).toBeCloseTo(4, 6);       // starts where the terrain stops it
    expect(Math.hypot(...shade[0][7])).toBeCloseTo(10, 6);      // ends on the far side of the base
    expect(shade[1]).toHaveLength(4);                           // the last ray: only one neighbour
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
