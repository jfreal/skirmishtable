/**
 * Valid shots: what an operative standing at an eye point could shoot, and how the
 * current ruleset judges each shot — clear, in cover, obscured, or not a valid target
 * (Concealed in cover, in melee with a friendly, not visible). The 2D map, the 3D table and
 * the side panel all read this while an operative is selected or being dragged.
 */
import { foesNear } from './engage.js';
import { G } from './grid.js';
import { sightAnalysis } from './sight.js';
import { OPS } from './world.js';
import { RULES } from '../rules/index.js';

export const SHOT_KINDS = {
  clear:     {label: "Clear shot",  tag: "CLEAR",     valid: true},
  cover:     {label: "In cover",    tag: "COVER",     valid: true},
  obscured:  {label: "Obscured",    tag: "OBSCURED",  valid: true},
  concealed: {label: "Not a valid target (Conceal + cover)", tag: "CONCEALED", valid: false},
  engaged:   {label: "Not a valid target (in melee with a friendly)", tag: "ENGAGED", valid: false},
  hidden:    {label: "Not visible", tag: "NO LOS",    valid: false},
};

// How high an operative's base stands above the table, and whether it stands on a terrain
// feature with the Vantage Point trait. TODO: the engine has no model heights or terrain
// traits yet (fire steps are C_STEP cells drawn from DECOR, upper floors are overhead
// C_OVER cells), so this only reads `z` / `vantage` when a caller sets them on the point,
// and is 0 / false on the table otherwise.
export function standing(p) {
  return {z: p.z || 0, vantage: !!p.vantage};
}

// Why the operative at eye {x, y, team, op?} can't take a Shoot action at all, or null:
// it is on Conceal (`{why: "conceal"}`), or an enemy has it within control range
// (`{why: "engaged", by}`).
export function cannotShoot(eye) {
  const op = eye.op || eye;
  if (RULES.orders && op.order === "conceal") return {why: "conceal"};
  if (eye.team === undefined) return null;
  const by = foesNear(eye.x, eye.y, eye.team)[0];
  return by ? {why: "engaged", by} : null;
}

// One shot from eye {x, y, team?, op?} at target {x, y, order}: is the target a valid
// target? Kill Team's steps, in order: an enemy with one of the shooter's friends in its
// control range is in melee, not a valid target; one that isn't visible isn't either. A
// target within 2" is a clear shot (no cover, no obscuring: see sightAnalysis). Then an
// obscured target is valid (the attack dice suffer for it); one in cover is valid on
// Engage (cover save) and not on Conceal, unless the shooter stands on a Vantage Point
// and the cover is only light terrain: then it is valid, and its cover save counts as a
// critical success. On Engage, a Vantage Point at least `vantage.accurate[0]` / `[1]`
// above the target gives the shot Accurate 1 / 2.
// `line` is the sight line that decides the call: a clear line, the cover line through the
// cover or the one through the obscuring terrain; none to a target that isn't visible.
// `save` is the cover save the target gets if shot: "normal", "crit" or null.
export function judgeShot(eye, target) {
  const shooter = eye.op || eye;
  const s = sightAnalysis(eye, target);
  // the friend in melee with the target: one of the shooter's side within the target's
  // engagement range (never the shooter itself: it is at the eye point)
  const engagedBy = eye.team === undefined ? null
    : foesNear(target.x, target.y, target.team, shooter.id ?? null).find(o => o.team === eye.team && o !== shooter) || null;
  const V = RULES.vantage, up = standing(eye), drop = up.z - standing(target).z;
  const onVantage = !!(V && up.vantage);
  let kind, save = null, accurate = 0;
  if (engagedBy) kind = "engaged";
  else if (!s.visible) kind = "hidden";
  else if (s.obscBy) kind = "obscured";
  else if (!s.coverBy) kind = "clear";
  else if (!(RULES.orders && target.order === "conceal")) {
    kind = "cover"; save = "normal";
    if (onVantage) accurate = V.accurate.filter(h => drop >= h - 1e-9).length;
  }
  else if (onVantage && !s.hardCover) { kind = "cover"; save = "crit"; }   // seen past light cover from above
  else kind = "concealed";
  const line = !s.visible ? null : s.obscBy ? s.obscBy.line : s.coverBy ? s.coverBy.line : s.clearLine;
  return {target, kind, sight: s, line, range: Math.max(0, s.gap), engagedBy, save, accurate,
          inCover: !!s.coverBy && !s.obscBy,
          // a Concealed target made valid by shooting down from a Vantage Point
          vantage: save === "crit"};
}

// Every live enemy of eye.team, judged from eye. Re-judged only when the eye, any
// operative, the map or the rules change, so a drag that lingers on one landing spot
// stays cheap.
let memo = {g: null, key: null, shots: []};
export function shotsFrom(eye) {
  const foes = OPS.filter(o => o.alive && o.team !== eye.team);
  const key = RULES.id + "|" + eye.x.toFixed(3) + "," + eye.y.toFixed(3) + "," + (eye.op ? eye.op.id : "") + "|" +
    OPS.map(o => `${o.id}${o.alive ? "" : "x"}@${o.x.toFixed(3)},${o.y.toFixed(3)},${o.order},${o.team}`).join(";");
  if (memo.g === G && memo.key === key) return memo.shots;
  memo = {g: G, key, shots: foes.map(o => judgeShot(eye, o))};
  return memo.shots;
}
