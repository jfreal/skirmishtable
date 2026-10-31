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
import { chargeRoute, threatMap, threatsAt } from '../engine/threat.js';
import { RULES, fmtIn } from '../rules/index.js';

export const THREAT_COL = {charge: "#d23c2a", close: "#e0a21e"};
export const THREAT_STYLES = {bands: "Bands", outlines: "Outlines", warn: "Warn only", off: "Off"};
// how strongly the zones are painted (a multiplier on the soft defaults)
export const THREAT_STRENGTHS = {faint: "Faint", soft: "Soft", bold: "Bold"};
const STRENGTH = {faint: 0.6, soft: 1, bold: 1.6};
// how a charging enemy's route to the landing ghost is drawn
export const PATH_STYLES = {flow: "Flowing dashes", comet: "Comets", arrow: "Arrows", line: "Straight lines"};
function pref(name, opts, dflt) {
  const key = "skirmishtable." + name;
  try { const v = localStorage.getItem(key); state[name] = v in opts ? v : dflt; } catch { state[name] = dflt; }
  return v => { state[name] = v; try { localStorage.setItem(key, v); } catch { /* private window: just don't remember */ } };
}
export const setThreatStyle = pref("threatStyle", THREAT_STYLES, "bands");
export const setThreatStrength = pref("threatStrength", THREAT_STRENGTHS, "soft");
export const setThreatPaths = pref("threatPaths", PATH_STYLES, "flow");

