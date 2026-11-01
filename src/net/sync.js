/**
 * Online play: one browser hosts, others open its link and see the same table live.
 * The host keeps the true game. A player's browser runs its own action exactly as offline
 * (routing, sight, dice), then sends the whole game (a few KB) to the host; the host checks
 * it (protocol.js), keeps it for undo and passes it to everyone. Selection, camera, ruler
 * and the 3D models stay per browser: every browser loads the models from Steam itself.
 *
 * Dice are the exception to "run it locally": with two players, every roll is a shared
 * commit-reveal roll between the two browsers (fairdice.js), the update says which rolls
 * it holds, and the other browser checks the dice and wounds against them.
 */
import { state } from '../state.js';
import { TTS_TEAMS } from '../data/tts-teams.js';
import { MAP, MAPS, OPS } from '../engine/world.js';
import { RULES, RULESETS, setRuleset } from '../rules/index.js';
import { renderAll } from '../ui/board.js';
import { loadMap, renderRuleButtons } from '../ui/controls.js';
import { hint, logEl, logHooks, logLine, logRemote } from '../ui/dom.js';
import { renderMinis } from '../ui/minis.js';
import { doUndo, refreshSight, snapshot, tray, undoStack } from '../ui/panels.js';
import { minis, onMinisChange, setMinisSides } from '../view3d/units.js';
import { cleanDiceTrays, cleanMinis, cleanMission, cleanOps, cleanStrings, cleanTray, newRoomCode, parseRoomHash, pickSeat, updateProblem } from './protocol.js';
import { exportDice, onDiceChange, renderDice, setDiceTray } from '../ui/dicetray.js';
import { onOpsChange, opsState, renderOps, setOpsState } from '../ui/ops.js';
import { TTS_OPS } from '../data/tts-ops.js';
import { closeRoom, openRoom, selfId, send } from './session.js';
import { noteChange } from './replayer.js';
import { createFair } from './fairdice.js';
import { setRoller } from './roll.js';
import { CTRL, WPN } from '../config.js';
import { d6 } from '../engine/dice.js';
import { opGap } from '../engine/geometry.js';
import { SHOT_KINDS, cannotShoot, judgeShot } from '../engine/shots.js';

// role: null offline, "host" or "guest"; seat: 0 / 1 = the side you play, null = watching
export const net = { role: null, code: null, seat: null, hostId: null, v: 0, peers: {}, roster: [], status: "" };
export const online = () => net.role !== null;
const connected = () => net.role === "host" || !!net.hostId;   // a guest waits for the host
// a replay on the table (replayer.js) is look-only
export const mayControl = op => !state.replay && (!online() || (!!op && op.team === net.seat && connected()));
export const mayPlay = () => !state.replay && (!online() || ((net.seat === 0 || net.seat === 1) && connected()));
export const maySetUp = () => !state.replay && (!online() || net.role === "host");

