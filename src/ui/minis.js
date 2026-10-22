/**
 * Miniatures panel: per side, a Kill Team from the Steam Workshop team mods, then a model
 * for each operative. Picking a team loads its models from Steam (src/view3d/units.js).
 */
import { TTS_TEAMS } from '../data/tts-teams.js';
import { TEAMCOL, TEAMNAME } from '../config.js';
import { OPS } from '../engine/world.js';
import { modelIndex, setPick, setTeam, teamOf } from '../view3d/units.js';
import { mayControl } from '../net/sync.js';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function renderMinis() {
  const box = document.getElementById("minis");
  if (!box) return;
  let html = "";
  for (const side of [0, 1]) {
    const team = teamOf(side);
    const off = mayControl({ team: side }) ? "" : " disabled";   // online: each player picks their own side
    html += `<div class="minirow"><b style="color:${TEAMCOL[side]}">${TEAMNAME[side]}</b>
      <select data-side="${side}" class="miniteam"${off} aria-label="${TEAMNAME[side]} team">
        <option value="">Plain tokens</option>
        ${TTS_TEAMS.map(t => `<option value="${t.id}"${team && team.id === t.id ? " selected" : ""}>${esc(t.name)}</option>`).join("")}
      </select></div>`;
    if (team) {
      html += `<div class="miniops">`;
      for (const op of OPS.filter(o => o.team === side)) {
        const pick = modelIndex(op, team.models.length);
        // the base measured off its model (blank until the model has loaded)
        html += `<label title="Base size, measured off the model">${op.id}${op.base ? ` · ${op.base}mm` : ""} <select data-side="${side}" data-op="${op.id}" class="minipick"${off}>
          ${team.models.map((m, i) => `<option value="${i}"${i === pick ? " selected" : ""}>${esc(m.name)} · ${m.w}W</option>`).join("")}
        </select></label>`;
      }
      html += `</div>`;
    }
  }
  html += `<div class="hint">Models load from the Steam Workshop team mods into this browser; this site doesn't host them.</div>`;
  box.innerHTML = html;
  box.querySelectorAll(".miniteam").forEach(s => s.onchange = () => { setTeam(+s.dataset.side, s.value); renderMinis(); });
  box.querySelectorAll(".minipick").forEach(s => s.onchange = () => setPick(+s.dataset.side, s.dataset.op, +s.value));
}
