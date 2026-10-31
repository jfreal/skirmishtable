/**
 * Ops & score: the mission cards and score sheet of a Kill Team game, as the KT24 Killzone
 * Mod lays them out in Tabletop Simulator. Cards and token art load from the mod's own links
 * (src/data/tts-ops.js) into this browser; the site hosts none of them.
 *
 *   - the season (Approved Ops 2025 / 2024), the shared Crit Op and the Kill Op
 *   - each side's Tac Op, and which op is its Primary (scores double at the end)
 *   - VP per turning point for Crit / Tac / Kill, totalled into the Battle tray
 *   - the universal equipment cards, and markers (grenades, objective tokens) on the table
 * Shared online like the rest of the game (src/net/sync.js).
 */
import { TTS_OPS } from '../data/tts-ops.js';
import { TEAMCOL, TEAMNAME } from '../config.js';
import { state } from '../state.js';
import { cachedFetch } from '../view3d/models.js';
import { hint, logLine, HINT0 } from './dom.js';
import { renderAll } from './board.js';
import { snapshot, tray, undoExtras } from './panels.js';

const COLS = ["Crit", "Tac", "Kill"];
const blankScore = () => [0, 1].map(() => [0, 1, 2, 3].map(() => [0, 0, 0]));
export const opsState = { set: 0, crit: null, tac: [null, null], primary: [null, null], score: blankScore(), markers: [] };
const listeners = [];
export const onOpsChange = fn => listeners.push(fn);
function changed(render = true) {
  // once the score sheet is in use it keeps the Battle tray's VP (until then, VP stay manual)
  if (opsState.score.flat(2).some(v => v > 0) || opsState.primary.some(p => p !== null))
    for (const s of [0, 1]) tray.vp[s] = scoreTotal(s);
  if (render) renderOps();
  renderAll();
  for (const fn of listeners) fn();
}
// end-of-game total: the Primary op's VP count again, halved and rounded up
export function scoreTotal(side) {
  const rows = opsState.score[side], sum = c => rows.reduce((a, r) => a + r[c], 0);
  const base = sum(0) + sum(1) + sum(2), p = opsState.primary[side];
  return base + (p === null ? 0 : Math.ceil(sum(p) / 2));
}
export const currentSet = () => TTS_OPS.sets[opsState.set] || TTS_OPS.sets[0];
// replace from the network (already cleaned)
export function setOpsState(o) { Object.assign(opsState, o); renderOps(); }

/* ---------- card images: one cell cut from the card sheet ---------- */
const cut = new Map();
export function cardImage(c) {
  const key = `${c.sheet}#${c.i}`;
  if (!cut.has(key)) cut.set(key, cachedFetch(c.sheet).then(r => r.blob()).then(createImageBitmap).then(img => {
    const w = img.width / c.cols, h = img.height / c.rows, col = c.i % c.cols, row = Math.floor(c.i / c.cols);
    const cv = document.createElement("canvas"); cv.width = Math.round(w); cv.height = Math.round(h);
    cv.getContext("2d").drawImage(img, col * w, row * h, w, h, 0, 0, cv.width, cv.height);
    return new Promise(res => cv.toBlob(b => res(URL.createObjectURL(b)), "image/jpeg", 0.92));
  }));
  return cut.get(key);
}
// <img> placeholders get their picture when it arrives
function fillImages(box) {
  box.querySelectorAll("img[data-card]").forEach(im => {
    const c = cardFrom(im.dataset.card);
    if (c) cardImage(c).then(u => { im.src = u; im.classList.add("ready"); }, () => { im.alt = "card unavailable"; });
  });
}
function cardFrom(ref) {
  const [kind, i] = ref.split(":"), set = currentSet();
  if (kind === "tac") return set.tac[+i];
  if (kind === "crit") return set.crit[+i];
  if (kind === "kill") return set.kill;
  if (kind === "extra") return set.extras[+i];
  if (kind === "eq") return TTS_OPS.equipment[+i];
  return null;
}
const cardImg = (ref, title, cls = "") => `<img class="cardthumb ${cls}" data-card="${ref}" alt="${title}" title="${title} — click to enlarge">`;
function showCard(ref) {
  const c = cardFrom(ref);
  if (!c) return;
  let ov = document.getElementById("cardview");
  if (!ov) {
    ov = document.createElement("div"); ov.id = "cardview";
    ov.onclick = () => ov.remove();
    document.body.appendChild(ov);
  }
  ov.innerHTML = `<figure><img alt="${c.name}"><figcaption>${c.name}${c.text ? " — " + c.text.replace(/</g, "&lt;") : ""} · click to close</figcaption></figure>`;
  cardImage(c).then(u => { ov.querySelector("img").src = u; });
}

