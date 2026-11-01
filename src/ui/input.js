/**
 * Pointer input: drag-to-move planner, clicks, targeting and order toggles. The 2D
 * board and the 3D table share it: each view turns pointer positions into board
 * inches (setBoardPicker) and hands token presses to armDrag / clickOp.
 */
import { state } from '../state.js';
import { CTRL, S } from '../config.js';
import { dist, opGap, opR } from '../engine/geometry.js';
import { chopIncrements, clampPath, nearestFree, opLayer, placeBlocked, planRoute, useBase } from '../engine/movement.js';
import { LEVELS, layerZ, onLayer, ptFree } from '../engine/grid.js';
import { foesNear } from '../engine/engage.js';
import { BH, BW, OPS } from '../engine/world.js';
import { RULES, fmtIn, moveSpec } from '../rules/index.js';
import { renderAll, renderOverlay } from './board.js';
import { hint, logLine, svg } from './dom.js';
import { cancelMode, defaultMoveType, refreshSight, snapshot, toggleOrder } from './panels.js';
import { mayControl } from '../net/sync.js';
import { cancelMarker, placeMarkerAt } from './ops.js';
import { openOpMenu } from './opmenu.js';

function svgPoint(ev) {
  const pt = new DOMPoint(ev.clientX, ev.clientY);
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  return [p.x / S, p.y / S];
}
// screen -> board inches for the active view (null = off the board)
let pickBoard = svgPoint;
export function setBoardPicker(fn) { pickBoard = fn || svgPoint; }

// Double-click an operative to flip its order (Conceal <-> Engage). Detected
// manually by oid + timestamp: the first click re-renders the tokens, so the
// browser's native dblclick never fires on the replaced node.
let lastTokenClick = {oid: null, t: 0};

const measuring = () => RULES.increment > 0 ? `measured in ${fmtIn(RULES.increment)}″ increments` : "measured exactly";

// pointerdown on a token: arm a drag (it activates once the pointer moves a little)
export function armDrag(op, ev, from3d = false) {
  if (!op || !op.alive || state.mode === "ruler" || state.mode === "target") return false;
  state.drag = {op, sx: op.x, sy: op.y, cx0: ev.clientX, cy0: ev.clientY, pid: ev.pointerId, from3d,
                goal: null, path: null, total: 0, valid: false, active: false};
  return true;
}

// Candidate plans: the available move actions in either order. A climb is only legal
// while the inches being spent belong to a move the ruleset lets climb, wherever that
// move sits in the plan — so if a climb won't fit with the main move first, the planner
// tries the secondary move first and saves the main move for the climb (arriving at
// the wall early burns the spare inches as "wait").
function plansFor(op, type = state.moveType) {
  const M = RULES.moves, used = t => op.used.includes(t);
  const phase = (type, spec) => ({type, allow: spec.allow(op), climb: spec.climb});
  const prim = phase("reposition", M.primary), sec = phase("dash", M.secondary);
  const plan = (p1, p2) => {
    const cap = p1.allow + (p2 ? p2.allow : 0);
    let lo = 0, hi = -1;                              // the climbing window, in inches from the start
    if (p1.climb && (!p2 || p2.climb)) hi = cap;
    else if (p1.climb) hi = p1.allow;
    else if (p2 && p2.climb) { lo = p1.allow; hi = cap; }
    return {p1, p2, lo, hi, cap};
  };
  const primAvail = !used("reposition") && !used("charge"), secAvail = !used("dash");
  if (type === "charge" && M.charge) return [plan(phase("charge", M.charge), null)];
  if (type === "dash") return primAvail ? [plan(sec, prim)] : [plan(sec, null)];
  return secAvail ? [plan(prim, sec), plan(sec, prim)] : [plan(prim, null)];
}

// A Charge can't share an activation with another move (and isn't repeated).
const mayCharge = op => !!RULES.moves.charge && !["reposition", "dash", "charge"].some(t => op.used.includes(t));

