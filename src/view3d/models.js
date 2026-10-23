/* global THREE */
/**
 * The exact Tabletop Simulator models on the 3D table: full-resolution meshes with their
 * original textures (built by tools/model_pack.py), each placed with the full TTS
 * transform — position, Unity Euler rotation and non-uniform scale — so the table looks
 * the way the mod models and textures it: scans, rubble bundles, the mat, objective
 * markers and the deployment guide planes.
 */

import { TTS_SOURCES } from '../data/tts-sources.js';
import { parseOBJ } from '../import/obj.js';
import { readBundle } from '../import/unity.js';
import UnityWorker from '../import/unity-worker.js?worker&inline';

// The manifest lists every model and texture. Locally it's public/models/manifest.json;
// the Claude artifact build points at a manifest whose "urls" map each file to its
// uploaded asset (see .env.artifact and tools/upload notes in README).
const MANIFEST_URL = import.meta.env.VITE_MODELS_MANIFEST || "models/manifest.json";
let manifest = null, manifestBase = "", manifestTried = null, fromSteam = false;
const modelCache = {}, texCache = {};
export const progress = { loaded: 0, total: 0, failed: 0, onChange: null };
// the table draws on demand: told whenever a model or texture lands
let redraw = () => {};
export const setRedraw = fn => { redraw = fn; };

// Where the public site gets the models: it hosts none, so the viewer's browser loads the
// OBJ scans, textures and Unity asset bundles (rubble, some fire steps) straight from the
// Steam CDN on request (src/data/tts-sources.js), keeps them in the Cache API for the next
// visit, and remembers the choice. A bundle that fails to read is drawn as a block.
const STEAM_CACHE = "skirmishtable-tts-v1", STEAM_PREF = "skirmishtable.ttsFromSteam";
const steamTex = {};   // textures are shared between models: count each once
for (const e of Object.values(TTS_SOURCES)) if (e.tex) steamTex[e.tex] = e.texBytes || 0;
export const steamBytes = Object.values(TTS_SOURCES).reduce((a, e) => a + (e.bytes || 0), 0)
  + Object.values(steamTex).reduce((a, b) => a + b, 0);
