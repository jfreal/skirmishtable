/**
 * The Options menu (header button → dialog): player preferences, remembered in this browser.
 * Add a setting by giving it a default in `options` and a row in OPTION_ROWS.
 */
const KEY = "skirmishtable.options";
export const options = {panSpeed: 1};   // panSpeed: WASD camera pan, × the base speed
try { Object.assign(options, JSON.parse(localStorage.getItem(KEY)) || {}); } catch (e) {}
function setOption(k, v) {
  options[k] = v;
  try { localStorage.setItem(KEY, JSON.stringify(options)); } catch (e) { /* private window: just don't remember */ }
}

const OPTION_ROWS = [
  {key: "panSpeed", label: "Keyboard pan speed", help: "How fast W A S D slide the 3D table view.",
   min: 0.25, max: 3, step: 0.25, fmt: v => `${v}×`},
];

export function wireOptions() {
  const dlg = document.getElementById("options"), body = document.getElementById("optionrows");
  body.innerHTML = OPTION_ROWS.map(r => `<label class="optrow">
    <span class="optlabel">${r.label} <b id="opt-${r.key}-v">${r.fmt(options[r.key])}</b></span>
    <input type="range" id="opt-${r.key}" min="${r.min}" max="${r.max}" step="${r.step}" value="${options[r.key]}">
    <span class="hint">${r.help}</span></label>`).join("");
  for (const r of OPTION_ROWS) {
    const input = document.getElementById(`opt-${r.key}`), out = document.getElementById(`opt-${r.key}-v`);
    input.oninput = () => { setOption(r.key, +input.value); out.textContent = r.fmt(+input.value); };
  }
  document.getElementById("optionsbtn").onclick = () => dlg.showModal();
  document.getElementById("optionsclose").onclick = () => dlg.close();
  dlg.addEventListener("click", ev => { if (ev.target === dlg) dlg.close(); });   // a click on the backdrop
}
