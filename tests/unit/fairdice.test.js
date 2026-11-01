import { describe, expect, it, vi } from 'vitest';
import { applyRoll, createFair, diceFrom, rollProblem, seedOf, sha256 } from '../../src/net/fairdice.js';
import { fightRoll, shootRoll } from '../../src/engine/dice.js';
import { mkOp } from '../../src/engine/world.js';

const roster = () => [mkOp("A1", 0, "Vekk", "leader", 2, 2), mkOp("B1", 1, "Sarn", "marksman", 20, 2),
                      mkOp("B2", 1, "Oran", "brawler", 3, 2)];
const trays = () => [0, 1].map(s => ({ who: s, label: "", hit: 3, dice: [], rerolled: [] }));
const game = () => ({ ops: roster(), dice: trays() });
const wire = g => JSON.parse(JSON.stringify(g));
// what the roller's browser puts in the game after a roll (the same function the checker uses)
function after(g, recs) {
  const st = { ops: g.ops.map(o => ({ ...o })), trays: wire(g.dice) };
  for (const r of recs) expect(applyRoll(r.what, r.s, st, diceFrom(r.seed), new Set(), new Set())).toBe(null);
  return { ops: st.ops, dice: st.trays };
}

describe("SHA-256", () => {
  it("matches the standard test vectors", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))
      .toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    expect(sha256("a".repeat(1000))).toBe("41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
  });
});

describe("dice from a seed", () => {
  it("gives the same dice for the same seed, and each face about as often", () => {
    const a = diceFrom("x"), b = diceFrom("x"), c = diceFrom("y");
    const sa = Array.from({ length: 50 }, a), sb = Array.from({ length: 50 }, b), sc = Array.from({ length: 50 }, c);
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
    const die = diceFrom("count"), n = [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 6000; i++) n[die()]++;
    expect(n[0]).toBe(0);
    for (let f = 1; f <= 6; f++) expect(n[f]).toBeGreaterThan(850), expect(n[f]).toBeLessThan(1150);
  });
});

describe("Shoot and Fight from given dice", () => {
  const seq = vals => { let i = 0; return () => vals[i++]; };
  it("works the shot out from the dice in order", () => {
    const [a, b] = roster();
    const r = shootRoll({ w: "srgFire", acc: 0, obsc: false, cover: false }, a, b, seq([6, 5, 1, 2, 4, 2, 2]));
    expect(r.atk.dice).toEqual([6, 5, 1, 2]);
    expect(r.dfn.dice).toEqual([4, 2, 2]);      // a 4+ save: one normal save
    expect(r.dmg).toBe(4);                       // the crit gets through (4), the normal is saved
    expect(shootRoll({ w: "srgBlade" }, a, b, seq([]))).toBe(null);   // not a ranged weapon
  });
  it("fights to the end, without changing the operatives passed in", () => {
    const [a, , c] = roster();
    const r = fightRoll({ wa: "srgBlade", wb: "blades" }, a, c, seq([6, 6, 6, 6, 1, 1, 1, 1, 2, 2, 2, 2]));
    expect(r.b.alive).toBe(false);
    expect(c.alive).toBe(true);
    expect(fightRoll({ wa: "blades", wb: "knife" }, a, c, seq([]))).toBe(null);   // not A1's weapon
  });
});