// Which layer a drag at (gx, gy) is aiming for: `hint` when the view knows (the 3D table
// picks the surface under the pointer: an upper floor or the table), else the layer the
// operative stands on if its base fits there, else the highest that fits. up (Shift on
// the 2D map, where a floor hides the ground under it) = the highest that fits.
function goalLayer(op, gx, gy, hint, up) {
  if (hint !== undefined && hint !== null) return hint;
  const fits = [0, ...LEVELS.map(L => L.l)].filter(l => onLayer(l, () => ptFree(gx, gy)));
  const here = opLayer(op), top = fits.reduce((a, l) => layerZ(l) > layerZ(a) ? l : a, fits[0] ?? here);
  return up ? top : fits.includes(here) ? here : top;
}
// re-plan the active drag towards board point (x, y) (on layer hint, if the view says)
function planDrag(x, y, hint, up) {
  const d = state.drag, R = opR(d.op);
  useBase(R);                                       // route, fit and collide this operative's own base
  let gx = Math.min(BW - R, Math.max(R, x));
  let gy = Math.min(BH - R, Math.max(R, y));
  const gl = goalLayer(d.op, gx, gy, hint, up);
  // pointing into terrain or another base: land pressed up against it instead
  const snap = nearestFree(gx, gy, d.op.id, gl), free = !!snap;
  if (snap) [gx, gy] = snap;
  // Engagement range: a normal move can't go within control range of an enemy (planRoute
  // routes round it), so dragging there turns the move into a Charge (Move + 2″, 1AP) when
  // one is allowed. A Charge may enter one enemy's control range, then has to stay in it.
  const intoFoes = foesNear(gx, gy, d.op.team, d.op.id, R, layerZ(gl)).length > 0;
  const charging = state.moveType === "charge" || (intoFoes && mayCharge(d.op));
  d.autoCharge = charging && state.moveType !== "charge";
  const plans = plansFor(d.op, charging ? "charge" : state.moveType);
  let bestPlan = null;
  if (free) for (const pl of plans) {
    const raw = planRoute(d.op, gx, gy, pl.lo, pl.hi, pl.cap, pl.p1.type === "charge", gl);
    if (!raw) continue;
    if (pl.p2) raw.split = pl.p1.allow;             // each move action gets its own free drop
    const c = clampPath(raw, pl.cap);
    const end = c.path[c.path.length - 1];
    const reach = !c.clamped && !raw.partial;
    const gapd = dist(end[0], end[1], gx, gy);
    if (!bestPlan
        || (reach && !bestPlan.reach)
        || (reach === bestPlan.reach && (reach ? c.total < bestPlan.c.total - 1e-9 : gapd < bestPlan.gapd - 1e-9)))
      bestPlan = {pl, c, reach, gapd, partial: !!raw.partial};
  }
  if (bestPlan) {
    const {pl, c, partial} = bestPlan;
    const end = c.path[c.path.length - 1];
    d.path = c.path; d.total = c.total; d.goal = [end[0], end[1]]; d.clamped = c.clamped; d.partial = partial;
    d.goalLayer = end[4] || 0; d.goalZ = layerZ(d.goalLayer);
    d.p1 = pl.p1; d.p2 = pl.p2;
    d.primAllow = pl.p1.allow;
    d.secondary = pl.p2 ? pl.p2.type : null;
    d.secAllow = pl.p2 ? pl.p2.allow : 0;
    d.foes = foesNear(end[0], end[1], d.op.team, d.op.id, R, d.goalZ);
    d.why = placeBlocked(end[0], end[1], d.op.id, d.goalLayer) ? "occupied"
      : charging && !d.foes.length ? "a Charge must end within engagement range"
      : !charging && (d.foes.length || intoFoes) && RULES.moves.charge ? "engagement range — can't Charge after moving"
      : null;
    d.valid = !d.why;
  } else {
    d.path = null; d.goal = [gx, gy]; d.total = 0; d.clamped = false; d.valid = false; d.partial = false;
    d.goalLayer = gl; d.goalZ = layerZ(gl);
    d.foes = []; d.why = "blocked";
    d.p1 = plans[0].p1; d.p2 = plans[0].p2;
    d.primAllow = plans[0].p1.allow; d.secondary = null; d.secAllow = 0;
  }
  renderOverlay();
}

