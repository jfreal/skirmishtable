/**
 * Dice and injury helpers, and the dice part of Shoot and Fight. `die` gives the next D6:
 * Math.random offline, the shared roll online (src/net/fairdice.js), so both players'
 * browsers can work out the same result from the same dice.
 */
import { WPN } from '../config.js';

/* ---------- dice ---------- */
export const d6 = () => 1 + Math.floor(Math.random()*6);
export function rollAttack(n, hit, rules, die = d6) {
  let dice = Array.from({length:n}, () => die());
  if (rules.includes("Ceaseless")) {
    // re-roll all dice of one failing result (pick the most common fail value)
    const fails = dice.filter(v => v < hit && v !== 6);
    if (fails.length) {
      const counts = {}; fails.forEach(v => counts[v] = (counts[v]||0)+1);
      const pick = +Object.keys(counts).sort((a,b)=>counts[b]-counts[a])[0];
      dice = dice.map(v => v === pick ? die() : v);
    }
  }
  const crit = dice.filter(v => v === 6).length;
  const norm = dice.filter(v => v !== 6 && v !== 1 && v >= hit).length;
  return {dice, crit, norm};
}
export function rollDefence(save, cover, die = d6) {
  const rolled = Array.from({length: cover ? 2 : 3}, () => die());
  const crit = rolled.filter(v => v === 6).length;
  let norm = rolled.filter(v => v !== 6 && v !== 1 && v >= save).length;
  if (cover) norm += 1; // banked cover save
  return {dice: rolled, crit, norm, cover};
}
export function effHit(op, w) { return Math.min(6, w.hit + (isInjured(op) ? 1 : 0)); }
export function isInjured(op) { return op.wounds < op.maxW/2; }
export function effMove(op) { return isInjured(op) ? Math.max(4, op.move-2) : op.move; }

/* ---------- Shoot and Fight, from the dice ---------- */
// One shot, `what` = {by, at, w: weapon key, acc: Accurate dice, obsc: obscured, cover}:
// the attack and defence dice and the damage. The shooter `a` and target `b` aren't changed.
// Null if the weapon isn't one of the shooter's ranged weapons.
export function shootRoll(what, a, b, die = d6) {
  const w = WPN[what.w];
  if (!w || w.type !== "R" || !a.weapons.includes(what.w)) return null;
  const hit = effHit(a, w);
  // Accurate (from a Vantage Point): that many attack dice kept as normal successes unrolled
  const acc = Math.max(0, Math.min(what.acc | 0, w.atk));
  const atk = rollAttack(w.atk - acc, hit, w.rules, die);
  let aCrit = atk.crit, aNorm = atk.norm + acc;
  const notes = [];
  if (acc) notes.push(`Accurate ${acc}`);
  if (what.obsc) { // crits become normal, then discard one success
    aNorm += aCrit; aCrit = 0;
    if (aNorm > 0) aNorm--;
    notes.push("obscured: crits downgraded, one success discarded");
  }
  const dfn = rollDefence(b.save, !!what.cover, die);
  if (dfn.cover) notes.push("cover save banked");
  let dCrit = dfn.crit, dNorm = dfn.norm;
  // resolve defence: crits block crits first, then normals; two normals stop a crit
  while (dCrit > 0) { if (aCrit > 0) {aCrit--; dCrit--;} else if (aNorm > 0) {aNorm--; dCrit--;} else break; }
  while (dNorm > 0) {
    if (aNorm > 0) {aNorm--; dNorm--;}
    else if (dNorm >= 2 && aCrit > 0) {aCrit--; dNorm -= 2;}
    else break;
  }
  return {w, hit, atk, dfn, dmg: aNorm * w.dmgN + aCrit * w.dmgC, notes};
}
// The melee weapon an operative fights with: its chosen one if that is melee, else its
// first melee weapon, else a knife.
export const meleeKey = op => WPN[op.weapon] && WPN[op.weapon].type === "M" ? op.weapon
  : op.weapons.find(k => WPN[k] && WPN[k].type === "M") || "knife";
// One fight, `what` = {by, at, wa, wb: the two melee weapon keys}: both sides' dice, then
// alternate strikes (crits first, the attacker starts). Returns the dice and both
// operatives' wounds and alive afterwards; `a` and `b` aren't changed. Null for a weapon
// that isn't the operative's (a knife always is).
export function fightRoll(what, a, b, die = d6) {
  const ok = (op, k) => WPN[k] && WPN[k].type === "M" && (k === "knife" || op.weapons.includes(k));
  if (!ok(a, what.wa) || !ok(b, what.wb)) return null;
  const wa = WPN[what.wa], wb = WPN[what.wb];
  const hitA = effHit(a, wa), hitB = effHit(b, wb);
  const ra = rollAttack(wa.atk, hitA, wa.rules, die), rb = rollAttack(wb.atk, hitB, wb.rules, die);
  const A = {wounds: a.wounds, alive: a.alive}, B = {wounds: b.wounds, alive: b.alive};
  const pools = [ {op:A, foe:B, w:wa, crit:ra.crit, norm:ra.norm},
                  {op:B, foe:A, w:wb, crit:rb.crit, norm:rb.norm} ];
  let i = 0, guard = 0;
  while ((pools[0].crit+pools[0].norm > 0 || pools[1].crit+pools[1].norm > 0) && guard++ < 30) {
    const p = pools[i % 2];
    if (p.crit + p.norm > 0 && p.op.alive) {
      let dmg;
      if (p.crit > 0) { p.crit--; dmg = p.w.dmgC; } else { p.norm--; dmg = p.w.dmgN; }
      p.foe.wounds = Math.max(0, p.foe.wounds - dmg);
      if (p.foe.wounds === 0) { p.foe.alive = false; break; }
    }
    i++;
  }
  return {wa, wb, hitA, hitB, ra, rb, a: A, b: B};
}
