/**
 * Side panels (operative card, verdict, tray), actions (shoot, fight, undo) and UI state.
 */
import { state } from '../state.js';
import { CTRL, TEAMCOL_LT, WPN } from '../config.js';
import { effHit, isInjured, rollAttack, rollDefence } from '../engine/dice.js';
import { opGap } from '../engine/geometry.js';
import { SHOT_KINDS, judgeShot, shotsFrom } from '../engine/shots.js';
import { OPS } from '../engine/world.js';
import { SHOT_COL, renderAll } from './board.js';
import { HINT0, fmtDice, hint, logLine } from './dom.js';
import { RULES, fmtIn, moveSpec } from '../rules/index.js';
import { mayControl } from '../net/sync.js';
import { showRoll } from './dicetray.js';

/* ---------- state / undo / log ---------- */
export let tray = {tp:1, cp:[3,3], vp:[0,0]};
export const undoStack = [];
// other modules' state that undo restores too ({get, set}; the ops & score panel)
export const undoExtras = [];
export function snapshot() {
  undoStack.push(JSON.stringify({ops:OPS, tray, extras: undoExtras.map(x => x.get())}));
  if (undoStack.length > 40) undoStack.shift();
}
export function doUndo() {
  const s = undoStack.pop(); if (!s) return;
  const o = JSON.parse(s); OPS.splice(0, OPS.length, ...o.ops); Object.assign(tray, o.tray);
  if (o.extras) undoExtras.forEach((x, i) => { if (o.extras[i] !== undefined) x.set(o.extras[i]); });
  if (state.sel) state.sel = OPS.find(x => x.id === state.sel.id) || null;
  state.target = null; state.lastShot = null; cancelMode();
  logLine("Undid last action.");
  renderAll();
}

