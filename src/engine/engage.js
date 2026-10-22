/**
 * Engagement range: two enemy operatives whose bases are within control range of each
 * other (Kill Team: 1″, base edge to base edge) are engaged. A normal move can't end
 * there; only a Charge can, and a Charge must.
 */
import { BASE_R, CTRL } from '../config.js';
import { dist, opR } from './geometry.js';
import { OPS } from './world.js';

// enemies of `team` that a base of radius r at (x, y) would be engaged with
export function foesNear(x, y, team, excludeId = null, r = BASE_R) {
  return OPS.filter(o => o.alive && o.team !== team && o.id !== excludeId && dist(x, y, o.x, o.y) - r - opR(o) <= CTRL + 1e-9);
}
// every engaged pair on the board, [a, b] with a on team 0
export function engagements() {
  const out = [];
  for (const a of OPS) if (a.alive && a.team === 0)
    for (const b of foesNear(a.x, a.y, 0, a.id, opR(a))) out.push([a, b]);
  return out;
}
