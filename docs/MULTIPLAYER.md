# Multiplayer: sharing one table across browsers

**Status: the first playable version is built** (Trystero, as recommended below). The code is
in `src/net/`: `session.js` is the network seam, `sync.js` the host and guest logic and the
Play online panel, and `protocol.js` the pure parts (room codes, seats, the host's check,
cleaning incoming data), tested in `tests/unit/net.test.js`.

How to use it: press **Host a game** in the Play online panel and send the link
(`…#room=CODE`). The host plays Ash, the first guest Slate, and anyone after that watches.
The host's address becomes `#host=CODE`, so a reload keeps hosting the same room and
restores the game from `localStorage`; guests reconnect by themselves. Online, only the
host changes the map, rules, imports or resets; Undo goes to the host's one undo stack.

Testing: add `?net=local` to the address and tabs of one browser talk over a
BroadcastChannel instead of WebRTC (no network). `tests/e2e/online.spec.js` uses it: host
and guest in two tabs, moves both ways, a refused move, End TP, Undo, the map lock.

## Fair dice

**Status: built.** Online with both players at the table, no browser rolls on its own.
Every roll (Shoot, Fight, the dice boxes and their re-rolls) is a shared roll that neither
player can choose or foresee, and each browser checks the other's dice and wounds. The Play
online panel says **Fair dice: shared rolls · N checked**, and a roll's log line ends in
**fair roll #N**. Offline, or while the host is alone, dice are `Math.random` as before.

How a roll works (commit-reveal, `src/net/fairdice.js`):

1. Each browser makes a random 128-bit secret for each roll and first sends only its
   SHA-256 hash, a "commitment": it can't change the secret afterwards.
2. The roller (the side acting) sends what it rolls for (this shot with these terms, these
   dice in the box) and reveals its secret, with the commitment for its next one.
3. The other browser checks the secret against the commitment, then reveals its own.
4. The dice are SHA-256 of both secrets and the roll's number, in both browsers. Neither
   secret could be picked to steer them: each was fixed before the other was known.

Commitments ride along with each answer, so a roll costs one message each way. Each side
numbers its own rolls, so both players can roll at once.

The checks:

- The roller puts the result in the game as before and the update says which rolls it holds.
  The other browser works those rolls out from the dice itself (`rollProblem`): both dice
  trays, and the wounds a Shoot or Fight changed.
