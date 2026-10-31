/**
 * Replays, the page half: the recorder and the viewer (replay.js is the pure half).
 *
 * The recorder: after every change (sync.js pump), the game as exportGame() sees it becomes
 * a step, with the log lines that came with it. Undo takes the last step off. A new map, a
 * reset or an opened share link starts a new recording. It is kept in localStorage, so
 * after a reload the Replay panel still offers it as the last game.
 *
 * The viewer: a replay from the panel, a "#replay=…" link or a saved file goes on the table
 * step by step, through sync.js applyGame (the same cleaning as share links and online
 * play). While it shows, state.replay makes the table look-only and the recorder waits.
 * Leaving puts your own table back; Play on from here keeps the shown step as a new game.
 */
import { state } from '../state.js';
import { renderAll } from '../ui/board.js';
import { HINT0, hint, logHooks, logLine } from '../ui/dom.js';
import { renderMinis } from '../ui/minis.js';
import { cancelMode, undoStack } from '../ui/panels.js';
import { SOFT_MAX } from './link.js';
import { addStep, decodeReplay, encodeReplay, isReplayHash, newRecording, packReplay, replayHash, steps, turnStarts, unpackReplay } from './replay.js';
import { gameProblem } from './share.js';
import { applyGame, exportGame, leaveGame, online, outGame, renderNet } from './sync.js';

const SAVE = "skirmishtable.replay", SAVE_PREV = "skirmishtable.replay.prev";
const base = () => location.origin + location.pathname + location.search;
const when = at => at ? new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "an unknown time";

/* ---------- the recorder ---------- */
let rec = null, prev = null, pending = [], fresh = false, adopt = false, timer = null, saveTimer = null;

// Called after every render and every dice, mission or miniatures change: look once
// everything this change does has happened (a map load and the game put on it are one).
export function noteChange() {
  if (state.replay || timer) return;
  timer = setTimeout(recordNow, 0);
}
// The next look starts a new recording (a new map, a reset, a shared game opened).
export function restartRecording() { if (!state.replay) fresh = true; }

function recordNow() {
  clearTimeout(timer); timer = null;
  if (state.replay) return;
  const g = exportGame(), f = rec && rec.frames[0];
  if (adopt && rec && !fresh) {           // your table, back after a replay: the same last step
    adopt = false;                        // (the cleaners may have tidied a field or two)
    const s = JSON.stringify(g), n = rec.frames.length - 1;
    rec.frames[n] = JSON.parse(s); rec.sigs[n] = s;
    pending = [];
    return;
  }
  adopt = false;
  if (!rec || fresh || g.map !== f.map || g.rules !== f.rules || g.mapName !== f.mapName) {
    rec = newRecording(g, Date.now(), outGame(g).mapDef);
    fresh = false; pending = [];
    renderReplayBox();
    return;
  }
  const r = addStep(rec, g, pending);
  pending = [];
  if (r === "step" || r === "undo") { saveSoon(); renderReplayBox(); }
}
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!steps(rec)) return;
    try { localStorage.setItem(SAVE, await encodeReplay(rec)); } catch (e) {}   // full or private: just don't keep it
  }, 1000);
}

/* ---------- the viewer ---------- */
const view = { rec: null, i: 0, live: null, code: null, label: "", play: null };
const bar = () => document.getElementById("replaybar");

async function watch(r, { step = 0, code = null, label = "" } = {}) {
  if (online()) {
    if (!code) { hint("Leave the online game first, then watch the replay."); return; }
    leaveGame();
  }
  if (!code) try { code = await encodeReplay(r); } catch (e) {}
  if (!state.replay) {
    if (timer) recordNow();               // the last change is in the recording before we leave it
    view.live = outGame();
  }
  stopPlay();
  state.replay = true;
  state.sel = null; state.target = null; state.lastShot = null; state.drag = null;
  cancelMode();
  Object.assign(view, { rec: r, code, label });
  buildBar();
  show(step);
  renderNet(); renderMinis();             // the dice, ops and miniatures panels go look-only
  hint("Watching a replay: step through it with the bar above the table, or the ← → keys.");
}
function show(i) {
  const r = view.rec, n = r.frames.length - 1;
  view.i = Math.max(0, Math.min(n, i | 0));
  const g = { ...r.frames[view.i] };
  if (r.mapDef) g.mapDef = r.mapDef;
  applyGame(g);
  if (view.code) history.replaceState(null, "", base() + replayHash(view.code, view.i));
  renderBar();
}
export function leaveReplay() {
  if (!state.replay) return;
  stopPlay();
  if (view.live) applyGame(view.live);    // still look-only here, so the recorder doesn't see it
  state.replay = false;
  adopt = true;
  view.rec = null;
  history.replaceState(null, "", base());
  bar().hidden = true;
  renderNet(); renderMinis(); renderAll();
  hint(HINT0);
}
function playOn() {
  if (!state.replay) return;
  const i = view.i;
  stopPlay();
  state.replay = false;
  view.rec = null;
  history.replaceState(null, "", base());
  bar().hidden = true;
  undoStack.length = 0;
  restartRecording();                     // this step is the start of a new game
  logLine(`<b>Replay:</b> playing on from step ${i}.`);
  renderNet(); renderMinis(); renderAll();
  hint(HINT0);
}
function stopPlay() {
  clearInterval(view.play); view.play = null;
  const b = document.getElementById("rpplay");
  if (b) b.textContent = "▶ Play";
}
function togglePlay() {
  if (view.play) { stopPlay(); return; }
  if (view.i >= view.rec.frames.length - 1) show(0);
  view.play = setInterval(() => {
    if (!state.replay || view.i >= view.rec.frames.length - 1) stopPlay();
    else show(view.i + 1);
  }, 1000);
  document.getElementById("rpplay").textContent = "❚❚ Pause";
}

