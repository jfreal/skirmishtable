// Dice tray counting, and cleaning the dice and mission state that arrive from another browser.
import { describe, it, expect } from 'vitest';
import { cleanDice, cleanMission, updateProblem } from '../../src/net/protocol.js';
import { TTS_OPS } from '../../src/data/tts-ops.js';

const blank = () => ({ set: 0, crit: null, tac: [null, null], primary: [null, null],
  score: [0, 1].map(() => [0, 1, 2, 3].map(() => [0, 0, 0])), markers: [] });

describe('TTS_OPS', () => {
  it('has both seasons with 12 Tac Ops, 9 Crit Ops and a Kill Op on card sheets', () => {
    expect(TTS_OPS.sets.map(s => s.name)).toEqual(['Approved Ops 2025', 'Approved Ops 2024']);
    for (const s of TTS_OPS.sets) {
      expect(s.tac).toHaveLength(12);
      expect(s.crit).toHaveLength(9);
      for (const c of [...s.tac, ...s.crit, s.kill]) {
        expect(c.sheet, c.name).toMatch(/^https:\/\//);
        expect(c.i).toBeLessThan(c.cols * c.rows);
      }
    }
    expect(TTS_OPS.equipment.length).toBe(10);
  });
});

describe('cleanDice', () => {
  it('keeps real dice and a sane target, drops the rest', () => {
    const d = cleanDice({ who: 1, label: 'B1 <b>shoots</b>', hit: 9, dice: [6, 7, 0, 3, 'x', 1], rerolled: [0, 9] });
    expect(d).toEqual({ who: 1, label: 'B1 bshoots/b', hit: 3, dice: [6, 3, 1], rerolled: [0] });
  });
});

describe('cleanMission', () => {
  it('keeps catalog indexes, small VP and good markers only', () => {
    const m = cleanMission({ set: 1, crit: 99, tac: [3, -1], primary: [2, 'x'],
      score: [[[1, 2, 3], [10, 0, 0]], []], markers: [{ id: 1, k: 0, x: 3, y: 4 }, { id: 2, k: 999, x: 1, y: 1 }] }, TTS_OPS);
    expect(m.set).toBe(1);
    expect(m.crit).toBeNull();
    expect(m.tac).toEqual([3, null]);
    expect(m.primary).toEqual([2, null]);
    expect(m.score[0][0]).toEqual([1, 2, 3]);
    expect(m.score[0][1]).toEqual([0, 0, 0]);
    expect(m.markers).toEqual([{ id: 1, k: 0, x: 3, y: 4 }]);
  });
});

describe("the host's check on the mission", () => {
  const game = mission => ({ rules: 'killteam', map: 'v1', mapName: 'x', ops: [], minis: [{}, {}], mission });
  it("refuses a guest's Crit Op or the other side's score, takes its own Tac Op", () => {
    const a = blank();
    expect(updateProblem(game(a), game({ ...blank(), crit: 2 }), 1)).toMatch(/host/);
    const theirs = blank(); theirs.score[0][0][0] = 3;
    expect(updateProblem(game(a), game(theirs), 1)).toMatch(/other side/);
    const mine = blank(); mine.tac[1] = 4; mine.score[1][0][1] = 2;
    expect(updateProblem(game(a), game(mine), 1)).toBeNull();
  });
});
