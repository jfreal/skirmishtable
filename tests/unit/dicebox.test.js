// The dice box: dice bounce round the box and come to rest inside it, held dice bunch up,
// results stack in their slots, shaking is counted, and a thrown roll reaches the tray.
import { describe, it, expect, beforeAll } from 'vitest';
import { atRest, handOffsets, shaker, slotSpots, stepDice } from '../../src/ui/dicephys.js';

const BOX = { x0: 0, y0: 0, x1: 200, y1: 110 }, R = 11;

describe('dice physics', () => {
  it('a hard throw bounces round the box and stops inside it', () => {
    const dice = Array.from({ length: 8 }, (_, i) => ({ x: 20 + i * 20, y: 55, vx: 1500 - i * 300, vy: 900 - i * 200, rot: 0, vr: 500 }));
    let hits = 0, t = 0;
    while (!dice.every(atRest) && t < 10) { if (stepDice(dice, BOX, R, 1 / 60) > 0) hits++; t += 1 / 60; }
    expect(dice.every(atRest)).toBe(true);
    expect(t).toBeLessThan(3);          // a roll settles in a couple of seconds
    expect(hits).toBeGreaterThan(0);
    for (const d of dice) {
      expect(d.x).toBeGreaterThanOrEqual(BOX.x0 + R); expect(d.x).toBeLessThanOrEqual(BOX.x1 - R);
      expect(d.y).toBeGreaterThanOrEqual(BOX.y0 + R); expect(d.y).toBeLessThanOrEqual(BOX.y1 - R);
    }
  });
  it('dice push each other apart', () => {
    const a = { x: 100, y: 50, vx: 0, vy: 0, rot: 0, vr: 0 }, b = { x: 104, y: 50, vx: 0, vy: 0, rot: 0, vr: 0 };
    stepDice([a, b], BOX, R, 1 / 60);
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThanOrEqual(2 * R - 1e-9);
  });
  it('held dice bunch round the hand without sitting on each other', () => {
    const offs = handOffsets(20, 21);
    expect(offs).toHaveLength(20);
    expect(offs[0]).toEqual([0, 0]);
    for (let i = 0; i < offs.length; i++) for (let j = i + 1; j < offs.length; j++)
      expect(Math.hypot(offs[i][0] - offs[j][0], offs[i][1] - offs[j][1])).toBeGreaterThan(8);
  });
});

describe('result slots', () => {
  const slots = [0, 1, 2, 3, 4, 5].map(i => ({ x: i * 70, y: 0, w: 66, h: 66 }));
  it('each die lands in the slot for its face', () => {
    const vals = [6, 1, 3, 6, 3, 3];
    slotSpots(vals, slots, 22).forEach(([x, y], i) => {
      const s = slots[vals[i] - 1];
      expect(x - 11).toBeGreaterThanOrEqual(s.x); expect(x + 11).toBeLessThanOrEqual(s.x + s.w);
      expect(y - 11).toBeGreaterThanOrEqual(s.y); expect(y + 11).toBeLessThanOrEqual(s.y + s.h);
    });
  });
  it('a crowded slot squeezes its rows but stays inside', () => {
    const spots = slotSpots(Array(12).fill(5), slots, 22);
    for (const [, y] of spots) expect(y + 11).toBeLessThanOrEqual(66);
    expect(new Set(spots.map(p => p.join())).size).toBe(12);
  });
});

describe('shaking', () => {
  it('counts back-and-forth strokes, not a steady drag', () => {
    const steady = shaker();
    for (let t = 0; t <= 300; t += 16) steady.push(t * 1.5, 0, t);
    expect(steady.level).toBe(0);

    const shake = shaker();
    let shakes = 0;
    for (let t = 0; t <= 600; t += 16) shakes += shake.push(Math.sin(t / 60) * 60, 0, t) ? 1 : 0;
    expect(shakes).toBeGreaterThanOrEqual(3);
    expect(shake.level).toBeGreaterThan(0.5);
  });
  it('a hand held still before letting go throws softly', () => {
    const s = shaker();
    for (let t = 0; t <= 100; t += 16) s.push(t * 2, 0, t);
    expect(s.velocity(100)[0]).toBeGreaterThan(1000);
    expect(s.velocity(400)).toEqual([0, 0]);
  });
});

describe('the tray takes thrown dice', () => {
  let tray;
  beforeAll(async () => {
    // dicetray.js logs to the page; a stand-in log is enough here
    const log = { prepend() {} };
    globalThis.document = { getElementById: id => id === 'log' ? log : null, createElement: () => ({}) };
    tray = await import('../../src/ui/dicetray.js');
  });
  it('keeps the faces the box decided, and re-rolls only the dice thrown again', () => {
    tray.setRoll([6, 2, 4, 1], 0);
    expect(tray.diceTrays[0].dice).toEqual([6, 2, 4, 1]);
    expect(tray.diceTrays[0].who).toBe(0);
    tray.rerollDice(0, [1, 3], [5, 6]);
    expect(tray.diceTrays[0].dice).toEqual([6, 5, 4, 6]);
    expect(tray.diceTrays[0].rerolled).toEqual([1, 3]);
    tray.rerollDice(0, [9], [3]);        // no such die
    expect(tray.diceTrays[0].dice).toEqual([6, 5, 4, 6]);
  });
  it('re-rolls each die once', () => {
    tray.setRoll([1, 2, 3], 0);
    tray.rerollDice(0, [0], [4]);
    tray.rerollDice(0, [0, 2], [6, 5]);  // die 0 has had its re-roll; die 2 hasn't
    expect(tray.diceTrays[0].dice).toEqual([4, 2, 5]);
    expect(tray.diceTrays[0].rerolled).toEqual([0, 2]);
    expect(tray.wasRerolled(0, 1)).toBe(false);
    // new dice thrown in beside the old ones keep the old ones' re-rolls used
    tray.setRoll([4, 2, 5, 6], 0, '', [0, 2]);
    expect(tray.diceTrays[0].rerolled).toEqual([0, 2]);
    tray.setRoll([6, 5, 4, 6], 0);
  });
  it('keeps each side in its own tray, so both can roll at once', () => {
    tray.setRoll([3, 3], 1, 'saves');
    expect(tray.diceTrays[1]).toMatchObject({ who: 1, dice: [3, 3], label: 'saves' });
    expect(tray.diceTrays[0].dice).toEqual([6, 5, 4, 6]);
    tray.clearDice(0);
    expect(tray.diceTrays.map(t => t.dice)).toEqual([[], [3, 3]]);
  });
});
