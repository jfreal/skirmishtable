/**
 * Side panels (operative card, verdict, tray), actions (shoot, fight, undo) and UI state.
 */
import { state } from '../state.js';
import { CTRL, TEAMCOL_LT, WPN } from '../config.js';
import { effHit, fightRoll, isInjured, meleeKey, shootRoll } from '../engine/dice.js';
import { opGap, opR } from '../engine/geometry.js';
import { nearestFree, opLayer, useBase } from '../engine/movement.js';
import { SHOT_KINDS, cannotShoot, judgeShot, shotsFrom } from '../engine/shots.js';
import { OPS } from '../engine/world.js';
import { SHOT_COL, renderAll } from './board.js';
import { HINT0, fmtDice, hint, logLine } from './dom.js';
import { RULES, fmtIn, moveSpec } from '../rules/index.js';
import { mayControl, online } from '../net/sync.js';
import { showRoll } from './dicetray.js';
import { fairNote, rollFor } from '../net/roll.js';

/* ---------- state / undo / log ---------- */
export let tray = {tp:1, cp:[3,3], vp:[0,0]};
export const undoStack = [];
// other modules' state that undo restores too ({get, set}; the ops & score panel)
export const undoExtras = [];
// Where each operative stood when its activation began, for "Undo activation". Every
// snapshot (taken before each change) refreshes the operatives that haven't acted yet,
// so the entry freezes the moment one starts acting. Local to this browser.
const actStart = new Map();
const untouched = o => o.ready && !o.used.length && o.ap === o.apl;
// An order change costs no AP, so it can be the first thing an activation does: the record
// taken before it (same turning point, same spot, different order) must not be refreshed.
const orderChanged = o => {
  const st = actStart.get(o.id);
  return !!st && !!RULES.orders && st.tp === tray.tp && st.order !== o.order && st.x === o.x && st.y === o.y && st.z === (o.z || 0);
};
export function snapshot() {
  for (const o of OPS) if (o.alive && untouched(o) && !orderChanged(o)) actStart.set(o.id, {tp: tray.tp, x: o.x, y: o.y, z: o.z || 0, order: o.order});
  undoStack.push(JSON.stringify({ops:OPS, tray, extras: undoExtras.map(x => x.get())}));
  if (undoStack.length > 40) undoStack.shift();
}
export function doUndo() {
  const s = undoStack.pop();
  if (!s) { hint(online() ? "Nothing to undo. Online, a shared roll can't be taken back." : "Nothing to undo."); return false; }
  const o = JSON.parse(s); OPS.splice(0, OPS.length, ...o.ops); Object.assign(tray, o.tray);
  if (o.extras) undoExtras.forEach((x, i) => { if (o.extras[i] !== undefined) x.set(o.extras[i]); });
  if (state.sel) state.sel = OPS.find(x => x.id === state.sel.id) || null;
  state.target = null; state.lastShot = null; cancelMode();
  logLine("Undid last action.");
  renderAll();
  return true;
}

