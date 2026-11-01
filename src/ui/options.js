/**
 * The Options menu (header button → dialog): player preferences, remembered in this browser.
 * Add a setting by giving it a default in `options` and a row in OPTION_ROWS (a slider, or
 * `choices` for a drop-down).
 */
const KEY = "skirmishtable.options";
// panSpeed: WASD camera pan, × the base speed; cardLayout: the status cards on the table
// edges, as "chips" (a tab per card) or a "drawer" (one tab per side); idle: the miniatures
// breathe and shift their weight on the 3D table (off by default if the system asks for less motion)
const calm = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
export const options = {panSpeed: 1, cardLayout: "chips", idle: calm ? "off" : "on"};
// only what the player set is stored, so a default (idle under reduced motion) stays a default
let stored = {};
try { stored = JSON.parse(localStorage.getItem(KEY)) || {}; Object.assign(options, stored); } catch (e) {}
if (!(options.panSpeed >= 0.25 && options.panSpeed <= 3)) options.panSpeed = 1;   // a hand-edited or corrupt value must not NaN the camera
if (!["chips", "drawer"].includes(options.cardLayout)) options.cardLayout = "chips";
if (!["on", "off"].includes(options.idle)) options.idle = calm ? "off" : "on";
const hooks = [];
export const onOptionChange = fn => hooks.push(fn);
function setOption(k, v) {
  options[k] = v; stored[k] = v;
  try { localStorage.setItem(KEY, JSON.stringify(stored)); } catch (e) { /* private window: just don't remember */ }
  for (const fn of hooks) fn(k);
}

const OPTION_ROWS = [
  {key: "panSpeed", label: "Keyboard pan speed", help: "How fast W A S D slide the 3D table view.",
   min: 0.25, max: 3, step: 0.25, fmt: v => `${v}×`},
  {key: "cardLayout", label: "Status cards", help: "Chips: a small tab per card on the table edge; click one to read it. Drawer: one tab per side opens all its cards.",
   choices: [["chips", "Chips"], ["drawer", "Drawer"]]},
  {key: "idle", label: "Idle animation", help: "Miniatures on the 3D table breathe and shift their weight a little while they stand.",
   choices: [["on", "On"], ["off", "Off"]]},
];

export function wireOptions() {
  const dlg = document.getElementById("options"), body = document.getElementById("optionrows");
  body.innerHTML = OPTION_ROWS.map(r => r.choices ? `<label class="optrow">
    <span class="optlabel">${r.label}</span>
    <select id="opt-${r.key}">${r.choices.map(([v, n]) => `<option value="${v}"${options[r.key] === v ? " selected" : ""}>${n}</option>`).join("")}</select>
    <span class="hint">${r.help}</span></label>` : `<label class="optrow">
    <span class="optlabel">${r.label} <b id="opt-${r.key}-v">${r.fmt(options[r.key])}</b></span>
    <input type="range" id="opt-${r.key}" min="${r.min}" max="${r.max}" step="${r.step}" value="${options[r.key]}">
    <span class="hint">${r.help}</span></label>`).join("");
  for (const r of OPTION_ROWS) {
    const input = document.getElementById(`opt-${r.key}`);
    if (r.choices) { input.onchange = () => setOption(r.key, input.value); continue; }
    const out = document.getElementById(`opt-${r.key}-v`);
    input.oninput = () => { setOption(r.key, +input.value); out.textContent = r.fmt(+input.value); };
  }
  document.getElementById("optionsbtn").onclick = () => dlg.showModal();
  document.getElementById("optionsclose").onclick = () => dlg.close();
  dlg.addEventListener("click", ev => { if (ev.target === dlg) dlg.close(); });   // a click on the backdrop
}
