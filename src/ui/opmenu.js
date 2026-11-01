/**
 * Right-click menu on an operative: on its 2D token, its 3D model and its circle in the top
 * ribbon. Mark expended ends its activation; Undo activation puts it back as it was when the
 * activation began (panels.js). On a phone a long press opens it.
 */
import { TEAMCOL_LT } from '../config.js';
import { mayControl } from '../net/sync.js';
import { canUndoActivation, endActivation, undoActivation } from './panels.js';

let menu = null;
const esc = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function closeOpMenu() { if (menu) { menu.remove(); menu = null; } }

// open the menu for op at a screen point (clientX / clientY)
export function openOpMenu(op, x, y) {
  closeOpMenu();
  if (!op) return;
  const mine = mayControl(op);
  const items = [
    ["expend", "Mark expended", mine && op.alive && op.ready, () => endActivation(op)],
    ["undo", "Undo activation", mine && canUndoActivation(op), () => undoActivation(op)],
  ];
  const why = !op.alive ? "Incapacitated" : !mine ? "Not yours to change" : !op.ready ? "Expended" : op.used.length ? "Activating" : "Ready";
  menu = document.createElement("div");
  menu.className = "opmenu"; menu.setAttribute("role", "menu");
  menu.innerHTML = `<div class="omh" style="color:${TEAMCOL_LT[op.team]}">${esc(op.id)} · ${esc(op.name)}<span>${why}</span></div>` +
    items.map(([k, label, ok]) => `<button role="menuitem" data-k="${k}"${ok ? "" : " disabled"}>${label}</button>`).join("");
  document.body.appendChild(menu);
  // keep it on screen
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.max(4, Math.min(window.innerWidth - w - 4, x)) + "px";
  menu.style.top = Math.max(4, Math.min(window.innerHeight - h - 4, y)) + "px";
  menu.addEventListener("click", ev => {
    const b = ev.target.closest("button[data-k]");
    if (!b || b.disabled) return;
    const it = items.find(i => i[0] === b.dataset.k);
    closeOpMenu(); it[3]();
  });
  menu.addEventListener("contextmenu", ev => ev.preventDefault());
  const first = menu.querySelector("button:not([disabled])");
  if (first) first.focus({ preventScroll: true });
}

export function wireOpMenu() {
  // any press outside closes it (capture, so it closes before the press does anything else)
  document.addEventListener("pointerdown", ev => { if (menu && !menu.contains(ev.target)) closeOpMenu(); }, true);
  document.addEventListener("keydown", ev => { if (ev.key === "Escape") closeOpMenu(); });
  window.addEventListener("resize", closeOpMenu);
  window.addEventListener("scroll", closeOpMenu, true);
}