/* ---------- combat ---------- */
function doShoot() {
  if (!state.sel || !state.target) return;
  const w = WPN[state.sel.weapon];
  if (w.type !== "R") { logLine("Selected weapon is melee — use Fight."); return; }
  const no = cannotShoot(selEye());
  if (no) { logLine(`<b>${state.sel.name}</b> can't Shoot — ${noShootWhy(no)}.`); return; }
  refreshSight();                        // judge it as things stand now, not when targeted
  const shot = state.lastShot;
  if (!shot || !SHOT_KINDS[shot.kind].valid) {
    logLine(`<b>${state.target.name}</b> is not a valid target — ${shot ? shotWhy(shot) : "no target"}.`);
    renderAll(); return;
  }
  // what is rolled for: the shot as this table judges it, fixed before the dice are known
  const what = {k: "shoot", by: state.sel.id, at: state.target.id, w: state.sel.weapon,
                acc: Math.min(shot.accurate, w.atk), obsc: !!shot.obscured, cover: !!shot.save};
  const why = rollFor(what, (die, done, n, cancel) => {
    // the dice arrive a moment after the click: judge again what they are for
    const a = OPS.find(o => o.id === what.by), b = OPS.find(o => o.id === what.at);
    if (!a || !b || !a.alive || !b.alive || a.ap < 1 || a.weapon !== what.w) {
      cancel();
      logLine(`<b>${a ? a.name : what.by}</b>'s shot no longer stands — not rolled.`);
      renderAll(); return;
    }
    snapshot();
    const r = shootRoll(what, a, b, die);
    showRoll(r.atk.dice, r.hit, a.team, `${a.name} shoots`);
    showRoll(r.dfn.dice, b.save, b.team, `${b.name} saves${r.dfn.cover ? " (+cover)" : ""}`);
    b.wounds = Math.max(0, b.wounds - r.dmg);
    a.ap -= 1; a.used.push("shoot");
    let line = `<b>${a.name}</b> shoots <b>${b.name}</b> with ${r.w.name} — ` +
      `<span class="dice">atk [${fmtDice(r.atk.dice)}] def [${fmtDice(r.dfn.dice)}${r.dfn.cover?" +cover":""}]</span> → ` +
      `<b>${r.dmg} dmg</b>${r.notes.length ? " <span class='dice'>("+r.notes.join("; ")+")</span>" : ""}`;
    if (b.wounds === 0) { b.alive = false; line += " — <b>incapacitated!</b>"; }
    else if (isInjured(b)) line += " — injured";
    logLine(line + fairNote(n), r.dmg > 0);
    rolled(n, done);
  });
  if (why) hint(`Can't shoot yet: ${why}.`);
}
// a roll's result is in: send it (online), and online a shared roll can't be undone
function rolled(n, done) {
  done();
  if (n != null) undoStack.length = 0;
  cancelMode(); renderAll();
}
function doFight() {
  if (!state.sel || !state.target) return;
  const gap = opGap(state.sel, state.target);
  if (gap > CTRL) { logLine(`Target is not within control range (${fmtIn(CTRL)}&Prime;).`); return; }
  const what = {k: "fight", by: state.sel.id, at: state.target.id, wa: meleeKey(state.sel),
                wb: state.target.weapons.find(k => WPN[k].type === "M") || "knife"};
  const why = rollFor(what, (die, done, n, cancel) => {
    const a = OPS.find(o => o.id === what.by), b = OPS.find(o => o.id === what.at);
    if (!a || !b || !a.alive || !b.alive || a.ap < 1 || opGap(a, b) > CTRL) {
      cancel();
      logLine(`<b>${a ? a.name : what.by}</b>'s fight no longer stands — not rolled.`);
      renderAll(); return;
    }
    snapshot();
    const r = fightRoll(what, a, b, die);
    showRoll(r.ra.dice, r.hitA, a.team, `${a.name} fights`);
    showRoll(r.rb.dice, r.hitB, b.team, `${b.name} fights back`);
    Object.assign(a, r.a); Object.assign(b, r.b);
    a.ap -= 1; a.used.push("fight");
    let line = `<b>${a.name}</b> fights <b>${b.name}</b> — ` +
      `<span class="dice">${a.name} [${fmtDice(r.ra.dice)}] vs ${b.name} [${fmtDice(r.rb.dice)}]</span> → ` +
      `${a.name} ${a.wounds}W, ${b.name} ${b.wounds}W`;
    if (!b.alive) line += ` — <b>${b.name} down!</b>`;
    if (!a.alive) line += ` — <b>${a.name} down!</b>`;
    logLine(line + fairNote(n), true);
    rolled(n, done);
  });
  if (why) hint(`Can't fight yet: ${why}.`);
}
// The ruleset's move actions as buttons: ① main move, ② secondary move, and its charge.
function moveButtons(repoUsed, dashUsed, chargeUsed) {
  const M = RULES.moves, op = state.sel, out = [];
  const btn = (t, spec, used, prefix, title, extraCls = "") =>
    `<button id="mv-${t}" class="${state.moveType === t ? "active" : ""} ${used ? "used" : ""} ${extraCls}" title="${title}">` +
    `${used ? "✓ " + spec.label : `${prefix}${spec.label} ${fmtIn(spec.allow(op))}&Prime;`}</button>`;
  out.push(btn("reposition", M.primary, repoUsed, "① ", `1AP · move up to ${fmtIn(M.primary.allow(op))}&Prime;${M.primary.climb ? " · can climb" : ""}`));
  out.push(btn("dash", M.secondary, dashUsed, "② ", `1AP · move up to ${fmtIn(M.secondary.allow(op))}&Prime;${M.secondary.climb ? " · can climb" : " · can't climb"}`));
  if (M.charge) {
    const restricted = !chargeUsed && (repoUsed || dashUsed);
    out.push(btn("charge", M.charge, chargeUsed, "", restricted
      ? `Cannot ${M.charge.label} in an activation with another move`
      : `1AP · move up to ${fmtIn(M.charge.allow(op))}&Prime;, must end in enemy control range`, restricted ? "restricted" : ""));
  }
  return out.join("\n      ");
}
// Hand-applied damage (ploys, falls, house rules), logged the way TTS players' wound
// counters log it: "[12/15] Blademaster took damage".
export function adjustWounds(op, d) {
  if (!op || !op.alive) return;
  snapshot();
  op.wounds = Math.max(0, Math.min(op.maxW, op.wounds + d));
  let line = `[${op.wounds}/${op.maxW}] <b>${op.name}</b> ${d < 0 ? "took damage" : "recovered"}`;
  if (op.wounds === 0) { op.alive = false; line += " — <b>incapacitated!</b>"; }
  else if (d < 0 && isInjured(op) && !isInjured({ ...op, wounds: op.wounds - d })) line += " — injured";
  logLine(line, d < 0);
  renderAll();
}
function woundClass(op) { const f = op.wounds / op.maxW; return f <= 0.25 ? "crit" : f < 0.5 ? "hurt" : ""; }
export function defaultMoveType(op) {
  const slot1Used = op.used.includes("reposition") || op.used.includes("charge");
  if (!slot1Used) return "reposition";
  if (!op.used.includes("dash")) return "dash";
  return "reposition";
}
export function renderCard() {
  const c = document.getElementById("opcard");
  if (!state.sel || !state.sel.alive) { c.innerHTML = '<span class="hint">Nothing selected.</span>'; return; }
  const inj = isInjured(state.sel);
  const meleeFoes = OPS.filter(o => o.alive && o.team !== state.sel.team && opGap(state.sel, o) <= CTRL);
  const repoUsed = state.sel.used.includes("reposition"), dashUsed = state.sel.used.includes("dash"), chargeUsed = state.sel.used.includes("charge");
  const slot1Used = repoUsed || chargeUsed;
  c.innerHTML = `
    <div class="opname" style="color:${TEAMCOL_LT[state.sel.team]}">${state.sel.id} · ${state.sel.name} <span class="tag">${state.sel.kind}</span>
      ${inj ? '<span class="tag warn">injured</span>' : ''} ${state.sel.ready ? '' : '<span class="tag">expended</span>'}</div>
    <div class="stats">
      <div><div class="v">${state.sel.apl}</div><div class="k">APL</div></div>
      <div><div class="v">${fmtIn(RULES.moves.primary.allow(state.sel))}"</div><div class="k">Move</div></div>
      <div><div class="v">${state.sel.save}+</div><div class="k">Save</div></div>
      <div><div class="v">${state.sel.wounds}/${state.sel.maxW}</div><div class="k">Wounds</div></div>
      <div><div class="v">${state.sel.ap}</div><div class="k">AP left</div></div>
      <div><div class="v" title="Two movements per activation: &#9312; ${RULES.moves.primary.label}${RULES.moves.charge ? " (or " + RULES.moves.charge.label + ")" : ""} and &#9313; ${RULES.moves.secondary.label}">${slot1Used?"○":"●"}${dashUsed?"○":"●"}</div><div class="k">Moves</div></div>
    </div>
    <div class="woundbar"><i class="${woundClass(state.sel)}" style="width:${100*state.sel.wounds/state.sel.maxW}%"></i></div>
    <div class="btnrow woundbtns">
      <button class="mini" id="wdn" title="Take 1 damage (logged)">−1 W</button>
      <button class="mini" id="wup" title="Recover 1 wound (logged)" ${state.sel.wounds >= state.sel.maxW ? "disabled" : ""}>+1 W</button>
    </div>
    <div class="btnrow">
      ${RULES.orders ? `<button id="ordbtn">${state.sel.order === "conceal" ? "◖ Conceal" : "▲ Engage"}</button>` : ""}
      <button id="endact">End activation</button>
    </div>
    <div class="weapons">${state.sel.weapons.map(k => {
      const w = WPN[k];
      return `<label><input type="radio" name="wpn" value="${k}" ${state.sel.weapon===k?"checked":""}>
        <span class="wname">${w.type==="R"?"⌖":"⚔"} ${w.name}</span>
        <span class="wstat">${w.atk}A ${effHit(state.sel,w)}+ ${w.dmgN}/${w.dmgC}${w.rules.length?" · "+w.rules.join(","):""}</span></label>`;
    }).join("")}</div>
    <div class="btnrow">${moveButtons(repoUsed, dashUsed, chargeUsed)}</div>
    <div class="btnrow">
      <button id="tgtbtn" class="${state.mode==='target'?'active':''}">Target ⌖</button>
      <button id="shootbtn" ${(!state.target || !state.lastShot || !SHOT_KINDS[state.lastShot.kind].valid || cannotShoot(selEye()) || WPN[state.sel.weapon].type!=="R") ? "disabled" : ""}>Shoot 1AP</button>
      <button id="fightbtn" ${meleeFoes.length ? "" : "disabled"}>Fight 1AP</button>
    </div>`;
  if (RULES.orders) c.querySelector("#ordbtn").onclick = () => { snapshot(); state.sel.order = state.sel.order === "conceal" ? "engage" : "conceal"; refreshSight(); renderAll(); };
  c.querySelector("#endact").onclick = () => endActivation(state.sel);
  c.querySelectorAll("input[name=wpn]").forEach(r => r.onchange = () => { state.sel.weapon = r.value; refreshSight(); renderAll(); });
  c.querySelector("#wdn").onclick = () => adjustWounds(state.sel, -1);
  c.querySelector("#wup").onclick = () => adjustWounds(state.sel, +1);
  for (const t of ["reposition", "dash", "charge"]) {
    if (!moveSpec(t)) continue;
    c.querySelector("#mv-" + t).onclick = () => {
      state.moveType = t;
      const label = moveSpec(t).label;
      if (state.sel && state.sel.used.includes(t))
        hint(`${label} already used this activation — dragging again would repeat it (players adjudicate).`);
      else
        hint(`${label} selected — drag ${state.sel ? state.sel.name : "an operative"} to move (${fmtIn(allowance())}" allowance).`);
      renderCard();
    };
  }
  c.querySelector("#tgtbtn").onclick = () => { state.mode = state.mode === "target" ? null : "target";
    hint(state.mode === "target" ? "Click an enemy operative to judge line of sight." : HINT0); renderAll(); };
  c.querySelector("#shootbtn").onclick = doShoot;
  if (!mayControl(state.sel))    // online: look at the other side's operatives, don't act for them
    c.querySelectorAll("button:not(#tgtbtn), input").forEach(b => { b.disabled = true; });
  c.querySelector("#fightbtn").onclick = () => {
    if (!state.target || opGap(state.sel, state.target) > CTRL) {
      state.target = meleeFoes[0]; refreshSight();
    }
    doFight();
  };
}
export function renderVerdict() {
  const v = document.getElementById("verdict");
  if (!state.sel || !state.target || !state.lastShot || !state.target.alive) {
    v.innerHTML = '<span class="hint">Select an operative, press Target, then click an enemy.</span>'; return;
  }
  const shot = state.lastShot, s = shot.sight, c = s.coverBy, o = s.obscBy;
  let big, cls, why = [];
  if (shot.kind === "engaged") { big = "NOT A VALID TARGET — IN MELEE"; cls = "v-novis";
    why.push(`friendly ${shot.engagedBy.name} is within ${fmtIn(CTRL)}" of it`); }
  else if (shot.kind === "hidden") { big = "NOT VISIBLE"; cls = "v-novis"; why.push("no clear sight line — blocked by terrain"); }
  else {
    if (shot.kind === "obscured") { big = "VALID — OBSCURED"; cls = "v-obsc";
      why.push(`heavy terrain ${o.id} crosses a cover line more than ${fmtIn(RULES.obscure.fromShooter)}" from the shooter and ${fmtIn(RULES.obscure.fromTarget)}" from the target → one success discarded, crits count as normal`);
      if (c) why.push(`also in cover behind ${c.id}${shot.vantage ? " (conceal order, seen past from a Vantage Point)" : ""} → cover save`); }
    else if (shot.kind === "concealed") { big = "NOT A VALID TARGET"; cls = "v-novis";
      why.push(`conceal order + in cover behind ${c.id}${s.hardCover ? " (heavy)" : ""}`); }
    else if (shot.kind === "cover") { big = "VALID — IN COVER"; cls = "v-cover";
      why.push(shot.vantage
        ? `conceal order, but shot down from a Vantage Point past light cover (${c.id}) → cover save`
        : `${c.id} intervenes within ${fmtIn(RULES.cover.range)}" of target → cover save`); }
    else { big = "VALID TARGET"; cls = "v-valid"; why.push("clear shot — no cover, not obscured"); }
    if (shot.accurate) why.push(`from a Vantage Point: Accurate ${shot.accurate}`);
    if (RULES.orders && state.target.order === "conceal" && !c && shot.kind === "clear") why.push("conceal order but no cover — still targetable");
    if (RULES.cover.voidWithin > 0 && s.gap <= RULES.cover.voidWithin) why.push(`within ${fmtIn(RULES.cover.voidWithin)}": no cover, no obscuring`);
  }
  why.push(`range ${Math.max(0, s.gap).toFixed(1)}" base-to-base`);
  const no = cannotShoot(selEye());
  const head = no ? `<div class="why"><b>${state.sel.name} can't Shoot</b> — ${noShootWhy(no)}</div>` : "";
  v.innerHTML = `${head}<div class="big ${cls}">${big}</div><div class="why">${state.sel.name} → ${state.target.name} · ${why.join(" · ")}</div>`;
}
// the selected operative as a shooter, where it stands
const selEye = () => ({x: state.sel.x, y: state.sel.y, team: state.sel.team, op: state.sel});
// why an operative can't take a Shoot action at all
const noShootWhy = n => n.why === "conceal" ? "it is on Conceal" : `within control range of ${n.by.name}`;
// one short reason per judgement, for the valid-shots list and the log
function shotWhy(s) {
  const c = s.sight.coverBy, o = s.sight.obscBy, acc = s.accurate ? `; Accurate ${s.accurate} from a Vantage Point` : "";
  if (s.kind === "clear") return "no cover, not obscured";
  if (s.kind === "cover") return s.vantage ? `on Conceal behind ${c.id}, seen past from a Vantage Point` : `${c.id} within ${fmtIn(RULES.cover.range)}″ of it${acc}`;
  if (s.kind === "obscured") return `heavy terrain ${o.id} in the way${c ? `; also in cover (${c.id})` : ""}`;
  if (s.kind === "concealed") return `on Conceal, in cover (${c.id})`;
  if (s.kind === "engaged") return `in melee with ${s.engagedBy.name}`;
  return "every line blocked by walls or heavy terrain";
}