// pointerup after an active drag: land the operative and log the move
function landDrag(d) {
  if (!d.valid || !d.path || !d.goal) {
    hint(d.why && d.why !== "blocked" && d.why !== "occupied"
      ? `No landing there — ${d.why}. Move cancelled.`
      : "No landing there — blocked or unreachable. Move cancelled.");
    renderAll(); return;
  }
  const chained = d.total > d.primAllow + 1e-9 && d.p2;
  const repeat = d.op.used.includes(d.p1.type) || (chained && d.op.used.includes(d.p2.type));
  const vert = chopIncrements(d.path).filter(st => st.climb);
  snapshot();
  d.op.x = d.goal[0]; d.op.y = d.goal[1]; d.op.z = d.goalZ || 0;
  const charged = d.p1.type === "charge";
  if (charged && RULES.orders && d.op.order === "conceal") {   // only an operative on Engage may charge
    d.op.order = "engage";
    logLine(`<b>${d.op.name}</b> flips to ▲ Engage to charge.`);
  }
  d.op.ap -= chained ? 2 : 1;
  d.op.used.push(d.p1.type);
  if (chained) d.op.used.push(d.p2.type);
  const verb = t => moveSpec(t).verb;
  const climbNote = vert.length ? ` incl. ${vert.map(st => st.kind === "up"
      ? `climbing ${st.climb}" onto ${st.level.name}'s upper floor (${fmtIn(st.up)}")`
      : st.kind === "drop" ? `dropping ${st.climb}" off ${st.level.name} (${fmtIn(st.down)}" counted)`
      : `climbing over ${st.climb}" terrain (${fmtIn(st.up)}" up, ${fmtIn(st.down)}" down)`).join(", then ")}` : "";
  const repeatNote = repeat ? ' <span class="crit">— repeated move action, players adjudicate</span>' : "";
  logLine(chained
    ? `<b>${d.op.name}</b> ${verb(d.p1.type)} ${fmtIn(d.primAllow)}" then ${verb(d.p2.type)} ${fmtIn(d.total - d.primAllow)}" (2AP)${climbNote}${repeatNote}.`
    : `<b>${d.op.name}</b> ${verb(d.p1.type)} ${fmtIn(d.total)}" (${fmtIn(d.primAllow)}" allowed)${climbNote}${repeatNote}.`);
  const enemies = OPS.filter(o => o.alive && o.team !== d.op.team && opGap(d.op, o) <= CTRL + 1e-9);
  if (enemies.length) logLine(`${d.op.name} is now in engagement range of ${enemies.map(e => e.name).join(", ")}.`);
  // auto-advance to the other movement of the activation: main move ①, then secondary ②
  const M = RULES.moves;
  const slot1Used = d.op.used.includes("reposition") || d.op.used.includes("charge");
  if (charged) {
    state.moveType = "reposition";
    hint(`${d.op.name} charged into ${enemies.map(e => e.name).join(", ")} — Fight!`);
  } else if (state.moveType !== "dash" && !d.op.used.includes("dash")) {
    state.moveType = "dash";
    hint(`${d.op.name}: movement ② still available — drag again to ${M.secondary.label} ${fmtIn(M.secondary.allow(d.op))}".`);
  } else if (state.moveType === "dash" && !slot1Used) {
    state.moveType = "reposition";
    hint(`${d.op.name}: movement ① still available — drag again to ${M.primary.label} ${fmtIn(M.primary.allow(d.op))}".`);
  } else {
    hint(`${d.op.name}: both movements used this activation.`);
  }
  renderAll();
}

// a click (or tap) on a token: order flip on double-click, targeting, or selection
export function clickOp(oid) {
  const now = performance.now();
  if (lastTokenClick.oid === oid && now - lastTokenClick.t < 400) {
    lastTokenClick = {oid: null, t: 0};
    if (RULES.orders) toggleOrder(oid);
    return;
  }
  lastTokenClick = {oid, t: now};
  const o = OPS.find(z => z.id === oid);
  if (!o || !o.alive) return;
  if (state.sel && o.team !== state.sel.team && (state.mode === "target" || state.mode === null)) {
    state.target = o; refreshSight(); renderAll();
    if (state.mode === "target") hint("Verdict panel explains the call. Shoot if you like the odds.");
    return;
  }
  state.sel = o; state.target = null; state.lastShot = null; state.moveType = defaultMoveType(o); cancelMode();
  hint(`${o.name} selected — drag to move, Target for line of sight${RULES.orders ? ", or double-click to toggle its order" : ""}.`);
  renderAll();
}

// Open an operative's right-click menu. A long press arms a drag first: drop it.
export function opMenuAt(op, ev) {
  if (!op) return;
  if (state.drag && !state.drag.active) state.drag = null;
  openOpMenu(op, ev.clientX, ev.clientY);
}

