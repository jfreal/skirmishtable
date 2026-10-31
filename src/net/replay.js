/**
 * Replays, the pure half (no DOM): a game recorded step by step, and packed into a
 * "#replay=…" link that plays it back turn by turn. The same idea as share links (link.js),
 * which this reuses: the first frame is a whole game, every step after it only what
 * changed. The fragment never reaches a server. See docs/MULTIPLAYER.md.
 *
 * A recording, in memory: { at, mapDef, frames: [game, …], logs: [[text, …], …] }.
 * frames[0] is the table when recording started; every action after it is one frame
 * (exportGame shape). logs[i] is the log lines that came with frame i, as plain text.
 *
 * Packed (the JSON in the link and in a saved file):
 *   { v: 1, at, start: packGame(frames[0]) without v/at, steps: [{ o, g, l }, …] }
 *   o: [[op index, key index, value, key index, value, …], …]   op fields that changed (OP_KEYS)
 *   g: { tray, minis, dice, mission, ops }                        whole parts that changed
 *   l: [text, …]                                                  the step's log lines
 */
import { LINK_V, OP_KEYS, packGame, unpackGame, unzipJSON, zipJSON } from './link.js';

export const REPLAY_V = 1;
export const MAX_STEPS = 3000;           // a long game is a few hundred
export const MAX_OPS = 64;                 // operatives in one game; a replay claiming more is junk
const HARD_MAX = 2000000;                // refuse to decode a link longer than this
const PARTS = ["tray", "minis", "dice", "mission"];
const LINES = 12, LINE_MAX = 400;        // log lines kept per step, and characters per line
const sig = g => JSON.stringify(g);

/* ---------- recording ---------- */
export function newRecording(g, at = Date.now(), mapDef) {
  const s = sig(g);
  return { at, mapDef, frames: [JSON.parse(s)], logs: [[]], sigs: [s] };
}
// The game after a change. Returns what happened: "same" (nothing changed), "undo" (it's
// back to the frame before the last one, so the last step is taken off), "full" or "step".
export function addStep(rec, g, lines = []) {
  const s = sig(g), n = rec.frames.length;
  if (s === rec.sigs[n - 1]) return "same";
  if (n >= 2 && s === rec.sigs[n - 2]) {
    rec.frames.pop(); rec.logs.pop(); rec.sigs.pop();
    return "undo";
  }
  if (n > MAX_STEPS) return "full";
  rec.frames.push(JSON.parse(s)); rec.sigs.push(s);
  rec.logs.push(cleanLines(lines));
  return "step";
}
export const steps = rec => rec ? rec.frames.length - 1 : 0;
const cleanLines = ls => (Array.isArray(ls) ? ls : []).filter(l => typeof l === "string" && l)
  .slice(-LINES).map(l => l.slice(0, LINE_MAX));

// Where each turning point starts: [{ tp, i }], i = the first frame showing that TP.
export function turnStarts(frames) {
  const out = [];
  frames.forEach((g, i) => {
    const tp = g && g.tray && g.tray.tp;
    if (Number.isInteger(tp) && (!out.length || tp !== out[out.length - 1].tp)) out.push({ tp, i });
  });
  return out;
}

/* ---------- packed ---------- */
export function packReplay(rec) {
  const start = packGame(rec.mapDef ? { ...rec.frames[0], mapDef: rec.mapDef } : rec.frames[0]);
  delete start.v; delete start.at;
  let prevOps = start.ops, prev = rec.frames[0];
  const out = rec.frames.slice(1).map((g, j) => {
    const s = {}, ops = packGame(g).ops;
    if (ops.length !== prevOps.length) (s.g = {}).ops = ops;
    else {
      const o = [];
      ops.forEach((a, i) => {
        const d = [];
        a.forEach((v, k) => { if (sig(v) !== sig(prevOps[i][k])) d.push(k, v === undefined ? null : v); });
        if (d.length) o.push([i, ...d]);
      });
      if (o.length) s.o = o;
    }
    for (const k of PARTS) if (sig(g[k]) !== sig(prev[k])) (s.g = s.g || {})[k] = g[k];
    const l = rec.logs[j + 1];
    if (l && l.length) s.l = l;
    prevOps = ops; prev = g;
    return s;
  });
  return { v: REPLAY_V, at: rec.at, start, steps: out };
}