/* ---------- combat ---------- */
function doShoot() {
  if (!state.sel || !state.target) return;
  const w = WPN[state.sel.weapon];
  if (w.type !== "R") { logLine("Selected weapon is melee — use Fight."); return; }
  refreshSight();                        // judge it as things stand now, not when targeted
  const shot = state.lastShot;
  if (!shot || !SHOT_KINDS[shot.kind].valid) {
    logLine(`<b>${state.target.name}</b> is not a valid target — ${shot ? shotWhy(shot) : "no target"}.`);
    renderAll(); return;
  }
  snapshot();
  const a = rollAttack(w.atk, effHit(state.sel, w), w.rules);
  showRoll(a.dice, effHit(state.sel, w), state.sel.team, `${state.sel.name} shoots`);
  let aCrit = a.crit, aNorm = a.norm, notes = [];
  // in cover keeps its cover save, also when Vantage or Indirect made it a valid target
  const dfn = rollDefence(state.target.save, shot.inCover);
  if (dfn.cover) notes.push("cover save banked");
  let dCrit = dfn.crit, dNorm = dfn.norm;
  // resolve defence: crits block crits first, then normals; two normals stop a crit
  while (dCrit > 0) { if (aCrit > 0) {aCrit--; dCrit--;} else if (aNorm > 0) {aNorm--; dCrit--;} else break; }
  while (dNorm > 0) {
    if (aNorm > 0) {aNorm--; dNorm--;}
    else if (dNorm >= 2 && aCrit > 0) {aCrit--; dNorm -= 2;}
    else break;
  }
  const dmg = aNorm * w.dmgN + aCrit * w.dmgC;
  state.target.wounds = Math.max(0, state.target.wounds - dmg);
  state.sel.ap -= 1; state.sel.used.push("shoot");
  let line = `<b>${state.sel.name}</b> shoots <b>${state.target.name}</b> with ${w.name} — ` +
    `<span class="dice">atk [${fmtDice(a.dice)}] def [${fmtDice(dfn.dice)}${dfn.cover?" +cover":""}]</span> → ` +
    `<b>${dmg} dmg</b>${notes.length ? " <span class='dice'>("+notes.join("; ")+")</span>" : ""}`;
  if (state.target.wounds === 0) { state.target.alive = false; line += " — <b>incapacitated!</b>"; }
  else if (isInjured(state.target)) line += " — injured";
  logLine(line, dmg > 0);
  cancelMode(); renderAll();
}
function doFight() {
  if (!state.sel || !state.target) return;
  const gap = opGap(state.sel, state.target);
  if (gap > CTRL) { logLine(`Target is not within control range (${fmtIn(CTRL)}&Prime;).`); return; }
  const wa = WPN[state.sel.weapon].type === "M" ? WPN[state.sel.weapon] : WPN[state.sel.weapons.find(k => WPN[k].type==="M")] || WPN.knife;
  const wb = WPN[state.target.weapons.find(k => WPN[k].type==="M")] || WPN.knife;
  snapshot();
  const ra = rollAttack(wa.atk, effHit(state.sel, wa), wa.rules);
  const rb = rollAttack(wb.atk, effHit(state.target, wb), wb.rules);
  showRoll(ra.dice, effHit(state.sel, wa), state.sel.team, `${state.sel.name} fights`);
  // alternate resolution, both always strike (crits first), attacker starts
  let pools = [ {op:state.sel, foe:state.target, w:wa, crit:ra.crit, norm:ra.norm},
                {op:state.target, foe:state.sel, w:wb, crit:rb.crit, norm:rb.norm} ];
  let i = 0, guard = 0;
  while ((pools[0].crit+pools[0].norm > 0 || pools[1].crit+pools[1].norm > 0) && guard++ < 30) {
    const p = pools[i % 2];
    if (p.crit + p.norm > 0 && p.op.alive) {
      let dmg;
      if (p.crit > 0) { p.crit--; dmg = p.w.dmgC; } else { p.norm--; dmg = p.w.dmgN; }
      p.foe.wounds = Math.max(0, p.foe.wounds - dmg);
      if (p.foe.wounds === 0) { p.foe.alive = false; break; }
    }
    i++;
  }
  state.sel.ap -= 1; state.sel.used.push("fight");
  let line = `<b>${state.sel.name}</b> fights <b>${state.target.name}</b> — ` +
    `<span class="dice">${state.sel.name} [${fmtDice(ra.dice)}] vs ${state.target.name} [${fmtDice(rb.dice)}]</span> → ` +
    `${state.sel.name} ${state.sel.wounds}W, ${state.target.name} ${state.target.wounds}W`;
  if (!state.target.alive) line += ` — <b>${state.target.name} down!</b>`;
  if (!state.sel.alive) line += ` — <b>${state.sel.name} down!</b>`;
  logLine(line, true);
  cancelMode(); renderAll();
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
      <button id="shootbtn" ${(!state.target || !state.lastShot || !SHOT_KINDS[state.lastShot.kind].valid || WPN[state.sel.weapon].type!=="R") ? "disabled" : ""}>Shoot 1AP</button>
      <button id="fightbtn" ${meleeFoes.length ? "" : "disabled"}>Fight 1AP</button>
    </div>`;
  if (RULES.orders) c.querySelector("#ordbtn").onclick = () => { state.sel.order = state.sel.order === "conceal" ? "engage" : "conceal"; refreshSight(); renderAll(); };
  c.querySelector("#endact").onclick = () => { snapshot(); state.sel.ready = false; state.sel.ap = state.sel.apl; state.sel.used = []; state.moveType = "reposition"; logLine(`<b>${state.sel.name}</b> activation ends.`); cancelMode(); renderAll(); };
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
  if (shot.kind === "hidden") { big = "NOT VISIBLE"; cls = "v-novis"; why.push("no clear sight line — blocked by terrain"); }
  else {
    if (shot.kind === "obscured") { big = "NOT A VALID TARGET — OBSCURED"; cls = "v-obsc";
      why.push(`heavy terrain ${o.id} crosses a cover line more than ${fmtIn(RULES.obscure.fromShooter)}" from the shooter and ${fmtIn(RULES.obscure.fromTarget)}" from the target`); }
    else if (shot.kind === "concealed") { big = "NOT A VALID TARGET"; cls = "v-novis"; why.push(`conceal order + in cover behind ${coverName(c)}`); }
    else if (shot.kind === "engaged") { big = "NOT A VALID TARGET — IN MELEE"; cls = "v-novis";
      why.push(`friendly ${shot.engagedBy.name} is within ${fmtIn(CTRL)}" of it`); }
    else if (shot.kind === "cover") { big = "VALID — IN COVER"; cls = "v-cover"; why.push(`${coverName(c)} intervenes within ${fmtIn(RULES.cover.range)}" of target → cover save`); }
    else { big = "VALID TARGET"; cls = "v-valid"; why.push("clear shot — no cover, not obscured"); }
    if (shot.vantage) why.push(`conceal order, but shot down from a Vantage Point over light cover: counts as Engage, keeps its cover save`);
    if (shot.indirect) why.push(`conceal order, but the Indirect weapon ignores cover for targeting: cover save still applies`);
    if (RULES.orders && state.target.order === "conceal" && !c) why.push("conceal order but no cover — still targetable");
    if (shot.kind === "engaged" && c) why.push(`in cover behind ${coverName(c)}`);
    if (RULES.cover.voidWithin > 0 && s.gap <= RULES.cover.voidWithin) why.push(`within ${fmtIn(RULES.cover.voidWithin)}": cover is void`);
  }
  why.push(`range ${Math.max(0, s.gap).toFixed(1)}" base-to-base`);
  v.innerHTML = `<div class="big ${cls}">${big}</div><div class="why">${state.sel.name} → ${state.target.name} · ${why.join(" · ")}</div>`;
}
// what gives cover: a terrain piece by name, or another operative's base
const coverName = c => c.kind === "operative" ? `${c.id}'s base` : c.id;
// one short reason per judgement, for the valid-shots list and the log
function shotWhy(s) {
  const c = s.sight.coverBy, o = s.sight.obscBy;
  const exc = s.vantage ? "; on Conceal, but shot from a Vantage Point" : s.indirect ? "; on Conceal, but the weapon is Indirect" : "";
  if (s.kind === "clear") return "no cover, not obscured";
  if (s.kind === "cover") return `${coverName(c)} within ${fmtIn(RULES.cover.range)}″ of it${exc}`;
  if (s.kind === "obscured") return `heavy terrain ${o.id} in the way`;
  if (s.kind === "concealed") return `on Conceal, in cover (${coverName(c)})`;
  if (s.kind === "engaged") return `in melee with ${s.engagedBy.name}`;
  return "every line blocked by walls or heavy terrain";
}

