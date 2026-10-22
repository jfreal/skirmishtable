// Valid shots: base-to-base cover lines, heavy vs light terrain, the cover and obscuring
// distances, the Conceal order and Vantage Points, friends in melee with the target, and
// when the shooter can't Shoot at all, judged on small hand-made boards under all three
// rulesets.
import { describe, it, expect, afterAll } from 'vitest';
import * as world from '../../src/engine/world.js';
import * as sight from '../../src/engine/sight.js';
import * as shots from '../../src/engine/shots.js';
import * as rules from '../../src/rules/index.js';
import * as config from '../../src/config.js';
import { perimeterPts } from '../../src/engine/geometry.js';
import { rollDefence } from '../../src/engine/dice.js';

afterAll(() => rules.setRuleset('killteam'));
// a bare 24" x 12" board with just the given terrain rects
const board = (...terrain) => world.buildWorld({
  name: 'test', w: 24, h: 12, objectives: [],
  terrain: terrain.map((t, i) => ({id: t.id || `${t.kind} ${i + 1}`, z: 3, ...t})),
  spawns: [[[1, 1]], [[23, 11]]],
});
const use = id => rules.setRuleset(id);
const op = (x, y, order = 'engage') => ({x, y, order});
const kind = (a, b) => shots.judgeShot(a, b).kind;
// put exactly these operatives on the board: [id, team, x, y, order?]
const ops = (...list) => world.OPS.splice(0, world.OPS.length,
  ...list.map(([id, team, x, y, order = 'engage']) => ({id, name: id, team, x, y, order, alive: true})));
const opById = id => world.OPS.find(o => o.id === id);
// the shot from A1 (team 0) at another operative, A1 being the eye
const shotAt = (id, extra = {}) => { const a = opById('A1'); return shots.judgeShot({x: a.x, y: a.y, team: 0, op: a, ...extra}, opById(id)); };

// Attacker on the left, target 9" to its right, on the same row.
const A = op(3, 6), B = op(12, 6);
const heavyWall = {kind: 'heavy', x: 7, y: 3, w: 1, h: 6};          // hides the whole target
const heavyPart = {kind: 'heavy', x: 7, y: 5.9, w: 1, h: 3.1};      // cuts across the lower half, far from both
const lightPart = {...heavyPart, kind: 'light'};
const lightNear = {kind: 'light', x: 11, y: 5, w: 0.3, h: 2};       // right in front of the target
const heavyNear = {kind: 'heavy', x: 11, y: 6.1, w: 0.3, h: 2};     // low wall beside the target, part of it

describe('Kill Team (2024) shots', () => {
  it('open ground is a clear shot', () => {
    use('killteam'); board();
    const j = shots.judgeShot(A, B);
    expect(j.kind).toBe('clear');
    expect(j.sight.visible).toBe(true);
    expect(j.line).toBeTruthy();
    expect(j.range).toBeCloseTo(9 - 2 * 0.551, 2);
  });

  it('heavy terrain across every line means no line of sight', () => {
    use('killteam'); board(heavyWall);
    expect(kind(A, B)).toBe('hidden');
  });

  it('heavy terrain crossing some cover lines, far from both, obscures', () => {
    use('killteam'); board(heavyPart);
    const j = shots.judgeShot(A, B);
    expect(j.kind).toBe('obscured');
    expect(j.sight.visible).toBe(true);
    expect(j.sight.coverBy).toBeNull();
    // the deciding line runs from the chosen attacker point to the target's base
    expect(j.line[0]).toEqual(j.sight.from);
    expect(Math.hypot(j.line[1][0] - B.x, j.line[1][1] - B.y)).toBeLessThan(0.6);
  });

  it('the same footprint as light terrain neither blocks nor obscures', () => {
    use('killteam'); board(lightPart);
    expect(sight.lineBlocked(3, 6.5, 12, 6.5)).toBe(false);
    expect(kind(A, B)).toBe('clear');
  });

  it('light terrain within 1" of the target gives cover', () => {
    use('killteam'); board(lightNear);
    const j = shots.judgeShot(A, B);
    expect(j.kind).toBe('cover');
    expect(j.sight.coverBy.kind).toBe('light');
    expect(j.sight.obscBy).toBeNull();
  });

  it('heavy terrain within 1" of the target gives cover, not obscuring', () => {
    use('killteam'); board(heavyNear);
    expect(kind(A, B)).toBe('cover');
  });

  it('terrain 1" or more from the target gives no cover', () => {
    use('killteam'); board({...lightNear, x: 9.8});        // 1.1" from the base edge
    expect(kind(A, B)).toBe('clear');
  });

  it('a Concealed operative in cover is not a valid target; on Engage it is', () => {
    use('killteam'); board(lightNear);
    expect(kind(A, op(12, 6, 'conceal'))).toBe('concealed');
    expect(kind(A, op(12, 6, 'engage'))).toBe('cover');
    // Conceal without cover is still a clear shot
    board();
    expect(kind(A, op(12, 6, 'conceal'))).toBe('clear');
  });

  it('within 2" there is no cover', () => {
    use('killteam'); board(lightNear);
    expect(kind(op(9.2, 6), B)).toBe('clear');               // 1.7" base to base
  });

  it('the attacker draws cover lines from whichever base point suits it best', () => {
    // A small light piece south-east of the line A -> B: the lines from A's east edge
    // cross it, the lines from A's west edge miss it. The attacker picks the west edge.
    use('killteam'); board({kind: 'light', x: 5.3, y: 7.4, w: 0.5, h: 0.4});
    const s = sight.sightAnalysis(op(5, 5), op(5, 9));
    expect(s.coverBy).toBeNull();
    expect(s.from[0]).toBeLessThan(5.3);
    expect(kind(op(5, 5), op(5, 9, 'conceal'))).toBe('clear');
  });
});

