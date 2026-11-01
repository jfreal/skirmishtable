/**
 * Where Shoot, Fight and the dice boxes get their dice. Offline (or online with nobody to
 * roll against) that is Math.random, right away. Online with two players, sync.js swaps
 * in the shared commit-reveal roll (fairdice.js): the dice come a moment later.
 *
 * rollFor(what, onDice, onFail): onDice(die, done, n, cancel) gets die() (the next D6), done()
 * (call it once the result is in the game, so it goes out marked for the other player to
 * check) and n, the shared roll's number (null offline), and cancel() (the roll can't be used: it frees the next roll and tells
 * the other player it was dropped). Returns null, or why it can't
 * roll now (nothing was rolled).
 */
import { d6 } from '../engine/dice.js';

let roller = (what, onDice) => { onDice(d6, () => {}, null, () => {}); return null; };
export const setRoller = fn => { roller = fn; };
export const rollFor = (what, onDice, onFail) => roller(what, onDice, onFail);
// the log's mark on a shared roll
export const fairNote = n => n == null ? "" : ` <span class="dice">· fair roll #${n}</span>`;