- Without a roll, dice in a tray can only be cleared, not changed.
- The host refuses a guest's update that doesn't add up (the guest's table snaps back, as
  for a move it isn't allowed). The host is the referee, so a guest can't refuse; it puts a
  ⚠ line in its log instead.
- A roll that is never used (rolled, didn't like it, rolled again) gets a ⚠ line on the
  other side when the next roll comes.
- The other browser also judges the shot itself (cover, obscured, Accurate) and the fight's
  control range, and warns if it sees it differently. It only warns: refusing to answer
  would let a player block the other's rolls.
- Online, a Shoot or Fight can't be undone (Undo stops at it), or Undo would be a re-roll.

What it doesn't cover: a browser can still refuse to answer a roll it doesn't like (the
roller sees no answer after 15 seconds); nothing checks moves; the host still holds the
true game; and watchers don't check rolls. Hand-applied damage (−1 W) is still allowed and
logged.

Code: `fairdice.js` (pure: SHA-256, the dice, the checks, the two-browser protocol; tested
in Node in `tests/unit/fairdice.test.js`), `roll.js` (where Shoot, Fight and the dice boxes
get their dice), `sync.js` (pairing the two players, marking and checking updates).
`tests/e2e/fairdice.spec.js` rolls in two tabs and tries changing dice by hand on each side.

## Share links

**Status: built.** Press **Share this game** (Play online panel) and send the link. Whoever
opens it sees that exact table: map, rules, every operative's position, wounds, order,
ready state and used actions, the turning point, CP and VP, the Miniatures picks, the dice
tray, and the Ops & score panel (cards, score sheet, markers). It
opens as a fresh local game, not online. The opener can play on from there, or press
**Host a game** to take it online. The log says "Opened a shared game from <date>", so it's
clear the table is a snapshot, not live.

**The pick: the whole game in the link** (`…#game=1.<data>`), not a short link backed by
storage. The part after `#` never leaves the browser: GitHub Pages never sees it, and there
is still no server. A short link would need one (a small database plus an API), and the
link already fits, so it has no reason to exist yet.

How it fits:

- `exportGame()` (or `outGame()` for an imported map) gives the game, as for online play.
  Operatives are cut to the fields that change in play, as short arrays; names, stats and
  weapons come from the opener's own roster, exactly as `cleanOps` does online.
- That JSON is compressed with the browser's own `CompressionStream("deflate-raw")` and
  written as base64url (letters, digits, `-` and `_`, safe in any address).
- The first `1.` is the format version, and the JSON carries `v: 1` too. A link from a
  newer version, a cut-short link or junk fails with a plain reason in the panel and leaves
  the table alone.
- Opening a link runs `applyGame()`, so everything goes through the same cleaners as
  online play (`cleanOps`, `cleanTray`, `cleanMinis`, `cleanStrings` for an imported map,
  and the dice tray and mission cleaners). Nothing from a link is put into the page as HTML.
  Decompressing stops at 4 MB, so a tiny "zip bomb" link can't hang the page.

Sizes (measured in `tests/unit/link.test.js`, full address on GitHub Pages):

| Game | Link length |
|---|---|
| Built-in map, 12 operatives mid-game, dice rolled, full score sheet, 6 markers | about 1,100 characters |
| Same, on an imported Gallowdark map (its walls travel in the link) | about 1,550 characters |
| Same, on an imported Volkus map (its 14 piece placements travel in the link) | about 2,600 characters |

Chat apps and email handle 2,000 characters fine; most handle far more. Over 2,000, the
panel still makes the link but warns that some chat apps cut links that long, so email it
or paste it into a note. The models are never in the link: the opener's browser loads them
from Steam, as always.

**Save picture** (next to Share this game) downloads a PNG of the board as it looks now: the 3D
table at twice the screen resolution, or the 2D map at twice its size, with a caption strip
(map, rules, TP, VP, date). It is made in the browser (`src/ui/picture.js`); nothing is uploaded.

Left out on purpose: the game log (it is HTML, and long), the undo history, and each
player's own view (selection, camera, ruler).

Code: `src/net/link.js` (pure: pack, compress, version, decode; tested in Node) and
`src/net/share.js` (the button and opening a link). `tests/e2e/share.spec.js` shares from
one page and opens the link in another.

## Replays

**Status: built.** Every action is recorded as you play. The **Replay** panel offers this
game (and the last one, kept in `localStorage` across a reload) as **Watch replay**, **Share
replay** (a link) or **Save file** (a `.json` to send or keep); **Open replay file…** opens one.

Watching puts a bar above the table: Back / Next (or the ← → keys), Play (one step a
second), a slider, a button per turning point that jumps to its start, and the log lines of
the step. The table is look-only (`state.replay`: `mayControl`, `mayPlay` and `maySetUp` say
no). The address follows the step (`#replay=1.<data>&step=12`), so **Copy link to this step**
or the address bar links straight to that moment. **Leave replay** puts your own table back;
**Play on from here** keeps the shown step as a new game.

How it fits:

- **What a step is.** After every change (`sync.js` `pump()`, the same place online play
  sends the game), the recorder looks once at `exportGame()`, after everything the change
  did has happened (a timeout). Different from the last frame: a new step, with the game
  log lines that came since, as plain text. Back to the frame before it (Undo): the last step
  comes off. A map load, a reset or an opened share link starts a new recording.
- **Saved states, not inputs.** Each step stores the result, not "op 3 dragged here", so a
  replay never re-runs the router or the dice and old replays still play after the engine
  changes.
- **Packed.** The first frame is a whole game, packed as a share link packs it. Each step
  after it carries only the operative fields that changed (`[op, field, value, …]`), any of
  tray, dice, mission and miniatures that changed, and its log lines. Then the same
  deflate-raw and base64url as share links. Format version `1.`, and `v: 1` in the JSON.
- **Opening one** goes through `applyGame()` frame by frame, so the same cleaners as share
  links and online play apply; log lines are put in with `textContent`. Online, opening a
  replay link leaves the room first; watching your own replay asks you to leave first.

Sizes (`tests/unit/replay.test.js`): a four-turning-point game with 63 steps, each with a
log line, is a link of about 2,700 characters. Over 2,000 the panel warns that some chat apps
cut links that long; the file has no limit.

Code: `src/net/replay.js` (pure: record, undo, pack, decode; tested in Node) and
`src/net/replayer.js` (recorder, viewer bar, Replay panel). `tests/e2e/replay.spec.js`
records a game in one page and steps through the link in another.

Below is the research and plan online play was built from.

Goal: one person hosts a game. Others open a link and see the same table, live. Each
player moves their own operatives. Viewers can watch.

## How browsers talk to each other

There are two ways to get a message from my browser to yours.

**1. Direct, browser to browser (WebRTC data channels).** Browsers can open a direct pipe
to each other. It is fast and encrypted, and no server sees the game data. But two browsers
can't find each other on their own. First they swap a short "here is how to reach me" note
(this is called **signaling**). Something both can reach must carry that note: a small
server, a public relay, anything. After that, the pipe is direct.

Home routers usually allow the direct pipe. Some networks don't: strict office Wi-Fi, some
mobile carriers, some hotel networks. Then the browsers need a **TURN relay**: a server
that forwards the traffic for them. Without TURN, a few player pairs will never connect.
Estimates vary, but it is somewhere between 1 in 10 and 1 in 5 pairs, and it is worse on
mobile data.

**2. Through a server (WebSockets).** Every browser keeps one open connection to a server
on the normal HTTPS port. The server forwards each message to everyone in the room. This
works on every network a web page works on. The cost is that someone has to run the server.
That can be us, with a few lines on Cloudflare, or a service such as Supabase.

For a turn-based game, speed doesn't matter. Messages are a few kilobytes, a few times a
minute. Either way is fast enough. **Reliability and setup effort decide it.**

## What the game must share

From reading the code:

| What | Where it lives | Size | Notes |
|---|---|---|---|
| Map choice | `MAP` in `src/engine/world.js` | a key, e.g. `"v1"` | Built-in maps send the key. Each browser runs `buildWorld()` itself, which is deterministic. Imported TTS maps (`MAPS.imp1`, `MAPS.import`) exist only in the host's browser, so the host sends the converted map object (terrain rects or piece placements, no meshes). |
| Ruleset | `RULES` in `src/rules/index.js` | an id | Guest runs `useRuleset(id, false)` then loads the map. |
| Operatives | `OPS` in `src/engine/world.js` | about 3 KB for 12 | `x, y, ap, used, wounds, alive, order, ready, weapon`. Plain JSON already: `snapshot()` serialises it. |
| Turning point, CP, VP | `tray` in `src/ui/panels.js` | tiny | `{tp, cp, vp}` |
| Miniatures picks | `minis` in `src/view3d/units.js` | tiny | Team id and model index per operative, per side. |
| Game log | `#log`, written by `logLine()` in `src/ui/dom.js` | small | The lines are HTML. See "Safety" below. |
| Undo | `undoStack` in `src/ui/panels.js` | up to 40 snapshots | Should live on the host only. |

**Stays local, never shared:** selection, target, drag in progress, ruler, move-type button,
2D/3D view and camera (`state` in `src/state.js`). Each player keeps their own.

**Each browser loads itself, never sent between players:** the terrain models and the
Miniatures. Every browser fetches them from the Steam CDN, as today (`src/data/tts-sources.js`,
`src/view3d/units.js`). The game only sends "side B uses team X, model 3 for B2". This keeps
the rule in `CLAUDE.md`: we never host or pass on the third-party models.

## How it fits the existing code

The code already has one good seam. Every action that changes the game calls `snapshot()`
first, changes `OPS` or `tray`, then calls `renderAll()`. The actions are:

- move: `landDrag()` in `src/ui/input.js`
- shoot and fight: `doShoot()`, `doFight()` in `src/ui/panels.js`
- end activation, order toggle: `src/ui/panels.js`
- end turning point, reset, map and rules pickers: `src/ui/controls.js`
- undo: `doUndo()` in `src/ui/panels.js`

**The model: the host keeps the true game.** Guests send what they did; the host applies
it and sends everyone the new full state.

For a first version, keep it simple and trust friends:

1. The player who acts runs the action in their own browser, exactly as today. Routing,
   sight and dice all run locally, so no engine code changes.
2. Their browser sends the new state `{seq, ops, tray, log}` to the host.
3. The host checks two things: the sender only changed their own side's operatives, and
   `seq` follows the last one. Then it saves it on its undo stack and sends it to everyone.
4. Everyone replaces `OPS` and `tray` with it (`doUndo()` already does exactly this
   replace: `OPS.splice(0, OPS.length, ...o.ops); Object.assign(tray, o.tray)`) and redraws.

Sending the whole state each time (about 3 KB) is simpler than sending changes, and it
can't drift out of step. A late joiner gets the same full state.

Later, if cheating or two people acting at once becomes a problem, move dice to the host:
pull the rules part of `doShoot()` / `doFight()` out of the UI into a function like
`resolveShoot(shooterId, targetId, sight)` that the host runs. Not needed for friends.
(Built differently: see "Fair dice" above. Dice come from both browsers, not the host.)

**Undo** goes to the host. A guest presses Undo, the host pops its stack and sends the
result. Simple rule: anyone may undo the last action. Players sort out disputes by talking.

**Seats.** The host picks a side, the first guest gets the other side, everyone after that
watches. `armDrag()` and the action buttons do nothing for operatives that aren't yours.
The Miniatures panel only lets you change your own side.

## The options

| Option | How you join | Account or server we run | Cost | Works on every network? | Privacy | Effort |
|---|---|---|---|---|---|---|
| **Trystero** (WebRTC, signaling over public Nostr or MQTT relays) | Link with a room code | None | Free | Most pairs. Some fail without a TURN relay | Game data goes direct and encrypted. Public relays see only the encrypted handshake. Players see each other's IP address | About 1 day |
| **PeerJS** (WebRTC, signaling over the free PeerJS cloud server) | Link with the host's peer id | None. Relies on one community server, `0.peerjs.com`, with no uptime promise | Free | Same as Trystero | Same as Trystero | About 1 day |
| **Cloudflare Worker + Durable Object** (our own tiny WebSocket relay) | Link with a room code | Free Cloudflare account. We deploy about 60 lines once with `wrangler` | Free tier: 100,000 requests a day, incoming WebSocket messages count 20 to 1. Far more than we need | Yes, it is plain HTTPS | Messages pass through our worker on Cloudflare. No third party stores them | About 1.5 days, plus the one-time deploy |
| **Supabase Realtime** (hosted WebSocket "broadcast" channels) | Link with a room code | Supabase account and project. The public key goes in the page | Free: 200 connections, 100 messages a second. Free projects pause after about a week unused | Yes | Supabase sees the messages | About 1 day |
| **Firebase Realtime Database** | Link with a room code | Google account and project, plus security rules | Free: 100 connections at once | Yes | Google sees and stores the messages | About 1 to 1.5 days |
| **Liveblocks / PartyKit / Yjs** (shared-document sync) | Link with a room code | Liveblocks account, or Cloudflare for PartyKit (Cloudflare owns PartyKit now) | Free tiers exist | Yes, if using their server | The vendor sees the data | 2 to 3 days. These sync a shared document that everyone edits at once. Our game is "one actor at a time, host decides", so they add weight without helping |

Speed (latency) is fine for all of them, well under a quarter of a second, so it isn't a
column.

Two notes that apply to all options:

- **Joining.** Put the room in the link's `#` part: `https://jfreal.github.io/skirmishtable/#room=K7Q2-9XMB`.
  The part after `#` never reaches GitHub's servers. Use a long random code. Anyone with the
  link can join, so it is the key to the room.
- **Safety.** `logLine()` puts HTML into the page. A message from another browser must never
  go into the page as HTML, or a stranger with the link could run code in your page. Send
  log entries as plain text and show them with `textContent`, or allow only `<b>` and
  `<span class="dice|crit">`.

## Recommendation: Trystero first, Cloudflare relay as the backup

**Pick Trystero for the first playable version.**

- No account, no server, no second deploy. It ships inside the same single-file build to
  the same GitHub Pages site. This fits a prototype.
- Game data goes straight between the players and is encrypted.
- It can use several public relays at once (`relayConfig.redundancy`), so one relay going
  down doesn't stop a game. PeerJS depends on a single community server.
- Our traffic is tiny and turn-based, which is the easy case for WebRTC.

**The risk:** a few player pairs (mostly on mobile data or strict networks) won't connect
without a TURN relay. If that happens in a real game, add the backup: a Cloudflare Worker
with a Durable Object that relays messages over a WebSocket. That works on every network.
To make that swap cheap, put all networking behind one small module (`src/net/session.js`,
below). The rest of the game never knows which one is in use.

The other choice would be to build the Cloudflare relay first: it always connects, but it
needs a Cloudflare account and a separate deploy before anyone can play. I'd start with
Trystero, because it gets a first game going with nothing to set up.

## Build plan

New files:

- `src/net/session.js`: the transport seam. `host()`, `join(code)`, `send(msg, to?)`,
  `onMessage(fn)`, `onPeerJoin(fn)`, `onPeerLeave(fn)`, `leave()`. First version wraps
  Trystero's `joinRoom({appId: "skirmishtable", password: code}, code)` and one
  `makeAction("game")`. A Cloudflare version would wrap a WebSocket with the same shape. A
  third, in-memory version lets tests run two "browsers" in one page.
- `src/net/sync.js`: game state in and out. `exportGame()` gives
  `{seq, mapKey or map, rules, ops, tray, minis, log}`; `applyGame(s)` loads the map if it
  changed, then replaces `OPS`, `tray` and `minis` and redraws. Holds my seat (side 0, side 1
  or viewer), the host's undo stack, and the ownership check.
- `tests/unit/sync.test.js`: export then apply gives the same state; a guest can't change
  the other side's operatives; `seq` out of order is rejected.

Changed files:

- `package.json`: add `trystero` (version 0.26.0, the latest on npm today) as a dependency.
  Vite bundles it into the single file.
- `index.html`: a small "Play online" box: Host game, Copy link, who's connected, my seat.
- `src/ui/panels.js`: `snapshot()` marks the state as changed; after the action, send it
  (host: to everyone; guest: to the host). `doUndo()` asks the host when online.
- `src/ui/board.js` or `src/ui/panels.js`: one hook after `renderAll()` that sends the state
  if it was marked changed. This catches every action in one place.
- `src/ui/input.js`: `armDrag()` and `clickOp()` don't act on operatives you don't own.
- `src/ui/controls.js`: map, rules, End TP and Reset go through the host when online. Read
  `#room=` at start-up and join.
- `src/ui/dom.js`: a `logText()` that writes plain text, for log lines from the network.
- `src/view3d/units.js`, `src/ui/minis.js`: apply the shared picks; only your own side is
  editable. (Another session is editing these two files now. Do this part after it lands.)

**First playable version looks like this:**

1. John clicks **Host game** and picks side A. The page shows a link.
2. A friend opens the link on their own computer. They get side B and see the same map,
   rules and operatives.
3. Each player drags only their own operatives. Moves, shots, fights, orders, End
   activation, End TP and Undo show up in the other browser within a second, with the same
   log lines.
4. Both pick Miniatures for their own side. Each browser loads the models from Steam itself.
5. A third person opening the link watches.

Not in the first version: host-side dice, choosing which side the host plays, showing the
other player's drag preview live, and a TURN relay. (Reconnecting after the host reloads
made it in: the host saves the game to `localStorage` and restores it.)

## Sources

- Trystero: https://github.com/dmotz/trystero (strategies, `turnConfig`, `relayConfig.redundancy`)
- PeerJS: https://peerjs.com/docs (cloud server on port 443, advice to self-host)
- Cloudflare Durable Objects pricing: https://developers.cloudflare.com/durable-objects/platform/pricing
- Cloudflare TURN pricing (1,000 GB a month free, then $0.05 per GB): https://developers.cloudflare.com/realtime/pricing/
- Supabase Realtime limits: https://supabase.com/docs/guides/realtime/limits
