/**
 * Share links, the pure half (no DOM): a whole game packed into the address after
 * "#game=", so a link shows someone the table without anyone hosting. The fragment never
 * reaches a server. What comes back out is only shaped here; the caller cleans it with
 * the same protocol.js cleaners as online play (sync.js applyGame). See docs/MULTIPLAYER.md.
 *
 * Format: "#game=1." + base64url(deflate-raw(JSON)). The "1." is the format version; the
 * JSON also says v:1. Operatives travel as short arrays of only the fields that change in
 * play (names, stats and weapons come from the opener's own roster, as online).
 */
export const LINK_V = 1;
export const SOFT_MAX = 2000;            // characters a link can have and still survive most chat apps
const HARD_MAX = 200000;                 // refuse to decode anything bigger
const OP_KEYS = ["id", "x", "y", "wounds", "ap", "order", "ready", "alive", "weapon", "used", "z"];

export function packGame(g, at = Date.now()) {
  const { ops, ...rest } = g;
  return { v: LINK_V, at, ...rest, ops: (ops || []).map(o => OP_KEYS.map(k => o[k])) };
}
// Back to the shape exportGame() makes. Junk in, null out; fields are cleaned later.
export function unpackGame(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  if (p.v !== LINK_V) return { error: p.v > LINK_V ? "it was made by a newer SkirmishTable" : "its format is unknown" };
  if (!Array.isArray(p.ops) || typeof p.map !== "string" || typeof p.rules !== "string") return null;
  const { v, at, ops, ...rest } = p;
  return { ...rest, at: typeof at === "number" && Number.isFinite(at) ? at : null,
    ops: ops.map(a => Array.isArray(a) ? Object.fromEntries(OP_KEYS.map((k, i) => [k, a[i]])) : null) };
}

/* ---------- bytes <-> text ---------- */
// limit: stop early (and throw) once the output passes it, so a tiny link can't unpack to gigabytes
async function pipe(bytes, stream, limit = Infinity) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader(), parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > limit) { reader.cancel().catch(() => {}); throw new Error("too big"); }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}
function toB64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(t) {
  const s = atob(t.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}

// game (exportGame/outGame shape) -> "1.xxxx", the part after "#game="
export async function encodeGame(g, at) {
  const json = new TextEncoder().encode(JSON.stringify(packGame(g, at)));
  return LINK_V + "." + toB64url(await pipe(json, new CompressionStream("deflate-raw")));
}
// "#game=1.xxxx" (or just "1.xxxx") -> { game } or { error: "why, in plain words" }
export async function decodeGame(hash) {
  const m = /^(?:#game=)?(\d+)\.([A-Za-z0-9_-]+)$/.exec(hash || "");
  if (!m) return { error: "the link is damaged (it may have been cut short)" };
  if (+m[1] !== LINK_V) return { error: +m[1] > LINK_V ? "it was made by a newer SkirmishTable" : "its format is unknown" };
  if (m[2].length > HARD_MAX) return { error: "it is too big" };
  let p;
  try {
    const bytes = await pipe(fromB64url(m[2]), new DecompressionStream("deflate-raw"), HARD_MAX * 20);
    p = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    return { error: "the link is damaged (it may have been cut short)" };
  }
  const g = unpackGame(p);
  if (!g) return { error: "it doesn't hold a game" };
  return g.error ? g : { game: g };
}
export const isGameHash = hash => /^#game=/.test(hash || "");