// The valid-shots summary: every enemy from the selected operative (or its landing spot
// while dragging), valid targets first. Rewritten only when the text changes.
const SHOT_ORDER = ["clear", "cover", "engaged", "concealed", "obscured", "hidden"];
export function renderShots(eye) {
  const box = document.getElementById("shots");
  if (!box) return;
  let html;
  if (!eye) html = state.drag && state.drag.active
    ? '<span class="hint">No legal landing spot — no shots to show.</span>'
    : '<span class="hint">Select or drag an operative to see what it could shoot.</span>';
  else {
    const list = [...shotsFrom(eye)].sort((p, q) => SHOT_ORDER.indexOf(p.kind) - SHOT_ORDER.indexOf(q.kind) || p.range - q.range);
    const valid = list.filter(s => SHOT_KINDS[s.kind].valid).length;
    html = `<div class="shothead">${eye.op.name}${eye.landing ? " at the landing spot" : ""} · ` +
      `<b>${valid}</b> valid target${valid === 1 ? "" : "s"} of ${list.length}</div><ul class="shotlist">` +
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
export function cancelMode() { state.mode = null; state.drag = null; state.rulerPts = []; hint(HINT0); }
// Judge the shot at the chosen target from where the selected operative stands, with its
// selected weapon (Indirect matters).
export function refreshSight() {
  state.lastShot = state.sel && state.target && state.target.alive
    ? judgeShot({x: state.sel.x, y: state.sel.y, team: state.sel.team, op: state.sel}, state.target) : null;
}
export function toggleOrder(oid) {
  const o = OPS.find(z => z.id === oid);
  if (!o || !o.alive || !mayControl(o)) return;
  o.order = o.order === "conceal" ? "engage" : "conceal";
  refreshSight();
  logLine(`<b>${o.name}</b> order: ${o.order === "conceal" ? "◖ Conceal" : "▲ Engage"}.`);
  hint(`${o.name} is now on ${o.order === "conceal" ? "Conceal (dome token — safe in cover, can't shoot/charge)" : "Engage (starburst token + hot glow — can shoot and charge)"}.`);
  renderAll();
}
