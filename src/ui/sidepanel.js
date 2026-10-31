/**
 * The side panel (Battle tray, Ops & score, Rules, …) folds away so the table and its overlay
 * fill the screen. It starts folded; the choice is remembered in this browser. While folded,
 * End TP, Undo and Ruler sit in the view bar, and the table is sized to fit the window.
 */
const KEY = "skirmishtable.sidebar";

let open = false;
try { open = localStorage.getItem(KEY) === "open"; } catch (e) {}

// the widest the table can be while its whole height still fits under the header and view bar
function fit() {
  const main = document.querySelector(".main"), stage = document.querySelector(".stage");
  if (!main || !stage) return;
  const top = stage.getBoundingClientRect().top + window.scrollY;
  const h = Math.max(240, window.innerHeight - top - 12), w = Math.round(h * 960 / 704) + "px";
  if (main.style.getPropertyValue("--fitw") === w) return false;
  main.style.setProperty("--fitw", w);
  return true;
}

function apply() {
  const main = document.querySelector(".main"), btn = document.getElementById("panelbtn");
  main.classList.toggle("folded", !open);
  btn.textContent = open ? "Hide panel" : "Show panel";
  btn.setAttribute("aria-expanded", String(open));
  fit();
  window.dispatchEvent(new Event("resize"));   // the 3D table and the dice boxes size from their box
}

export function wireSidePanel() {
  document.getElementById("panelbtn").onclick = () => {
    open = !open;
    try { localStorage.setItem(KEY, open ? "open" : "folded"); } catch (e) { /* private window: just don't remember */ }
    apply();
  };
  // the folded view bar's buttons press the Battle tray's own
  document.querySelectorAll("[data-press]").forEach(b => b.onclick = () => document.getElementById(b.dataset.press).click());
  window.addEventListener("resize", fit);
  // the header and view bar change height too (3D controls appear, rows wrap, the replay bar opens)
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => { if (fit()) window.dispatchEvent(new Event("resize")); });
    ["header", ".viewbar", "#replaybar"].forEach(q => { const e = document.querySelector(q); if (e) ro.observe(e); });
  }
  apply();
}
