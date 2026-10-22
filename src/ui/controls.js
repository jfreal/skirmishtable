/**
 * Map loading (UI side), the map picker, tray buttons and the TTS import button.
 */
import { state } from '../state.js';
import { px } from '../engine/geometry.js';
import { FEATS } from '../engine/grid.js';
import { BH, BW, MAP, MAPS, OPS, TERRAIN, buildWorld } from '../engine/world.js';
import { convertGallowdark, convertVolkusBag, findVolkusBags, parseBSON } from '../import/tts.js';
import { buildStatic, renderAll, renderTray } from './board.js';
import { HINT0, hint, logEl, logLine, svg } from './dom.js';
import { cancelMode, doUndo, snapshot, tray, undoStack } from './panels.js';
import { build3DScene, setView, three, view3D } from '../view3d/table3d.js';
import { RULES, RULESETS, fmtIn, setRuleset } from '../rules/index.js';
import { mayPlay, maySetUp, pump, requestUndo } from '../net/sync.js';

// online, only the host sets up the table and only the two players act
const setupOnly = () => { if (maySetUp()) return false; hint("Online, only the host changes the map, rules or resets."); return true; };
const playOnly = () => { if (mayPlay()) return false; hint("You're watching — only the two players can do that."); return true; };

export function loadMap(keyOrMap) {
  buildWorld(typeof keyOrMap === "string" ? MAPS[keyOrMap] : keyOrMap);
  svg.setAttribute("viewBox", `0 0 ${px(BW)} ${px(BH)}`);
  state.sel = null; state.target = null; state.lastShot = null; state.drag = null;
  undoStack.length = 0;
  Object.assign(tray, {tp:1, cp:[3,3], vp:[0,0]});
  cancelMode();
  buildStatic();
  renderAll();
  renderMapButtons();
  if (three) build3DScene();
  const walls = TERRAIN.filter(t => t.kind === "wall").length;
  const hatches = Math.round(TERRAIN.filter(t => t.hatch).length / 2);
  const deploy = MAP.dropEdge === "long" ? 'long-edge deployment, 3" zones' : 'short-edge deployment, ' + (MAP.dropDepth || 6) + '" zones';
  document.getElementById("mapnote").textContent = MAP.fine
    ? `${MAP.name} · ${BW}"×${BH}" · ${deploy} · ${FEATS.length - 1} terrain pieces, footprints traced from the TTS scans at 0.1" — ` +
      `bases fit any doorway, alcove or nook they really fit; blue hatch = upper floor you can stand under` +
      (MAP.source ? ` · ${MAP.source}` : "")
    : `${MAP.name} · ${BW}"×${BH}" · ${deploy} · ${walls} wall pieces` +
      (hatches ? ` · ${hatches} hatchways (lighter stubs = open access points)` : "") +
      (MAP.source ? ` · ${MAP.source}` : "");
  logLine(`<b>Killzone loaded:</b> ${MAP.name}${MAP.source ? ` <span class="dice">(${MAP.source})</span>` : ""}.`);
}
// Rules picker: switching rules restarts the current map (base size, climbing costs and
// movement change the routing data).
export function useRuleset(id, announce = true) {
  setRuleset(id);
  renderRuleButtons();
  if (announce) logLine(`<b>Rules:</b> ${RULES.name} — ${RULES.blurb}`);
  if (MAP) loadMap(MAP);
}
export function renderRuleButtons() {
  const box = document.getElementById("rulebtns");
  box.innerHTML = "";
  for (const r of Object.values(RULESETS)) {
    const b = document.createElement("button");
    b.className = "mini" + (RULES === r ? " active" : "");
    b.textContent = r.short;
    b.title = r.name;
    b.onclick = () => { if (RULES !== r && !setupOnly()) useRuleset(r.id); };
    box.appendChild(b);
  }
  document.getElementById("rulenote").textContent =
    `${RULES.name} · ${RULES.baseMm}mm bases · control range ${fmtIn(RULES.controlRange)}″ · ${RULES.blurb}`;
}
// Map picker: one compact row per family (Volkus 2024, Volkus 2025, Gallowdark, …)
function renderMapButtons() {
  const box = document.getElementById("mapbtns");
  box.innerHTML = "";
  const rows = new Map();
  for (const [key, m] of Object.entries(MAPS)) {
    if (!m) continue;
    const group = m.group || "Imported";
    if (!rows.has(group)) {
      const row = document.createElement("div"); row.className = "maprow";
      const lab = document.createElement("span"); lab.className = "mapgroup"; lab.textContent = group;
      row.appendChild(lab); box.appendChild(row); rows.set(group, row);
    }
    const b = document.createElement("button");
    b.className = "mini" + (MAP === m ? " active" : "");
    b.textContent = m.short || m.name;
    b.title = m.name;
    b.onclick = () => { if (!setupOnly()) loadMap(key); };
    rows.get(group).appendChild(b);
  }
}
async function importTTSFile(file) {
  const buf = await file.arrayBuffer();
  let saveDoc;
  const dv = new DataView(buf);
  if (buf.byteLength > 5 && dv.getInt32(0, true) === buf.byteLength) saveDoc = parseBSON(buf);
  else saveDoc = JSON.parse(new TextDecoder().decode(buf));
  // Volkus first: a save can hold several Approved Ops layout bags — import them all
  const vbags = findVolkusBags(saveDoc);
  if (vbags.length) {
    let first = null, n = 0;
    for (const b of vbags.slice(0, 12)) {
      try {
        const key = "imp" + (n + 1);
        MAPS[key] = convertVolkusBag(b, b.Nickname || "Imported " + (n + 1));
        n++; if (!first) first = key;
      } catch (e) {}
    }
    if (first) {
      loadMap(first);
      if (n > 1) logLine(`Imported <b>${n}</b> Volkus layouts from this save — they're all in the killzone list.`);
      return;
    }
  }
  const label = ((saveDoc && saveDoc.SaveName) || file.name || "TTS import").replace(/\.[^.]+$/, "");
  MAPS.import = convertGallowdark(saveDoc, label);
  loadMap("import");
}

