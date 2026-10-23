/**
 * Infinity-style skirmish, heavily simplified — inspired by the game's feel, not its
 * actual rules: free measuring, MOV split into two moves (4″ + 2″), climbing costs
 * just the height, cover only from terrain the base is right up against.
 */
export default {
  id: 'infinity',
  name: 'Infinity-style (simplified)',
  short: 'Infinity-style',
  blurb: 'Measured exactly (no increments); Move 4″ then a second Move 2″, both can climb; climbing costs the height, dropping down is free; cover only from terrain within ½″ of the base; no obscuring.',
  baseMm: 25,
  controlRange: 0.1,       // engagement means base contact
  increment: 0,
  moves: {
    primary:   { label: 'Move',        verb: 'moves',          allow: () => 4, climb: true },
    secondary: { label: 'Second move', verb: 'moves again',    allow: () => 2, climb: true },
    charge:    null,
  },
  climbUp: h => h,
  climbDown: () => 0,
  cover: { range: 0.5, voidWithin: 0 },
  obscure: null,
  vantage: null,
  orders: false,
};
