/**
 * Valid shots: what an operative standing at an eye point could shoot, and how the
 * current ruleset judges each shot — clear, in cover, or not a valid target (obscured,
 * Concealed in cover, in melee with a friendly, not visible). The 2D map, the 3D table and
 * the side panel all read this while an operative is selected or being dragged.
 */
import { WPN } from '../config.js';
import { foesNear } from './engage.js';
import { G } from './grid.js';
import { sightAnalysis } from './sight.js';
import { OPS } from './world.js';
import { RULES } from '../rules/index.js';

export const SHOT_KINDS = {
  clear:     {label: "Clear shot",  tag: "CLEAR",     valid: true},
  cover:     {label: "In cover",    tag: "COVER",     valid: true},
  obscured:  {label: "Not a valid target (obscured)", tag: "OBSCURED", valid: false},
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

// One shot from eye {x, y, team?, op?, weapon?} at target {x, y, order}. Kill Team's
// targeting, in order: the target must be visible; then not obscured; then cover decides,
// with the order: a Concealed target in cover isn't a valid target, unless the shooter
// looks down from a Vantage Point over cover that is only light terrain, or shoots an Indirect weapon (both make it count as on Engage for this shot; it
// still keeps its cover save). Last, an enemy with one of the shooter's friends in its
// control range is in melee and not a valid target.
// `eye.op` is the shooter's own operative; `eye.weapon` a
// WPN key or weapon object, else the shooter's selected weapon.
// `line` is the sight line that decides the call: a clear line, the cover line through the
// cover or the one through the obscuring terrain. A target that isn't visible gets no
// line: nothing to draw one to. `inCover` says whether the cover save applies if it is shot.
export function judgeShot(eye, target) {
  const shooter = eye.op || eye;
  // other operatives never give cover: only terrain does
  const s = sightAnalysis(eye, target);
  const wk = eye.weapon !== undefined ? eye.weapon : eye.op && eye.op.weapon;
  const w = typeof wk === "string" ? WPN[wk] : wk;
  const indirect = !!(w && w.rules && w.rules.includes("Indirect"));
  const inCover = !!(s.visible && s.coverBy);
  const up = standing(eye), down = standing(target);
  const vantage = !!(RULES.vantage && inCover && up.vantage && !s.hardCover && up.z - down.z >= RULES.vantage.rise - 1e-9);
  const concealed = !!(RULES.orders && target.order === "conceal" && inCover);
  // the friend in melee with the target: one of the shooter's side within the target's
  // engagement range (never the shooter itself: it is at the eye point)
  const engagedBy = eye.team === undefined ? null
    : foesNear(target.x, target.y, target.team, eye.op ? eye.op.id : null).find(o => o.team === eye.team && o !== shooter) || null;
  let kind;
  if (!s.visible) kind = "hidden";
  else if (s.obscBy) kind = "obscured";
  else if (concealed && !vantage && !indirect) kind = "concealed";
  else if (engagedBy) kind = "engaged";
  else if (inCover) kind = "cover";
  else kind = "clear";
  const line = kind === "hidden" ? null
             : kind === "obscured" ? s.obscBy.line
             : inCover ? s.coverBy.line
             : s.clearLine;
  return {target, kind, sight: s, line, range: Math.max(0, s.gap), inCover, engagedBy,
          // which exception turned a Concealed target in cover into a valid one
          vantage: concealed && vantage, indirect: concealed && !vantage && indirect};
}

// Every live enemy of eye.team, judged from eye. Re-judged only when the eye, its weapon,
// any operative, the map or the rules change, so a drag that lingers on one landing spot
// stays cheap.
let memo = {g: null, key: null, shots: []};
export function shotsFrom(eye) {
  const foes = OPS.filter(o => o.alive && o.team !== eye.team);
  const wk = eye.weapon !== undefined ? eye.weapon : eye.op && eye.op.weapon;
  const key = RULES.id + "|" + eye.x.toFixed(3) + "," + eye.y.toFixed(3) + "," + (eye.op ? eye.op.id : "") + "," +
    (typeof wk === "string" ? wk : JSON.stringify(wk)) + "|" +
    OPS.map(o => `${o.id}${o.alive ? "" : "x"}@${o.x.toFixed(3)},${o.y.toFixed(3)},${o.order},${o.team}`).join(";");
  if (memo.g === G && memo.key === key) return memo.shots;
  memo = {g: G, key, shots: foes.map(o => judgeShot(eye, o))};
  return memo.shots;
}
