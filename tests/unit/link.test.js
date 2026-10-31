// Share links: a game packed into "#game=…" and back, how long the link is, and junk
// links failing with a plain reason instead of loading half a game.
import { beforeAll, describe, expect, it } from 'vitest';
import * as world from '../../src/engine/world.js';
import { SOFT_MAX, decodeGame, encodeGame, packGame, unpackGame } from '../../src/net/link.js';
import { cleanDiceTrays, cleanMinis, cleanMission, cleanOps, cleanTray } from '../../src/net/protocol.js';
import { TTS_OPS } from '../../src/data/tts-ops.js';

beforeAll(() => world.initMaps());

// a game a few turns in, as sync.js exportGame() makes it
function midGame(key = "v1") {
  world.buildWorld(world.MAPS[key]);
  const ops = JSON.parse(JSON.stringify(world.OPS));
  ops.forEach((o, i) => {
    o.x += Math.sin(i) * 3.123456789; o.y += Math.cos(i) * 2.987654321;   // dragged: long decimals
    o.used = i % 3 ? ["reposition", "shoot"] : ["dash"]; o.ready = i % 2 === 0;
    o.order = i % 2 ? "engage" : "conceal"; o.ap = i % 3;
  });
  ops[2].wounds = 3; ops[7].wounds = 0; ops[7].alive = false; ops[4].weapon = ops[4].weapons[1] || ops[4].weapon;
  return { rules: "killteam", map: key, mapName: world.MAP.name, ops,
    tray: { tp: 3, cp: [1, 4], vp: [5, 7] },
    minis: [{ team: "kasrkin", picks: { A1: 2, A2: 0, A3: 5 } }, { team: null, picks: {} }],
    dice: [{ who: 0, label: "", hit: 3, dice: [], rerolled: [] },
           { who: 1, label: "Shoot: Sarn at Vekk", hit: 4, dice: [1, 3, 4, 6, 6], rerolled: [1] }],
    // a busy score sheet: cards picked, VP in every turning point, six markers dragged about
    mission: { set: 0, crit: 2, tac: [1, 4], primary: [0, 2],
      score: [0, 1].map(s => [0, 1, 2, 3].map(tp => [0, 1, 2].map(c => (s + tp + c) % 4))),
      markers: [0, 1, 2, 3, 4, 5].map(i => ({ id: i + 1, k: i % 3, x: 3.14159 * i + 1.0001, y: 2.71828 * i + 0.5003 })) } };
}
const link = code => "https://jfreal.github.io/skirmishtable/#game=" + code;

describe("share links", () => {
  it("round-trips a game: operatives, tray and miniatures come back the same", async () => {
    const g = midGame();
    const code = await encodeGame(g, 1760000000000);
    const back = await decodeGame("#game=" + code);
    expect(back.error).toBeUndefined();
    const out = back.game;
    expect(out.at).toBe(1760000000000);
    expect([out.rules, out.map, out.mapName]).toEqual([g.rules, g.map, g.mapName]);
    expect(out.tray).toEqual(g.tray);
    expect(out.minis).toEqual(g.minis);
    // through the same cleaners as online play, against the opener's fresh roster
    world.buildWorld(world.MAPS.v1);
    expect(cleanOps(out.ops, world.OPS)).toEqual(g.ops);
    expect(cleanTray(out.tray, { tp: 1, cp: [3, 3], vp: [0, 0] })).toEqual(g.tray);
    expect(cleanMinis(out.minis, ["kasrkin"])).toEqual(g.minis);
    expect(cleanDiceTrays(out.dice)).toEqual(g.dice);
    expect(cleanMission(out.mission, TTS_OPS)).toEqual(g.mission);
  });

  it("keeps a normal game's link short enough for chat apps", async () => {
    for (const key of ["v1", "y4", "gd1"]) {
      const url = link(await encodeGame(midGame(key)));
      console.log(`share link, ${key}, 12 operatives, dice and score sheet mid-game: ${url.length} characters`);
      expect(url.length).toBeLessThan(SOFT_MAX);
    }
  });

  it("carries an imported map's definition, at a longer length", async () => {
    // an imported Volkus bag converts to the same placements as the built-in map
    const g = { ...midGame("v2"), map: "imp1", mapDef: world.MAPS.v2 };
    const url = link(await encodeGame(g));
    console.log(`share link with an imported map: ${url.length} characters`);
    const back = await decodeGame(url.slice(url.indexOf("#")));
    expect(back.game.mapDef).toEqual(world.MAPS.v2);
  });

  it("refuses junk with a plain reason", async () => {
    const good = await encodeGame(midGame());
    const cases = ["", "#game=", "#game=1.", "#game=abc", "#game=1.!!!!", "#game=1.AAAA",
      "#game=" + good.slice(0, good.length / 2), "#game=1.<script>"];
    for (const c of cases) expect((await decodeGame(c)).error).toMatch(/damaged/);
    expect((await decodeGame("#game=9." + good.slice(2))).error).toMatch(/newer/);
    // valid compression, wrong contents
    const wrapped = async obj => {
      const bytes = new TextEncoder().encode(JSON.stringify(obj));
      const z = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
      return "#game=1." + btoa(String.fromCharCode(...z)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    expect((await decodeGame(await wrapped([1, 2, 3]))).error).toMatch(/doesn't hold a game/);
    expect((await decodeGame(await wrapped({ v: 1, map: 5 }))).error).toMatch(/doesn't hold a game/);
    expect((await decodeGame(await wrapped({ v: 2, map: "v1" }))).error).toMatch(/newer/);
    // a zip bomb: a short link that would unpack to megabytes
    const bomb = await wrapped({ v: 1, rules: "killteam", map: "v1", ops: [], pad: "x".repeat(5e6) });
    expect(bomb.length).toBeLessThan(20000);
    expect((await decodeGame(bomb)).error).toMatch(/damaged/);
  });

  it("leaves junk inside a valid link to the cleaners", () => {
    const g = unpackGame({ v: 1, rules: "killteam", map: "v1", at: "soon",
      ops: [["A1", "<b>", 2, 999, 1, "engage", 1, 1, "nuke", ["dash", "<img>"]], "junk"] });
    expect(g.at).toBe(null);
    world.buildWorld(world.MAPS.v1);
    const a1 = world.OPS.find(o => o.id === "A1");
    // wrong roster size -> cleanOps refuses the lot; right size -> bad fields fall back
    expect(cleanOps(g.ops, world.OPS)).toBe(null);
    const ops = cleanOps([g.ops[0], ...world.OPS.slice(1)], world.OPS);
    expect(ops[0]).toMatchObject({ x: a1.x, y: 2, wounds: a1.maxW, weapon: a1.weapon, used: ["dash"] });
    expect(packGame({ ops: [] }, 5)).toEqual({ v: 1, at: 5, ops: [] });
  });
});
