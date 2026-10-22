/**
 * Kill Team (2024) core rules, as far as SkirmishTable models them.
 */
import { effMove } from '../engine/dice.js';

export default {
  id: 'killteam',
  name: 'Kill Team (2024)',
  short: 'Kill Team',
  blurb: 'Moves in whole-inch increments; Reposition then Dash 3″; climbing costs the height (at least 2″) plus the drop past the free 2″; cover from terrain within 1″ unless within 2″; Conceal/Engage orders.',
  baseMm: 28,              // base diameter
  controlRange: 1,         // melee, objective control and the shaded ring round a selected model
  increment: 1,            // moves are paid in increments of this many inches (0 = measured exactly)
  moves: {
    primary:   { label: 'Reposition', verb: 'repositions', allow: op => effMove(op),     climb: true },
    secondary: { label: 'Dash',       verb: 'dashes',      allow: () => 3,               climb: false },
    charge:    { label: 'Charge',     verb: 'charges',     allow: op => effMove(op) + 2, climb: true },
  },
  climbUp: h => Math.max(2, h),          // each climb counts as at least 2″
  climbDown: h => Math.max(0, h - 2),    // the first 2″ of a drop are free
  cover: { range: 1, voidWithin: 2 },    // intervening terrain within `range` of the target; void inside `voidWithin`
  obscure: { beyond: 1 },                // sight-blocking terrain more than `beyond` from both operatives
  orders: true,                          // Conceal/Engage: concealed in cover = not a valid target
};