// Wiring: event listeners and button handlers (called once from main.js).
export function wireInput() {
  svg.addEventListener("pointermove", ev => {
    if (state.mode === "ruler" && state.rulerPts.length === 1) renderOverlay(svgPoint(ev));
  });
  /* drag to move — Pointer Events, so mouse, touch and pen all work: pointerdown on a
     token arms a drag; moving past a small threshold activates it; the path auto-routes
     around terrain; pointerup lands the operative. Token groups set touch-action:none
     so the browser doesn't turn the gesture into a page scroll. */
  svg.addEventListener("pointerdown", ev => {
    if (!ev.isPrimary || ev.button !== 0) return;
    const gEl = ev.target.closest && ev.target.closest("[data-oid]");
    if (!gEl) return;
    if (armDrag(OPS.find(o => o.id === gEl.getAttribute("data-oid")), ev)) ev.preventDefault();
  });
  // Chrome ignores touch-action on SVG shapes, so a finger on a token would scroll the page
  // (and cancel the drag). Once a token has armed a drag, stop the touch from panning.
  for (const type of ["touchstart", "touchmove"]) svg.addEventListener(type, ev => {
    if (state.drag && !state.drag.from3d && ev.cancelable) ev.preventDefault();
  }, {passive: false});
  window.addEventListener("pointermove", ev => {
    const d = state.drag;
    if (!d || ev.pointerId !== d.pid) return;
    if (!d.active) {
      if (Math.hypot(ev.clientX - d.cx0, ev.clientY - d.cy0) < 6) return;
      if (!mayControl(d.op)) {     // online: not yours to move; letting go still counts as a tap
        hint(`${d.op.name} belongs to the other player.`); return;
      }
      d.active = true;
      if (state.sel !== d.op) { state.sel = d.op; state.target = null; state.lastShot = null; state.moveType = defaultMoveType(d.op); }
      hint(`${d.op.name}: release to ${(moveSpec(state.moveType) || RULES.moves.primary).label.toLowerCase()} — route ${measuring()}.${RULES.moves.charge ? ` Ending within ${fmtIn(CTRL)}″ of an enemy makes it a ${RULES.moves.charge.label}.` : ""}${LEVELS.length && !d.from3d ? " Hold Shift to climb onto an upper floor." : ""}`);
      renderAll();
    }
    const p = pickBoard(ev);
    if (p) planDrag(p[0], p[1], p[2], ev.shiftKey);
  });
  window.addEventListener("pointerup", ev => {
    const d = state.drag;
    if (!d || ev.pointerId !== d.pid) return;
    state.drag = null;
    if (!d.active) { if (d.from3d) clickOp(d.op.id); return; } // a tap: the 2D board's click handler covers its own
    state.suppressClick = true; setTimeout(() => { state.suppressClick = false; }, 0);
    landDrag(d);
  });
  // a cancelled touch (system gesture, notification shade) abandons the move cleanly
  window.addEventListener("pointercancel", ev => {
    if (!state.drag || ev.pointerId !== state.drag.pid) return;
    const wasActive = state.drag.active;
    state.drag = null;
    if (wasActive) { hint("Move cancelled."); renderAll(); }
  });
  svg.addEventListener("click", ev => {
    if (state.suppressClick) return;
    const [x, y] = svgPoint(ev);
    if (state.mode === "marker" && placeMarkerAt(x, y)) return;
    if (state.mode === "ruler") {
      if (state.rulerPts.length >= 2) state.rulerPts = [];
      state.rulerPts.push([x, y]);
      renderOverlay([x, y]);
      return;
    }
    const oid = ev.target.closest && ev.target.closest("[data-oid]") ? ev.target.closest("[data-oid]").getAttribute("data-oid") : null;
    if (oid) clickOp(oid);
  });
  // right-click (or long-press) a token: its menu (opmenu.js)
  svg.addEventListener("contextmenu", ev => {
    const gEl = ev.target.closest && ev.target.closest("[data-oid]");
    if (!gEl) return;
    ev.preventDefault();
    opMenuAt(OPS.find(o => o.id === gEl.getAttribute("data-oid")), ev);
  });
  document.addEventListener("keydown", ev => {
    if (ev.key === "Escape") { cancelMarker(); cancelMode(); renderAll(); }
  });
}
