/**
 * The board overlay (HUD): a thin ribbon across the top of the table with one square per
 * operative for each side (ready, activating, expended, injured, incapacitated), and a small
 * score bug at the bottom (VP, CP, turning point) that opens the score sheet.
 *
 *   - hover a square: the operative's name, profile and weapons
 *   - click a square: select that operative and flash a pillar of light on it
 *   - click the score bug: Crit / Tac / Kill VP per turning point, CP, and kills so far
 * It reads and writes the same state as the Battle tray and the Ops & score panel.
 */
import { state } from '../state.js';
import { TEAMCOL, TEAMCOL_LT, TEAMNAME, WPN } from '../config.js';
import { effHit, effMove, isInjured } from '../engine/dice.js';
import { OPS } from '../engine/world.js';
import { mayPlay } from '../net/sync.js';
import { RULES, fmtIn } from '../rules/index.js';
import { flashOp3D } from '../view3d/table3d.js';
import { modelIndex, teamOf } from '../view3d/units.js';
import { flashOp2D, renderAll } from './board.js';
import { capName, logLine } from './dom.js';
import { cancelMode, defaultMoveType, snapshot, tray } from './panels.js';
import { mayScore, opsState, scoreTotal, setScore } from './ops.js';

const COLS = ["Crit", "Tac", "Kill"];
let sheetOpen = false;

const teamName = s => (teamOf(s) && teamOf(s).name) || TEAMNAME[s];
const modelName = op => {
  const t = teamOf(op.team);
  return t && t.models.length ? t.models[modelIndex(op, t.models.length)].name : null;
};
// activating: selected and still ready, or part-way through its actions
const activating = op => op.alive && op.ready && ((state.sel && state.sel.id === op.id) || op.used.length > 0);
const status = op => !op.alive ? "dead" : activating(op) ? "active" : op.ready ? "ready" : "spent";
const STATUS_LABEL = { ready: "Ready", active: "Activating", spent: "Expended", dead: "Incapacitated" };
const kills = s => OPS.filter(o => o.team !== s && !o.alive).length;
const esc = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/* ---------- top ribbon ---------- */
// a circle per operative: a pie of its wounds left (a sliver at the least while it stands),
// in the team colour while ready, grey once expended; a soft cross once it's down
const SOFT_X = '<svg class="hx" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 3l4 4M7 3l-4 4"/></svg>';
function square(op) {
  const st = status(op), hp = op.alive ? Math.max(0.08, op.wounds / op.maxW) : 0;
  return `<button class="hsq ${st}${state.sel && state.sel.id === op.id ? " sel" : ""}" data-oid="${op.id}" ` +
    `style="--tc:${TEAMCOL[op.team]};--hp:${hp.toFixed(3)}" ` +
    `aria-label="${esc(`${op.id} ${op.name}, ${STATUS_LABEL[st]}${op.alive ? `, ${op.wounds}/${op.maxW} wounds` : ""}`)}">` +
    (st === "dead" ? SOFT_X : "") + `</button>`;
}
function side(s) {
  const ops = OPS.filter(o => o.team === s), left = ops.filter(o => o.alive && o.ready).length;
  return `<div class="hside s${s}"><span class="hname" style="color:${TEAMCOL_LT[s]}">${esc(teamName(s))}</span>` +
    `<span class="hsqs">${ops.map(square).join("")}</span><span class="hleft">${left} left</span></div>`;
}

