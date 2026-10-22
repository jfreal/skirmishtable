/**
 * Online play, the pure half (no DOM, no network): room codes, seats, the host's check on
 * a player's update, and cleaning whatever arrives from another browser before it touches
 * the game. The unit tests run this in Node. See docs/MULTIPLAYER.md.
 */

// room codes: no 0/O, 1/I/L, so they survive being read out loud
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function newRoomCode(n = 10) {
  const r = crypto.getRandomValues(new Uint32Array(n));
  return Array.from(r, v => CODE_CHARS[v % CODE_CHARS.length]).join("");
}
// "#host=CODE" reopens a room you host (after a reload); "#room=CODE" joins one
export function parseRoomHash(hash) {
  const m = /^#(host|room)=([A-Za-z0-9]{6,24})$/.exec(hash || "");
  return m ? { role: m[1] === "host" ? "host" : "guest", code: m[2].toUpperCase() } : null;
}

// The host's side is taken; the first guest gets the other one (or the side it asks for,
// if free), everyone after that watches (null).
export function pickSeat(peers, hostSeat, want) {
  const taken = new Set([hostSeat, ...Object.values(peers)]);
  if ((want === 0 || want === 1) && !taken.has(want)) return want;
  for (const s of [0, 1]) if (!taken.has(s)) return s;
  return null;
}

// Why the host refuses a player's update (null = fine). Players trust each other with
// dice and wounds; the check stops a browser moving the other side's operatives,
// changing the map or rules, or a watcher changing anything.
const FIXED_FOR_FOES = ["x", "y", "order", "weapon"];
export function updateProblem(prev, next, seat) {
  if (seat !== 0 && seat !== 1) return "watchers can't change the game";
  if (!next || typeof next !== "object") return "empty update";
  if (next.rules !== prev.rules || next.map !== prev.map || next.mapName !== prev.mapName)
    return "only the host changes the map or rules";
  if (!Array.isArray(next.ops) || next.ops.length !== prev.ops.length) return "roster doesn't match";
  for (const p of prev.ops) {
    const n = next.ops.find(o => o && o.id === p.id);
    if (!n) return "roster doesn't match";
    if (p.team !== seat && FIXED_FOR_FOES.some(k => n[k] !== p[k])) return `${p.id} belongs to the other player`;
  }
  const other = 1 - seat, ms = next.minis;
  if (!Array.isArray(ms) || JSON.stringify(ms[other]) !== JSON.stringify(prev.minis[other]))
    return "the other side's miniatures belong to the other player";
  // the mission: the host sets the season and Crit Op; each player their own Tac Op,
  // Primary and score; markers and dice are anyone's (players trust each other there)
  const a = prev.mission, b = next.mission;
  if (a && b) {
    if (b.set !== a.set || b.crit !== a.crit) return "only the host sets the season and Crit Op";
    const mineOnly = k => JSON.stringify((b[k] || [])[other]) !== JSON.stringify((a[k] || [])[other]);
    if (["tac", "primary", "score"].some(mineOnly)) return "the other side's ops and score belong to the other player";
  }
  return null;
}
// The dice tray: up to 20 dice of 1–6, a target of 2–6, re-rolled indexes within range.
export function cleanDice(d) {
  const dice = Array.isArray(d && d.dice) ? d.dice.filter(v => Number.isInteger(v) && v >= 1 && v <= 6).slice(0, 20) : [];
  return {
    who: d && (d.who === 0 || d.who === 1) ? d.who : null,
    label: typeof (d && d.label) === "string" ? d.label.replace(/[<>"&]/g, "").slice(0, 80) : "",
    hit: d && Number.isInteger(d.hit) && d.hit >= 2 && d.hit <= 6 ? d.hit : 3,
    dice,
    rerolled: Array.isArray(d && d.rerolled) ? d.rerolled.filter(i => Number.isInteger(i) && i >= 0 && i < dice.length).slice(0, 20) : [],
  };
}
// The mission and score sheet: indexes into the card catalog, small whole-number VP,
// markers by token index and board position.
export function cleanMission(m, catalog) {
  const idx = (v, n) => Number.isInteger(v) && v >= 0 && v < n ? v : null;
  const set = idx(m && m.set, catalog.sets.length) ?? 0, s = catalog.sets[set];
  const pair = (p, n) => [0, 1].map(i => idx(Array.isArray(p) ? p[i] : null, n));
  const vp = v => Number.isInteger(v) && v >= 0 && v <= 9 ? v : 0;
  const score = [0, 1].map(i => [0, 1, 2, 3].map(tp => [0, 1, 2].map(c => vp(m && m.score && m.score[i] && m.score[i][tp] && m.score[i][tp][c]))));
  const markers = Array.isArray(m && m.markers) ? m.markers.slice(0, 60).filter(k => k && idx(k.k, catalog.tokens.length) !== null
    && Number.isFinite(k.x) && Number.isFinite(k.y) && Number.isInteger(k.id))
    .map(k => ({ id: k.id, k: k.k, x: k.x, y: k.y })) : [];
  return { set, crit: idx(m && m.crit, s.crit.length), tac: pair(m && m.tac, s.tac.length),
           primary: pair(m && m.primary, 3), score, markers };
}

/* ---------- cleaning incoming data ---------- */
const num = (v, d) => typeof v === "number" && Number.isFinite(v) ? v : d;
const ACTS = ["reposition", "dash", "charge", "shoot", "fight"];
// Operatives from another browser: only the fields that change in play are taken, and
// only in their known shapes; names, stats and weapons come from this browser's roster.
export function cleanOps(incoming, local) {
  if (!Array.isArray(incoming) || incoming.length !== local.length) return null;
  const byId = new Map(incoming.filter(o => o && typeof o === "object").map(o => [o.id, o]));
  return local.map(l => {
    const o = byId.get(l.id);
    if (!o) return { ...l };
    return { ...l,
      x: num(o.x, l.x), y: num(o.y, l.y),
      wounds: Math.max(0, Math.min(l.maxW, num(o.wounds, l.wounds))), ap: num(o.ap, l.ap),
      order: o.order === "engage" ? "engage" : "conceal",
      ready: !!o.ready, alive: !!o.alive,
      weapon: l.weapons.includes(o.weapon) ? o.weapon : l.weapon,
      used: Array.isArray(o.used) ? o.used.filter(u => ACTS.includes(u)).slice(0, 12) : [] };
  });
}
export function cleanTray(t, d) {
  if (!t || typeof t !== "object") return d;
  const pair = (p, q) => Array.isArray(p) ? [num(p[0], q[0]), num(p[1], q[1])] : q;
  return { tp: num(t.tp, d.tp), cp: pair(t.cp, d.cp), vp: pair(t.vp, d.vp) };
}
export function cleanMinis(sides, teamIds) {
  return [0, 1].map(i => {
    const s = Array.isArray(sides) && sides[i] && typeof sides[i] === "object" ? sides[i] : {};
    const picks = {};
    if (s.picks && typeof s.picks === "object")
      for (const [k, v] of Object.entries(s.picks))
        if (/^[A-Z]\d{1,2}$/.test(k) && Number.isInteger(v) && v >= 0 && v < 1000) picks[k] = v;
    return { team: teamIds.includes(s.team) ? s.team : null, picks };
  });
}
// An imported map's definition: plain JSON, but its names end up in the page as HTML,
// so strip the characters that could make markup.
export function cleanStrings(v) {
  if (typeof v === "string") return v.replace(/[<>"&]/g, "");
  if (Array.isArray(v)) return v.map(cleanStrings);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[cleanStrings(k)] = cleanStrings(x);
    return o;
  }
  return v;
}