describe('Kill Team (2024): obscured more than 1" from the shooter and 2" from the target', () => {
  // the same heavy piece across the lower half of the lines, moved towards the target
  const piece = x => ({kind: 'heavy', x, y: 5.9, w: 0.3, h: 3.1});

  it('heavy terrain over 2" from the target obscures, and an obscured target is still valid', () => {
    use('killteam'); board(piece(8.9));                    // about 2.3" from the target's base
    const j = shots.judgeShot(A, B);
    expect(j.kind).toBe('obscured');
    expect(shots.SHOT_KINDS[j.kind].valid).toBe(true);
    expect(j.save).toBeNull();
  });

  it('between 1" and 2" from the target it neither obscures nor gives cover', () => {
    use('killteam'); board(piece(9.7));                    // about 1.5" from the target's base
    const s = sight.sightAnalysis(A, B);
    expect(s.obscBy).toBeNull();
    expect(s.coverBy).toBeNull();
    expect(kind(A, B)).toBe('clear');
  });

  it('an obscured target is a valid one on Conceal too', () => {
    use('killteam'); board(heavyPart);
    expect(kind(A, op(12, 6, 'conceal'))).toBe('obscured');
  });

  it('within 2" nothing obscures and nothing gives cover', () => {
    // With Kill Team's numbers obscuring can't happen inside 2" anyway (1" + 2" > 2"), so
    // tighten them for this check: the same heavy strip obscures from 2.5" but not 1.9".
    use('killteam'); board({kind: 'heavy', x: 10.4, y: 5.9, w: 0.2, h: 3.1});
    const keep = rules.RULES.obscure;
    try {
      rules.RULES.obscure = {fromShooter: 0, fromTarget: 0};
      expect(kind(op(8.4, 6), B)).toBe('obscured');        // 2.5" base to base
      expect(kind(op(9, 6), B)).toBe('clear');             // 1.9": no obscuring, and no cover
    } finally { rules.RULES.obscure = keep; }
  });

  it('the ruleset holds the two distances', () => {
    expect(rules.RULESETS.killteam.obscure).toEqual({fromShooter: 1, fromTarget: 2});
  });
});

describe('Kill Team (2024): other operatives give no cover', () => {
  it('the base of another operative right in front of the target gives no cover', () => {
    use('killteam'); board();
    ops(['A1', 0, 3, 6], ['B1', 1, 12, 6], ['B2', 1, 10.6, 6]);
    const j = shotAt('B1');
    expect(j.kind).toBe('clear');
    expect(j.inCover).toBe(false);
    expect(j.sight.coverBy).toBeNull();
    expect(j.sight.obscBy).toBeNull();
  });

  it('a friendly base in front of the target gives no cover either', () => {
    use('killteam'); board();
    ops(['A1', 0, 3, 6], ['B1', 1, 12, 6], ['A2', 0, 9, 6]);
    expect(shotAt('B1').kind).toBe('clear');
  });

  it('a Concealed target behind another operative is still a valid target', () => {
    use('killteam'); board();
    ops(['A1', 0, 3, 6], ['B1', 1, 12, 6, 'conceal'], ['B2', 1, 10.6, 6]);
    expect(shotAt('B1').kind).toBe('clear');
  });
});

