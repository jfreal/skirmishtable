/**
 * DOM helpers: the SVG board, element factory, hint line and battle log.
 */
export const capName = s => s[0].toUpperCase() + s.slice(1);
export function fmtDice(dice) { return dice.map(v => v===6?`<span class="crit">${v}</span>`:v).join(" "); }
export const HINT0 = "Drag an operative to move — the app paths around or over terrain and prices the move by the current rules. Click to select.";
export const logEl = document.getElementById("log");
// tap: online play collects this browser's lines to send; rec: the replay recorder's
// copy of every game line (replayer.js); mute: lines that stay local
export const logHooks = { tap: null, rec: null, mute: false };
export function logLine(html, hit) {
  const p = document.createElement("p"); if (hit) p.className = "hit";
  p.innerHTML = html; logEl.prepend(p);
  if (logHooks.tap && !logHooks.mute) logHooks.tap(html, !!hit);
  if (logHooks.rec && !logHooks.mute) logHooks.rec(p.textContent);
}
// A line from another browser: only <b> and <span class="dice|crit"> survive, the rest
// becomes plain text, so nothing sent over the network can run in this page.
function safeCopy(from, to) {
  for (const c of from.childNodes) {
    if (c.nodeType === 3) { to.appendChild(document.createTextNode(c.textContent)); continue; }
    if (c.nodeType !== 1) continue;
    const tag = c.tagName.toLowerCase();
    if (tag !== "b" && tag !== "span") { safeCopy(c, to); continue; }
    const e = document.createElement(tag), cls = c.getAttribute("class");
    if (tag === "span" && (cls === "dice" || cls === "crit")) e.className = cls;
    safeCopy(c, e); to.appendChild(e);
  }
}
export function logRemote(html, hit) {
  const t = document.createElement("template"); t.innerHTML = html;   // inert: nothing loads or runs
  const p = document.createElement("p"); if (hit) p.className = "hit";
  safeCopy(t.content, p); logEl.prepend(p);
  if (logHooks.rec) logHooks.rec(p.textContent);
}
export function hint(t) { document.getElementById("hint").textContent = t; }

/* ---------- board rendering ---------- */
export const svg = document.getElementById("board");
export const NS = "http://www.w3.org/2000/svg";
export function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  (parent || svg).appendChild(e); return e;
}
