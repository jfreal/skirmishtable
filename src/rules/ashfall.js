/**
 * Ashfall — a made-up house ruleset, here to show the rules layer is pluggable:
 * coarse 2″ movement bounds, a flat price for any climb, bigger bases and generous
 * cover. Nothing official about it.
 */
export default {
  id: 'ashfall',
  name: 'Ashfall (house rules)',
  short: 'Ashfall',
  blurb: 'Moves paid in 2″ bounds; Advance 6″, Sprint 4″ (can’t climb) or Assault 8″; any climb costs a flat 3″ up and 1″ down; cover from terrain within 2″ unless within 3″; obscured beyond 3″.',
  baseMm: 32,
  controlRange: 2,
  increment: 2,
  moves: {
    primary:   { label: 'Advance', verb: 'advances', allow: () => 6, climb: true },
    secondary: { label: 'Sprint',  verb: 'sprints',  allow: () => 4, climb: false },
    charge:    { label: 'Assault', verb: 'assaults', allow: () => 8, climb: true },
  },
  climbUp: () => 3,
  climbDown: () => 1,
  cover: { range: 2, voidWithin: 3 },
  obscure: { fromShooter: 3, fromTarget: 3 },
  vantage: null,
  orders: false,
};