/* ---------- hover card: who it is and its rules ---------- */
function tipHTML(op) {
  const st = status(op), model = modelName(op), inj = op.alive && isInjured(op);
  const stats = [["APL", op.apl], ["Move", fmtIn(RULES.moves.primary.allow(op)) + "″"], ["Save", op.save + "+"], ["Wounds", `${op.wounds}/${op.maxW}`]];
  const weapons = op.weapons.map(k => {
    const w = WPN[k];
    return `<div class="tw"><span>${w.type === "R" ? "⌖" : "⚔"} ${esc(w.name)}</span>` +
      `<span>${w.atk}A ${effHit(op, w)}+ ${w.dmgN}/${w.dmgC}${w.rules.length ? " · " + esc(w.rules.join(", ")) : ""}</span></div>`;
  }).join("");
  const notes = [];
  if (RULES.orders && op.alive) notes.push(op.order === "conceal" ? "◖ Conceal: can't Shoot or Charge; safe in cover" : "▲ Engage: can Shoot and Charge");
  if (inj) notes.push(`Injured (under half wounds): move ${fmtIn(effMove(op))}″, worse hit rolls`);
  if (op.alive && op.used.length) notes.push("Used: " + op.used.map(capName).join(", "));
  return `<div class="tn" style="color:${TEAMCOL_LT[op.team]}">${esc(op.id)} · ${esc(op.name)}</div>` +
    `<div class="tk">${esc(model || capName(op.kind))}${model ? " · " + esc(op.kind) : ""} · <b class="${st}">${STATUS_LABEL[st]}</b></div>` +
    `<div class="ts">${stats.map(([k, v]) => `<span><b>${v}</b> ${k}</span>`).join("")}</div>${weapons}` +
    (notes.length ? `<div class="tnote">${notes.map(esc).join("<br>")}</div>` : "");
}
function showTip(btn) {
  const op = OPS.find(o => o.id === btn.dataset.oid), tip = document.getElementById("hudtip");
  if (!op || !tip) return;
  tip.innerHTML = tipHTML(op);
  tip.hidden = false;
  const stage = tip.parentElement.getBoundingClientRect(), b = btn.getBoundingClientRect();
  const x = Math.max(4, Math.min(stage.width - tip.offsetWidth - 4, b.left - stage.left + b.width / 2 - tip.offsetWidth / 2));
  tip.style.left = x + "px";
  tip.style.top = (b.bottom - stage.top + 6) + "px";
}
const hideTip = () => { const t = document.getElementById("hudtip"); if (t) t.hidden = true; };

/* ---------- bottom score bug and sheet ---------- */
function bug() {
  return `<button class="hbug" id="hudbug" aria-expanded="${sheetOpen}" title="Score sheet: Crit, Tac and Kill VP per turning point, and CP">` +
    `<span class="hcp">${tray.cp[0]} CP</span>` +
    `<span class="hvp"><b style="color:${TEAMCOL_LT[0]}">${tray.vp[0]}</b><i>–</i><b style="color:${TEAMCOL_LT[1]}">${tray.vp[1]}</b></span>` +
    `<span class="hcp">${tray.cp[1]} CP</span><span class="htp">TP ${tray.tp}</span></button>`;
}
function sheet() {
  const dis = ok => ok ? "" : " disabled";
  const head = s => COLS.map(c => `<th>${c}</th>`).join("");
  const rows = [0, 1, 2, 3].map(tp => `<tr class="${tp + 1 === tray.tp ? "now" : ""}"><th>TP${tp + 1}</th>${[0, 1].map(s => COLS.map((_, c) =>
    `<td><input type="number" min="0" max="9" class="hudvp" data-s="${s}" data-tp="${tp}" data-c="${c}" value="${opsState.score[s][tp][c] || ""}"${dis(mayScore(s))}></td>`).join("")).join("")}</tr>`).join("");
  const cp = s => `<div class="hcpctl"><span style="color:${TEAMCOL_LT[s]}">${esc(teamName(s))}</span>` +
    `<button class="mini" data-cp="${s}" data-d="-1" aria-label="Spend 1 CP"${dis(mayPlay())}>−</button><b>${tray.cp[s]} CP</b>` +
    `<button class="mini" data-cp="${s}" data-d="1" aria-label="Gain 1 CP"${dis(mayPlay())}>+</button>` +
    `<span class="hkills" title="Enemy operatives incapacitated (the Kill Op counts these)">✕ ${kills(s)} kill${kills(s) === 1 ? "" : "s"}</span></div>`;
  return `<div class="hsheethead"><b>Score sheet</b><button class="mini" id="hudclose" aria-label="Close">×</button></div>
    <div class="hcprow">${cp(0)}${cp(1)}</div>
    <table class="hscore"><thead>
      <tr><th></th><th colspan="3" style="color:${TEAMCOL_LT[0]}">${esc(teamName(0))}</th><th colspan="3" style="color:${TEAMCOL_LT[1]}">${esc(teamName(1))}</th></tr>
      <tr><th></th>${head(0)}${head(1)}</tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><th>VP</th><td colspan="3"><b>${scoreTotal(0)}</b></td><td colspan="3"><b>${scoreTotal(1)}</b></td></tr></tfoot></table>
    <div class="hint">Kill VP from the Kill Op card; the ✕ count above is enemy operatives down so far.</div>`;
}

