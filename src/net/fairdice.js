/**
 * Fair dice online: commit-reveal. Neither player's browser can choose or foresee a roll,
 * and each browser checks that the other one used the dice it was given.
 *
 * Every roll has a roller (the side acting) and a responder (the other player). Each
 * player makes a fresh random secret for each roll and sends only its hash first (the
 * "commitment"). For roll n of a side:
 *
 *   1. The responder's commitment for roll n is already there (it came with the answer
 *      to roll n-1, or at the start).
 *   2. The roller sends what it is rolling for (`what`: this shot, these dice) and reveals
 *      its secret for roll n, with the commitment for its secret for roll n+1.
 *   3. The responder checks that secret against the roller's commitment, then reveals its
 *      own secret for roll n (and commits to n+1).
 *   4. Both browsers now hold both secrets. The dice are SHA-256 of both, so they are the
 *      same in both browsers. Neither player could steer them: each secret was fixed by
 *      its hash before the other secret was known.
 *
 * The roller puts the result into the game and sends it as usual, marked with the roll's
 * number. The other player's browser works the dice out itself and checks the trays and
 * wounds (rollProblem). Without a mark, dice in the trays can't change. If a roll is never
 * used (rolled, didn't like it, rolled again), the responder sees that at the next roll.
 *
 * Plain JS, no DOM: the unit tests wire two of these together in Node.
 */
import { fightRoll, shootRoll } from '../engine/dice.js';
import { cleanDiceTrays } from './protocol.js';

const SIDE = ["Ash", "Slate"];

/* ---------- SHA-256 (synchronous, so messages are handled in order) ---------- */
// The constants are the fractional parts of the square and cube roots of the first primes.
const PRIMES = [];
for (let n = 2; PRIMES.length < 64; n++) if (PRIMES.every(p => n % p)) PRIMES.push(n);
const frac = x => ((x - Math.floor(x)) * 2 ** 32) >>> 0;
const K = Uint32Array.from(PRIMES, p => frac(Math.cbrt(p)));
const H0 = Uint32Array.from(PRIMES.slice(0, 8), p => frac(Math.sqrt(p)));
const ror = (x, n) => (x >>> n) | (x << (32 - n));
export function sha256(str) {
  const bytes = new TextEncoder().encode(String(str)), len = bytes.length;
  const m = new Uint8Array(Math.ceil((len + 9) / 64) * 64);
  m.set(bytes); m[len] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(m.length - 8, Math.floor(len / 2 ** 29));
  dv.setUint32(m.length - 4, (len * 8) >>> 0);
  const h = Uint32Array.from(H0), w = new Uint32Array(64);
  for (let o = 0; o < m.length; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      w[i] = w[i - 16] + (ror(x, 7) ^ ror(x, 18) ^ (x >>> 3)) + w[i - 7] + (ror(y, 17) ^ ror(y, 19) ^ (y >>> 10));
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += k;
  }
  return Array.from(h, v => v.toString(16).padStart(8, "0")).join("");
}

/* ---------- secrets and dice ---------- */
// 128 random bits as hex, from the browser's cryptographic random numbers
export function newSecret() {
  return Array.from(crypto.getRandomValues(new Uint32Array(4)), v => v.toString(16).padStart(8, "0")).join("");
}
const HEX = /^[0-9a-f]{32,64}$/;
// what both browsers hash for roll n of side s: the roller's secret, then the responder's
export const seedOf = (s, n, rollerSec, responderSec) => `skirmishtable-roll:${s}:${n}:${rollerSec}:${responderSec}`;
// The dice of a roll: bytes of SHA-256(seed, block), each byte under 252 a D6 (252 = 42 × 6,
// so every face is equally likely), as many blocks as the roll needs.
export function diceFrom(seed) {
  let block = 0, bytes = [], i = 0;
  return () => {
    for (;;) {
      if (i >= bytes.length) { const hx = sha256(seed + "#" + block++); bytes = hx.match(/../g).map(b => parseInt(b, 16)); i = 0; }
      const b = bytes[i++];
      if (b < 252) return 1 + (b % 6);
    }
  };
}

