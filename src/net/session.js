/**
 * The network seam: one room, one kind of message. This version is Trystero (WebRTC,
 * browsers talk directly; public Nostr relays only carry the handshake). A WebSocket relay
 * could replace it with the same functions. See docs/MULTIPLAYER.md.
 *
 * With `?net=local` in the address, tabs of one browser talk over a BroadcastChannel
 * instead: no network at all, for the end-to-end tests and offline demos.
 */
import { joinRoom, selfId } from 'trystero';

export { selfId };
const LOCAL = typeof location !== "undefined" && /[?&]net=local\b/.test(location.search);
let room = null, action = null, chan = null;

// handlers: onMessage(data, peerId), onJoin(peerId), onLeave(peerId), onError(message)
export function openRoom(code, handlers) {
  closeRoom();
  if (LOCAL) return openLocal(code, handlers);
  const { onMessage, onJoin, onLeave, onError } = handlers;
  room = joinRoom({ appId: "skirmishtable", password: code }, code,
    { onJoinError: e => onError && onError(e && e.error ? e.error : String(e)) });
  action = room.makeAction("game");
  action.onMessage = (data, ctx) => onMessage(data, ctx.peerId);
  room.onPeerJoin = onJoin;
  room.onPeerLeave = onLeave;
}
// to everyone in the room, or to one peer
export function send(data, to) {
  if (chan) chan.postMessage({ k: "msg", from: selfId, to: to || null, data });
  else if (action) action.send(data, to ? { target: to } : undefined).catch(() => {});
}
export function closeRoom() {
  if (chan) { chan.postMessage({ k: "leave", from: selfId }); chan.close(); }
  if (room) room.leave().catch(() => {});
  room = null; action = null; chan = null;
}

// BroadcastChannel room: a newcomer says "join", everyone already there answers "here"
function openLocal(code, { onMessage, onJoin, onLeave }) {
  const c = chan = new BroadcastChannel("skirmishtable-room-" + code);
  const peers = new Set();
  const meet = id => { if (!peers.has(id)) { peers.add(id); onJoin(id); } };
  c.onmessage = ({ data: m }) => {
    if (!m || m.from === selfId) return;
    if (m.k === "join") { c.postMessage({ k: "here", from: selfId, to: m.from }); meet(m.from); }
    else if (m.k === "here" && m.to === selfId) meet(m.from);
    else if (m.k === "leave") { if (peers.delete(m.from)) onLeave(m.from); }
    else if (m.k === "msg" && (!m.to || m.to === selfId)) onMessage(m.data, m.from);
  };
  addEventListener("pagehide", () => { if (chan === c) c.postMessage({ k: "leave", from: selfId }); });
  c.postMessage({ k: "join", from: selfId });
}
