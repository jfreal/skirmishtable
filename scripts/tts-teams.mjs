// Write src/data/tts-teams.js: the Kill Team (2024) operatives of each team mod on the Steam
// Workshop, as links to their models on the Steam CDN — the photoscanned miniature and its
// base, with the transforms the mod gives them. Like tts-sources.js it holds links only: the
// browser loads the models from Steam when a player picks a team.
// Usage: npm run tts:teams   (saves are cached in cache/teams/)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseBSON } from '../src/import/tts.js';

// The Yellowscribed Kill Team series (one author, consistent layout: each operative is a
// base model with the miniature as a child object, named "[w/w] Operative").
const TEAMS = [
  '3348911404', '3357789238', '3352828814', '3348897103', '3352921015', '3352910203', '3352896702',
  '3352829910', '3356062570', '3464050043', '3464054760', '3464059773', '3466150755', '3466172522', '3547861860',
];
const API = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';
const CDN = 'cdn.steamusercontent.com';
const cdn = u => u ? u.replace(/^https?:\/\/[^/]*steamusercontent[^/]*\//, `https://${CDN}/`) : null;   // other hosts kept
const CACHE = new URL('../cache/teams/', import.meta.url);
mkdirSync(CACHE, { recursive: true });

async function details(ids) {
  const body = new URLSearchParams({ itemcount: String(ids.length) });
  ids.forEach((id, i) => body.set(`publishedfileids[${i}]`, id));
  return (await (await fetch(API, { method: 'POST', body })).json()).response.publishedfiledetails;
}
async function save(d) {
  const file = new URL(`${d.publishedfileid}-${d.time_updated}.bson`, CACHE);
  if (!existsSync(file)) writeFileSync(file, Buffer.from(await (await fetch(d.file_url)).arrayBuffer()));
  const buf = readFileSync(file);
  return buf[0] === 0x7b ? JSON.parse(buf) : parseBSON(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
}

const clean = s => (s || '').replace(/\[[0-9a-fA-F]{6}\]|\[-\]|\[\/?[bius]\]|\[sup\]|\[\/sup\]/g, '').trim();
const r4 = v => +(+v || 0).toFixed(4);
const tf = t => ({ p: [r4(t.posX), r4(t.posY), r4(t.posZ)], r: [r4(t.rotX), r4(t.rotY), r4(t.rotZ)], s: [r4(t.scaleX), r4(t.scaleY), r4(t.scaleZ)] });
const col = c => c && [c.r, c.g, c.b].some(v => Math.abs(v - 1) > 1e-3) ? [r4(c.r), r4(c.g), r4(c.b)] : null;
// one drawable: an OBJ (with texture) or a Unity bundle, plus its local transform and tint
function part(o, local) {
  const cm = o.CustomMesh, ca = o.CustomAssetbundle;
  const e = cm ? { obj: cdn(cm.MeshURL), tex: cdn(cm.DiffuseURL) || undefined, material: cm.MaterialIndex || 0 }
    : ca ? { bundle: cdn(ca.AssetbundleURL), material: ca.MaterialIndex || 0 } : null;
  if (!e || !(e.obj || e.bundle)) return null;
  const c = col(o.ColorDiffuse);
  if (c) e.color = c;
  if (local) Object.assign(e, tf(o.Transform));
  return e;
}

// drop models whose files are gone from Steam (deleted uploads answer 404)
const alive = new Map();
async function live(url) {
  if (!alive.has(url)) alive.set(url, fetch(url, { headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(60000) })
    .then(r => r.ok, () => true));   // a timeout isn't proof it's gone
  return alive.get(url);
}
const teams = [];
for (const d of await details(TEAMS)) {
  if (d.result !== 1 || !d.file_url) { console.log(`skip ${d.publishedfileid} (result ${d.result})`); continue; }
  const root = await save(d);
  const name = clean(d.title).replace(/\s*\(Yellowscribed\)\s*/i, '').replace(/\s*Kill Team\b/i, '').trim();
  const models = [], seen = new Set();
  (function visit(o) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(visit); return; }
    const m = /^\s*(\d+)\s*\/\s*(\d+)\s*(.+)$/.exec(clean(o.Nickname));
    const base = m && part(o, false);
    if (base) {
      const parts = (o.ChildObjects || []).map(c => part(c, true)).filter(Boolean);
      const key = JSON.stringify([base.obj || base.bundle, parts.map(p => [p.obj || p.bundle, p.tex])]);
      if (!seen.has(key)) {
        seen.add(key);
        const t = o.Transform || {};
        models.push({ name: m[3].trim(), w: +m[2], s: [r4(t.scaleX), r4(t.scaleY), r4(t.scaleZ)], base, parts });
      }
    }
    for (const k in o) if (k !== 'LuaScript' && k !== 'XmlUI' && k !== 'ChildObjects') visit(o[k]);
  })(root.ObjectStates);
  const ok = [];
  for (const m of models) {
    const urls = [m.base, ...m.parts].flatMap(e => [e.obj || e.bundle, e.tex]).filter(Boolean);
    if ((await Promise.all(urls.map(live))).every(Boolean)) ok.push(m);
    else console.log(`  dropped ${m.name}: a file is gone from Steam`);
  }
  ok.sort((a, b) => a.name.localeCompare(b.name));
  teams.push({ id: d.publishedfileid, name, models: ok });
  console.log(`${d.publishedfileid}  ${name}: ${ok.length} models`);
}
teams.sort((a, b) => a.name.localeCompare(b.name));
const out = new URL('../src/data/tts-teams.js', import.meta.url);
writeFileSync(out, `/**
 * Kill Team operatives from Steam Workshop team mods (Yellowscribed series): links to each
 * miniature and its base on the Steam CDN, with the mod's transforms. Generated by
 * scripts/tts-teams.mjs — links only, no third-party content.
 */
export const TTS_TEAMS = [
${teams.map(t => ` {"id":${JSON.stringify(t.id)},"name":${JSON.stringify(t.name)},"models":[\n${t.models.map(m => `  ${JSON.stringify(m)},`).join('\n')}\n ]},`).join('\n')}
];
`);
console.log(`wrote src/data/tts-teams.js (${teams.length} teams, ${teams.reduce((a, t) => a + t.models.length, 0)} models)`);