export function steamRemembered() {
  try { return localStorage.getItem(STEAM_PREF) === "1"; } catch (e) { return false; }
}
export function useSteamSource() {
  if (fromSteam) return manifest;
  try { localStorage.setItem(STEAM_PREF, "1"); } catch (e) {}
  fromSteam = true; manifestBase = "";
  manifest = { models: {}, textures: steamTex };
  for (const [k, e] of Object.entries(TTS_SOURCES)) manifest.models[k] = { ...e, bytes: e.bytes || 0 };
  progress.loaded = 0; progress.total = steamBytes;
  return manifest;
}
// a fetch that didn't arrive (network, CORS, HTTP error), told apart from a file we can't read
async function download(url) {
  let r;
  try { r = await fetch(url); } catch (e) { throw Object.assign(e, { download: true }); }
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { download: true });
  return r;
}
export async function cachedFetch(url) {
  let cache = null;
  try { cache = await caches.open(STEAM_CACHE); const hit = await cache.match(url); if (hit) return hit; } catch (e) {}
  const r = await download(url);
  if (cache) try { await cache.put(url, r.clone()); } catch (e) {}
  return r;
}
// Downloads that failed (Steam unreachable, blocked, an error): each keeps the bytes it
// counted as done and how to forget it, so Retry can fetch it again. Logged with the cause.
const failures = [];
export function noteFailure(url, err, bytes, forget) {
  console.warn(`SkirmishTable: couldn't load ${url}:`, (err && err.message) || err);
  failures.push({ bytes, forget });
  progress.failed = failures.length;
  if (progress.onChange) progress.onChange();
}
export function retryFailed() {
  for (const f of failures.splice(0)) { progress.loaded -= f.bytes; f.forget(); }
  progress.failed = 0;
}
// a Unity bundle we can't read (or a model that didn't download): a block filling its bounds,
// in its own local space
function blockPart(info) {
  const [lo, hi] = info.bounds;
  const g = new THREE.BoxGeometry(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  g.translate((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
  return [{ geometry: g, tex: null, color: /fire step/i.test(info.name) ? 0xd9b765 : 0x8e8577 }];
}
function geometryOf(o) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(o.pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(o.nrm, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(o.uv, 2));
  g.setIndex(new THREE.BufferAttribute(o.idx, 1));
  g.computeBoundingSphere();
  return g;
}
// Bundles and OBJ scans are read in a few workers (big bundles take seconds each, a big OBJ
// a few hundred ms, and a team has a dozen); straight here if workers fail.
let workers = null, jobs = 0;
const pending = new Map();
const objParts = buf => workerJob(buf, "obj", () => [parseOBJ(new TextDecoder().decode(buf))]);
const bundleParts = buf => workerJob(buf, "bundle", () => readBundle(buf));
function workerJob(buf, kind, here) {
  if (workers === null) {
    try {
      workers = [];
      for (let i = 0; i < Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1)); i++) {
        const w = new UnityWorker();
        w.busy = 0;
        w.onmessage = ({ data }) => {
          const job = pending.get(data.id); pending.delete(data.id); w.busy--;
          if (data.error) job.reject(new Error(data.error)); else job.resolve(data.parts);
        };
        workers.push(w);
      }
    } catch (e) { workers = false; }
  }
  if (!workers) return Promise.resolve().then(here);
  const w = workers.reduce((a, b) => b.busy < a.busy ? b : a);
  return new Promise((resolve, reject) => {
    const id = ++jobs;
    pending.set(id, { resolve, reject }); w.busy++;
    w.postMessage({ id, buf, kind }, [buf]);
  });
}
// decoded bundle textures, by content key: the rubble bundles all carry the same one
const bundleTex = {}, partsCache = {};
// One Steam-hosted drawable — an OBJ with its texture, or a Unity bundle — as parts
// [{geometry, tex, png}]. Shared by the terrain and the operatives (src/view3d/units.js).
export function steamParts(e) {
  const key = (e.obj || e.bundle) + "|" + (e.tex || "");
  if (partsCache[key]) return partsCache[key];
  const parts = e.bundle
    ? cachedFetch(e.bundle).then(r => r.arrayBuffer()).then(bundleParts).then(list => list.map(p => {
        const tex = p.tex ? "bundle:" + p.tex.key : null;
        if (tex && !bundleTex[tex]) bundleTex[tex] = p.tex;
        return { geometry: geometryOf(p), tex };
      }))
    : cachedFetch(e.obj).then(r => r.arrayBuffer()).then(objParts).then(([o]) => {
        // a damaged file that lost most of its texture coordinates can't take its texture
        const tex = o.missingUV > o.pos.length / 12 ? null : e.tex || null;
        return [{ geometry: geometryOf(o), tex, png: !!e.png }];
      });
  // a failed download isn't kept: the next call (Retry) fetches it again
  return partsCache[key] = parts.catch(err => { if (err.download) delete partsCache[key]; throw err; });
}
function steamModel(key, info) {
  return steamParts(info).then(parts => {
    bump(info.bytes);
    return parts.length ? parts : blockPart(info);
  }, err => {
    // a block in its place (not nothing); one that didn't download is retried, and its
    // texture won't come either
    if (err.download) noteFailure(info.obj || info.bundle, err, info.bytes, () => { delete modelCache[key]; });
    bump(info.bytes); if (info.tex) texDone(info.tex);
    return blockPart(info);
  });
}
// RGBA rows bottom-up, as Unity stores them: GL's own order, so no flip
function bundleTexture(key) {
  const d = bundleTex[key], t = new THREE.DataTexture(d.rgba, d.width, d.height, THREE.RGBAFormat);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}
// Photo textures: decoded off the main thread into an ImageBitmap where the browser does that
// well (a 4096² JPEG takes ~150 ms to decode; on the main thread, at upload, that froze the
// first frames for over a second), else through an <img>. Phones and tablets get them at
// most 2048² (a 4096² texture is 90 MB of GPU memory with its mipmaps).
const BITMAPS = typeof createImageBitmap === "function" && !/^((?!chrome|android).)*safari/i.test(navigator.userAgent);
const TEX_CAP = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches ? 2048 : 16384;
async function decodeImage(blob) {
  if (BITMAPS) try {
    // flipped here: GL's UNPACK_FLIP_Y and premultiply don't apply to ImageBitmaps
    const opts = { imageOrientation: "flipY", premultiplyAlpha: "none" };
    const bmp = await createImageBitmap(blob, opts);
    const k = TEX_CAP / Math.max(bmp.width, bmp.height);
    if (k >= 1) return bmp;
    const small = await createImageBitmap(bmp, { ...opts, imageOrientation: "none",
      resizeWidth: Math.round(bmp.width * k), resizeHeight: Math.round(bmp.height * k), resizeQuality: "high" });
    bmp.close();
    return small;
  } catch (e) {}   // an older browser without these options: the <img> way
  const img = new Image(), src = URL.createObjectURL(blob);
  img.src = src;
  await img.decode();
  URL.revokeObjectURL(src);
  const k = TEX_CAP / Math.max(img.width, img.height);
  if (k >= 1) return img;
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c;
}
// each texture's bytes count once toward the progress, whichever model asked for it first
const texCounted = new Set();
function texDone(key) {
  if (texCounted.has(key)) return;
  texCounted.add(key);
  bump((manifest && manifest.textures && manifest.textures[key]) || 0);
}
// a texture that didn't download: plain grey (an empty one samples black), refetched on Retry
function greyImage() {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const x = c.getContext("2d"); x.fillStyle = "#8e8577"; x.fillRect(0, 0, 1, 1);
  return c;
}
function imageTexture(fetchIt, key) {
  const t = new THREE.Texture();
  const fill = () => fetchIt().then(r => r.blob()).then(decodeImage).then(img => {
    t.image = img;
    t.flipY = !(typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap);
    t.needsUpdate = true;
    texDone(key);
  }).catch(err => {
    t.image = greyImage(); t.flipY = true; t.needsUpdate = true;
    if (err.download) noteFailure(key, err, 0, () => { fill(); });
    texDone(key); redraw();
  });
  fill();
  return t;
}
const steamTexture = url => imageTexture(() => cachedFetch(url), url);

// TTS material types: 0 plastic, 1 wood, 2 metal, 3 cardboard. Kept matte: the scans are
// photos with their lighting baked in, and a glossy finish throws mirror-like glare on floors
const SURFACE = [{ roughness: 0.88, metalness: 0 }, { roughness: 0.9, metalness: 0 },
                 { roughness: 0.7, metalness: 0.2 }, { roughness: 0.95, metalness: 0 }];

export function ensureManifest() {
  if (!manifestTried) manifestTried = (async () => {
    try {
      const url = new URL(MANIFEST_URL, document.baseURI);
      const r = await fetch(url);
      if (!r.ok) return null;
      manifest = await r.json();
      manifestBase = url.href;
      progress.total = Object.values(manifest.models).reduce((a, m) => a + m.bytes, 0)
        + Object.values(manifest.textures || {}).reduce((a, b) => a + b, 0);
    } catch (e) { manifest = null; }
    return manifest;
  })();
  return manifestTried;
}
export const hasModels = map => !!(manifest && map && map.models3d && map.models3d.some(m => manifest.models[m.k]));
const urlOf = path => (manifest.urls && manifest.urls[path]) || new URL(path, manifestBase).href;
const bump = n => { progress.loaded += n; if (progress.onChange) progress.onChange(); redraw(); };

function loadModel(key) {
  if (modelCache[key]) return modelCache[key];
  const info = manifest.models[key];
  if (fromSteam) return modelCache[key] = steamModel(key, info);
  return modelCache[key] = fetch(urlOf(info.file)).then(r => r.arrayBuffer()).then(buf => {
    bump(info.bytes);
    const hlen = new DataView(buf).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hlen)));
    const base = 4 + hlen;
    return header.parts.map(p => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(buf, base + p.pos, p.count * 3), 3));
      g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(buf, base + p.nrm, p.count * 3), 3));
      g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(buf, base + p.uv, p.count * 2), 2));
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(buf, base + p.idx, p.icount), 1));
      g.computeBoundingSphere();
      return { geometry: g, tex: p.tex };
    });
  });
}
function texture(path, renderer, steam = fromSteam) {
  if (texCache[path]) return texCache[path];
  const t = bundleTex[path] ? bundleTexture(path) : steam ? steamTexture(path)
    : imageTexture(() => download(urlOf(path)), path);
  t.encoding = THREE.sRGBEncoding;
  if (renderer) t.anisotropy = renderer.capabilities.getMaxAnisotropy();   // none yet: measuring bases from the 2D map
  return texCache[path] = t;
}
// material for a steamParts() part: textures always come from Steam; `color` is a TTS tint
export function steamMaterial(p, color, material, renderer) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(...(color || [1, 1, 1])).convertSRGBToLinear(),
    map: p.tex ? texture(p.tex, renderer, true) : null,
    alphaTest: p.png ? 0.5 : 0,
    ...SURFACE[material] || SURFACE[0],
  });
}

