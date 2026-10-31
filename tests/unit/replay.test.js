// Replays: a game recorded step by step, packed into "#replay=…" and back, undo taking a
// step off, turning points found, the link's length for a whole game, and junk refused.
import { beforeAll, describe, expect, it } from 'vitest';
import * as world from '../../src/engine/world.js';
import { MAX_OPS, addStep, decodeReplay, encodeReplay, newRecording, packReplay, replayHash, steps, turnStarts, unpackReplay } from '../../src/net/replay.js';
import { cleanOps } from '../../src/net/protocol.js';

beforeAll(() => world.initMaps());

const clone = g => JSON.parse(JSON.stringify(g));
function startGame(key = "v1") {
  world.buildWorld(world.MAPS[key]);
  return { rules: "killteam", map: key, mapName: world.MAP.name, ops: clone(world.OPS),
    tray: { tp: 1, cp: [3, 3], vp: [0, 0] },
    minis: [{ team: null, picks: {} }, { team: null, picks: {} }],
    dice: [0, 1].map(who => ({ who, label: "", hit: 3, dice: [], rerolled: [] })),
    mission: { set: 0, crit: null, tac: [null, null], primary: [null, null], score: [[], []], markers: [] } };
}
// four turning points: every operative moves (long decimals, as dragged), a third of them
// shoot and roll dice, then End TP readies everyone
function playGame(rec, g) {
  let n = 0;
  for (let tp = 1; tp <= 4; tp++) {
    g.ops.forEach((o, i) => {
      if (!o.alive) return;
      o.x += Math.sin(i + tp) * 2.123456789; o.y += Math.cos(i * tp) * 1.987654321;
      o.ap -= 1; o.used.push("reposition"); o.ready = false;
      addStep(rec, g, [`${o.name} repositions ${(3 + i % 3)}″ (${o.ap} AP left).`]); n++;
      if (i % 3 === 0) {
        const t = g.ops[(i + 7) % g.ops.length];
        t.wounds = Math.max(0, t.wounds - 3); if (!t.wounds) t.alive = false;
        o.ap -= 1; o.used.push("shoot");
        g.dice[o.team] = { who: o.team, label: `${o.name} shoots`, hit: 3, dice: [1 + i % 6, 6, 4, 2], rerolled: [] };
        addStep(rec, g, [`${o.name} shoots ${t.name} with ${o.weapon} — atk [${g.dice[o.team].dice.join(" ")}] def [5 2 3] → 3 dmg`]); n++;
      }
    });
    if (tp < 4) {
      g.tray = { tp: tp + 1, cp: [g.tray.cp[0] + 1, g.tray.cp[1] + 1], vp: [tp, tp + 1] };
      g.ops.forEach(o => { o.ready = true; o.ap = o.apl; o.used = []; });
      addStep(rec, g, [`Turning point ${tp + 1}. All operatives readied.`]); n++;
    }
  }
  return n;
}

describe("replays", () => {
  it("records a step per change, ignores no-change and takes a step off on undo", () => {
    const g = startGame(), rec = newRecording(g, 1760000000000);
    expect(addStep(rec, g)).toBe("same");
    const before = clone(g);
    g.ops[0].x += 1; g.ops[0].used.push("reposition");
    expect(addStep(rec, g, ["moved"])).toBe("step");
    expect(steps(rec)).toBe(1);
    expect(rec.frames[0].ops[0].x).toBe(before.ops[0].x);   // frames are copies, not the live game
    // undo puts the table back as it was a step ago: that step is gone, not a new one
    expect(addStep(rec, before, ["Undid last action."])).toBe("undo");
    expect(steps(rec)).toBe(0);
    expect(rec.logs).toEqual([[]]);
  });

  it("round-trips a whole game, frame by frame", async () => {
    const g = startGame(), rec = newRecording(g, 1760000000000);
    const n = playGame(rec, g);
    expect(steps(rec)).toBe(n);
    const back = await decodeReplay(replayHash(await encodeReplay(rec), 5));
    expect(back.error).toBeUndefined();
    expect(back.step).toBe(5);
    const r = back.replay;
    expect(r.at).toBe(1760000000000);
    expect(r.frames).toHaveLength(rec.frames.length);
    expect(r.logs).toEqual(rec.logs);
    world.buildWorld(world.MAPS.v1);
    rec.frames.forEach((f, i) => {
      const o = r.frames[i];
      expect([o.rules, o.map, o.mapName]).toEqual([f.rules, f.map, f.mapName]);
      for (const k of ["tray", "minis", "dice", "mission"]) expect(o[k]).toEqual(f[k]);
      // through the same cleaner as share links and online play
      expect(cleanOps(o.ops, world.OPS)).toEqual(cleanOps(f.ops, world.OPS));
    });
    expect(turnStarts(r.frames).map(t => t.tp)).toEqual([1, 2, 3, 4]);
    expect(turnStarts(r.frames)[0].i).toBe(0);
    expect(r.frames[turnStarts(r.frames)[2].i].tray.tp).toBe(3);
  });

  it("says how long a whole game's link is", async () => {
    for (const key of ["v1", "gd1"]) {
      const g = startGame(key), rec = newRecording(g);
      const n = playGame(rec, g);
      const url = "https://jfreal.github.io/skirmishtable/" + replayHash(await encodeReplay(rec));
      console.log(`replay link, ${key}, 4 TPs, ${n} steps with log lines: ${url.length} characters`);
      expect(url.length).toBeLessThan(20000);
    }
  });

  it("carries an imported map's definition in the first frame only", async () => {
    const g = { ...startGame("v2"), map: "imp1" }, rec = newRecording(g, 1, world.MAPS.v2);
    playGame(rec, g);
    expect(packReplay(rec).start.mapDef).toEqual(world.MAPS.v2);
    const back = await decodeReplay(await encodeReplay(rec));
    expect(back.replay.mapDef).toEqual(world.MAPS.v2);
    expect(back.replay.frames[0].mapDef).toBeUndefined();
  });

  it("refuses junk with a plain reason", async () => {
    const g = startGame(), rec = newRecording(g);
    playGame(rec, g);
    const good = await encodeReplay(rec);
    for (const c of ["", "#replay=", "#replay=1.", "#replay=1.!!!", "#replay=1." + good.slice(2, good.length / 2), "#replay=1.<script>"])
      expect((await decodeReplay(c)).error).toMatch(/damaged/);
    expect((await decodeReplay("#replay=9." + good.slice(2))).error).toMatch(/newer/);
    expect(unpackReplay(null)).toBeNull();
    expect(unpackReplay({ v: 1, start: {}, steps: [] })).toBeNull();
    const p = packReplay(rec);
    expect(unpackReplay({ ...p, steps: [{ o: [[999, 1, 5]] }] })).toBeNull();   // no such operative
    expect(unpackReplay({ ...p, steps: [{ o: [[0, 99, 5]] }] })).toBeNull();    // no such field
    const many = Array.from({ length: MAX_OPS + 1 }, () => []);
    expect(unpackReplay({ ...p, start: { ...p.start, ops: many } })).toBeNull();           // too many operatives at the start
    expect(unpackReplay({ ...p, steps: [{ g: { ops: many } }] })).toBeNull();              // or in a step
    // a step past the end clamps to the last frame
    expect((await decodeReplay(replayHash(good, 99999))).step).toBe(steps(rec));
  });
});