/* ---------- what a roll does to the game ---------- */
const ints = (a, max) => Array.isArray(a) ? a.filter(i => Number.isInteger(i) && i >= 0 && i < max).slice(0, 20) : [];
// Apply roll `what` by side s to st = {ops, trays} (copies: changed in place). Marks the
// operatives whose wounds it changes in `touched` and the trays it fills in `sides`.
// Returns why the roll makes no sense, or null.
//   shoot {by, at, w, acc, obsc, cover} · fight {by, at, wa, wb} · tray {side, idx, add}
//   (tray: the dice box threw the slotted dice at `idx` again plus `add` new ones)
export function applyRoll(what, s, st, die, touched, sides) {
  if (!what || typeof what !== "object") return "a roll for nothing";
  if (what.k === "shoot" || what.k === "fight") {
    const a = st.ops.find(o => o.id === what.by), b = st.ops.find(o => o.id === what.at);
    if (!a || !b || a.team !== s || b.team === s || !a.alive || !b.alive) return "a roll for the wrong operatives";
    if (what.k === "shoot") {
      const r = shootRoll(what, a, b, die);
      if (!r) return `a shot with a weapon ${a.name} doesn't carry`;
      st.trays[a.team] = { ...st.trays[a.team], dice: r.atk.dice, hit: r.hit, rerolled: [] };
      st.trays[b.team] = { ...st.trays[b.team], dice: r.dfn.dice, hit: b.save, rerolled: [] };
      b.wounds = Math.max(0, b.wounds - r.dmg);
      if (b.wounds === 0) b.alive = false;
      touched.add(b.id);
    } else {
      const r = fightRoll(what, a, b, die);
      if (!r) return `a fight with a weapon ${a.name} or ${b.name} doesn't carry`;
      st.trays[a.team] = { ...st.trays[a.team], dice: r.ra.dice, hit: r.hitA, rerolled: [] };
      st.trays[b.team] = { ...st.trays[b.team], dice: r.rb.dice, hit: r.hitB, rerolled: [] };
      Object.assign(a, r.a); Object.assign(b, r.b);
      touched.add(a.id); touched.add(b.id);
    }
    sides.add(0); sides.add(1);
    return null;
  }
  if (what.k === "tray") {
    if (what.side !== s) return "a roll in the other side's dice box";
    const t = st.trays[s] = { ...st.trays[s], dice: [...st.trays[s].dice], rerolled: [...st.trays[s].rerolled] };
    const idx = ints(what.idx, t.dice.length), add = Math.max(0, Math.min(20, what.add | 0));
    const vals = Array.from({ length: idx.length + add }, () => die());
    if (add) {
      // new dice join the slotted ones as one roll; slotted dice thrown with them re-rolled
      idx.forEach((i, k) => { t.dice[i] = vals[k]; });
      t.dice = [...t.dice, ...vals.slice(idx.length)].slice(0, 20);
      t.rerolled = [...new Set([...t.rerolled, ...idx])];
    } else {
      // a re-roll: each die once
      idx.forEach((i, k) => { if (!t.rerolled.includes(i)) { t.dice[i] = vals[k]; t.rerolled.push(i); } });
    }
    sides.add(s);
    return null;
  }
  return "an unknown kind of roll";
}

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
// Is `next` what `prev` becomes after these rolls (recs: [{s, what, seed}], in order)?
// Checks the dice in both trays and the wounds the rolls changed; with no rolls, dice in
// a tray may only be cleared. prev.ops must carry the stats (names, weapons, save).
// Returns what's wrong, or null.
export function rollProblem(prev, next, recs) {
  if (!prev || !next || !Array.isArray(prev.ops)) return "no game to check";
  const ops = prev.ops.map(o => ({ ...o }));
  const before = cleanDiceTrays(prev.dice), got = cleanDiceTrays(next.dice);
  const st = { ops, trays: before.map(t => ({ ...t, dice: [...t.dice], rerolled: [...t.rerolled] })) };
  const touched = new Set(), sides = new Set();
  for (const r of recs) {
    const why = applyRoll(r.what, r.s, st, diceFrom(r.seed), touched, sides);
    if (why) return why;
  }
  for (const s of [0, 1]) {
    if (sides.has(s)) {
      if (!same(got[s].dice, st.trays[s].dice)) return `${SIDE[s]}'s dice don't match the shared roll`;
    } else if (got[s].dice.length && !same(got[s].dice, before[s].dice)) {
      return `${SIDE[s]}'s dice changed without a shared roll`;
    }
  }
  const nextOps = Array.isArray(next.ops) ? next.ops : [];
  for (const id of touched) {
    const e = ops.find(o => o.id === id), n = nextOps.find(o => o && o.id === id);
    if (!n || n.wounds !== e.wounds || !!n.alive !== !!e.alive) return `${e.name}'s wounds don't match the shared roll`;
  }
  return null;
}