const SIDE = ["Ash", "Slate"];
const seatName = s => s === 0 || s === 1 ? SIDE[s] : "watching";
const SAVE = "skirmishtable.host.";
let applying = false, lastSig = "", outbox = [], queued = false;
let lastHost = null;     // a guest's copy of the host's last game: what the host's next update is checked against
const esc = t => String(t).replace(/[<>&"]/g, "");

/* ---------- fair dice: the two players roll together ---------- */
// Does this roll look right from this table? Only warned about (fairdice.js).
function checkRoll(what, s) {
  const op = id => OPS.find(o => o.id === id);
  if (!what || typeof what !== "object") return "it says nothing";
  if (what.k === "tray") return what.side === s ? null : "it's in the other side's dice box";
  const a = op(what.by), b = op(what.at);
  if (!a || !b) return "it names an operative that isn't on this table";
  if (what.k === "shoot") {
    const w = WPN[what.w];
    if (!w || w.type !== "R") return "it isn't a ranged weapon";
    const eye = { x: a.x, y: a.y, team: a.team, op: a };
    if (cannotShoot(eye)) return `this table shows ${a.name} can't shoot`;
    const j = judgeShot(eye, b);
    if (!SHOT_KINDS[j.kind].valid) return `this table shows ${b.name} as "${SHOT_KINDS[j.kind].label}"`;
    const terms = (acc, obsc, cover) => [cover ? "in cover" : "not in cover", obsc ? "obscured" : "not obscured", `Accurate ${acc}`].join(", ");
    const here = terms(Math.min(j.accurate, w.atk), !!j.obscured, !!j.save), there = terms(what.acc | 0, !!what.obsc, !!what.cover);
    if (here !== there) return `it was rolled as ${there}, but this table shows ${here}`;
  } else if (what.k === "fight") {
    if (opGap(a, b) > CTRL) return `this table shows ${a.name} and ${b.name} out of control range`;
  }
  return null;
}
export const fair = createFair({
  send: (m, to) => send(m, to),
  warn: t => note(`<b>Online:</b> ⚠ ${esc(t)}.`),
  check: checkRoll,
});
// Online with both players at the table: the shared roll. Otherwise Math.random, now.
function roller(what, onDice, onFail) {
  if (!online() || !fair.paired()) { onDice(d6, () => {}, null, () => {}); return null; }
  const why = fair.roll(what, onDice,
    why => { hint(`The roll didn't happen: ${why}.`); if (onFail) onFail(why); });
  return why;
}

/* ---------- the game, out and in ---------- */
const mapKey = () => Object.keys(MAPS).find(k => MAPS[k] === MAP) || null;
const imported = k => /^imp/.test(k || "");
export function exportGame() {
  return { rules: RULES.id, map: mapKey(), mapName: MAP && MAP.name, ops: OPS,
           tray: { tp: tray.tp, cp: [...tray.cp], vp: [...tray.vp] }, minis: minis.sides,
           dice: exportDice(),
           mission: JSON.parse(JSON.stringify(opsState)) };
}
const sig = g => JSON.stringify(g);
// what goes on the wire: an imported map travels with its definition (guests don't have it)
export function outGame(g = exportGame()) { return imported(g.map) ? { ...g, mapDef: MAPS[g.map] } : g; }

export function applyGame(g) {
  if (!g || typeof g !== "object") return;
  applying = true; logHooks.mute = true;
  try {
    let reload = false;
    if (g.rules !== RULES.id && RULESETS[g.rules]) { setRuleset(g.rules); renderRuleButtons(); reload = true; }
    if (g.map !== mapKey() || (MAP && g.mapName !== MAP.name)) {
      if (imported(g.map) && g.mapDef) MAPS[g.map] = cleanStrings(g.mapDef);
      reload = true;
    }
    if (reload && MAPS[g.map]) loadMap(g.map);
    const ops = cleanOps(g.ops, OPS);
    if (ops) OPS.splice(0, OPS.length, ...ops);
    Object.assign(tray, cleanTray(g.tray, tray));
    // point the local selection, target and drag at the new operative objects
    const same = o => o && OPS.find(x => x.id === o.id) || null;
    state.sel = same(state.sel); state.target = same(state.target);
    refreshSight();
    if (state.drag) { state.drag.op = same(state.drag.op); if (!state.drag.op) state.drag = null; }
    const m = cleanMinis(g.minis, TTS_TEAMS.map(t => t.id));
    if (JSON.stringify(m) !== JSON.stringify(minis.sides)) setMinisSides(m);
    renderMinis();
    if (g.dice) setDiceTray(cleanDiceTrays(g.dice));
    if (g.mission) setOpsState(cleanMission(g.mission, TTS_OPS));
    renderAll();
  } finally {
    applying = false; logHooks.mute = false;
    lastSig = sig(exportGame()); outbox = [];
  }
}
// a line in this browser's log only (not sent)
function note(html) { logHooks.mute = true; logLine(html); logHooks.mute = false; }
function recentLog() {
  return [...logEl.children].slice(0, 40).reverse().map(p => ({ html: p.innerHTML, hit: p.classList.contains("hit") }));
}
function addLines(lines) {
  if (Array.isArray(lines)) for (const l of lines.slice(0, 30)) if (l && typeof l.html === "string") logRemote(l.html.slice(0, 4000), !!l.hit);
}

// After every render (and every Miniatures change): if the game changed, send it (and
// the replay recorder looks for a new step).
// One action can render several times (Shoot fills two dice trays, then the wounds), so
// the send waits for the end of the action: everything it did goes as one update.
export function pump() {
  noteChange();
  if (!online() || applying || queued) return;
  queued = true;
  queueMicrotask(flush);
}
function flush() {
  queued = false;
  if (!online() || applying) return;
  const g = exportGame(), s = sig(g);
  if (s === lastSig && !fair.pending()) { outbox = []; return; }   // a roll still to send goes even if it changed nothing   // nothing changed: log lines were local feedback
  if (net.role === "host") {
    net.v++;
    send({ t: "state", v: net.v, game: outGame(g), log: outbox, from: selfId, rolls: fair.take() });
    saveHost();
  } else if (net.hostId && mayPlay()) {
    send({ t: "update", base: net.v, game: outGame(g), log: outbox, rolls: fair.take() }, net.hostId);
  }
  lastSig = s; outbox = [];
}
// Undo online goes to the host, which keeps the one undo stack. True = handled here.
export function requestUndo() {
  if (net.role !== "guest") return false;
  if (net.hostId && mayPlay()) send({ t: "undo" }, net.hostId);
  return true;
}

/* ---------- host ---------- */
function saveHost() {
  try { localStorage.setItem(SAVE + net.code, JSON.stringify({ v: net.v, game: outGame() })); } catch (e) {}
}
export function hostGame(code = newRoomCode()) {
  Object.assign(net, { role: "host", code, seat: 0, hostId: selfId, v: 1, peers: {}, roster: [], status: "Waiting for players…" });
  history.replaceState(null, "", "#host=" + code);
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SAVE + code)); } catch (e) {}
  if (saved && saved.game) { applyGame(saved.game); net.v = (saved.v | 0) + 1; note("<b>Online:</b> restored the game you were hosting."); }
  lastSig = sig(exportGame()); outbox = [];
  openRoom(code, {
    onMessage: hostMessage,
    onJoin: () => {},                      // a guest says hello first
    onLeave: id => {
      if (id === fair.peer()) fair.unpair();
      if (id in net.peers) { note(`<b>Online:</b> ${seatName(net.peers[id])} left.`); delete net.peers[id]; sendRoster(); }
    },
    onError: e => { net.status = "Couldn't open the room: " + e; renderNet(); },
  });
  renderNet(); renderMinis(); renderAll();
}
function sendRoster() {
  net.roster = [net.seat, ...Object.values(net.peers)];
  net.status = net.roster.length > 1 ? "" : "Waiting for players…";
  send({ t: "roster", roster: net.roster });
  renderNet();
}
function hostMessage(m, from) {
  if (!m || typeof m !== "object") return;
  if (m.t === "hello") {
    delete net.peers[from];
    const seat = pickSeat(net.peers, net.seat, m.want);
    net.peers[from] = seat;
    send({ t: "welcome", seat, v: net.v, game: outGame(), log: recentLog() }, from);
    if ((net.seat === 0 || net.seat === 1) && seat === 1 - net.seat) fair.pair(from, net.seat);   // the other player: roll together from now on
    note(`<b>Online:</b> a player joined — ${seat === null ? "watching" : "playing " + SIDE[seat]}.`);
    sendRoster();
  } else if (m.t === "fair") {
    if (from === fair.peer()) fair.onMessage(m);
  } else if (m.t === "update") {
    const seat = from in net.peers ? net.peers[from] : null, prev = exportGame();
    let why = m.base !== net.v ? "out of step" : updateProblem(prev, m.game, seat);
    if (why) fair.lose(m.rolls);
    // the dice: only from shared rolls, and as they fell
    else if (from === fair.peer()) why = fair.verify(prev, m.game, m.rolls);
    if (why) {
      if (Array.isArray(m.rolls) && m.rolls.length) note(`<b>Online:</b> ${seatName(seat)}'s roll wasn't used: ${esc(why)}.`);
      send({ t: "state", v: net.v, game: outGame(), resync: why }, from); return;
    }
    const kinds = fair.kinds(m.rolls);
    snapshot();                             // the host's undo covers everyone's actions
    applyGame(m.game);
    if (kinds.length) undoStack.length = 0;   // a shared roll (shot, fight or dice box) can't be undone
    addLines(m.log);
    net.v++;
    send({ t: "state", v: net.v, game: outGame(), log: m.log, from, rolls: Array.isArray(m.rolls) ? m.rolls : [] });
    saveHost();
    renderFair();
  } else if (m.t === "undo") {
    if ((net.peers[from] === 0 || net.peers[from] === 1) && !doUndo())   // doUndo renders, so pump() sends it
      send({ t: "note", text: "Nothing to undo. Online, a shared roll can't be taken back." }, from);
  }
}

