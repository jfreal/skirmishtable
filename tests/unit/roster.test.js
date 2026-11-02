// Fielding your own operatives: adding and removing them on a side (the Miniatures panel),
// the roster surviving a new map, and the same roster arriving through links, replays and
// online play.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as world from '../../src/engine/world.js';
import { dist } from '../../src/engine/geometry.js';
import { packGame, unpackGame } from '../../src/net/link.js';
import { newRecording, addStep, packReplay, unpackReplay } from '../../src/net/replay.js';
import { cleanOps, updateProblem } from '../../src/net/protocol.js';

beforeAll(() => world.initMaps());
beforeEach(() => world.buildWorld(world.MAPS.v1));

const side = t => world.OPS.filter(o => o.team === t);
const inZone = op => { const z = world.DROPZONES[op.team]; return op.x >= z.x && op.x <= z.x + z.w && op.y >= z.y && op.y <= z.y + z.h; };
const game = () => ({ rules: "killteam", map: "v1", mapName: world.MAP.name, ops: JSON.parse(JSON.stringify(world.OPS)),
  tray: { tp: 1, cp: [3, 3], vp: [0, 0] }, minis: [{ team: null, picks: {} }, { team: null, picks: {} }] });

describe("adding and removing operatives", () => {
  it("starts six a side", () => {
    expect(side(0).map(o => o.id)).toEqual(["A1", "A2", "A3", "A4", "A5", "A6"]);
    expect(side(1)).toHaveLength(6);
  });
  it("adds one with the next free id, named after its model, free in its drop zone", () => {
    const op = world.addOp(0, "Cultist");
    expect(op).toMatchObject({ id: "A7", team: 0, name: "Cultist", kind: "trooper", alive: true, ready: true });
    expect(world.OPS).toContain(op);
    expect(inZone(op)).toBe(true);
    for (const o of world.OPS) if (o !== op) expect(dist(o.x, o.y, op.x, op.y)).toBeGreaterThan(1.2);
    expect(world.addOp(0, "Cultist").name).toBe("Cultist 2");      // a second one gets told apart
    expect(world.addOp(1, "Mutant").id).toBe("B7");
  });
  it("removes one, keeps at least one a side, and reuses a freed id", () => {
    expect(world.removeOp("A3")).toBe(true);
    expect(world.OPS.find(o => o.id === "A3")).toBeUndefined();
    expect(world.removeOp("A3")).toBe(false);
    expect(world.addOp(0, "Gunner").id).toBe("A3");
    for (const o of side(1).slice(1)) expect(world.removeOp(o.id)).toBe(true);
    expect(world.removeOp("B1")).toBe(false);
    expect(side(1).map(o => o.id)).toEqual(["B1"]);
  });
  it("gives an unknown kind the trooper profile, and cleans names", () => {
    expect(world.mkOp("A9", 0, "X", "constructor", 1, 1).kind).toBe("trooper");
    expect(world.addOp(0, "Tzaangor Warrior (Blade & Shield)").name).toBe("Tzaangor Warrior (Blade and Shield)");
    expect(world.addOp(1, '<img src=x onerror="1">').name).not.toMatch(/[<>"&]/);
  });
  it("stops at the side limit", () => {
    while (world.addOp(0, "Trooper"));
    expect(side(0)).toHaveLength(world.MAX_SIDE);
    expect(new Set(side(0).map(o => o.id)).size).toBe(world.MAX_SIDE);
    expect(side(0).every(inZone)).toBe(true);
  });
  it("keeps the roster on a new map, everyone fresh in the drop zones", () => {
    world.addOp(0, "Cultist"); world.addOp(0, "Mutant"); world.removeOp("B6");
    world.OPS[0].wounds = 1; world.OPS[0].alive = false;
    world.buildWorld(world.MAPS.y3, world.rosterDefs());
    expect(side(0).map(o => o.name)).toEqual(["Vekk", "Moss", "Harrow", "Snyde", "Brand", "Kole", "Cultist", "Mutant"]);
    expect(side(1)).toHaveLength(5);
    expect(world.OPS[0]).toMatchObject({ alive: true, wounds: world.OPS[0].maxW });
    expect(world.OPS.every(inZone)).toBe(true);
    world.buildWorld(world.MAPS.v1);                                 // no roster given: the default
    expect(world.OPS).toHaveLength(12);
  });
});

describe("a changed roster on the wire", () => {
  it("travels in a share link: an operative the opener doesn't have is made from it", () => {
    world.addOp(0, "Cultist");
    const sent = unpackGame(JSON.parse(JSON.stringify(packGame(game())))).ops;
    world.buildWorld(world.MAPS.v1);                                 // the opener: six a side
    const got = cleanOps(sent, world.OPS);
    expect(got.map(o => o.id)).toEqual([...world.OPS.map(o => o.id), "A7"]);
    expect(got.find(o => o.id === "A7")).toMatchObject({ team: 0, name: "Cultist", kind: "trooper" });
    expect(got.find(o => o.id === "A1").name).toBe("Vekk");
  });
  it("makes a reused id afresh when it's a different operative", () => {
    world.removeOp("A2"); world.addOp(0, "Cultist");                // the new A2
    const sent = unpackGame(JSON.parse(JSON.stringify(packGame(game())))).ops;
    world.buildWorld(world.MAPS.v1);                                 // the opener's A2 is still Moss
    expect(cleanOps(sent, world.OPS).find(o => o.id === "A2")).toMatchObject({ name: "Cultist", kind: "trooper" });
    // the other way round: a link's default A2 (no name sent) over the opener's own Cultist A2
    const dflt = unpackGame(JSON.parse(JSON.stringify(packGame(game())))).ops;
    world.removeOp("A2"); world.addOp(0, "Cultist");
    expect(cleanOps(dflt, world.OPS).find(o => o.id === "A2")).toMatchObject({ name: "Moss", kind: "marksman" });
    // online: the same operative keeps this browser's object
    const same = JSON.parse(JSON.stringify(world.OPS));
    expect(cleanOps(same, world.OPS).find(o => o.id === "A2").name).toBe("Cultist");
  });
  it("cleans a made-up operative's name and kind", () => {
    const [a] = cleanOps([{ id: "B9", name: "<img src=x onerror=alert(1)>", kind: "god", x: 3, y: 4 }], world.OPS);
    expect(a).toMatchObject({ id: "B9", team: 1, kind: "trooper", x: 3, y: 4 });
    expect(a.name).not.toMatch(/[<>"&]/);
    expect(cleanOps([{ id: "C1" }, { id: "A1" }, { id: "A1" }], world.OPS).map(o => o.id)).toEqual(["A1"]);
  });
  it("replays across an operative joining and leaving", () => {
    const g0 = game(), rec = newRecording(g0, 1);
    world.addOp(1, "Mutant"); addStep(rec, game());
    world.OPS.find(o => o.id === "B7").x += 1; addStep(rec, game());
    world.removeOp("A2"); addStep(rec, game());
    const back = unpackReplay(JSON.parse(JSON.stringify(packReplay(rec))));
    world.buildWorld(world.MAPS.v1);
    const ids = back.frames.map(f => cleanOps(f.ops, world.OPS).map(o => o.id).join(","));
    expect(ids[0].split(",")).toHaveLength(12);
    expect(ids[1]).toContain("B7");
    expect(ids[3]).not.toContain("A2");
    expect(cleanOps(back.frames[2].ops, world.OPS).find(o => o.id === "B7").x).toBeCloseTo(rec.frames[2].ops.find(o => o.id === "B7").x);
  });
});

describe("online: each player builds their own side", () => {
  it("lets a player add and remove their own operatives", () => {
    const prev = game();
    world.addOp(1, "Mutant"); world.removeOp("B2");
    expect(updateProblem(prev, game(), 1)).toBe(null);
  });
  it("refuses adding to or removing from the other side", () => {
    const prev = game();
    world.addOp(0, "Cultist");
    expect(updateProblem(prev, game(), 1)).toMatch(/own player/);
    world.buildWorld(world.MAPS.v1); world.removeOp("A2");
    expect(updateProblem(prev, game(), 1)).toMatch(/other player/);
    world.buildWorld(world.MAPS.v1);
    const none = game(); none.ops = none.ops.filter(o => o.team !== 1);   // their own side, all gone
    expect(updateProblem(prev, none, 1)).toMatch(/at least one/);
    const renamed = game(); renamed.ops[0].name = "Mine now";
    expect(updateProblem(prev, renamed, 1)).toMatch(/other player/);
    const dup = game(); dup.ops.push({ ...dup.ops[7] });
    expect(updateProblem(prev, dup, 1)).toMatch(/roster/);
  });
});
