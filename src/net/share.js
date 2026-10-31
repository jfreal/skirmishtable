/**
 * Share links, the page half: "Share this game" puts the table as it is now into a link
 * (link.js), and opening a "#game=…" link loads that snapshot as a fresh local game. No
 * one hosts; the opener can play on, or press Host a game to take it online. Everything
 * from the link goes through sync.js applyGame, the same cleaning as online play.
 */
import { MAPS } from '../engine/world.js';
import { RULESETS } from '../rules/index.js';
import { hint, logLine } from '../ui/dom.js';
import { undoStack } from '../ui/panels.js';
import { savePicture } from '../ui/picture.js';
import { SOFT_MAX, decodeGame, encodeGame, isGameHash } from './link.js';
import { applyGame, leaveGame, online, outGame } from './sync.js';
import { leaveReplay, restartRecording } from './replayer.js';

let lastLink = "", status = "";
const when = at => at ? new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "an unknown time";
const base = () => location.origin + location.pathname + location.search;

async function share() {
  lastLink = base() + "#game=" + await encodeGame(outGame());
  const long = lastLink.length > SOFT_MAX;
  status = `Link to this table as it is now (${lastLink.length.toLocaleString()} characters).` +
    (long ? " That's long: some chat apps cut links this size, so email it or paste it into a note." : "");
  renderShare();
  const input = document.getElementById("sharelink");
  const done = () => hint("Link copied — whoever opens it sees this table and plays on from here.");
  if (navigator.clipboard) navigator.clipboard.writeText(lastLink).then(done, () => input.select());
  else input.select();
}

export function renderShare() {
  const box = document.getElementById("sharebox");
  if (!box) return;
  box.innerHTML = `<div class="btnrow"><button class="mini" id="sharebtn">Share this game</button>
    <button class="mini" id="picbtn" title="Download a PNG of the board as it looks now">Save picture</button></div>
    ${lastLink ? `<div class="btnrow"><input id="sharelink" readonly aria-label="Link to this game"></div>` : ""}
    <div class="hint" id="sharenote"></div>`;
  if (lastLink) box.querySelector("#sharelink").value = lastLink;
  box.querySelector("#sharenote").textContent = status ||
    "A link to this table as it is now (no hosting: whoever opens it gets their own copy), or a picture of the board to send.";
  box.querySelector("#sharebtn").onclick = () => share().catch(e => { status = "Couldn't make the link: " + e.message; renderShare(); });
  box.querySelector("#picbtn").onclick = () => savePicture().catch(e => hint("Couldn't save the picture: " + e.message));
}

// Why this version can't open a game from a link or file (null = it can)
export function gameProblem(g) {
  if (!RULESETS[g.rules]) return "its rules aren't in this version of SkirmishTable";
  if (!MAPS[g.map] && !(/^imp/.test(g.map) && g.mapDef && typeof g.mapDef === "object")) return "its map isn't in this version of SkirmishTable";
  return null;
}
// Open "#game=…" from the address: a fresh local game, then the address goes back to plain.
export async function openSharedGame(hash = location.hash) {
  if (!isGameHash(hash)) return false;
  const r = await decodeGame(hash);
  history.replaceState(null, "", base());
  const g = r.game;
  const why = r.error || gameProblem(g);
  if (why) {
    status = "Couldn't open that shared game: " + why + ".";
    hint(status); renderShare();
    return false;
  }
  if (online()) leaveGame();
  leaveReplay();                             // a game on the table replaces any replay
  applyGame(g);
  undoStack.length = 0;                      // a fresh game: nothing from before to undo
  restartRecording();
  status = `Opened a shared game from ${when(g.at)}. It's a snapshot: play on from here, or Host a game to play it online.`;
  logLine(`<b>Shared game:</b> ${status.replace(/[<>&"]/g, "")}`);
  hint(status); renderShare();
  return true;
}
export function wireShare() {
  renderShare();
  addEventListener("hashchange", () => { if (isGameHash(location.hash)) openSharedGame(); });
  return openSharedGame();
}
