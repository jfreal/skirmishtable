// Threat ranges: where a ready enemy could charge a base, or shoot it from inside the cover
// void after moving twice, judged for the mover's base centre on small hand-made boards.
import { describe, it, expect, afterAll } from 'vitest';
import * as world from '../../src/engine/world.js';
import * as rules from '../../src/rules/index.js';
import { BASE_R } from '../../src/config.js';
import { threatMap, threatsAt } from '../../src/engine/threat.js';

afterAll(() => rules.setRuleset('killteam'));
// a bare 40" x 12" board with just the given terrain rects, one enemy (B1) and one mover (A1)
function board(enemy, terrain = [], kind = 'marksman') {
  world.buildWorld({
    name: 'test', w: 40, h: 12, objectives: [],
    terrain: terrain.map((t, i) => ({id: `${t.kind} ${i + 1}`, z: 3, ...t})),
    spawns: [[[1, 1]], [[39, 11]]],
  });
  world.OPS.length = 0;
  const mover = world.mkOp('A1', 0, 'Mover', 'marksman', 1, 1);
  const foe = Object.assign(world.mkOp('B1', 1, 'Foe', kind, 6, 6), enemy);
  world.OPS.push(mover, foe);
  return {mover, foe, map: threatMap(mover)};
}
const at = (map, x, y) => { const t = threatsAt(map, x, y); return [t.charge.length > 0, t.close.length > 0]; };

describe('Kill Team (2024) threat ranges', () => {
  // Move 6: Charge 8", then 1" base to base. Shooting from within 2": APL 2 = Reposition 6"
  // then Shoot; APL 3 (the leader) = Reposition 6" + Dash 3" then Shoot.
  const edgeCharge = 6 + 8 + 2 * BASE_R + 1, edgeClose2 = 6 + 6 + 2 * BASE_R + 2, edgeClose3 = 6 + 9 + 2 * BASE_R + 2;

  it('charge reach is Move + 2", then control range, edge to edge', () => {
    const {map} = board({});
    expect(at(map, edgeCharge - 0.25, 6)[0]).toBe(true);
    expect(at(map, edgeCharge + 0.25, 6)[0]).toBe(false);
  });

  it('APL 2: cover breaks inside 2" after a Reposition only (no AP left to Dash and Shoot)', () => {
    const {map} = board({});
    expect(at(map, edgeClose2 - 0.25, 6)).toEqual([true, true]);
    expect(at(map, edgeClose2 + 0.25, 6)).toEqual([true, false]);   // charge reaches further
  });

  it('APL 3: Reposition + Dash, then Shoot, reaches further than the charge', () => {
    const {map} = board({}, [], 'leader');
    expect(at(map, edgeCharge + 0.25, 6)).toEqual([false, true]);
    expect(at(map, edgeClose3 - 0.25, 6)[1]).toBe(true);
    expect(at(map, edgeClose3 + 0.25, 6)[1]).toBe(false);
  });

  it('APL 1: shoots from where it stands', () => {
    const {map} = board({apl: 1});
    const edge = 6 + 2 * BASE_R + 2;
    expect(at(map, edge - 0.25, 6)[1]).toBe(true);
    expect(at(map, edge + 0.25, 6)[1]).toBe(false);
  });

  it('only enemies that are still ready threaten', () => {
    const {map} = board({ready: false});
    expect(map.foes).toEqual([]);
    expect(at(map, 8, 6)).toEqual([false, false]);
  });

  it('a wall between makes the enemy go round it, and the reach does not pass through it', () => {
    // an 8" heavy wall (too tall to climb within 9") from the top edge to 2" from the bottom
    const {map} = board({}, [{kind: 'heavy', x: 8, y: 0, w: 0.5, h: 10, z: 8}]);
    expect(at(map, 10, 2)).toEqual([false, false]);     // 4" away as the crow flies, ~13" round the end
    expect(at(map, 9.2, 4)).toEqual([false, false]);    // within 2" of the enemy's side, but through the wall
    expect(at(map, 10, 10)).toEqual([true, true]);      // round the end
  });

  it('an injured enemy moves 2" less', () => {
    const {map, foe} = board({wounds: 3});
    expect(foe.wounds < foe.maxW / 2).toBe(true);
    expect(at(map, edgeCharge - 2.25, 6)[0]).toBe(true);
    expect(at(map, edgeCharge - 1.75, 6)[0]).toBe(false);
  });
});

describe('other rulesets', () => {
  it('Infinity-style has no charge and no cover void, so no zones', () => {
    rules.setRuleset('infinity');
    const {map} = board({});
    expect(at(map, 7.5, 6)).toEqual([false, false]);
    rules.setRuleset('killteam');
  });
});
