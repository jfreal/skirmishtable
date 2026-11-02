/**
 * Miniatures panel: per side, a Kill Team from the Steam Workshop team mods, then the
 * side's roster: a model per operative, a button to take one off, and the team's models by
 * name to add more. Picking a team loads its models from Steam (src/view3d/units.js).
 */
import { TTS_TEAMS } from '../data/tts-teams.js';
import { TEAMCOL, TEAMNAME } from '../config.js';
import { MAX_SIDE, OPS, addOp, removeOp } from '../engine/world.js';
import { minis, modelIndex, setPick, setTeam, teamOf } from '../view3d/units.js';
import { mayControl } from '../net/sync.js';
import { state } from '../state.js';
import { renderAll } from './board.js';
import { hint, logLine } from './dom.js';
import { refreshSight, snapshot } from './panels.js';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// a team's models grouped by name, in the mod's order: [{ name, w, idx: [model indexes] }]
export function modelGroups(team) {
  const groups = new Map();
  team.models.forEach((m, i) => {
    if (!groups.has(m.name)) groups.set(m.name, { name: m.name, w: m.w, idx: [] });
    groups.get(m.name).idx.push(i);
  });
  return [...groups.values()];
}

// Add an operative to a side, as the model named `name` (a copy no one on the side uses
// yet, if the mod has one); no team: a plain token.
export function addOperative(side, name) {
  if (!mayControl({ team: side })) return null;
  const team = teamOf(side), g = team && modelGroups(team).find(x => x.name === name);
  snapshot();
  const op = addOp(side, g ? g.name : "Operative");
  if (!op) {
    hint(OPS.filter(o => o.team === side).length >= MAX_SIDE ? `A side fields at most ${MAX_SIDE} operatives.` : `No room left in ${TEAMNAME[side]}'s drop zone.`);
    return null;
  }
  if (g) {
    const used = new Set(OPS.filter(o => o.team === side && o !== op).map(o => modelIndex(o, team.models.length)));
    setPick(side, op.id, g.idx.find(i => !used.has(i)) ?? g.idx[0]);
  } else delete minis.sides[side].picks[op.id];
  logLine(`<b>${esc(op.name)}</b> (${op.id}) joins ${TEAMNAME[side]}.`);
  renderAll(); renderMinis();
  return op;
}
// Take an operative off its side's roster (its model pick stays, so undo brings it back as it was).
export function removeOperative(id) {
  const op = OPS.find(o => o.id === id);
  if (!op || !mayControl(op)) return false;
  if (OPS.filter(o => o.team === op.team).length <= 1) { hint("A side keeps at least one operative."); return false; }
  snapshot();
  removeOp(id);
  if (state.sel && state.sel.id === id) state.sel = null;
  if (state.target && state.target.id === id) state.target = null;
  if (state.drag && state.drag.op && state.drag.op.id === id) state.drag = null;
  refreshSight();
  logLine(`<b>${esc(op.name)}</b> (${op.id}) leaves ${TEAMNAME[op.team]}.`);
  renderAll(); renderMinis();
  return true;
}

export function renderMinis() {
  const box = document.getElementById("minis");
  if (!box) return;
  let html = "";
  for (const side of [0, 1]) {
    const team = teamOf(side), ops = OPS.filter(o => o.team === side);
    const off = mayControl({ team: side }) ? "" : " disabled";   // online: each player picks their own side
    html += `<div class="minirow"><b style="color:${TEAMCOL[side]}">${TEAMNAME[side]}</b>
      <select data-side="${side}" class="miniteam"${off} aria-label="${TEAMNAME[side]} team">
        <option value="">Plain tokens</option>
        ${TTS_TEAMS.map(t => `<option value="${t.id}"${team && team.id === t.id ? " selected" : ""}>${esc(t.name)}</option>`).join("")}
      </select></div>`;
    html += `<div class="miniops">`;
    for (const op of ops) {
      const pick = team && modelIndex(op, team.models.length);
      // the base measured off its model (blank until the model has loaded)
      html += `<div class="miniop"><span class="mid" title="${esc(op.name)}${op.base ? ` · base ${op.base}mm, measured off the model` : ""}">${op.id}${op.base ? ` · ${op.base}mm` : ""}</span>` +
        (team ? `<select data-side="${side}" data-op="${op.id}" class="minipick"${off} aria-label="${op.id} model">
          ${team.models.map((m, i) => `<option value="${i}"${i === pick ? " selected" : ""}>${esc(m.name)} · ${m.w}W</option>`).join("")}
        </select>` : `<span class="mname">${esc(op.name)}</span>`) +
        `<button class="mini minirm" data-op="${op.id}" title="Take ${esc(op.name)} off the roster" aria-label="Remove ${op.id}"${off || (ops.length <= 1 ? " disabled" : "")}>×</button></div>`;
    }
    html += `</div>`;
    // add an operative: the team's models by name (the mod's copies of each counted)
    const full = ops.length >= MAX_SIDE ? " disabled" : "";
    html += `<div class="miniadd"><div class="hint">Add (${ops.length}/${MAX_SIDE})</div>` + (team
      ? modelGroups(team).map(g => `<button class="mini miniaddbtn" data-side="${side}" data-name="${esc(g.name)}"${off || full} ` +
          `title="Add a ${esc(g.name)} (${g.w}W) to ${TEAMNAME[side]}"><span>+ ${esc(g.name)}</span>` +
          `<span class="hint">${g.idx.length > 1 ? `×${g.idx.length} · ` : ""}${g.w}W</span></button>`).join("")
      : `<button class="mini miniaddbtn" data-side="${side}" data-name=""${off || full}><span>+ Operative</span></button>`) + `</div>`;
  }
  html += `<div class="hint">Models load from the Steam Workshop team mods into this browser; this site doesn't host them.</div>`;
  box.innerHTML = html;
  box.querySelectorAll(".miniteam").forEach(s => s.onchange = () => { setTeam(+s.dataset.side, s.value); renderMinis(); });
  box.querySelectorAll(".minipick").forEach(s => s.onchange = () => setPick(+s.dataset.side, s.dataset.op, +s.value));
  box.querySelectorAll(".miniaddbtn").forEach(b => b.onclick = () => addOperative(+b.dataset.side, b.dataset.name));
  box.querySelectorAll(".minirm").forEach(b => b.onclick = () => removeOperative(b.dataset.op));
}