function buildBar() {
  const b = bar(), r = view.rec;
  b.innerHTML = `<div class="rprow"><b>Replay</b><span id="rpwhere"></span><span class="hint" id="rplabel"></span></div>
    <div class="rprow">
      <button class="mini" id="rpfirst" title="Back to the start">⏮</button>
      <button class="mini" id="rpback" title="One step back (← key)">◀ Back</button>
      <button class="mini" id="rpplay" title="Play the steps one a second">▶ Play</button>
      <button class="mini" id="rpnext" title="One step on (→ key)">Next ▶</button>
      <button class="mini" id="rplast" title="The last step">⏭</button>
      <span class="rptps" id="rptps"></span>
    </div>
    <input type="range" id="rpslider" min="0" max="${r.frames.length - 1}" step="1" aria-label="Replay step">
    <div class="rplog" id="rplog"></div>
    <div class="rprow">
      <button class="mini" id="rpcopy" title="A link that opens this replay at this step">Copy link to this step</button>
      <button class="mini" id="rpon" title="Keep the table as it is at this step and play on from here">Play on from here</button>
      <button class="mini" id="rpleave" title="Back to your own table">Leave replay</button>
    </div>`;
  const $ = id => b.querySelector("#" + id);
  $("rplabel").textContent = view.label;
  const tps = $("rptps");
  for (const t of turnStarts(r.frames)) {
    const btn = document.createElement("button");
    btn.className = "mini"; btn.textContent = "TP " + t.tp; btn.dataset.i = t.i;
    btn.title = `Jump to the start of turning point ${t.tp}`;
    btn.onclick = () => { stopPlay(); show(t.i); };
    tps.appendChild(btn);
  }
  $("rpfirst").onclick = () => { stopPlay(); show(0); };
  $("rpback").onclick = () => { stopPlay(); show(view.i - 1); };
  $("rpnext").onclick = () => { stopPlay(); show(view.i + 1); };
  $("rplast").onclick = () => { stopPlay(); show(r.frames.length - 1); };
  $("rpplay").onclick = togglePlay;
  $("rpslider").oninput = e => { stopPlay(); show(+e.target.value); };
  $("rpcopy").onclick = () => {
    if (!view.code) { hint("Couldn't make a link for this replay."); return; }
    const link = base() + replayHash(view.code, view.i);
    const done = () => hint(`Link copied (${link.length.toLocaleString()} characters) — it opens this replay at step ${view.i}.`);
    if (navigator.clipboard) navigator.clipboard.writeText(link).then(done, () => hint("Couldn't copy: the address bar has the link to this step."));
    else hint("The address bar has the link to this step.");
  };
  $("rpon").onclick = playOn;
  $("rpleave").onclick = leaveReplay;
  b.hidden = false;
}
function renderBar() {
  const b = bar(), r = view.rec, n = r.frames.length - 1, g = r.frames[view.i];
  b.querySelector("#rpwhere").textContent = `TP ${g.tray ? g.tray.tp : "?"} · ${view.i ? `step ${view.i} of ${n}` : `start (${n === 1 ? "1 step" : n + " steps"})`}`;
  b.querySelector("#rpslider").value = view.i;
  b.querySelector("#rpback").disabled = b.querySelector("#rpfirst").disabled = view.i === 0;
  b.querySelector("#rpnext").disabled = b.querySelector("#rplast").disabled = view.i === n;
  const tp = g.tray && g.tray.tp;
  for (const t of b.querySelectorAll("#rptps button")) t.classList.toggle("active", t.textContent === "TP " + tp);
  const log = b.querySelector("#rplog");
  log.innerHTML = "";
  const lines = r.logs[view.i] || [];
  for (const l of lines.length ? lines : [view.i ? "(no log line for this step)" : "The table when the recording started."]) {
    const p = document.createElement("p"); p.textContent = l;   // text only: nothing from a link runs here
    if (!lines.length) p.className = "hint";
    log.appendChild(p);
  }
}