// The valid-shots summary: every enemy from the selected operative (or its landing spot
// while dragging), valid targets first. Rewritten only when the text changes.
const SHOT_ORDER = ["clear", "cover", "obscured", "engaged", "concealed", "hidden"];
export function renderShots(eye) {
  const box = document.getElementById("shots");
  if (!box) return;
  let html;
  if (!eye) html = state.drag && state.drag.active
    ? '<span class="hint">No legal landing spot — no shots to show.</span>'
    : '<span class="hint">Select or drag an operative to see what it could shoot.</span>';
  else {
    const list = [...shotsFrom(eye)].sort((p, q) => SHOT_ORDER.indexOf(p.kind) - SHOT_ORDER.indexOf(q.kind) || p.range - q.range);
    const valid = list.filter(s => SHOT_KINDS[s.kind].valid).length, no = cannotShoot(eye);
    html = `<div class="shothead">${eye.op.name}${eye.landing ? " at the landing spot" : ""} · ` +
      `<b>${valid}</b> valid target${valid === 1 ? "" : "s"} of ${list.length}` +
      `${no ? ` · <b>can't Shoot</b>: ${noShootWhy(no)}` : ""}</div><ul class="shotlist">` +
      list.map(s => `<li data-shot="${s.kind}" data-oid="${s.target.id}"><i style="background:${SHOT_COL[s.kind]}"></i>` +
        `<b>${s.target.id} ${s.target.name}</b> <span class="k-${s.kind}">${SHOT_KINDS[s.kind].label}</span>` +
        `${s.kind === "hidden" ? "" : ` · ${s.range.toFixed(1)}″`}<span class="why"> — ${shotWhy(s)}</span></li>`).join("") + "</ul>";
  }
  if (box._html !== html) { box.innerHTML = html; box._html = html; }
}