/* ---------- markers on the table ---------- */
let markerPick = null;          // token index waiting to be placed
export function placeMarkerAt(x, y) {
  if (markerPick === null) return false;
  snapshot();
  const k = markerPick, id = (opsState.markers.reduce((a, m) => Math.max(a, m.id), 0) || 0) + 1;
  opsState.markers.push({ id, k, x: +x.toFixed(2), y: +y.toFixed(2) });
  logLine(`Placed <b>${TTS_OPS.tokens[k].name}</b> marker.`);
  markerPick = null; state.mode = null; hint(HINT0);
  changed();
  return true;
}
export function markerMode() { return markerPick !== null; }

/* ---------- the panel ---------- */
let mine = () => true, host = () => true;
export function wireOps(mayEditSide, maySetUp) {
  if (mayEditSide) mine = mayEditSide;
  if (maySetUp) host = maySetUp;
  renderOps();
}
export function renderOps() {
  const box = document.getElementById("opsbox");
  if (!box) return;
  const set = currentSet(), dis = ok => ok ? "" : " disabled";
  const opt = (list, sel) => `<option value="">—</option>` + list.map((c, i) => `<option value="${i}"${sel === i ? " selected" : ""}>${c.name}</option>`).join("");
  const side = s => {
    const tac = opsState.tac[s], p = opsState.primary[s];
    return `<div class="opside"><b style="color:${TEAMCOL[s]}">${TEAMNAME[s]}</b>
      <label>Tac Op <select class="optac" data-s="${s}"${dis(mine(s))}>${opt(set.tac, tac)}</select></label>
      <label title="The Primary op's VP count again (half, rounded up) at the end">Primary
        <select class="opprim" data-s="${s}"${dis(mine(s))}><option value="">—</option>${COLS.map((n, i) => `<option value="${i}"${p === i ? " selected" : ""}>${n}</option>`).join("")}</select></label>
      ${tac !== null ? cardImg("tac:" + tac, set.tac[tac].name) : ""}</div>`;
  };
  const scoreRows = [0, 1, 2, 3].map(tp => `<tr><th>TP${tp + 1}</th>${[0, 1].map(s => COLS.map((_, c) =>
    `<td><input type="number" min="0" max="9" class="opvp" data-s="${s}" data-tp="${tp}" data-c="${c}" value="${opsState.score[s][tp][c] || ""}"${dis(mine(s))}></td>`).join("")).join("")}</tr>`).join("");
  box.innerHTML = `
    <div class="btnrow oprow">
      <label>Season <select id="opset"${dis(host())}>${TTS_OPS.sets.map((x, i) => `<option value="${i}"${i === opsState.set ? " selected" : ""}>${x.name}</option>`).join("")}</select></label>
      <label>Crit Op <select id="opcrit"${dis(host())}>${opt(set.crit, opsState.crit)}</select></label>
      <button class="mini" id="opcritrnd"${dis(host())} title="Draw a random Crit Op">Draw</button>
    </div>
    <div class="cardrow">
      ${opsState.crit !== null ? cardImg("crit:" + opsState.crit, set.crit[opsState.crit].name) : ""}
      ${set.kill ? cardImg("kill:0", "Kill Op") : ""}
    </div>
    <div class="opsides">${side(0)}${side(1)}</div>
    <table class="opscore"><thead>
      <tr><th></th><th colspan="3" style="color:${TEAMCOL[0]}">${TEAMNAME[0]}</th><th colspan="3" style="color:${TEAMCOL[1]}">${TEAMNAME[1]}</th></tr>
      <tr><th></th>${[0, 1].map(() => COLS.map(n => `<th>${n}</th>`).join("")).join("")}</tr></thead>
      <tbody>${scoreRows}</tbody>
      <tfoot><tr><th>VP</th><td colspan="3"><b>${scoreTotal(0)}</b></td><td colspan="3"><b>${scoreTotal(1)}</b></td></tr></tfoot></table>
    ${set.extras.length ? `<details><summary>Initiative cards</summary><div class="cardrow">${set.extras.map((c, i) => cardImg("extra:" + i, c.name, "small")).join("")}</div></details>` : ""}
    <details><summary>Equipment</summary><div class="cardrow">${TTS_OPS.equipment.map((c, i) => cardImg("eq:" + i, c.name, "small")).join("")}</div></details>
    <details${opsState.markers.length || markerPick !== null ? " open" : ""}><summary>Markers (${opsState.markers.length})</summary>
      <div class="tokrow">${TTS_OPS.tokens.map((t, i) => `<button class="tok${markerPick === i ? " active" : ""}" data-k="${i}" title="${t.name} — then click the table"${dis(mine(0) || mine(1))}><img src="${t.img}" alt="${t.name}" crossorigin="anonymous"></button>`).join("")}</div>
      ${opsState.markers.length ? `<div class="toklist">${opsState.markers.map(m => `<span>${TTS_OPS.tokens[m.k] ? TTS_OPS.tokens[m.k].name : "?"} <button class="mini" data-rm="${m.id}" title="Remove"${dis(mine(0) || mine(1))}>×</button></span>`).join(" ")}</div>` : ""}
    </details>
    <div class="hint">Cards and token art load from the Killzone Mod into this browser; this site doesn't host them.</div>`;
  fillImages(box);
  box.querySelectorAll("img[data-card]").forEach(im => im.onclick = () => showCard(im.dataset.card));
  const sel = (q, fn) => { const e = box.querySelector(q); if (e) e.onchange = () => fn(e.value); };
  sel("#opset", v => { snapshot(); Object.assign(opsState, { set: +v, crit: null, tac: [null, null] }); changed(); });
  sel("#opcrit", v => { snapshot(); opsState.crit = v === "" ? null : +v; if (v !== "") logLine(`Crit Op: <b>${set.crit[+v].name}</b>.`); changed(); });
  box.querySelector("#opcritrnd").onclick = () => {
    snapshot(); opsState.crit = Math.floor(Math.random() * set.crit.length);
    logLine(`Crit Op drawn: <b>${set.crit[opsState.crit].name}</b>.`); changed();
  };
  box.querySelectorAll(".optac").forEach(e => e.onchange = () => {
    snapshot(); opsState.tac[+e.dataset.s] = e.value === "" ? null : +e.value;
    if (e.value !== "") logLine(`<b>${TEAMNAME[+e.dataset.s]}</b> Tac Op: <b>${set.tac[+e.value].name}</b>.`);
    changed();
  });
  box.querySelectorAll(".opprim").forEach(e => e.onchange = () => { snapshot(); opsState.primary[+e.dataset.s] = e.value === "" ? null : +e.value; changed(); });
  box.querySelectorAll(".opvp").forEach(e => e.onchange = () => {
    setScore(+e.dataset.s, +e.dataset.tp, +e.dataset.c, e.value, false);
    box.querySelector("tfoot").innerHTML = `<tr><th>VP</th><td colspan="3"><b>${scoreTotal(0)}</b></td><td colspan="3"><b>${scoreTotal(1)}</b></td></tr>`;
  });
  box.querySelectorAll(".tok").forEach(b => b.onclick = () => {
    markerPick = markerPick === +b.dataset.k ? null : +b.dataset.k;
    state.mode = markerPick === null ? null : "marker";
    hint(markerPick === null ? HINT0 : `Click the table to place ${TTS_OPS.tokens[markerPick].name}. Esc to cancel.`);
    renderOps();
  });
  box.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => {
    snapshot(); opsState.markers = opsState.markers.filter(m => m.id !== +b.dataset.rm); changed();
  });
}
// one box of the score sheet (this panel's or the board overlay's)
export const mayScore = s => mine(s);
export function setScore(s, tp, c, value, render = true) {
  const v = Math.max(0, Math.min(9, value | 0));
  snapshot(); opsState.score[s][tp][c] = v;
  logLine(`<b>${TEAMNAME[s]}</b> TP${tp + 1} ${COLS[c]} Op: ${v} VP (total ${scoreTotal(s)}).`);
  changed(render);
}
// Esc / another mode clears a pending marker
export function cancelMarker() { if (markerPick !== null) { markerPick = null; renderOps(); } }
export { blankScore };
// undo covers the ops and score too
undoExtras.push({ get: () => JSON.parse(JSON.stringify({ ...opsState, markers: opsState.markers })),
                  set: o => { Object.assign(opsState, o); renderOps(); } });