describe('Kill Team (2024): Conceal and Vantage Points', () => {
  it('Conceal in light or heavy cover is not a valid target', () => {
    use('killteam'); board(lightNear);
    const j = shots.judgeShot(A, op(12, 6, 'conceal'));
    expect(j.kind).toBe('concealed');
    expect(j.vantage).toBe(false);
    board(heavyNear);
    expect(kind(A, op(12, 6, 'conceal'))).toBe('concealed');
  });

  it('on Engage in cover it is valid and keeps a normal cover save', () => {
    use('killteam'); board(lightNear);
    const j = shots.judgeShot(A, B);
    expect([j.kind, j.save, j.accurate]).toEqual(['cover', 'normal', 0]);
  });

  it('from a Vantage Point, Conceal in light cover is valid, its cover save a crit', () => {
    use('killteam'); board(lightNear);
    const j = shots.judgeShot({...A, z: 3, vantage: true}, op(12, 6, 'conceal'));
    expect([j.kind, j.save, j.vantage]).toEqual(['cover', 'crit', true]);
    expect(kind({...A, z: 3}, op(12, 6, 'conceal'))).toBe('concealed');            // not a Vantage Point
    board(heavyNear);
    expect(kind({...A, z: 3, vantage: true}, op(12, 6, 'conceal'))).toBe('concealed');   // heavy cover
  });

  it('from a Vantage Point, an Engage target in cover gives Accurate 1 from 2" lower, 2 from 4"', () => {
    use('killteam'); board(lightNear);
    const acc = z => shots.judgeShot({...A, z, vantage: true}, B).accurate;
    expect([acc(1.5), acc(2), acc(3.9), acc(4)]).toEqual([0, 1, 1, 2]);
    expect(shots.judgeShot({...A, z: 4, vantage: true}, B).save).toBe('normal');
  });

  it('the cover save is kept unrolled: one normal success, or a crit', () => {
    for (let n = 0; n < 20; n++) {
      const plain = rollDefence(7, false), normal = rollDefence(7, 'normal'), crit = rollDefence(7, 'crit');
      expect([plain.dice.length, normal.dice.length, crit.dice.length]).toEqual([3, 2, 2]);
      // a 7+ save only succeeds on 6s, so what's left over is the kept cover save
      const sixes = d => d.dice.filter(v => v === 6).length;
      expect([normal.norm, normal.crit - sixes(normal)]).toEqual([1, 0]);
      expect([crit.norm, crit.crit - sixes(crit)]).toEqual([0, 1]);
    }
  });

  it('operatives stand on the table until the engine knows heights', () => {
    expect(shots.standing({x: 1, y: 1})).toEqual({z: 0, vantage: false});
  });
});

describe('Kill Team (2024): a friend in melee with the target', () => {
  it('an enemy with one of the shooter\'s friends in its control range is not a valid target', () => {
    use('killteam'); board();
    ops(['A1', 0, 3, 6], ['B1', 1, 12, 6], ['A2', 0, 12, 7.6]);    // 0.5" base to base
    const j = shotAt('B1');
    expect(j.kind).toBe('engaged');
    expect(j.engagedBy.id).toBe('A2');
    expect(shots.SHOT_KINDS.engaged.valid).toBe(false);
  });

  it('a friend outside control range, or another enemy close by, changes nothing', () => {
    use('killteam'); board();
    ops(['A1', 0, 3, 6], ['B1', 1, 12, 6], ['A2', 0, 12, 8.4], ['B2', 1, 13.5, 6]);
    expect(shotAt('B1').kind).toBe('clear');
  });

  it('is judged before visibility and cover', () => {
    use('killteam'); board(heavyWall);
    ops(['A1', 0, 3, 6], ['B1', 1, 12, 6, 'conceal'], ['A2', 0, 12, 7.6]);
    const j = shotAt('B1');
    expect(j.kind).toBe('engaged');
    expect(j.sight.visible).toBe(false);
    expect(j.line).toBeNull();
  });
});

describe('when the shooter can\'t Shoot at all', () => {
  it('on Conceal, or with an enemy in its control range', () => {
    use('killteam'); board();
    ops(['A1', 0, 3, 6, 'conceal'], ['B1', 1, 12, 6], ['B2', 1, 3, 7.5]);
    const eye = () => { const a = opById('A1'); return {x: a.x, y: a.y, team: 0, op: a}; };
    expect(shots.cannotShoot(eye())).toEqual({why: 'conceal'});
    opById('A1').order = 'engage';
    const no = shots.cannotShoot(eye());
    expect(no.why).toBe('engaged');
    expect(no.by.id).toBe('B2');
    opById('B2').y = 9;
    expect(shots.cannotShoot(eye())).toBeNull();
  });

  it('rulesets without orders only check melee', () => {
    use('ashfall'); board();
    ops(['A1', 0, 3, 6, 'conceal'], ['B1', 1, 12, 6]);
    expect(shots.cannotShoot({x: 3, y: 6, team: 0, op: opById('A1')})).toBeNull();
  });
});