describe("checking an update against the rolls", () => {
  const shot = { k: "shoot", by: "A1", at: "B1", w: "srgFire", acc: 0, obsc: false, cover: false };
  it("passes the result of the roll and nothing else", () => {
    const g = game(), recs = [{ s: 0, what: shot, seed: "s1" }];
    const next = after(g, recs);
    expect(rollProblem(g, wire(next), recs)).toBe(null);
    const wounds = wire(next); wounds.ops[1].wounds = 0; wounds.ops[1].alive = false;
    expect(rollProblem(g, wounds, recs)).toMatch(/Sarn's wounds don't match/);
    const dice = wire(next); dice.dice[0].dice = [6, 6, 6, 6];
    expect(rollProblem(g, dice, recs)).toMatch(/Ash's dice don't match/);
  });
  it("lets dice change only through a roll, or be cleared", () => {
    const g = game(); g.dice[1].dice = [3, 4];
    const cheat = wire(g); cheat.dice[1].dice = [6, 6];
    expect(rollProblem(g, cheat, [])).toMatch(/Slate's dice changed without a shared roll/);
    const cleared = wire(g); cleared.dice[1].dice = [];
    expect(rollProblem(g, cleared, [])).toBe(null);
  });
  it("refuses a roll for the other side", () => {
    const g = game();
    expect(rollProblem(g, wire(g), [{ s: 1, what: shot, seed: "s" }])).toMatch(/wrong operatives/);
    expect(rollProblem(g, wire(g), [{ s: 1, what: { k: "tray", side: 0, idx: [], add: 3 }, seed: "s" }])).toMatch(/other side's dice box/);
  });
  it("follows the dice box: new dice join, slotted dice re-roll once", () => {
    const g = game(); g.dice[0].dice = [1, 2, 3];
    const throwIn = [{ s: 0, what: { k: "tray", side: 0, idx: [0], add: 2 }, seed: "t" }];
    const n1 = after(g, throwIn);
    expect(n1.dice[0].dice.length).toBe(5);
    expect(n1.dice[0].dice.slice(1, 3)).toEqual([2, 3]);
    expect(n1.dice[0].rerolled).toEqual([0]);
    expect(rollProblem(g, wire(n1), throwIn)).toBe(null);
    // a re-roll leaves a die that has already re-rolled alone
    const again = [{ s: 0, what: { k: "tray", side: 0, idx: [0, 1], add: 0 }, seed: "u" }];
    const n2 = after(n1, again);
    expect(n2.dice[0].dice[0]).toBe(n1.dice[0].dice[0]);
    expect(n2.dice[0].rerolled).toEqual([0, 1]);
  });
});

// Two browsers: messages go through a queue, delivered in order, as the network does.
function pairUp({ cheatA } = {}) {
  const q = [], warnings = { A: [], B: [] };
  const mk = (name, other) => createFair({
    send: m => q.push([other, cheatA && name === "A" ? cheatA(m) : JSON.parse(JSON.stringify(m))]),
    warn: t => warnings[name].push(t),
  });
  const nodes = {};
  nodes.A = mk("A", "B"); nodes.B = mk("B", "A");
  const run = () => { while (q.length) { const [to, m] = q.shift(); nodes[to].onMessage(m); } };
  nodes.A.pair("b", 0); nodes.B.pair("a", 1);
  run();
  return { ...nodes, run, warnings };
}

describe("the shared roll between two browsers", () => {
  it("gives both the same dice, which neither knew in advance", () => {
    const { A, B, run, warnings } = pairUp();
    let got = null;
    expect(A.roll({ k: "tray", side: 0, idx: [], add: 5 }, (die, done, n) => { got = { dice: Array.from({ length: 5 }, die), done, n }; })).toBe(null);
    expect(got).toBe(null);                     // nothing until the other browser answers
    run();
    expect(got.n).toBe(1);
    got.done();
    const [tag] = A.take();
    expect(tag).toEqual({ s: 0, n: 0 });
    // B checks A's update against the roll it took part in
    const prev = game(), next = wire(prev); next.dice[0].dice = got.dice;
    expect(B.verify(prev, next, [tag])).toBe(null);
    expect(B.checked()).toBe(1);
    expect(B.verify(prev, next, [tag])).toMatch(/used twice/);
    expect(warnings).toEqual({ A: [], B: [] });
  });

  it("takes turns: each side rolls in its own run of numbers", () => {
    const { A, B, run } = pairUp();
    const seen = [];
    for (let i = 0; i < 3; i++) {
      A.roll({ k: "tray", side: 0, idx: [], add: 1 }, (die, done, n) => { seen.push("A" + n); done(); });
      run();
      B.roll({ k: "tray", side: 1, idx: [], add: 1 }, (die, done, n) => { seen.push("B" + n); done(); });
      run();
    }
    expect(seen).toEqual(["A1", "B1", "A2", "B2", "A3", "B3"]);
  });

  it("notices a roll that was thrown away", () => {
    const { A, run, warnings } = pairUp();
    A.roll({ k: "tray", side: 0, idx: [], add: 3 }, (die, done) => done());   // rolled, never sent to B
    run();
    A.take();
    A.roll({ k: "tray", side: 0, idx: [], add: 3 }, (die, done) => done());
    run();
    expect(warnings.B).toEqual(["Ash's roll #1 was never used"]);
  });

  it("refuses to answer a roller that changes its secret after promising it", () => {
    // A swaps in another secret when it reveals: B can tell from the hash it was promised
    const { A, run, warnings } = pairUp({ cheatA: m => m.k === "roll" ? { ...m, sec: "0".repeat(32) } : m });
    const onDice = vi.fn();
    A.roll({ k: "tray", side: 0, idx: [], add: 3 }, onDice);
    run();
    expect(onDice).not.toHaveBeenCalled();
    expect(warnings.B[0]).toMatch(/isn't the one it promised/);
  });

  it("waits for the other browser's promise before revealing anything", () => {
    const q = [];
    const A = createFair({ send: m => q.push(m) });
    A.pair("b", 0);
    q.length = 0;                               // B hasn't said hello yet
    expect(A.roll({ k: "tray", side: 0, idx: [], add: 1 }, () => {})).toBe(null);
    expect(q).toEqual([]);
    expect(A.roll({ k: "tray", side: 0, idx: [], add: 1 }, () => {})).toMatch(/still on its way/);
  });

  it("puts both secrets in the seed, the roller's first", () => {
    expect(seedOf(1, 4, "aa", "bb")).not.toBe(seedOf(1, 4, "bb", "aa"));
    expect(seedOf(0, 4, "aa", "bb")).not.toBe(seedOf(1, 4, "aa", "bb"));
  });
});
