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

const LEN = { h: 30, m: 24, s: 90 }, MAX = 12;   // the same caps the host applies (protocol.js)
const open = [new Set(), new Set()];   // chips open in this browser
const drawer = [false, false];
// { s, i, was, rank, twins } — was: the card as it stood when editing began (null for a new card,
// which goes one past the end); twins: how many cards then read the same, rank: which of them
// this is. The other player may add or remove cards meanwhile.
let editing = null;
const sameCard = (a, b) => a.h === b.h && a.m === b.m && a.s === b.s;
const twinsOf = (notes, card) => notes.flatMap((n, j) => sameCard(n, card) ? [j] : []);
function startEdit(s, i) {
  const was = { ...opsState.notes[s][i] }, twins = twinsOf(opsState.notes[s], was);
  editing = { s, i, was, rank: twins.indexOf(i), twins: twins.length };
}
// follow the card being edited to wherever it now sits (cards only get added, removed or changed,
// never reordered); drop the edit if it's gone, changed, or one of its twins went and we can't
// tell which
function locate() {
  if (!editing) return;
  const notes = opsState.notes[editing.s];
  if (!editing.was) editing.i = notes.length < MAX ? notes.length : -1;
  else {
    const twins = twinsOf(notes, editing.was);
    editing.i = twins.length === editing.twins ? twins[editing.rank] : -1;
  }
  if (editing.i < 0 || !mayNote(editing.s)) editing = null;
}
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
  const add = mayNote(s) && !adding && notes.length < MAX ? `<button class="scadd" data-act="add" title="Add a status card for ${TEAMNAME[s]}">+ card</button>` : "";
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
    if (editing && editing.s === s) locate();
    // only rewrite what changed, and never under someone's typing
    const html = dockHTML(s);
    if (dock._html === html || editing && editing.s === s && dock.querySelector("form") && dock.contains(document.activeElement)) continue;
    dock.innerHTML = html; dock._html = html;
    const f = dock.querySelector("form input");
    if (f) f.focus();
  }
}

function save(s, form) {
  locate();
  if (!editing) { renderStatusCards(); return; }
  const i = editing.i, val = k => form.querySelector(`[data-f="${k}"]`).value.trim().slice(0, LEN[k]);
  const card = { h: val("h"), m: val("m"), s: val("s"), by: online() && net.seat !== s && (net.seat === 0 || net.seat === 1) ? net.seat : null };
  const list = opsState.notes[s].map(n => ({ ...n })), isNew = i >= list.length;
  editing = null;
  if (!card.h && !card.m && !card.s) { renderStatusCards(); return; }   // an empty new card: nothing to keep
  list[i] = card;
  if (options.cardLayout === "chips") open[s].add(i);
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
      else if (act === "edit" && mayNote(s) && opsState.notes[s][i]) startEdit(s, i);
      else if (act === "add" && mayNote(s) && opsState.notes[s].length < MAX) { editing = { s, i: opsState.notes[s].length, was: null }; drawer[s] = true; }
      else if (act === "cancel") editing = null;
      else if (act === "del" && mayNote(s)) { locate(); if (editing && editing.was) { remove(s, editing.i); return; } }
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