describe('the target must be visible before any line is drawn', () => {
  const seesFrom = ([ax, ay], o) => perimeterPts(o, 24, config.BASE_R - 0.02).some(([bx, by]) => !sight.lineBlocked(ax, ay, bx, by));

  it('cover lines start from a base point that can see the target', () => {
    // Volkus AO 2: from here the only point that dodges the obscuring wall can't see B2 at all
    use('killteam'); world.initMaps(); world.buildWorld(world.MAPS.v2);
    const b2 = world.OPS.find(o => o.id === 'B2');
    const j = shots.judgeShot(op(6.8, 5.6), b2);
    expect(j.sight.visible).toBe(true);
    expect(seesFrom(j.sight.from, b2)).toBe(true);
    expect(j.line[0]).toEqual(j.sight.from);
  });

  it('an enemy that is not visible gets no line at all', () => {
    use('killteam'); board(heavyWall);
    const j = shots.judgeShot(A, B);
    expect(j.kind).toBe('hidden');
    expect(j.line).toBeNull();
  });
});

describe('the other rulesets', () => {
  it('Infinity-style: no obscuring, cover only from terrain within ½"', () => {
    use('infinity'); board(heavyPart);
    expect(kind(A, B)).toBe('clear');
    board(lightNear);
    expect(kind(A, B)).toBe('cover');
    expect(kind(A, op(12, 6, 'conceal'))).toBe('cover');     // no orders in this ruleset
    board({...lightNear, x: 10.4});                           // ~0.6" away
    expect(kind(A, B)).toBe('clear');
  });

  it('Infinity-style: other bases give no cover, and melee means base contact', () => {
    use('infinity'); board();
    ops(['A1', 0, 3, 6], ['B1', 1, 12, 6], ['B2', 1, 10.8, 6]);
    expect(shotAt('B1').kind).toBe('clear');
    ops(['A1', 0, 3, 6], ['B1', 1, 12, 6], ['A2', 0, 12, 7.6]);
    expect(shotAt('B1').kind).toBe('clear');
    ops(['A1', 0, 3, 6], ['B1', 1, 12, 6], ['A2', 0, 12, 7]);
    expect(shotAt('B1').kind).toBe('engaged');
  });

  it('Ashfall: cover within 2", obscured beyond 3", no orders', () => {
    use('ashfall'); board({kind: 'light', x: 9.5, y: 5, w: 0.3, h: 2});
    expect(kind(A, op(12, 6, 'conceal'))).toBe('cover');
    board(heavyPart);
    expect(kind(A, B)).toBe('obscured');
    // ~2.5" from the target: obscured under Kill Team, neither obscured nor cover here
    const mid = {kind: 'heavy', x: 8.6, y: 5.9, w: 0.3, h: 3.1};
    board(mid);
    expect(kind(A, B)).toBe('clear');
    use('killteam'); board(mid);
    expect(kind(A, B)).toBe('obscured');
  });
});

describe('shotsFrom', () => {
  it('judges every live enemy from the eye point, and reuses the answer while nothing moves', () => {
    use('killteam'); board(lightNear);
    world.OPS.splice(0, world.OPS.length,
      {...op(3, 6), id: 'A1', team: 0, alive: true},
      {...op(12, 6, 'conceal'), id: 'B1', team: 1, alive: true},
      {...op(12, 2), id: 'B2', team: 1, alive: true},
      {...op(20, 6), id: 'B3', team: 1, alive: false},
      {...op(3, 9), id: 'A2', team: 0, alive: true});
    const eye = {x: 3, y: 6, team: 0};
    const list = shots.shotsFrom(eye);
    expect(list.map(s => [s.target.id, s.kind])).toEqual([['B1', 'concealed'], ['B2', 'clear']]);
    expect(shots.shotsFrom({...eye})).toBe(list);
    world.OPS[1].order = 'engage';
    expect(shots.shotsFrom(eye).map(s => s.kind)).toEqual(['cover', 'clear']);
    // a friend stepping into the target's control range is a change too
    world.OPS[4].x = 12; world.OPS[4].y = 7.6;
    expect(shots.shotsFrom(eye).map(s => s.kind)).toEqual(['engaged', 'clear']);
  });
});