/* ---------- the protocol between the two players ---------- */
// send(msg, peerId): to the other player. warn(text): something the other browser did
// wrong, for this player's log. check(what, side): why this roll looks wrong from this
// table (a shot it doesn't see), or null; warned about, never refused, so neither player
// can block the other's rolls. Messages are {t: "fair", k: "hi" | "roll" | "rolled", ...}.
export function createFair({ send, warn = () => {}, check = () => null, timeout = 15000, secret = newSecret } = {}) {
  let peer = null, me = null, them = null;
  let next, mine, theirs, waiting, inflight, landing, recs, out, checked;
  const fresh = n => { const sec = secret(); return { n, sec, h: sha256(sec) }; };
  function reset() {
    next = [0, 0];                    // the next roll's number, per side
    mine = [fresh(0), fresh(0)];      // my secret for that roll, per side
    theirs = [null, null];            // their commitment for that roll, per side
    waiting = null; inflight = null; landing = 0;
    recs = new Map(); out = []; checked = 0;
  }
  reset();
  const key = (s, n) => s + ":" + n;
  function fail(w, why) {
    clearTimeout(w.timer);
    if (waiting === w) waiting = null;
    if (w.onFail) w.onFail(why);
  }

  // start (or restart) rolling with this player; I play side `seat`
  function pair(id, seat) {
    if (waiting) fail(waiting, "the other player reconnected");
    peer = id; me = seat; them = 1 - seat;
    reset();
    send({ t: "fair", k: "hi", h: [mine[0].h, mine[1].h] }, peer);
  }
  function unpair() {
    if (waiting) fail(waiting, "the other player left");
    peer = null;
  }

  // Roll for `what`: onDice(die, done, n) once both secrets are in (die() gives the dice
  // in order; call done() when the result is in the game, which marks it for the other
  // player to check; n is the roll's number for the log). Returns null, or why not now.
  function roll(what, onDice, onFail) {
    if (!peer) return "no other player to roll with";
    if (inflight && inflight.late) return "the other player's browser stopped answering rolls — leave and join again";
    if (waiting || inflight) return "a roll is still on its way";
    if (landing && Date.now() - landing < 8000) return "wait for your last roll to land";
    const w = waiting = { s: me, what, onDice, onFail };
    w.timer = setTimeout(() => { w.late = true; fail(w, "the other player's browser didn't answer"); }, timeout);
    go();
    return null;
  }
  function go() {
    const w = waiting;
    if (!w || w.sent || inflight) return;
    const s = w.s, n = next[s], t = theirs[s];
    if (!t || t.n !== n) return;      // their commitment for this roll isn't here yet
    const my = mine[s];
    mine[s] = fresh(n + 1);
    Object.assign(w, { n, sec: my.sec, sent: true });
    inflight = w;
    send({ t: "fair", k: "roll", s, n, what: w.what, sec: my.sec, h: mine[s].h }, peer);
  }

  function onMessage(m) {
    if (!peer || !m || typeof m !== "object") return;
    if (m.k === "hi") {
      if (!Array.isArray(m.h) || !m.h.every(h => HEX.test(h))) return warn("the other player's browser sent a broken start");
      theirs = [{ n: 0, h: m.h[0] }, { n: 0, h: m.h[1] }];
      go();
    } else if (m.k === "roll") answer(m);
    else if (m.k === "rolled") rolled(m);
  }
  // I'm the responder: check their secret, reveal mine
  function answer(m) {
    const s = m.s, n = m.n, t = theirs[s];
    if (s !== them) return warn("a roll for the wrong side");
    if (n !== next[s] || !t || t.n !== n) return warn(`${SIDE[s]}'s roll #${(n | 0) + 1} came out of order`);
    if (typeof m.sec !== "string" || sha256(m.sec) !== t.h || !HEX.test(m.h))
      return warn(`${SIDE[s]}'s secret for roll #${n + 1} isn't the one it promised — not answered`);
    const before = recs.get(key(s, n - 1));
    if (before && !before.seen) warn(`${SIDE[s]}'s roll #${n} was never used`);
    let why = null;
    try { why = check(m.what, s); } catch (e) { why = "it names something this table doesn't have"; }
    if (why) warn(`${SIDE[s]}'s roll #${n + 1}: ${why}`);
    const my = mine[s];
    mine[s] = fresh(n + 1);
    send({ t: "fair", k: "rolled", s, n, sec: my.sec, h: mine[s].h }, peer);
    theirs[s] = { n: n + 1, h: m.h };
    next[s] = n + 1;
    recs.set(key(s, n), { s, n, what: m.what, seed: seedOf(s, n, m.sec, my.sec), seen: false });
  }
  // I'm the roller: check their secret, then the dice are known
  function rolled(m) {
    const w = inflight;
    if (!w || m.s !== w.s || m.n !== w.n) return warn("an answer to a roll nobody made");
    inflight = null;
    const t = theirs[w.s];
    if (typeof m.sec !== "string" || sha256(m.sec) !== t.h || !HEX.test(m.h)) {
      warn(`the other player's secret for roll #${w.n + 1} isn't the one it promised`);
      return fail(w, "the other player's browser broke the shared roll");
    }
    theirs[w.s] = { n: w.n + 1, h: m.h };
    next[w.s] = w.n + 1;
    const seed = seedOf(w.s, w.n, w.sec, m.sec), rec = { s: w.s, n: w.n, what: w.what, seed, seen: false };
    recs.set(key(w.s, w.n), rec);
    if (waiting !== w) return;        // it timed out: this roll is lost
    clearTimeout(w.timer); waiting = null;
    landing = Date.now();
    w.onDice(diceFrom(seed), () => { landing = 0; out.push({ s: w.s, n: w.n }); }, w.n + 1);
  }

  // the rolls put into the game since the last update (to send with it)
  const take = () => out.splice(0);
  // the other browser's update: are these rolls (tags [{s, n}]) in it as they fell?
  function verify(prev, nextGame, tags) {
    if (!peer) return null;
    const list = [];
    for (const t of Array.isArray(tags) ? tags.slice(0, 8) : []) {
      const r = t && recs.get(key(t.s, t.n));
      if (!r) return "a roll that never happened";
      if (r.seen) return `${SIDE[r.s]}'s roll #${r.n + 1} used twice`;
      list.push(r);
    }
    for (const r of list) r.seen = true;
    const why = rollProblem(prev, nextGame, list);
    if (!why) checked += list.length;
    return why;
  }
  // rolls in an update that was refused for another reason: not used, and no warning later
  function lose(tags) {
    for (const t of Array.isArray(tags) ? tags : []) { const r = t && recs.get(key(t.s, t.n)); if (r) r.seen = true; }
  }
  const kinds = tags => (Array.isArray(tags) ? tags : []).map(t => (recs.get(key(t && t.s, t && t.n)) || {}).what).filter(Boolean).map(w => w.k);
  return { pair, unpair, roll, onMessage, take, verify, lose, kinds,
           peer: () => peer, paired: () => peer !== null, checked: () => checked };
}