// Wiring: event listeners and button handlers (called once from main.js).
export function wireControls() {

  /* ---------- tray buttons ---------- */
  document.getElementById("endtp").onclick = () => {
    if (playOnly()) return;
    snapshot();
    if (tray.tp >= 4) { logLine("<b>Battle ends after turning point 4.</b> Count your VP!"); return; }
    tray.tp += 1; tray.cp[0] += 1; tray.cp[1] += 1;
    OPS.forEach(o => { o.ready = true; o.ap = o.apl; o.used = []; });
    logLine(`<b>Turning point ${tray.tp}.</b> All operatives readied, +1CP each (initiative player would get 1, other 2 — adjust to taste).`);
    renderAll();
  };
  document.getElementById("undo").onclick = () => { if (!playOnly() && !requestUndo()) doUndo(); };
  document.getElementById("reset").onclick = () => { if (setupOnly()) return; logEl.innerHTML = ""; loadMap(MAP); };
  document.getElementById("rulerbtn").onclick = () => {
    if (view3D && state.mode !== "ruler") setView(false);   // the ruler lives on the 2D map
    state.mode = state.mode === "ruler" ? null : "ruler"; state.rulerPts = [];
    hint(state.mode === "ruler" ? "Ruler: click two points to measure. Esc to exit." : HINT0);
    renderAll();
  };
  for (const [id, team, key] of [["cpa",0,"cp"],["cpb",1,"cp"],["vpa",0,"vp"],["vpb",1,"vp"]]) {
    document.getElementById(id).style.cursor = "pointer";
    document.getElementById(id).title = "click +1 · shift-click −1";
    document.getElementById(id).onclick = ev => {
      if (playOnly()) return;
      tray[key][team] = Math.max(0, tray[key][team] + (ev.shiftKey ? -1 : 1)); renderTray(); pump();
    };
  }
  document.getElementById("importbtn").onclick = () => { if (!setupOnly()) document.getElementById("importfile").click(); };
  document.getElementById("importfile").addEventListener("change", async ev => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    try { await importTTSFile(f); }
    catch (e) {
      logLine(`<span class="crit">Import failed:</span> ${String(e && e.message || e)}`);
      hint("Couldn't read that file as a Tabletop Simulator save.");
    }
    ev.target.value = "";
  });
}