/* ---------- interaction ---------- */
export function allowance() {
  if (!state.sel) return 0;
  const spec = moveSpec(state.moveType) || RULES.moves.primary;
  return spec.allow(state.sel);
}
// Mark an operative expended: its activation is over for this turning point.
export function endActivation(op) {
  if (!op || !op.alive || !op.ready || !mayControl(op)) return;
  snapshot(); op.ready = false; op.ap = op.apl; op.used = [];
  if (state.sel === op) state.moveType = "reposition";
  logLine(`<b>${op.name}</b> activation ends.`); cancelMode(); renderAll();
}
// Something to undo: the operative has acted, or is expended.
export const canUndoActivation = op => !!op && op.alive && (!untouched(op) || orderChanged(op));
// Put an operative back as it was when its activation began: where it stood, its order,
// ready with full AP. Wounds stay as they are (they may come from the other side).
export function undoActivation(op) {
  if (!canUndoActivation(op) || !mayControl(op)) return;
  const st = actStart.get(op.id), here = st && st.tp === tray.tp;
  snapshot();
  if (here) { op.x = st.x; op.y = st.y; op.z = st.z; if (RULES.orders) op.order = st.order; }
  op.ready = true; op.ap = op.apl; op.used = [];
  if (state.sel === op) state.moveType = "reposition";
  logLine(`<b>${op.name}</b> activation undone${here ? " — back where it started" : ""}, ready again.`);
  cancelMode(); refreshSight(); renderAll();
}
// Take an operative off the table as incapacitated (down = true), or put it back (with at
// least 1 wound) if that was a mistake: where it was, or the nearest spot within 3" where its
// base fits (someone may have moved in meanwhile); if there's none it stays down.
export function setIncapacitated(op, down) {
  if (!op || op.alive !== down || !mayControl(op)) return;
  let spot = null;
  if (!down) {
    useBase(opR(op));
    spot = nearestFree(op.x, op.y, op.id, opLayer(op), 3);
    if (!spot) { logLine(`No room to put <b>${op.name}</b> back where it was — clear the spot first.`); return; }
  }
  snapshot();
  op.alive = !down;
  if (down) {
    if (state.sel === op) state.sel = null;
    if (state.target === op) state.target = null;
    logLine(`<b>${op.name}</b> is incapacitated — off the table.`, true);
  } else {
    const moved = Math.hypot(spot[0] - op.x, spot[1] - op.y) > 1e-6;
    op.x = spot[0]; op.y = spot[1];
    op.wounds = Math.max(1, op.wounds);
    logLine(`<b>${op.name}</b> is back on the table (${op.wounds}W)${moved ? ", moved aside: its spot was taken" : ""}.`);
  }
  cancelMode(); refreshSight(); renderAll();
}
export function cancelMode() { state.mode = null; state.drag = null; state.rulerPts = []; hint(HINT0); }
// Judge the shot at the chosen target from where the selected operative stands.
export function refreshSight() {
  state.lastShot = state.sel && state.target && state.target.alive
    ? judgeShot(selEye(), state.target) : null;
}
export function toggleOrder(oid) {
  const o = OPS.find(z => z.id === oid);
  if (!o || !o.alive || !mayControl(o)) return;
  snapshot();
  o.order = o.order === "conceal" ? "engage" : "conceal";
  refreshSight();
  logLine(`<b>${o.name}</b> order: ${o.order === "conceal" ? "◖ Conceal" : "▲ Engage"}.`);
  hint(`${o.name} is now on ${o.order === "conceal" ? "Conceal (dome token — safe in cover, can't shoot/charge)" : "Engage (starburst token + hot glow — can shoot and charge)"}.`);
  renderAll();
}