/* ---------- render and wiring ---------- */
export function renderHud() {
  const top = document.getElementById("hudtop"), bot = document.getElementById("hudbot"), sh = document.getElementById("hudsheet");
  if (!top) return;
  // only rewrite what changed, so a hover or a focused score box isn't lost on every render
  const t = `${side(0)}<span class="hmid">TP ${tray.tp}</span>${side(1)}`;
  if (top._html !== t) { top.innerHTML = t; top._html = t; }
  const b = bug();
  if (bot._html !== b) { bot.innerHTML = b; bot._html = b; }
  sh.hidden = !sheetOpen;
  if (sheetOpen && !sh.contains(document.activeElement)) sh.innerHTML = sheet();
}
// pick an operative from the ribbon, as clicking it on the table does, and show where it is
function pick(oid) {
  const op = OPS.find(o => o.id === oid);
  if (!op) return;
  if (op.alive) {
    state.sel = op; state.target = null; state.lastShot = null; state.moveType = defaultMoveType(op); cancelMode();
    renderAll();
  }
  flashOp(op);
}
export function flashOp(op) { flashOp2D(op); flashOp3D(op); }

export function wireHud() {
  const top = document.getElementById("hudtop"), bot = document.getElementById("hudbot"), sh = document.getElementById("hudsheet");
  top.addEventListener("click", ev => { const b = ev.target.closest(".hsq"); if (b) pick(b.dataset.oid); });
  top.addEventListener("pointerover", ev => { const b = ev.target.closest(".hsq"); if (b) showTip(b); });
  top.addEventListener("pointerout", ev => { if (ev.target.closest(".hsq")) hideTip(); });
  top.addEventListener("focusin", ev => { const b = ev.target.closest(".hsq"); if (b) showTip(b); });
  top.addEventListener("focusout", hideTip);
  bot.addEventListener("click", ev => { if (ev.target.closest("#hudbug")) { sheetOpen = !sheetOpen; renderHud(); } });
  sh.addEventListener("click", ev => {
    if (ev.target.closest("#hudclose")) { sheetOpen = false; renderHud(); return; }
    const b = ev.target.closest("[data-cp]");
    if (!b || !mayPlay()) return;
    const s = +b.dataset.cp, d = +b.dataset.d;
    if (tray.cp[s] + d < 0) return;
    snapshot(); tray.cp[s] += d;
    logLine(`<b>${esc(teamName(s))}</b> ${d > 0 ? "gains" : "spends"} 1CP (${tray.cp[s]} left).`);
    sh.innerHTML = sheet(); renderAll();
  });
  sh.addEventListener("change", ev => {
    const e = ev.target.closest(".hudvp");
    if (!e) return;
    setScore(+e.dataset.s, +e.dataset.tp, +e.dataset.c, e.value);
    sh.innerHTML = sheet();
  });
  document.addEventListener("keydown", ev => { if (ev.key === "Escape" && sheetOpen) { sheetOpen = false; renderHud(); } });
}
