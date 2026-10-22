/**
 * Dice and injury helpers.
 */
/* ---------- dice ---------- */
export const d6 = () => 1 + Math.floor(Math.random()*6);
export function rollAttack(n, hit, rules) {
  let dice = Array.from({length:n}, d6);
  if (rules.includes("Ceaseless")) {
    // re-roll all dice of one failing result (pick the most common fail value)
    const fails = dice.filter(v => v < hit && v !== 6);
    if (fails.length) {
      const counts = {}; fails.forEach(v => counts[v] = (counts[v]||0)+1);
      const pick = +Object.keys(counts).sort((a,b)=>counts[b]-counts[a])[0];
      dice = dice.map(v => v === pick ? d6() : v);
    }
  }
  const crit = dice.filter(v => v === 6).length;
  const norm = dice.filter(v => v !== 6 && v !== 1 && v >= hit).length;
  return {dice, crit, norm};
}
// cover: falsy, or the cover save kept without rolling: a normal success, or "crit"
export function rollDefence(save, cover) {
  const rolled = Array.from({length: cover ? 2 : 3}, d6);
  let crit = rolled.filter(v => v === 6).length;
  let norm = rolled.filter(v => v !== 6 && v !== 1 && v >= save).length;
  if (cover === "crit") crit += 1; else if (cover) norm += 1; // banked cover save
  return {dice: rolled, crit, norm, cover};
}
export function effHit(op, w) { return Math.min(6, w.hit + (isInjured(op) ? 1 : 0)); }
export function isInjured(op) { return op.wounds < op.maxW/2; }
export function effMove(op) { return isInjured(op) ? Math.max(4, op.move-2) : op.move; }
