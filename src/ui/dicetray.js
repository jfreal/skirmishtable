/**
 * The dice trays: what each side has rolled. Two players often roll at once (one shoots,
 * the other saves), so each side has its own tray and its own dice box on screen
 * (src/ui/dicebox.js). A tray holds the dice in roll order, the hit/save target, what they
 * were for and which dice were re-rolled. Shoot and Fight put the attacker's and defender's
 * dice in their own trays. Shared online like the rest of the game (src/net/sync.js).
 */
import { TEAMNAME } from '../config.js';
import { logLine } from './dom.js';

const emptyTray = side => ({ who: side, label: "", hit: 3, dice: [], rerolled: [] });
export const diceTrays = [emptyTray(0), emptyTray(1)];
let canRoll = () => true;
const listeners = [], renders = [];
export const onDiceChange = fn => listeners.push(fn);
// every redraw, local or from the network: the dice boxes follow their trays
export const onDiceRender = fn => renders.push(fn);
function changed() { renderDice(); for (const fn of listeners) fn(); }
const tray = who => diceTrays[who === 1 ? 1 : 0];

// may this browser roll for that side (online: only your own)
export const mayRoll = side => canRoll(side);
export const tally = (dice, hit) => ({
  crit: dice.filter(v => v === 6).length,
  norm: dice.filter(v => v !== 6 && v !== 1 && v >= hit).length,
});
const fmt = (dice, hit) => dice.map(v => v === 6 ? `<span class="crit">6</span>` : v >= hit && v !== 1 ? `${v}` : `<span class="dice">${v}</span>`).join(" ");

// a roll whose dice were already thrown (the dice box decides them as they leave the hand);
// `rerolled`: dice of it that have used their re-roll (new dice thrown in beside old ones)
export function setRoll(values, who, label = "", rerolled = []) {
  const t = tray(who);
  t.label = label; t.dice = values.slice(0, 20); t.rerolled = [...new Set(rerolled)].filter(i => i < t.dice.length);
  const c = tally(t.dice, t.hit);
  logLine(`<b>${TEAMNAME[t.who]}</b> rolls ${t.dice.length}D (${t.hit}+)${label ? " " + label : ""} — ` +
    `[${fmt(t.dice, t.hit)}] → <b>${c.crit} crit, ${c.norm} hit</b>`);
  changed();
}
// dice from Shoot / Fight, into that side's tray, so both players see them land
export function showRoll(dice, hit, who, label) {
  Object.assign(tray(who), { dice: [...dice], hit, label, rerolled: [] });
  changed();
}
// re-roll several dice at once (picked up out of their slots and thrown again): one log line.
// Each die re-rolls once; a die that already has is left as it was.
export const wasRerolled = (who, i) => tray(who).rerolled.includes(i);
export function rerollDice(who, idx, values) {
  const t = tray(who);
  const ok = idx.map((i, k) => [i, values[k]]).filter(([i]) => i >= 0 && i < t.dice.length && !t.rerolled.includes(i));
  if (!ok.length) return;
  const was = ok.map(([i]) => t.dice[i]);
  for (const [i, v] of ok) t.dice[i] = v;
  t.rerolled = [...new Set([...t.rerolled, ...ok.map(([i]) => i)])];
  const c = tally(t.dice, t.hit);
  logLine(`<b>${TEAMNAME[t.who]}</b> re-rolls: ${was.join(" ")} → <b>${ok.map(([, v]) => v).join(" ")}</b> · now [${fmt(t.dice, t.hit)}] → <b>${c.crit} crit, ${c.norm} hit</b>`);
  changed();
}
export function setHit(who, h) { tray(who).hit = Math.max(2, Math.min(6, h | 0)); changed(); }
export function clearDice(who) { Object.assign(tray(who), { dice: [], rerolled: [], label: "" }); changed(); }
// replace both trays from the network (already cleaned)
export function setDiceTray(trays) { trays.forEach((d, s) => Object.assign(diceTrays[s], d, { who: s })); renderDice(); }
export const exportDice = () => diceTrays.map(t => ({ ...t, dice: [...t.dice], rerolled: [...t.rerolled] }));

// allowFn(side): may this browser roll in that side's tray
export function wireDice(allowFn) { canRoll = allowFn; renderDice(); }
export function renderDice() { for (const fn of renders) fn(); }
