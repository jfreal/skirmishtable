// Download the Steam Workshop saves the import tests read, into cache/workshop/ (git-ignored:
// they're third-party content and never committed, see CLAUDE.md). Same files and names as
// tools/fetch_assets.py. Tests that need them skip when they're missing.
// Usage: npm run fetch:saves
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

export const SAVES = { volkus: '3573927734', gallowdark1: '3353224453' };
const API = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';
const dir = new URL('../cache/workshop/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const id of Object.values(SAVES)) {
  const file = new URL(`${id}.bson`, dir);
  if (existsSync(file)) { console.log(`cache/workshop/${id}.bson (already there)`); continue; }
  const body = new URLSearchParams({ itemcount: '1', 'publishedfileids[0]': id });
  const d = (await (await fetch(API, { method: 'POST', body })).json()).response.publishedfiledetails[0];
  if (!d.file_url) throw new Error(`Workshop ${id} has no downloadable file (result ${d.result})`);
  const buf = Buffer.from(await (await fetch(d.file_url)).arrayBuffer());
  writeFileSync(file, buf);
  console.log(`cache/workshop/${id}.bson  ${(buf.length / 1e6).toFixed(1)} MB  (${d.title})`);
}
