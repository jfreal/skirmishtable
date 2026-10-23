// Upper floors: finding them, climbing onto them, dropping off them (the free 2" is per
// action), and what standing up there changes (engagement, Vantage).
import { describe, it, expect, beforeAll } from 'vitest';
import * as world from '../../src/engine/world.js';
import * as grid from '../../src/engine/grid.js';
import * as mv from '../../src/engine/movement.js';
import { foesNear } from '../../src/engine/engage.js';
import { standing } from '../../src/engine/shots.js';

beforeAll(() => world.initMaps());
const total = p => mv.pathTotalInches(p);
const level = name => grid.LEVELS.find(L => L.name === name);

describe('finding upper floors', () => {
  it('Volkus AO 1: both strongholds at 2.5", both large ruins at 3"', () => {
    world.buildWorld(world.MAPS.v1);
    expect(grid.LEVELS.map(L => [L.name, L.z]).sort()).toEqual(
      [['Large ruin 1', 3], ['Large ruin 2', 3], ['Stronghold 1', 2.5], ['Stronghold 2', 2.5]]);
    for (const L of grid.LEVELS) expect(L.free.some(f => f)).toBe(true);   // a base fits up there
  });

  it('maps without upper floors have none', () => {
    for (const key of ['volkus', 'gd1']) {
      world.buildWorld(world.MAPS[key]);
      expect(grid.LEVELS).toEqual([]);
    }
  });
});

describe('climbing onto and dropping off a floor (Volkus AO 1, Large ruin 1)', () => {
  let L;
  beforeAll(() => { world.buildWorld(world.MAPS.v1); L = level('Large ruin 1'); });

  it('a Reposition climbs 3" up onto the floor (3" floor) and walks on', () => {
    const p = mv.findPath(10.5, 17.55, 12.35, 18.35, 0, 6, 9, 0, L.l);
    expect(p.partial).toBeFalsy();
    expect(p[p.length - 1][4]).toBe(L.l);
    const st = mv.chopIncrements(p).filter(s => s.climb);
    expect(st.map(s => [s.kind, s.up, s.down])).toEqual([['up', 3, 0]]);
    expect(total(p)).toBe(6);
  });

  it('a Dash can\'t climb up', () => {
    const p = mv.findPath(10.5, 17.55, 12.35, 18.35, 0, -1, 3, 0, L.l);
    expect(p === null || p.partial || p[p.length - 1][4] !== L.l).toBe(true);
  });

  it('a Dash can drop off: 3" down, the first 2" free', () => {
    const p = mv.findPath(11.15, 17.55, 10.3, 17.55, 0, -1, 3, L.l, 0);
    expect(p.partial).toBeFalsy();
    expect(mv.clampPath(p, 3).clamped).toBe(false);                   // fits the Dash's 3"
    expect(p[p.length - 1][4] || 0).toBe(0);
    expect(mv.chopIncrements(p).filter(s => s.climb).map(s => [s.kind, s.down])).toEqual([['drop', 1]]);
    expect(total(p)).toBe(2);                                         // 1" across + 1" of the 3" drop
  });

  it('a drop further than the Dash allows stops on the floor (all or nothing)', () => {
    const p = mv.findPath(12.35, 18.35, 10.5, 17.55, 0, -1, 3, L.l, 0);
    expect(total(p)).toBe(4);
    const c = mv.clampPath(p, 3);
    expect(c.clamped).toBe(true);
    expect(c.path[c.path.length - 1][4]).toBe(L.l);
  });

  it('only operatives on the same layer get in the way', () => {
    const op = world.OPS[0], other = world.OPS[1];
    const [x, y] = [12.35, 18.35];
    Object.assign(other, {x, y, z: 0});                  // on the table under the floor... (if it fits)
    expect(mv.placeBlocked(x, y, op.id, L.l)).toBe(null);
    Object.assign(other, {z: L.z});
    expect(mv.placeBlocked(x, y, op.id, L.l)).toEqual({id: other.name});
    expect(mv.opLayer(other)).toBe(L.l);
    world.rosterInit();
  });
});

describe('the free 2" of dropping is for the whole action', () => {
  beforeAll(() => world.buildWorld(world.MAPS.volkus));
  // two climbs over 3" terrain: up 3" each, and 3" down each
  const two = () => [[2, 2, 0, 0, 0], [4, 2, 3, 0, 0], [6, 2, 3, 0, 0]];

  it('one action: the second drop pays its full height', () => {
    expect(mv.legCosts(two()).slice(1).map(c => c.cost)).toEqual([2 + 3 + 1, 2 + 3 + 3]);
    expect(total(two())).toBe(14);
  });

  it('a second action (path.split) gets its own free 2"', () => {
    const p = two(); p.split = 6;
    expect(mv.legCosts(p).slice(1).map(c => c.cost)).toEqual([6, 6]);
    expect(mv.chopIncrements(p).reduce((a, s) => a + s.cost, 0)).toBe(12);
  });
});

describe('standing on a floor', () => {
  beforeAll(() => world.buildWorld(world.MAPS.v1));

  it('is a Vantage Point at the floor\'s height', () => {
    const L = level('Stronghold 1');
    const k = L.free.findIndex(f => f), x = (L.i0 + k % L.w + 0.5) * grid.GRES, y = (L.j0 + (k / L.w | 0) + 0.5) * grid.GRES;
    expect(standing({x, y, z: L.z})).toEqual({z: 2.5, vantage: true});
    expect(standing({x, y, z: 0})).toEqual({z: 0, vantage: false});
  });

  it('isn\'t engaged with an enemy on the table right below', () => {
    const a = world.OPS.find(o => o.team === 0), b = world.OPS.find(o => o.team === 1);
    Object.assign(a, {x: 12.35, y: 18.35, z: 3}); Object.assign(b, {x: 12.35, y: 18.35, z: 0});
    expect(foesNear(a.x, a.y, a.team, a.id, 0.55, 3)).not.toContain(b);
    expect(foesNear(a.x, a.y, a.team, a.id, 0.55, 0)).toContain(b);
    world.rosterInit();
  });
});
