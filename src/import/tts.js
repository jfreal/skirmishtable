/**
 * Tabletop Simulator importers: BSON reader, Gallowdark walls, Volkus layout bags.
 */
import { FINE_PIECES } from '../data/fine-pieces.js';
import { VOLKUS_PIECES } from '../data/volkus-pieces.js';

// Minimal BSON reader — enough for TTS WorkshopUpload files (double, string,
// document, array, binary(skipped), bool, datetime, null, int32, int64).
export function parseBSON(buf) {
  const dv = new DataView(buf), td = new TextDecoder();
  let pos = 0;
  function cstring() {
    const s = pos;
    while (dv.getUint8(pos) !== 0) pos++;
    const str = td.decode(new Uint8Array(buf, s, pos - s));
    pos++; return str;
  }
  function doc(isArray) {
    const end = pos + dv.getInt32(pos, true); pos += 4;
    const out = isArray ? [] : {};
    while (pos < end - 1) {
      const type = dv.getUint8(pos); pos++;
      const key = cstring();
      let v;
      switch (type) {
        case 1: v = dv.getFloat64(pos, true); pos += 8; break;
        case 2: { const n = dv.getInt32(pos, true); pos += 4;
                  v = td.decode(new Uint8Array(buf, pos, n - 1)); pos += n; break; }
        case 3: v = doc(false); break;
        case 4: v = doc(true); break;
        case 5: { const n = dv.getInt32(pos, true); pos += 5 + n; v = null; break; }
        case 8: v = dv.getUint8(pos) !== 0; pos++; break;
        case 9: case 18: v = Number(dv.getBigInt64(pos, true)); pos += 8; break;
        case 10: v = null; break;
        case 16: v = dv.getInt32(pos, true); pos += 4; break;
        default: throw new Error("unsupported BSON type " + type);
      }
      if (isArray) out.push(v); else out[key] = v;
    }
    pos = end;
    return out;
  }
  return doc(false);
}
// Collect every TTS object in the save: the ObjectStates tree, bag contents, and
// objects embedded as JSON strings inside Lua [[...]] literals (map-saver cards).
export function extractTTSObjects(root) {
  const out = [];
  (function visit(o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { o.forEach(visit); return; }
    if (o.Name && o.Transform) out.push(o);
    for (const k in o) {
      const v = o[k];
      if (k === "LuaScript" && typeof v === "string" && v.length > 100) {
        for (const m of v.matchAll(/\[\[([\s\S]*?)\]\]/g)) {
          const s = m[1].trim();
          if (s.startsWith("{")) {
            try { const j = JSON.parse(s); if (j.Name && j.Transform) out.push(j); } catch (e) {}
          }
        }
      } else visit(v);
    }
  })(root);
  return out;
}
// Convert a TTS Gallowdark map save into a SkirmishTable map. TTS table units are inches;
// the board is 6x7 cells of 3.78", centred on the origin (x short axis, z long axis).
// We rotate to landscape: X = z + 13.23, Y = x + 11.34. rotY 0/180 pieces run along
// tts-x, so they become vertical here. Known hatchway asset bundles split into two
// stubs around an open access point; anything parked off the board is a spare.
export function convertGallowdark(saveDoc, label) {
  const HATCH_IDS = new Set(["207C7AB5934D67BEB61E"]);
  const LEN = 1.89, THICK = 0.25, OPEN = 1.4, STUB = (LEN - OPEN) / 2, WZ = 4;
  const W = 26.46, H = 22.68, HX = 11.34, HZ = 13.23;
  const terrain = [], objectives = [];
  let idn = 0;
  const addRect = (cx, cy, length, vertical, hatch) => {
    const r = vertical ? {x: cx-THICK/2, y: cy-length/2, w: THICK, h: length}
                       : {x: cx-length/2, y: cy-THICK/2, w: length, h: THICK};
    const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
    const x1 = Math.min(W, r.x + r.w), y1 = Math.min(H, r.y + r.h);
    if (x1 - x0 < 0.08 || y1 - y0 < 0.08) return;
    const e = {id: "G" + (idn++), kind: "wall", noclimb: true, z: WZ,
               x: +x0.toFixed(3), y: +y0.toFixed(3), w: +(x1-x0).toFixed(3), h: +(y1-y0).toFixed(3)};
    if (hatch) e.hatch = true;
    terrain.push(e);
  };
  for (const o of extractTTSObjects(saveDoc)) {
    const t = o.Transform || {};
    if (typeof t.posX !== "number" || typeof t.posZ !== "number") continue;
    const rot = Math.round(t.rotY || 0) % 360;
    if (Math.abs(t.posX) > HX + 0.3 || Math.abs(t.posZ) > HZ + 0.3) continue; // spare piece
    const X = t.posZ + HZ, Y = t.posX + HX;
    if (o.Name === "Custom_Token") {
      objectives.push({id: "OBJ-" + (objectives.length + 1), x: +X.toFixed(2), y: +Y.toFixed(2)});
      continue;
    }
    if (o.Name !== "Custom_Assetbundle") continue;
    const parts = (((o.CustomAssetbundle || {}).AssetbundleURL) || "").split("/").filter(Boolean);
    const hash = (parts[parts.length - 1] || "").slice(0, 20);
    const vertical = rot % 180 <= 1 || rot % 180 >= 179; // ran along tts-x
    if (HATCH_IDS.has(hash)) {
      const off = (OPEN + STUB) / 2;
      if (vertical) { addRect(X, Y - off, STUB, true, true); addRect(X, Y + off, STUB, true, true); }
      else { addRect(X - off, Y, STUB, false, true); addRect(X + off, Y, STUB, false, true); }
    } else addRect(X, Y, LEN, vertical, false);
  }
  if (!terrain.length) throw new Error("no recognisable map pieces in this save");
  return {name: label, source: "imported from TTS", w: W, h: H, dropDepth: 3.78, terrain, objectives};
}
// Volkus: a save (like the KT24 Killzone Mod) holds each Approved Ops layout as a
// Bag of terrain pieces. We find those bags and turn each into piece placements on the
// board; loadMap() then lays every piece's traced footprint onto the terrain grid.
export function findVolkusBags(root) {
  const bags = [];
  (function visit(o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { o.forEach(visit); return; }
    if (o.Name === "Bag" && /volkus/i.test(o.Nickname || "") && (o.ContainedObjects || []).length >= 15)
      bags.push(o);
    for (const k in o) if (k !== "LuaScript") visit(o[k]);
  })(root);
  return bags;
}
// Layouts the TTS mod stores rotated 180° relative to their printed cards (verified
// by overlap scoring). Same map either way; this just makes them match the card.
export const VOLKUS_CARD_TURN = {"Volkus 25 01": 180, "Volkus 25 02": 180, "Volkus 25 03": 180};
export function convertVolkusBag(bag, label, source) {
  const P = VOLKUS_PIECES, W = 30, H = 22;
  const hashOf = u => { const p = (u || "").split("/").filter(Boolean); return (p[p.length-1] || "").slice(-16); };
  const keyOf = o => {
    const u = (o.CustomMesh && o.CustomMesh.MeshURL) || (o.CustomAssetbundle && o.CustomAssetbundle.AssetbundleURL);
    return u ? hashOf(u) : null;
  };
  // R(a): the same rotation the composer and the 3D view use
  const rotXZ = (deg, x, z) => { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
                                 return [x * c + z * s, -x * s + z * c]; };
  // a real TTS bag, or the trimmed [key, posX, posZ, rotY, scale] rows baked into this page
  const items = bag.items
    ? bag.items.map(([k, x, z, r, s, y = 0, rx = 0, rz = 0, sy = s, sz = s, tint = null]) => ({k, x, z, r, s, y, rx, rz, sy, sz, tint}))
    : (bag.ContainedObjects || []).filter(o => o.Transform && typeof o.Transform.posX === "number")
        .map(o => {
          const t = o.Transform, c = o.ColorDiffuse;
          return {k: keyOf(o), x: t.posX, z: t.posZ, r: t.rotY || 0, s: t.scaleX || 1, y: t.posY || 0, rx: t.rotX || 0, rz: t.rotZ || 0,
                  sy: t.scaleY || t.scaleX || 1, sz: t.scaleZ || t.scaleX || 1,
                  tint: c ? [c.r ?? 1, c.g ?? 1, c.b ?? 1, c.a ?? 1] : null};
        });
  // frame: guides at ±9 along an axis => that axis is the 30" one (6" zones); ±8 => 22" axis (3" zones)
  let alpha = 0, edge = "short";
  const guides = items.filter(o => o.k === P.guide).map(o => [o.x, o.z]);
  if (guides.length >= 3) {
    const rx = Math.max(...guides.map(g => g[0])) - Math.min(...guides.map(g => g[0]));
    const rz = Math.max(...guides.map(g => g[1])) - Math.min(...guides.map(g => g[1]));
    const alongX = rx > rz;
    const d = Math.max(...guides.map(g => Math.abs(alongX ? g[0] : g[1])));
    const thirty = d > 8.5;
    alpha = ((alongX && !thirty) || (!alongX && thirty)) ? 90 : 0;
    edge = thirty ? "short" : "long";
  } else if (items.some(o => Math.abs(o.z) > 11.5)) alpha = 90;
  alpha += VOLKUS_CARD_TURN[bag.Nickname] || 0;
  const place = [], objectives = [];
  for (const it of items) {
    if (!it.k || it.k === P.surface || it.k === P.guide) continue;
    const [bx, by] = rotXZ(alpha, it.x, -it.z);              // board = (x, -z), then frame rotation
    const X = bx + W / 2, Y = by + H / 2;
    if (it.k === P.objective) {
      objectives.push({id: "OBJ-" + (objectives.length + 1), x: +X.toFixed(2), y: +Y.toFixed(2)});
      continue;
    }
    if (!FINE_PIECES[it.k] && !P.templates[it.k]) continue;
    const a = alpha + 180 - it.r;                             // OBJ X-flip + z-flip = rotation by a
    place.push({k: it.k, x: +X.toFixed(3), y: +Y.toFixed(3), a: +(((a % 360) + 360) % 360).toFixed(2), s: +(+it.s).toFixed(4)});
  }
  if (!place.length) throw new Error("no recognisable Volkus pieces");
  // every model exactly as TTS places it (raw transform + the board frame), for the 3D table
  const models3d = items.filter(it => it.k).map(it => ({k: it.k, p: [it.x, it.y, it.z], r: [it.rx, it.r, it.rz],
    s: [it.s, it.sy, it.sz], tint: it.tint && it.tint.some(v => Math.abs(v - 1) > 1e-3) ? it.tint : null}));
  return {name: label, source: source || "imported from TTS", w: W, h: H, fine: true,
          dropEdge: edge, dropDepth: edge === "long" ? 3 : 6, objectives, place,
          pieces: place.filter(p => FINE_PIECES[p.k]),        // decimated scans (fallback 3D view)
          models3d, frame: alpha,
          terrain: [], decor: []};
}