// TTS world -> table. TTS (Unity) is left-handed, y up; the board is (x, -z) turned by the
// layout's frame angle and centred; the table top (the mat's upper face) sits at height 0.
// Object matrix = T(pos) · Ry·Rx·Rz (Unity's Z-X-Y Euler order) · S, applied to geometry
// already stored in Unity local space.
export function placementMatrix(m, frameDeg, top, BW, BH) {
  const a = frameDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const L = new THREE.Matrix4().set(c, 0, -s, BW / 2, 0, 1, 0, -top, -s, 0, -c, BH / 2, 0, 0, 0, 1);
  const d = Math.PI / 180;
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(m.r[0] * d, m.r[1] * d, m.r[2] * d, "YXZ"));
  const U = new THREE.Matrix4().compose(new THREE.Vector3(...m.p), q, new THREE.Vector3(...m.s));
  return L.multiply(U);
}

const MAT_KEY = "06EC984208223D38", GUIDE_KEY = "9C8BD76749A0A723";
// The mat is a thin box textured all over: its sides smear the art's edge pixels. Keep the
// art on the upward faces (material 0) and draw the rest plain black (material 1).
let matSides = null, aboveTable = null;   // made on first use: THREE comes from a CDN
function splitTopFaces(g) {
  if (g.userData.topSplit) return;
  const idx = g.index.array, nrm = g.attributes.normal.array, top = [], rest = [];
  for (let t = 0; t < idx.length; t += 3) {
    const up = (nrm[idx[t] * 3 + 1] + nrm[idx[t + 1] * 3 + 1] + nrm[idx[t + 2] * 3 + 1]) / 3 > 0.5;
    (up ? top : rest).push(idx[t], idx[t + 1], idx[t + 2]);
  }
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(top.concat(rest)), 1));
  g.clearGroups(); g.addGroup(0, top.length, 0); g.addGroup(top.length, rest.length, 1);
  g.userData.topSplit = true;
}

