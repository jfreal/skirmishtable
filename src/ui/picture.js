/**
 * "Save picture": the board as it looks now (the 3D table or the 2D map, whichever is
 * showing) as a PNG, with a caption strip under it (map, rules, turning point, VP, date),
 * downloaded in this browser. Nothing is uploaded; the picture never leaves the player's
 * own machine until they send it. Pairs with share links (src/net/share.js).
 */
import { MAP } from '../engine/world.js';
import { RULES } from '../rules/index.js';
import { requestRender, three, view3D } from '../view3d/table3d.js';
import { hint } from './dom.js';
import { tray } from './panels.js';

/* ---------- caption and file name ---------- */
function pictureCaption({ map, rules, tp, vp, at }) {
  const when = new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return `SkirmishTable · ${map} · ${rules} · TP ${tp} · VP Ash ${vp[0]} – Slate ${vp[1]} · ${when}`;
}
// "skirmishtable-gallowdark-ao1-tp2.png": letters, digits and dashes only
function pictureName(map, tp) {
  const slug = String(map || "table").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "table";
  return `skirmishtable-${slug}-tp${tp | 0}.png`;
}

/* ---------- the board, as a canvas ---------- */
// The 3D table: render a frame at twice the screen's resolution and copy it out at once
// (WebGL clears its buffer after the frame is shown, so it has to be the same task).
function grab3D() {
  const { renderer, scene, camera } = three, pr = renderer.getPixelRatio();
  renderer.setPixelRatio(Math.max(2, pr));
  try {
    renderer.render(scene, camera);
    const src = renderer.domElement, c = document.createElement("canvas");
    c.width = src.width; c.height = src.height;
    c.getContext("2d").drawImage(src, 0, 0);
    return c;
  } finally { renderer.setPixelRatio(pr); requestRender(); }   // resizing cleared the table: draw it again
}
const blobToDataURL = b => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(b); });
// The 2D map: the SVG drawn into a canvas. An SVG drawn as a picture can't load other
// files, so marker images go in as data URLs (or are left out if they won't load).
async function grab2D() {
  const svg = document.getElementById("board"), vb = svg.viewBox.baseVal;
  const w = Math.round(vb.width * 2), h = Math.round(vb.height * 2), copy = svg.cloneNode(true);
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("width", w); copy.setAttribute("height", h);
  copy.removeAttribute("style");
  await Promise.all([...copy.querySelectorAll("image")].map(async im => {
    const href = im.getAttribute("href");
    try { im.setAttribute("href", await blobToDataURL(await (await fetch(href, { mode: "cors" })).blob())); }
    catch (e) { im.remove(); }
  }));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise((ok, no) => { img.onload = ok; img.onerror = () => no(new Error("the map didn't draw")); img.src = url; });
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#1b1712"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally { URL.revokeObjectURL(url); }
}

// The board plus a caption strip, as a PNG blob.
export async function boardPicture() {
  const board = view3D && three ? grab3D() : await grab2D();
  const strip = Math.round(board.width / 40), c = document.createElement("canvas");
  c.width = board.width; c.height = board.height + strip;
  const ctx = c.getContext("2d");
  ctx.drawImage(board, 0, 0);
  ctx.fillStyle = "#14110e"; ctx.fillRect(0, board.height, c.width, strip);
  ctx.fillStyle = "#e8e2d8"; ctx.textBaseline = "middle";
  ctx.font = `600 ${Math.round(strip * 0.45)}px 'JetBrains Mono', monospace`;
  const vp = [document.getElementById("vpa").textContent, document.getElementById("vpb").textContent];
  ctx.fillText(pictureCaption({ map: MAP.name, rules: RULES.name, tp: tray.tp, vp, at: Date.now() }),
    strip * 0.5, board.height + strip / 2, c.width - strip);
  return new Promise((ok, no) => c.toBlob(b => b ? ok(b) : no(new Error("the browser couldn't make a PNG")), "image/png"));
}

export async function savePicture() {
  const blob = await boardPicture();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = pictureName(MAP.name, tray.tp);
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  hint(`Saved ${a.download} — a picture of the ${view3D ? "3D table" : "2D map"} as it is now.`);
}