/* ---------- guest ---------- */
export function joinGame(code) {
  Object.assign(net, { role: "guest", code, seat: null, hostId: null, v: 0, peers: {}, roster: [], status: "Looking for the host…" });
  let want = null;
  try { want = JSON.parse(sessionStorage.getItem("skirmishtable.seat." + code)); } catch (e) {}
  openRoom(code, {
    onMessage: guestMessage,
    onJoin: id => send({ t: "hello", want }, id),
    onLeave: id => { if (id === net.hostId) { net.hostId = null; fair.unpair(); net.status = "The host left. Waiting for them to come back…"; renderNet(); renderAll(); } },
    onError: e => { net.status = "Couldn't join: " + e; renderNet(); },
  });
  renderNet(); renderMinis(); renderAll();
}
function guestMessage(m, from) {
  if (!m || typeof m !== "object") return;
  if (m.t === "welcome") {
    net.hostId = from; net.seat = m.seat === 0 || m.seat === 1 ? m.seat : null; net.v = m.v | 0;
    net.status = "";
    try { sessionStorage.setItem("skirmishtable.seat." + net.code, JSON.stringify(net.seat)); } catch (e) {}
    logEl.innerHTML = "";
    addLines(m.log);
    applyGame(m.game);
    lastHost = m.game;
    if (net.seat === 0 || net.seat === 1) fair.pair(from, net.seat); else fair.unpair();
    note(`<b>Online:</b> joined the host's table — ${net.seat === null ? "you're watching" : "you play " + SIDE[net.seat]}.`);
    renderNet();
  } else if (from !== net.hostId) {
    return;                                 // only the host speaks for the game
  } else if (m.t === "fair") {
    fair.onMessage(m);
  } else if (m.t === "note") {
    hint(String(m.text).slice(0, 200));
  } else if (m.t === "state") {
    // the host's dice: check them against the shared rolls (a guest can't refuse, only say so)
    const prevOps = lastHost && m.v === net.v + 1 && cleanOps(lastHost.ops, OPS);
    if (fair.paired() && prevOps) {
      const why = fair.verify({ ops: prevOps, dice: lastHost.dice }, m.game, m.rolls, m.from === selfId);
      if (why) note(`<b>Online:</b> ⚠ the host's last update doesn't add up: ${esc(why)}.`);
    }
    net.v = m.v | 0;
    applyGame(m.game);
    lastHost = m.game;
    renderFair();
    if (m.from !== selfId) addLines(m.log);
    if (m.resync) { note(`<b>Online:</b> the host didn't take your last action (${String(m.resync).replace(/[<>&"]/g, "")}) — the table shows the host's game.`); }
  } else if (m.t === "roster") {
    net.roster = Array.isArray(m.roster) ? m.roster : [];
    renderNet();
  }
}

