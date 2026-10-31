/**
 * Status cards: each side's game-wide notes (a ploy in play, +1 initiative, a game state),
 * docked on its own edge of the table, Ash left and Slate right. A card is three lines the
 * players type themselves: a small header, the main text and a line of small text. The app
 * doesn't know what any of them mean.
 *
 *   - Chips (the default): a tab per card showing its main text; click to open the card
 *   - Drawer (Options): one tab per side; click to open all its cards
 * Which cards are open is this browser's; the cards themselves are shared online with the
 * mission (opsState.notes). Each side edits its own, or both when the host allows it.
 */
import { TEAMNAME } from '../config.js';
import { net, online } from '../net/sync.js';
import { onOptionChange, options } from './options.js';
import { mayNote, mayNoteSetUp, opsState, setNoteEdit, setNotes } from './ops.js';

const LEN = { h: 30, m: 24, s: 90 };   // the same caps the host applies (protocol.js)
const open = [new Set(), new Set()];   // chips open in this browser
const drawer = [false, false];
let editing = null;                    // { s, i, orig } — orig is the card as it was when opened; null for a new card
const MAX = 12;                        // the cleaner keeps no more than this per side
const stamp = n => JSON.stringify([n.h, n.m, n.s, n.by]);
// An open edit belongs to a card, not a position: if that card moved, changed or went (the other
// player edited this side), the edit is dropped rather than saved over a different card.
const stale = () => editing && editing.orig !== null && (!opsState.notes[editing.s][editing.i] || stamp(opsState.notes[editing.s][editing.i]) !== editing.orig);
const esc = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const LOCK = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>';

function cardHTML(s, i) {
  const n = opsState.notes[s][i] || { h: "", m: "", s: "" };
  if (editing && editing.s === s && editing.i === i) {
    const field = (k, ph) => `<input class="sc${k}" data-f="${k}" maxlength="${LEN[k]}" value="${esc(n[k])}" placeholder="${ph}" aria-label="${ph}">`;
    return `<form class="scard editing" data-s="${s}" data-i="${i}">${field("h", "Header")}${field("m", "Main text")}${field("s", "Small text")}
      <div class="scbtns"><button class="mini" type="submit">Save</button><button class="mini" type="button" data-act="cancel">Cancel</button>
      ${i < opsState.notes[s].length ? `<button class="mini" type="button" data-act="del" title="Remove this card">Remove</button>` : ""}</div></form>`;
  }
  const tools = (mayNote(s) ? `<button class="scbtn" data-act="edit" title="Edit this card" aria-label="Edit">✎</button>`
                            : `<span class="sclock" title="Only the ${TEAMNAME[s]} player edits these">${LOCK}</span>`) +
    (options.cardLayout === "chips" ? `<button class="scbtn" data-act="close" title="Fold it back to a tab" aria-label="Close">×</button>` : "");
  return `<div class="scard" data-s="${s}" data-i="${i}"><div class="sch"><span>${esc(n.h)}</span><span class="sctools">${tools}</span></div>` +
    `<div class="scm">${esc(n.m)}</div>${n.s ? `<div class="scs">${esc(n.s)}</div>` : ""}` +
    (n.by === 0 || n.by === 1 ? `<div class="scby">changed by ${TEAMNAME[n.by]}</div>` : "") + `</div>`;
}
function dockHTML(s) {
  const notes = opsState.notes[s], adding = editing && editing.s === s && editing.i === notes.length;
  const add = notes.length < MAX && mayNote(s) && !adding ? `<button class="scadd" data-act="add" title="Add a status card for ${TEAMNAME[s]}">+ card</button>` : "";
  const who = online() && mayNoteSetUp() && s === 0
    ? `<button class="scadd" data-act="who" title="Who may edit the status cards (you're the host)">${opsState.noteEdit === "any" ? "both edit both" : "own side only"}</button>` : "";
  const cards = notes.map((_, i) => i);
  if (adding) cards.push(notes.length);
  if (options.cardLayout === "drawer") {
    if (!notes.length && !add && !adding) return "";
    const tab = `<button class="sctab" data-act="drawer" aria-expanded="${drawer[s]}" title="${TEAMNAME[s]} status cards">${notes.length ? notes.length + " " : ""}card${notes.length === 1 ? "" : "s"}</button>`;
    return `<div class="scrow">${tab}${drawer[s] || adding ? `<div class="sccol">${cards.map(i => cardHTML(s, i)).join("")}${add}${who}</div>` : ""}</div>`;
  }
  return cards.map(i => open[s].has(i) || (editing && editing.s === s && editing.i === i) ? cardHTML(s, i)
    : `<button class="schip" data-i="${i}" data-act="open" title="${esc([notes[i].h, notes[i].m, notes[i].s].filter(Boolean).join(" · "))}">${esc(notes[i].m || notes[i].h || "…")}</button>`).join("") + add + who;
}

