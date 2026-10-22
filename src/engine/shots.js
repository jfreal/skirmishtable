/**
 * Valid shots: what an operative standing at an eye point could shoot, and how the
 * current ruleset judges each shot — clear, in cover, obscured, not a valid target
 * (Concealed in cover) or not visible. The 2D map, the 3D table and the side panel all
 * read this while an operative is selected or being dragged.
 */
import { G } from './grid.js';
import { sightAnalysis } from './sight.js';
import { OPS } from './world.js';
import { RULES } from '../rules/index.js';

export const SHOT_KINDS = {
  clear:     {label: "Clear shot",  tag: "CLEAR",     valid: true},
  cover:     {label: "In cover",    tag: "COVER",     valid: true},
  obscured:  {label: "Obscured",    tag: "OBSCURED",  valid: true},
  concealed: {label: "Not a valid target (Conceal + cover)", tag: "CONCEALED", valid: false},
  hidden:    {label: "Not visible", tag: "NO LOS",    valid: false},
};

// One shot from eye {x, y} at target {x, y, order}. `line` is the sight line that decides
// the call: a clear line, the cover line through the cover or the one through the
// obscuring terrain. A target that isn't visible gets no line: nothing to draw one to.
export function judgeShot(eye, target) {
  const s = sightAnalysis(eye, target);
  let kind;
  if (!s.visible) kind = "hidden";
  else if (RULES.orders && target.order === "conceal" && s.coverBy) kind = "concealed";
  else if (s.obscBy) kind = "obscured";
  else if (s.coverBy) kind = "cover";
  else kind = "clear";
  const line = kind === "clear" ? s.clearLine
             : kind === "obscured" ? s.obscBy.line
             : kind === "hidden" ? null
             : s.coverBy.line;
  return {target, kind, sight: s, line, range: Math.max(0, s.gap)};
}

// Every live enemy of eye.team, judged from eye. Re-judged only when the eye, an enemy,
// the map or the rules change, so a drag that lingers on one landing spot stays cheap.
let memo = {g: null, key: null, shots: []};
export function shotsFrom(eye) {
  const foes = OPS.filter(o => o.alive && o.team !== eye.team);
  const key = RULES.id + "|" + eye.x.toFixed(3) + "," + eye.y.toFixed(3) + "|" +
    foes.map(o => `${o.id}@${o.x.toFixed(3)},${o.y.toFixed(3)},${o.order}`).join(";");
  if (memo.g === G && memo.key === key) return memo.shots;
  memo = {g: G, key, shots: foes.map(o => judgeShot(eye, o))};
  return memo.shots;
}
