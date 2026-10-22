import { describe, expect, it } from 'vitest';
import { cleanMinis, cleanOps, cleanStrings, cleanTray, newRoomCode, parseRoomHash, pickSeat, updateProblem } from '../../src/net/protocol.js';
import { mkOp } from '../../src/engine/world.js';

const roster = () => [mkOp("A1", 0, "Vekk", "leader", 2, 2), mkOp("B1", 1, "Sarn", "leader", 20, 2)];
const game = () => ({ rules: "killteam", map: "v1", mapName: "Volkus 1", ops: roster(),
  tray: { tp: 1, cp: [3, 3], vp: [0, 0] }, minis: [{ team: null, picks: {} }, { team: null, picks: {} }] });
const wire = g => JSON.parse(JSON.stringify(g));   // what arrives over the network

describe("room codes", () => {
  it("makes readable codes and reads them back from the address", () => {
    const c = newRoomCode();
    expect(c).toMatch(/^[A-HJKMNP-Z2-9]{10}$/);
    expect(parseRoomHash("#room=" + c)).toEqual({ role: "guest", code: c });
    expect(parseRoomHash("#host=" + c.toLowerCase())).toEqual({ role: "host", code: c });
    expect(parseRoomHash("#room=<x>")).toBe(null);
    expect(parseRoomHash("")).toBe(null);
  });
});

describe("seats", () => {
  it("gives the first guest the free side and makes the rest watch", () => {
    expect(pickSeat({}, 0)).toBe(1);
    expect(pickSeat({ p1: 1 }, 0)).toBe(null);
    expect(pickSeat({ p1: null }, 0, 1)).toBe(1);   // a returning player gets its side back
    expect(pickSeat({ p1: 1 }, 0, 1)).toBe(null);   // unless someone has it
  });
});

describe("the host's check", () => {
  it("lets a player move their own side and hurt the other", () => {
    const prev = game(), next = wire(prev);
    next.ops[1].x = 10; next.ops[0].wounds = 3; next.ops[0].alive = false;
    expect(updateProblem(prev, next, 1)).toBe(null);
  });
  it("refuses moving the other side, changing the map, or a watcher's update", () => {
    const prev = game();
    const moved = wire(prev); moved.ops[0].x = 10;
    expect(updateProblem(prev, moved, 1)).toMatch(/other player/);
    const map = wire(prev); map.map = "v2";
    expect(updateProblem(prev, map, 1)).toMatch(/host/);
    expect(updateProblem(prev, wire(prev), null)).toMatch(/watchers/);
    const minis = wire(prev); minis.minis[0].team = "x";
    expect(updateProblem(prev, minis, 1)).toMatch(/miniatures/);
  });
  it("lets End TP ready the other side", () => {
    const prev = game(); prev.ops[0].ready = false; prev.ops[0].used = ["shoot"];
    const next = wire(prev); next.ops[0].ready = true; next.ops[0].used = []; next.tray.tp = 2;
    expect(updateProblem(prev, next, 1)).toBe(null);
  });
});

describe("cleaning what arrives", () => {
  it("takes play fields only; names and stats stay this browser's", () => {
    const local = roster();
    const sent = wire(local);
    Object.assign(sent[0], { name: "<img src=x onerror=alert(1)>", x: 7, wounds: 99, order: "evil", used: ["dash", "<b>"], weapon: "nope" });
    const [a] = cleanOps(sent, local);
    expect(a.name).toBe("Vekk");
    expect(a.x).toBe(7);
    expect(a.wounds).toBe(a.maxW);
    expect(a.order).toBe("conceal");
    expect(a.used).toEqual(["dash"]);
    expect(a.weapon).toBe(local[0].weapon);
    expect(cleanOps([sent[0]], local)).toBe(null);   // roster size must match
  });
  it("keeps the tray and miniatures to their shapes", () => {
    const d = { tp: 1, cp: [3, 3], vp: [0, 0] };
    expect(cleanTray({ tp: 2, cp: [1, "x"], vp: null }, d)).toEqual({ tp: 2, cp: [1, 3], vp: [0, 0] });
    expect(cleanMinis([{ team: "t1", picks: { A1: 2, "<x>": 1, A2: -1 } }, { team: "bad" }], ["t1"]))
      .toEqual([{ team: "t1", picks: { A1: 2 } }, { team: null, picks: {} }]);
  });
  it("strips markup characters from an imported map", () => {
    expect(cleanStrings({ name: '<b>"Ruin"</b>', place: [{ k: "a&b", x: 1 }] }))
      .toEqual({ name: "bRuin/b", place: [{ k: "ab", x: 1 }] });
  });
});