export function renderStatusCards() {
  for (const s of [0, 1]) {
    const dock = document.getElementById("scards" + s);
    if (!dock) continue;
    for (const i of [...open[s]]) if (i >= opsState.notes[s].length) open[s].delete(i);
    if (editing && editing.s === s && editing.orig === null && opsState.notes[s].length < MAX) editing.i = opsState.notes[s].length;   // a new card always goes last
    if (editing && editing.s === s && (editing.i > opsState.notes[s].length || !mayNote(s) || stale())) editing = null;
    // only rewrite what changed, and never under someone's typing
    const html = dockHTML(s);
    if (dock._html === html || editing && editing.s === s && dock.querySelector("form") && dock.contains(document.activeElement)) continue;
    dock.innerHTML = html; dock._html = html;
    const f = dock.querySelector("form input");
    if (f) f.focus();
  }
}

function save(s, form) {
  if (!editing || editing.s !== s || stale()) { editing = null; renderStatusCards(); return; }
  const i = editing.i;
  const val = k => form.querySelector(`[data-f="${k}"]`).value.trim().slice(0, LEN[k]);
  const card = { h: val("h"), m: val("m"), s: val("s"), by: online() && net.seat !== s && (net.seat === 0 || net.seat === 1) ? net.seat : null };
  const list = opsState.notes[s].map(n => ({ ...n })), isNew = editing.orig === null;
  editing = null;
  if (!card.h && !card.m && !card.s) { renderStatusCards(); return; }   // an empty new card: nothing to keep
  if (isNew && list.length >= MAX) { renderStatusCards(); return; }
  const at = isNew ? list.length : i;
  list[at] = card;
  if (options.cardLayout === "chips") open[s].add(at);
  setNotes(s, list, `<b>${TEAMNAME[s]}</b> status card ${isNew ? "added" : "changed"}: <b>${esc(card.m || card.h)}</b>${card.s ? " — " + esc(card.s) : ""}.`);
}
function remove(s, i) {
  const list = opsState.notes[s].filter((_, j) => j !== i), gone = opsState.notes[s][i];
  open[s] = new Set([...open[s]].filter(j => j !== i).map(j => j > i ? j - 1 : j));
  editing = null;
  setNotes(s, list, `<b>${TEAMNAME[s]}</b> status card removed: <b>${esc(gone.m || gone.h)}</b>.`);
}

export function wireStatusCards() {
  for (const s of [0, 1]) {
    const dock = document.getElementById("scards" + s);
    dock.addEventListener("click", ev => {
      const b = ev.target.closest("[data-act]");
      if (!b) return;
      const at = b.closest("[data-i]"), i = at ? +at.dataset.i : null, act = b.dataset.act;
      if (act === "open") open[s].add(i);
      else if (act === "close") open[s].delete(i);
      else if (act === "drawer") drawer[s] = !drawer[s];
      else if (act === "edit" && mayNote(s) && opsState.notes[s][i]) editing = { s, i, orig: stamp(opsState.notes[s][i]) };
      else if (act === "add" && mayNote(s) && opsState.notes[s].length < MAX) { editing = { s, i: opsState.notes[s].length, orig: null }; drawer[s] = true; }
      else if (act === "cancel") editing = null;
      else if (act === "del" && mayNote(s) && !stale()) { remove(s, i); return; }
      else if (act === "who" && mayNoteSetUp()) { setNoteEdit(opsState.noteEdit === "any" ? "own" : "any"); return; }
      dock._html = null; renderStatusCards();
    });
    dock.addEventListener("submit", ev => {
      ev.preventDefault();
      const f = ev.target.closest("form");
      if (f && mayNote(s)) save(s, f);
    });
    dock.addEventListener("keydown", ev => {
      if (ev.key === "Escape" && editing) { editing = null; renderStatusCards(); ev.stopPropagation(); }
    });
  }
  onOptionChange(k => { if (k === "cardLayout") { editing = null; renderStatusCards(); } });
  renderStatusCards();
}