// the view-bar pickers; the key's tooltips spell out the reach under the rules in play
export function wireThreatPicker(redraw) {
  const wire = (id, opts, cur, set) => {
    const sel = document.getElementById(id);
    sel.innerHTML = Object.entries(opts).map(([v, l]) => `<option value="${v}"${cur === v ? " selected" : ""}>${l}</option>`).join("");
    sel.onchange = () => { set(sel.value); redraw(); };
  };
  wire("threatstyle", THREAT_STYLES, state.threatStyle, setThreatStyle);
  wire("threatstrength", THREAT_STRENGTHS, state.threatStrength, setThreatStrength);
  wire("threatpaths", PATH_STYLES, state.threatPaths, setThreatPaths);
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
  const at = d.path ? threatsAt(map, d.goal[0], d.goal[1]) : {charge: [], close: []};
  // the way each enemy that could charge the ghost would come (null: draw it straight)
  const routes = new Map();
  if (state.threatPaths !== "line") for (const o of at.charge) routes.set(o, chargeRoute(map, o, d.goal[0], d.goal[1]));
  return {map, at, routes};
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

// The zones as a picture: 4 px per 0.1" cell, row 0 = the board's top edge. Each zone's
// cell mask is blurred into a smooth field and drawn by its 0.5 contour, so the fill and
// the edge line are anti-aliased instead of stepping cell by cell. The edge is only drawn
// where the zone meets open ground (a wall is its own edge).
const P = 4;
let painted = {key: null, map: null, canvas: null, url: null};
function blur3(f, nx, ny) {            // one 3x3 box pass
  const t = new Float32Array(f.length), o = new Float32Array(f.length);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    t[k] = (f[k] + f[i > 0 ? k - 1 : k] + f[i < nx - 1 ? k + 1 : k]) / 3;
  }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    o[k] = (t[k] + t[j > 0 ? k - nx : k] + t[j < ny - 1 ? k + nx : k]) / 3;
  }
  return o;
}
// a zone's smoothed field, and the cells near where it meets open ground outside it
function zoneField(mask, nx, ny, open) {
  const n = nx * ny, f = new Float32Array(n), e = new Uint8Array(n);
  for (let k = 0; k < n; k++) f[k] = mask[k] ? 1 : 0;
  const out = m => !mask[m] && open(m);
  for (let k = 0; k < n; k++) {
    if (!mask[k]) continue;
    const i = k % nx, j = k / nx | 0;
    if (!((i > 0 && out(k - 1)) || (i < nx - 1 && out(k + 1)) || (j > 0 && out(k - nx)) || (j < ny - 1 && out(k + nx)))) continue;
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
      const ii = i + di, jj = j + dj;
      if (ii >= 0 && jj >= 0 && ii < nx && jj < ny) e[jj * nx + ii] = 1;
    }
  }
  return {f: blur3(blur3(f, nx, ny), nx, ny), e};
}
export function threatCanvas(map, style) {
  const s = STRENGTH[state.threatStrength] || 1, key = `${style}|${s}`;
  if (painted.map === map && painted.key === key) return painted;
  const nx = G.nx, ny = G.ny, W = nx * P, H = ny * P;
  const cv = painted.canvas && painted.canvas.width === W && painted.canvas.height === H ? painted.canvas : document.createElement("canvas");
  cv.width = W; cv.height = H;
  const x = cv.getContext("2d"), img = x.createImageData(W, H), px = img.data;
  const cls = G.cls, open = m => cls[m] !== 1 && cls[m] !== 2;
  const ch = zoneField(map.charge, nx, ny, open), cl = zoneField(map.close, nx, ny, open);
  const R = [210, 60, 42], A = [224, 162, 30], a = v => Math.min(1, v * s);
  const look = style === "bands"
    ? {chFill: a(0.13), chEdge: a(0.6), clWash: a(0.04), clStripe: a(0.3), clEdge: a(0.5)}
    : {chFill: a(0.06), chEdge: a(0.65), clWash: a(0.04), clStripe: 0, clEdge: a(0.55)};
  const put = (o, c, al) => {          // "over" blend onto what's there
    if (al <= 0) return;
    const a0 = px[o + 3] / 255, ao = al + a0 * (1 - al);
    for (let n = 0; n < 3; n++) px[o + n] = (c[n] * al + px[o + n] * a0 * (1 - al)) / ao;
    px[o + 3] = ao * 255;
  };
  // signed distance in px from the zone's 0.5 contour (+ inside): the field bilinear
  // between cell centres, over its local gradient
  const sdist = (Z, fx, fy) => {
    const i0 = Math.max(0, Math.min(nx - 2, Math.floor(fx))), j0 = Math.max(0, Math.min(ny - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - i0)), ty = Math.max(0, Math.min(1, fy - j0)), k = j0 * nx + i0;
    const f00 = Z.f[k], f10 = Z.f[k + 1], f01 = Z.f[k + nx], f11 = Z.f[k + nx + 1];
    const v = (f00 * (1 - tx) + f10 * tx) * (1 - ty) + (f01 * (1 - tx) + f11 * tx) * ty;
    const gx = ((f10 - f00) * (1 - ty) + (f11 - f01) * ty) / P, gy = ((f01 - f00) * (1 - tx) + (f11 - f10) * tx) / P;
    return (v - 0.5) / Math.max(1e-4, Math.hypot(gx, gy));
  };
  const cover = sd => Math.max(0, Math.min(1, sd + 0.5));                   // 1 px soft fill edge
  const line = (sd, half) => Math.max(0, Math.min(1, half + 0.5 - Math.abs(sd)));   // a line 2*half px wide
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, inCl = cl.f[k] > 1e-3, inCh = ch.f[k] > 1e-3;
    if (!inCh && !inCl) continue;
    for (let v = 0; v < P; v++) for (let u = 0; u < P; u++) {
      const X = i * P + u, Y = j * P + v, o = (Y * W + X) * 4, fx = (X + 0.5) / P - 0.5, fy = (Y + 0.5) / P - 0.5;
      if (inCl) {
        const sd = sdist(cl, fx, fy), c = cover(sd);
        if (c > 0) {
          put(o, A, look.clWash * c);
          if (look.clStripe) {         // diagonal stripes, their sides smoothed
            const t = (X + Y) % 22;
            put(o, A, look.clStripe * c * Math.max(0, Math.min(1, (2.5 - Math.abs(t - 2.5)) * 0.7 + 0.5)));
          }
        }
        if (cl.e[k]) put(o, A, look.clEdge * line(sd, 0.8));
      }
      if (inCh) {
        const sd = sdist(ch, fx, fy);
        put(o, R, look.chFill * cover(sd));
        if (ch.e[k]) put(o, R, look.chEdge * line(sd, 1.1));
      }
    }
  }
  x.putImageData(img, 0, 0);
  painted = {key, map, canvas: cv, url: null};
  return painted;
}
export function threatImageURL(map, style) {
  const p = threatCanvas(map, style);
  if (!p.url) p.url = p.canvas.toDataURL();
  return p.url;
}