// Back to a recording. Junk in, null out (or { error }); the frames still go through
// sync.js applyGame's cleaners before they touch the table.
export function unpackReplay(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  if (p.v !== REPLAY_V) return { error: p.v > REPLAY_V ? "it was made by a newer SkirmishTable" : "its format is unknown" };
  if (!p.start || typeof p.start !== "object" || !Array.isArray(p.steps) || p.steps.length > MAX_STEPS) return null;
  if (!Array.isArray(p.start.ops) || p.start.ops.length > MAX_OPS) return null;
  const first = unpackGame({ ...p.start, v: LINK_V, at: p.at });
  if (!first || first.error) return null;
  const { at, mapDef, ...g0 } = first;
  const frames = [g0], logs = [[]];
  let ops = p.start.ops, prev = g0;
  for (const s of p.steps) {
    if (!s || typeof s !== "object") return null;
    const g = s.g && typeof s.g === "object" ? s.g : {};
    if (Array.isArray(g.ops)) {
      if (g.ops.length > MAX_OPS) return null;
      ops = g.ops;
    }
    else if (Array.isArray(s.o)) {
      ops = ops.map(a => Array.isArray(a) ? a.slice() : a);
      for (const d of s.o) {
        if (!Array.isArray(d) || !Number.isInteger(d[0]) || !Array.isArray(ops[d[0]])) return null;
        for (let k = 1; k + 1 < d.length; k += 2) {
          if (!Number.isInteger(d[k]) || d[k] < 0 || d[k] >= OP_KEYS.length) return null;
          ops[d[0]][d[k]] = d[k + 1];
        }
      }
    }
    const next = { ...prev };
    for (const k of PARTS) if (k in g) next[k] = g[k];
    next.ops = unpackGame({ v: LINK_V, map: next.map, rules: next.rules, ops }).ops;
    frames.push(next); logs.push(cleanLines(s.l));
    prev = next;
  }
  return { at: typeof at === "number" ? at : null, mapDef, frames, logs };
}

/* ---------- links ---------- */
// recording -> "1.xxxx", the part after "#replay="
export async function encodeReplay(rec) {
  return REPLAY_V + "." + await zipJSON(packReplay(rec));
}
// "#replay=1.xxxx&step=12" -> { replay, step } or { error: "why, in plain words" }
export async function decodeReplay(hash) {
  const m = /^(?:#replay=)?(\d+)\.([A-Za-z0-9_-]+)(?:&step=(\d+))?$/.exec(hash || "");
  if (!m) return { error: "the link is damaged (it may have been cut short)" };
  if (+m[1] !== REPLAY_V) return { error: +m[1] > REPLAY_V ? "it was made by a newer SkirmishTable" : "its format is unknown" };
  if (m[2].length > HARD_MAX) return { error: "it is too big" };
  let p;
  try {
    p = await unzipJSON(m[2], HARD_MAX * 20);
  } catch (e) {
    return { error: "the link is damaged (it may have been cut short)" };
  }
  const replay = unpackReplay(p);
  if (!replay) return { error: "it doesn't hold a replay" };
  if (replay.error) return replay;
  return { replay, code: m[1] + "." + m[2], step: m[3] === undefined ? 0 : Math.min(+m[3], replay.frames.length - 1) };
}
export const isReplayHash = hash => /^#replay=/.test(hash || "");
export const replayHash = (code, step) => "#replay=" + code + (step ? "&step=" + step : "");
