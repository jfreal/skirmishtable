/**
 * Rulesets: everything game-specific that the table (terrain, measuring, routing,
 * sight geometry) consults — base size, control range, movement increments and
 * actions, climbing costs, cover and obscuring, orders. Add a game by adding a module
 * here with the same shape (see killteam.js) and listing it in RULESETS.
 */
import { setBaseRadius, setControlRange } from '../config.js';
import killteam from './killteam.js';
import infinity from './infinity.js';
import ashfall from './ashfall.js';

export const RULESETS = { killteam, infinity, ashfall };
export let RULES = killteam;

// Switch rules. Callers reload the map afterwards: the clearance map, climb portals and
// route fields all depend on the base size and climbing costs.
export function setRuleset(id) {
  const r = RULESETS[id];
  if (!r) throw new Error('unknown ruleset ' + id);
  RULES = r;
  setBaseRadius(r.baseMm / 25.4 / 2);
  setControlRange(r.controlRange);
  return r;
}

// Cost of a straight walking leg of length L under the current rules.
export function legCost(L) {
  const inc = RULES.increment;
  return inc > 0 ? Math.ceil(L / inc - 1e-9) * inc : L;
}
// Inches for display: whole numbers as-is, otherwise one decimal.
export const fmtIn = v => Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : v.toFixed(1);
// Move actions keep fixed ids in game state ('reposition' = the ruleset's main move,
// 'dash' = its secondary move, 'charge' = its charge, if any); labels come from here.
const SLOT = { reposition: 'primary', dash: 'secondary', charge: 'charge' };
export const moveSpec = type => RULES.moves[SLOT[type]] || null;
export const moveLabel = type => (moveSpec(type) || { label: type }).label;