// height of the table top in TTS coordinates: the mat surface's upper face
function tableTop(map) {
  const surf = map.models3d.find(m => m.k === MAT_KEY && manifest.models[m.k]);
  if (surf) return surf.p[1] + manifest.models[surf.k].bounds[1][1] * surf.s[1];
  const ys = map.models3d.map(m => m.p[1]).sort((x, y) => x - y);
  return ys[ys.length >> 1] || 0;
}

// Add every model of the map to `group` as it arrives. `isCurrent()` says whether the
// group still belongs to the scene being built (the map may change mid-download).
export function addModels(group, map, renderer, BW, BH, isCurrent) {
  const top = tableTop(map);
  for (const m of map.models3d) {
    const info = manifest.models[m.k];
    if (!info) continue;
    const M = placementMatrix(m, map.frame || 0, top, BW, BH);
    loadModel(m.k).then(parts => {
      if (!isCurrent()) return;
      for (const p of parts) {
        const tint = m.tint || [1, 1, 1, 1];
        const color = new THREE.Color(tint[0], tint[1], tint[2]).convertSRGBToLinear();
        if (p.color) color.multiply(new THREE.Color(p.color).convertSRGBToLinear());   // stand-in blocks
        const mat = new THREE.MeshStandardMaterial({
          color,
          map: p.tex ? texture(p.tex, renderer) : null,
          transparent: tint[3] < 1, opacity: tint[3], depthWrite: tint[3] >= 1,
          alphaTest: p.png || (p.tex && /\.png$/i.test(p.tex)) ? 0.5 : 0,   // cut-out textures (objective markers)
          ...SURFACE[info.material] || SURFACE[0],
        });
        // deployment guide planes reach below the table top: cut them off at the surface
        if (m.k === GUIDE_KEY) mat.clippingPlanes = aboveTable || (aboveTable = [new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)]);
        if (m.k === MAT_KEY) {
          // ruin floors, rubble and bases sit exactly on the mat: push it back in depth so
          // they always win instead of flickering
          Object.assign(mat, { polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
          splitTopFaces(p.geometry);
          matSides = matSides || new THREE.MeshBasicMaterial({ color: 0x000000 });   // flat black, unlit
        }
        const mesh = new THREE.Mesh(p.geometry, m.k === MAT_KEY ? [mat, matSides] : mat);
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(M);
        mesh.castShadow = tint[3] >= 1; mesh.receiveShadow = true;
        mesh.userData.model = m.k;
        group.add(mesh);
      }
      if (progress.onChange) progress.onChange();
      redraw();
    }).catch(() => {});
  }
}