/* ---------- leaving, start-up, the panel ---------- */
export function leaveGame() {
  fair.unpair(); lastHost = null;
  closeRoom();
  Object.assign(net, { role: null, code: null, seat: null, hostId: null, v: 0, peers: {}, roster: [], status: "" });
  history.replaceState(null, "", location.pathname + location.search);
  renderNet(); renderMinis(); renderAll();
}
// the panel's count of checked rolls
function renderFair() { const e = document.getElementById("netfair"); if (e) e.textContent = `Fair dice: shared rolls · ${fair.checked()} checked`; }
const shareLink = () => location.origin + location.pathname + location.search + "#room=" + net.code;

export function renderNet() {
  const box = document.getElementById("netbox");
  if (!box) return;
  let html;
  if (!online()) {
    html = `<div class="btnrow"><button class="mini" id="nethost">Host a game</button></div>
      <div class="hint">Others open your link and see this table live; each player moves their own side.
      Every browser loads the models from Steam itself.</div>`;
  } else {
    const who = net.roster.length
      ? `Ash: ${net.roster.includes(0) ? "✓" : "open"} · Slate: ${net.roster.includes(1) ? "✓" : "open"}` +
        `${net.roster.filter(s => s === null).length ? ` · ${net.roster.filter(s => s === null).length} watching` : ""}`
      : "";
    html = `<div class="netline"><b>${net.role === "host" ? "Hosting" : "Joined"}</b> · room ${net.code} · ` +
      `${net.role === "guest" && !net.hostId ? "connecting…" : "you: " + seatName(net.seat)}</div>` +
      (net.role === "host" ? `<div class="btnrow"><input id="netlink" readonly value="${shareLink()}" aria-label="Link to send to the other player">
        <button class="mini" id="netcopy">Copy link</button></div>` : "") +
      (who ? `<div class="hint">${who}</div>` : "") +
      (fair.paired() ? `<div class="hint" id="netfair" title="Each roll mixes a secret from both browsers, each promised (hashed) before the other was shown, so neither player can pick or foresee the dice. Each browser checks the other's dice and wounds.">` +
        `Fair dice: shared rolls · ${fair.checked()} checked</div>` : "") +
      (net.status ? `<div class="hint">${net.status}</div>` : "") +
      `<div class="btnrow"><button class="mini" id="netleave">${net.role === "host" ? "Stop hosting" : "Leave"}</button></div>`;
  }
  box.innerHTML = html;
  renderDice(); renderOps();      // who may roll and edit which side follows the seat
  const $ = id => box.querySelector("#" + id);
  if ($("nethost")) $("nethost").onclick = () => hostGame();
  if ($("netleave")) $("netleave").onclick = leaveGame;
  if ($("netcopy")) $("netcopy").onclick = () => {
    const done = () => hint("Link copied — send it to the other player.");
    if (navigator.clipboard) navigator.clipboard.writeText(shareLink()).then(done, () => $("netlink").select());
    else $("netlink").select();
  };
}
// Called once from main.js after the first map loads: wire the hooks, then host or join
// if the address says so (#host=CODE after a host reloads, #room=CODE from a shared link).
export function wireNet() {
  logHooks.tap = (html, hit) => { if (online() && !applying) outbox.push({ html, hit }); };
  setRoller(roller);
  onMinisChange(pump);
  onDiceChange(pump);
  onOpsChange(pump);
  const r = parseRoomHash(location.hash);
  if (r && r.role === "host") hostGame(r.code);
  else if (r) joinGame(r.code);
  else renderNet();
}