/* ---------- the Replay panel ---------- */
let status = "", lastLink = "";
async function shareReplay(r) {
  lastLink = base() + "#replay=" + await encodeReplay(r);
  status = `Link to the whole replay (${lastLink.length.toLocaleString()} characters).` +
    (lastLink.length > SOFT_MAX ? " That's long: some chat apps cut links this size, so email it, paste it into a note, or send the file instead." : "");
  renderReplayBox();
  const input = document.getElementById("replaylink");
  const done = () => hint("Replay link copied — whoever opens it can step through the game turn by turn.");
  if (navigator.clipboard) navigator.clipboard.writeText(lastLink).then(done, () => input && input.select());
  else if (input) input.select();
}
function saveFile(r) {
  const blob = new Blob([JSON.stringify({ app: "SkirmishTable replay", ...packReplay(r) })], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `skirmishtable-replay-${new Date(r.at || Date.now()).toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function openFile(file) {
  let r = null;
  if (file.size > 20e6) { status = "Couldn't open that replay: the file is too big."; renderReplayBox(); hint(status); return; }
  try { r = unpackReplay(JSON.parse(await file.text())); } catch (e) {}
  const why = !r ? "it isn't a SkirmishTable replay" : r.error || gameProblem({ ...r.frames[0], mapDef: r.mapDef });
  if (why) { status = "Couldn't open that replay: " + why + "."; renderReplayBox(); hint(status); return; }
  status = "";
  await watch(r, { label: `${file.name} · recorded ${when(r.at)}` });
}

export function renderReplayBox() {
  const box = document.getElementById("replaybox");
  if (!box) return;
  const rows = [];
  const n = r => steps(r) === 1 ? "1 step" : steps(r) + " steps";
  if (steps(rec)) rows.push({ r: rec, text: `This game: ${n(rec)} so far.`, label: "This game" });
  if (steps(prev)) rows.push({ r: prev, text: `Last game, ${when(prev.at)}: ${n(prev)}.`, label: `Last game · recorded ${when(prev.at)}` });
  box.innerHTML = rows.map((x, k) => `<div class="hint">${x.text}</div>
      <div class="btnrow"><button class="mini" data-k="${k}" data-do="watch">Watch replay</button>
      <button class="mini" data-k="${k}" data-do="share">Share replay</button>
      <button class="mini" data-k="${k}" data-do="file" title="Download the replay as a .json file">Save file</button></div>`).join("") +
    `${lastLink ? `<div class="btnrow"><input id="replaylink" readonly aria-label="Link to the replay"></div>` : ""}
    <div class="btnrow"><button class="mini" id="replayopen">Open replay file…</button>
      <input type="file" id="replayfile" accept=".json,application/json" style="display:none"></div>
    <div class="hint" id="replaynote"></div>`;
  if (lastLink) box.querySelector("#replaylink").value = lastLink;
  box.querySelector("#replaynote").textContent = status ||
    (rows.length ? "" : "Every action is recorded as you play, so you can step back through the game turn by turn, or send it as a link.");
  for (const b of box.querySelectorAll("button[data-do]")) {
    const x = rows[+b.dataset.k];
    b.onclick = () => {
      if (b.dataset.do === "watch") watch(x.r, { label: x.label });
      else if (b.dataset.do === "share") shareReplay(x.r).catch(e => { status = "Couldn't make the link: " + e.message; renderReplayBox(); });
      else saveFile(x.r);
    };
  }
  box.querySelector("#replayopen").onclick = () => box.querySelector("#replayfile").click();
  box.querySelector("#replayfile").onchange = ev => { const f = ev.target.files[0]; if (f) openFile(f); };
}

// Open "#replay=…" from the address: the replay goes on the table at its step.
export async function openReplayLink(hash = location.hash) {
  if (!isReplayHash(hash)) return false;
  const r = await decodeReplay(hash);
  const why = r.error || gameProblem({ ...r.replay.frames[0], mapDef: r.replay.mapDef });
  if (why) {
    history.replaceState(null, "", base());
    status = "Couldn't open that replay: " + why + ".";
    hint(status); renderReplayBox();
    return false;
  }
  await watch(r.replay, { step: r.step, code: r.code, label: `Shared replay · recorded ${when(r.replay.at)}` });
  return true;
}

export function wireReplay() {
  logHooks.rec = text => { if (!state.replay) pending.push(text); };
  // last session's recording becomes "last game"; this session records afresh
  let code = null;
  try {
    code = localStorage.getItem(SAVE);
    if (code) { localStorage.setItem(SAVE_PREV, code); localStorage.removeItem(SAVE); }
    else code = localStorage.getItem(SAVE_PREV);
  } catch (e) {}
  if (code) decodeReplay(code).then(r => { if (r.replay) { prev = r.replay; renderReplayBox(); } });
  document.addEventListener("keydown", ev => {
    if (!state.replay || /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName)) return;
    if (ev.key === "ArrowLeft") { stopPlay(); show(view.i - 1); ev.preventDefault(); }
    else if (ev.key === "ArrowRight") { stopPlay(); show(view.i + 1); ev.preventDefault(); }
  });
  addEventListener("hashchange", () => {
    // our own replaceState never fires this; a pasted link or Back does
    const own = state.replay && view.code && location.hash.split("&")[0] === replayHash(view.code);
    if (isReplayHash(location.hash) && !own) openReplayLink();
  });
  renderReplayBox();
  return openReplayLink();
}
