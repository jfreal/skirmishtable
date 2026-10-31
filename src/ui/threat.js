/**
 * Threat overlay while dragging: the charge zone and the cover-broken zone of every enemy
 * that hasn't activated yet (engine/threat.js), painted once into a canvas that the 2D map
 * shows as an <image> and the 3D table lays on the board as a texture. Three looks to
 * compare, picked in the view bar:
 *   bands    — charge = solid red tint with a red edge; cover broken = amber stripes
 *   outlines — just the two edges (red thick, amber thin) over a faint wash
 *   warn     — no zones; only the landing ghost, its label and lines to the threats
 */
import { state } from '../state.js';
import { G } from '../engine/grid.js';
import { threatMap, threatsAt } from '../engine/threat.js';
import { RULES, fmtIn } from '../rules/index.js';

export const THREAT_COL = {charge: "#d23c2a", close: "#e0a21e"};
export const THREAT_STYLES = {bands: "Bands", outlines: "Outlines", warn: "Warn only", off: "Off"};
const KEY = "skirmishtable.threatStyle";
state.threatStyle = (() => { try { const v = localStorage.getItem(KEY); return v in THREAT_STYLES ? v : "bands"; } catch { return "bands"; } })();
export function setThreatStyle(s) {
  state.threatStyle = s;
  try { localStorage.setItem(KEY, s); } catch { /* private window: just don't remember */ }
}

// the view-bar picker; the key's tooltips spell out the reach under the rules in play
export function wireThreatPicker(redraw) {
  const sel = document.getElementById("threatstyle");
  sel.innerHTML = Object.entries(THREAT_STYLES).map(([v, l]) => `<option value="${v}"${state.threatStyle === v ? " selected" : ""}>${l}</option>`).join("");
  sel.onchange = () => { setThreatStyle(sel.value); redraw(); };
  const key = document.getElementById("threatkey");
  key.onmouseenter = () => {
    const L = threatLegend();
    key.title = [L.charge && `red: ${L.charge}`, L.close && `amber stripes: ${L.close}`].filter(Boolean).join("\n") +
      "\nOnly enemies that haven't activated this turning point. Zones are for your model's base centre.";
  };
}
// The zones for the active drag (null when there's nothing to show), plus who threatens
// the landing spot.
export function dragThreat() {
  const d = state.drag;
  if (state.threatStyle === "off" || !d || !d.active || !d.goal || !G) return null;
  const map = threatMap(d.op);
  if (!map.foes.length) return null;
  return {map, at: d.path ? threatsAt(map, d.goal[0], d.goal[1]) : {charge: [], close: []}};
}

// "⚠ Charge: S1 S3 · Cover broken: S2" for the landing spot, or "" when it's safe.
export function threatLabel(at) {
  const ids = l => l.map(o => o.id).join(" ");
  const close = at.close.filter(o => !at.charge.includes(o));
  const parts = [];
  if (at.charge.length) parts.push(`${RULES.moves.charge.label}: ${ids(at.charge)}`);
  if (close.length) parts.push(`Cover broken: ${ids(close)}`);
  return parts.length ? "⚠ " + parts.join(" · ") : "";
}
export const threatLevel = at => at.charge.length ? "charge" : at.close.length ? "close" : null;

// legend text for the view bar, from the rules in play
export function threatLegend() {
  const M = RULES.moves, voidIn = RULES.cover && RULES.cover.voidWithin;
  return {
    charge: M.charge ? `${M.charge.label} reach (${M.charge.label} move, then within ${fmtIn(RULES.controlRange)}")` : null,
    close: voidIn ? `Cover broken (${M.primary.label}${M.secondary ? `, plus ${M.secondary.label} with APL 3+` : ""}, then shoots from within ${fmtIn(voidIn)}")` : null,
  };
}

// The zones as a picture: 4 px per 0.1" cell, row 0 = the board's top edge.
const P = 4;
let painted = {map: null, style: null, canvas: null, url: null};
export function threatCanvas(map, style) {
  if (painted.map === map && painted.style === style) return painted;
  const nx = G.nx, ny = G.ny, W = nx * P, H = ny * P;
  const cv = painted.canvas && painted.canvas.width === W && painted.canvas.height === H ? painted.canvas : document.createElement("canvas");
  cv.width = W; cv.height = H;
  const x = cv.getContext("2d"), img = x.createImageData(W, H), px = img.data;
  const {charge, close} = map, cls = G.cls;
  const open = m => cls[m] !== 1 && cls[m] !== 2;
  const edge = (mask, k) => {
    if (!mask[k]) return false;
    const i = k % nx, j = k / nx | 0;
    return (i > 0 && !mask[k - 1] && open(k - 1)) || (i < nx - 1 && !mask[k + 1] && open(k + 1)) ||
           (j > 0 && !mask[k - nx] && open(k - nx)) || (j < ny - 1 && !mask[k + nx] && open(k + nx));
  };
  const R = [210, 60, 42], A = [224, 162, 30];
  const put = (o, c, a) => {           // "over" blend onto what's there
    const a0 = px[o + 3] / 255, ao = a + a0 * (1 - a);
    if (ao <= 0) return;
    for (let n = 0; n < 3; n++) px[o + n] = (c[n] * a + px[o + n] * a0 * (1 - a)) / ao;
    px[o + 3] = ao * 255;
  };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, inCh = !!charge[k], inCl = !!close[k];
    if (!inCh && !inCl) continue;
    const eCh = edge(charge, k), eCl = edge(close, k);
    for (let v = 0; v < P; v++) for (let u = 0; u < P; u++) {
      const X = i * P + u, Y = j * P + v, o = (Y * W + X) * 4;
      if (style === "bands") {
        if (inCl) { put(o, A, 0.07); if ((X + Y) % 22 < 5) put(o, A, 0.6); }
        if (inCh) put(o, R, 0.26);
        if (eCl) put(o, A, 0.85);
        if (eCh) put(o, R, 0.95);
      } else {                         // outlines
        if (inCl) put(o, A, 0.08);
        if (inCh) put(o, R, 0.12);
        if (eCl) put(o, A, 0.9);
        if (eCh) put(o, R, 0.95);
      }
    }
  }
  x.putImageData(img, 0, 0);
  painted = {map, style, canvas: cv, url: null};
  return painted;
}
export function threatImageURL(map, style) {
  const p = threatCanvas(map, style);
  if (!p.url) p.url = p.canvas.toDataURL();
  return p.url;
}
