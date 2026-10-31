/**
 * Dice tray, as Kill Team players use it in Tabletop Simulator: roll 1–6 dice (or more),
 * see them sorted by face with counts, read off crits (6s) and normal successes against a
 * hit/save target, and click a die to re-roll it. Shoot and Fight put their attack dice
 * here too. Shared online like the rest of the game (src/net/sync.js).
 */
import { d6 } from '../engine/dice.js';
import { TEAMNAME } from '../config.js';
import { logLine } from './dom.js';

// who rolled (side 0/1 or null), what for, the target number and the dice in roll order
export const diceTray = { who: null, label: "", hit: 3, dice: [], rerolled: [] };
let mySide = () => null, canRoll = () => true;
const listeners = [], renders = [];
export const onDiceChange = fn => listeners.push(fn);
// every redraw, local or from the network: the dice box follows the tray
export const onDiceRender = fn => renders.push(fn);
function changed() { renderDice(); for (const fn of listeners) fn(); }

export const mySideNow = () => mySide();
export const mayRoll = () => canRoll();
export const tally = (dice, hit) => ({
  crit: dice.filter(v => v === 6).length,
  norm: dice.filter(v => v !== 6 && v !== 1 && v >= hit).length,
});
const fmt = (dice, hit) => dice.map(v => v === 6 ? `<span class="crit">6</span>` : v >= hit && v !== 1 ? `${v}` : `<span class="dice">${v}</span>`).join(" ");

export function rollDice(n, who, label = "") {
  setRoll(Array.from({ length: Math.max(1, Math.min(20, n)) }, d6), who, label);
}
// a roll whose dice were already thrown (the dice box decides them as they leave the hand)
export function setRoll(values, who, label = "") {
  diceTray.who = who; diceTray.label = label;
  diceTray.dice = values.slice(0, 20);
  diceTray.rerolled = [];
  const n = diceTray.dice.length, t = tally(diceTray.dice, diceTray.hit);
  logLine(`${who === 0 || who === 1 ? `<b>${TEAMNAME[who]}</b> rolls` : "Roll:"} ${n}D (${diceTray.hit}+)${label ? " " + label : ""} — ` +
    `[${fmt(diceTray.dice, diceTray.hit)}] → <b>${t.crit} crit, ${t.norm} hit</b>`);
  changed();
}
// attack dice from Shoot / Fight, so both players see them sorted the same way
export function showRoll(dice, hit, who, label) {
  Object.assign(diceTray, { dice: [...dice], hit, who, label, rerolled: [] });
  changed();
}
export function rerollDie(i) { rerollDice([i], [d6()]); }
// re-roll several dice at once (picked up out of their slots and thrown again): one log line
export function rerollDice(idx, values) {
  const ok = idx.map((i, k) => [i, values[k]]).filter(([i]) => i >= 0 && i < diceTray.dice.length);
  if (!ok.length) return;
  const was = ok.map(([i]) => diceTray.dice[i]);
  for (const [i, v] of ok) diceTray.dice[i] = v;
  diceTray.rerolled = [...new Set([...diceTray.rerolled, ...ok.map(([i]) => i)])];
  const t = tally(diceTray.dice, diceTray.hit);
  logLine(`Re-roll: ${was.join(" ")} → <b>${ok.map(([, v]) => v).join(" ")}</b> · now [${fmt(diceTray.dice, diceTray.hit)}] → <b>${t.crit} crit, ${t.norm} hit</b>`);
  changed();
}
export function setHit(h) { diceTray.hit = Math.max(2, Math.min(6, h | 0)); changed(); }
export function clearDice() { Object.assign(diceTray, { dice: [], rerolled: [], label: "" }); changed(); }
// replace the tray from the network (already cleaned)
export function setDiceTray(d) { Object.assign(diceTray, d); renderDice(); }

export function wireDice(sideFn, allowFn) {
  mySide = sideFn; canRoll = allowFn;
  renderDice();
}
export function renderDice() {
  for (const fn of renders) fn();
  const box = document.getElementById("dicetray");
  if (!box) return;
  const t = tally(diceTray.dice, diceTray.hit), off = canRoll() ? "" : " disabled";
  const faces = [1, 2, 3, 4, 5, 6].map(f => {
    const idx = diceTray.dice.map((v, i) => v === f ? i : -1).filter(i => i >= 0);
    const cls = f === 6 ? "crit" : f === 1 || f < diceTray.hit ? "miss" : "hit";
    return `<div class="dcol ${cls}"><div class="dface">${f}</div>
      <div class="dpips">${idx.map(i => `<button class="die ${cls}${diceTray.rerolled.includes(i) ? " rr" : ""}" data-i="${i}" title="Re-roll this die"${off}>${f}</button>`).join("")}</div>
      <div class="dcount">${idx.length || ""}</div></div>`;
  }).join("");
  box.innerHTML = `
    <div class="btnrow dicebtns">${[1, 2, 3, 4, 5, 6].map(n => `<button class="mini" data-n="${n}"${off}>${n}D</button>`).join("")}
      <label class="dhit">hit on <select id="dicehit"${off}>${[2, 3, 4, 5, 6].map(h => `<option${h === diceTray.hit ? " selected" : ""}>${h}</option>`).join("")}</select>+</label></div>
    <div class="dgrid">${faces}</div>
    <div class="dsum">${diceTray.dice.length
      ? `${diceTray.who === 0 || diceTray.who === 1 ? TEAMNAME[diceTray.who] + " · " : ""}${diceTray.label ? diceTray.label + " · " : ""}<b>${t.crit}</b> crit · <b>${t.norm}</b> hit · ${diceTray.dice.length - t.crit - t.norm} miss`
      : `<span class="hint">Quick roll, or Shoot / Fight; click a die to re-roll it. Dice box (on the table): pick up, shake, throw.</span>`}
      ${diceTray.dice.length ? `<button class="mini" id="diceclear"${off}>Clear</button>` : ""}</div>`;
  box.querySelectorAll("[data-n]").forEach(b => b.onclick = () => rollDice(+b.dataset.n, mySide()));
  box.querySelectorAll(".die").forEach(b => b.onclick = () => rerollDie(+b.dataset.i));
  box.querySelector("#dicehit").onchange = e => setHit(+e.target.value);
  const c = box.querySelector("#diceclear");
  if (c) c.onclick = clearDice;
}
