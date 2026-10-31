/**
 * The dice boxes: physical dice, the way Kill Team players handle them in Tabletop Simulator.
 * One per side, behind a die icon in a bottom corner of the table (Ash left, Slate right),
 * so the attacker and the defender can roll at the same time. Pick how many and they land
 * loose on the mat. Press any of them and the whole pile comes up in your hand; shake it
 * (they rattle), then let go over the box and they tumble. When they stop they line up in
 * six slots by face, and the roll goes to that side's tray (log, online play) like any
 * other. Pick slotted dice up and throw them again to re-roll them: one die, or several
 * selected by clicking or by dragging a box round them. Each die re-rolls once; after that
 * it stays in its slot, marked with a dot. Shoot / Fight dice and the other
 * player's rolls tumble through their box too, so everyone sees them land.
 */
import { d6 } from '../engine/dice.js';
import { TEAMNAME } from '../config.js';
import { clearDice, diceTrays, mayRoll, onDiceRender, rerollDice, setHit, setRoll, tally, wasRerolled } from './dicetray.js';
import { atRest, handOffsets, shaker, slotSpots, speed, stepDice } from './dicephys.js';

const S = 22, R = S / 2;           // die size and collision radius, px
const RIM = 7;                     // the box's wooden rim, px
const NARROW = 720;                // below this a screen has room for one box at a time
const rnd = (a, b) => a + Math.random() * (b - a);
const boxes = [];
// sound on or off, remembered in this browser
const SOUND = "skirmishtable.diceSound";
let sound = true;
try { sound = localStorage.getItem(SOUND) !== "off"; } catch (e) {}
function setSound(on) {
  sound = on;
  try { localStorage.setItem(SOUND, on ? "on" : "off"); } catch (e) { /* private window */ }
  for (const b of boxes) b.updateBar();
}

/* ---------- sound: clicks of filtered noise, made here (no audio files) ---------- */
let ac = null, noise = null, lastClack = 0;
function audio() {
  if (!sound) return null;
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === "suspended") ac.resume();
    if (!noise) {
      noise = ac.createBuffer(1, Math.ceil(ac.sampleRate * 0.05), ac.sampleRate);
      const ch = noise.getChannelData(0);
      for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ch.length / 6));
    }
    return ac;
  } catch (e) { return null; }
}
function click(vol, when = 0) {
  const a = audio(); if (!a) return;
  const t = a.currentTime + when, src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
  src.buffer = noise; f.type = "bandpass"; f.frequency.value = rnd(1600, 4200); f.Q.value = 2.5;
  g.gain.value = vol;
  src.connect(f); f.connect(g); g.connect(a.destination); src.start(t);
}
const rattle = n => { for (let i = 0; i < Math.min(n, 6); i++) click(rnd(0.15, 0.3), i * 0.014 + rnd(0, 0.02)); };
function clack(s) {
  const now = performance.now();
  if (now - lastClack < 35) return;
  lastClack = now; click(Math.min(0.6, s / 1800));
}

/* ---------- one side's box ---------- */
function makeBox(side, dock) {
  const tray = () => diceTrays[side];
  const dice = [];                 // {el, face, val, idx, mode, x, y, vx, vy, rot, vr, sel, ...}
  // mode: loose (on the mat, not rolled) · held · rolling · glide (sliding to a spot) · slot
  let open = false, geo = null, hand = null;
  let raf = 0, lastT = 0, rollT0 = 0, settleT = 0;

  const mat = document.createElement("div");
  mat.className = "dicemat"; mat.id = "dicemat" + side; mat.hidden = true;
  mat.setAttribute("role", "dialog"); mat.setAttribute("aria-label", `${TEAMNAME[side]} dice box`);
  mat.innerHTML = `
    <div class="dmbar">
      <span class="dmtitle">${TEAMNAME[side]}</span>
      ${[1, 2, 3, 4, 5, 6].map(n => `<button class="mini" data-n="${n}" title="Put ${n} dice on the mat">${n}</button>`).join("")}
      <button class="mini dmadd" title="One more die">+1</button>
      <button class="mini dmthrow" title="Throw the loose (or selected) dice in for me">Throw</button>
      <label class="dmhitl" title="The hit or save target">on <select class="dmhit">${[2, 3, 4, 5, 6].map(h => `<option>${h}</option>`).join("")}</select>+</label>
      <button class="mini dmend dmsound" title="Dice sounds"></button>
      <button class="mini dmclose" title="Hide the dice box">✕</button>
    </div>
    <div class="dmplay">
      <div class="dmfelt" data-hint="grab the dice, shake, drop them in the box"></div>
      <div class="dmbox" title="Drop dice here to roll them"></div>
    </div>
    <div class="dmslots">${[1, 2, 3, 4, 5, 6].map(f => `<div class="dmslot">${f}</div>`).join("")}</div>
    <div class="dmsum"></div>
    <div class="dmdice"></div>
    <div class="dmlasso" hidden></div>`;
  dock.prepend(mat);
  const icon = dock.querySelector(".diceicon"), badge = dock.querySelector(".dicebadge");
  const $ = s => mat.querySelector(s);
  const bar = $(".dmbar"), felt = $(".dmfelt"), box = $(".dmbox"), layer = $(".dmdice"), lasso = $(".dmlasso"), sum = $(".dmsum");
  const slotEls = [...mat.querySelectorAll(".dmslot")];

  /* ---------- geometry (px from the mat's top-left) ---------- */
  function rel(el, inset = 0) {
    const m = mat.getBoundingClientRect(), r = el.getBoundingClientRect();
    return { x0: r.left - m.left + inset, y0: r.top - m.top + inset, x1: r.right - m.left - inset, y1: r.bottom - m.top - inset };
  }
  function measure() {
    geo = { felt: rel(felt), outer: rel(box), box: rel(box, RIM),
            slots: slotEls.map(e => { const r = rel(e); return { x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0 }; }) };
  }
  const inside = (b, x, y) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
  const clampTo = (b, d) => { d.x = Math.min(b.x1 - R, Math.max(b.x0 + R, d.x)); d.y = Math.min(b.y1 - R, Math.max(b.y0 + R, d.y)); };
  function local(ev) { const m = mat.getBoundingClientRect(); return [ev.clientX - m.left, ev.clientY - m.top]; }

  /* ---------- dice ---------- */
  function makeDie(x, y) {
    const el = document.createElement("div");
    el.className = "mdie"; el.innerHTML = "<i></i>".repeat(9);
    layer.appendChild(el);
    const d = { el, face: 1 + Math.floor(Math.random() * 6), val: null, idx: null, mode: "loose",
                x, y, vx: 0, vy: 0, rot: rnd(-25, 25), vr: 0, sel: false, flick: 0 };
    el.addEventListener("pointerdown", ev => press(ev, d));
    dice.push(d);
    return d;
  }
  function removeDie(d) { d.el.remove(); dice.splice(dice.indexOf(d), 1); }
  function result(v) { return v === 6 ? "crit" : v === 1 || v < tray().hit ? "miss" : "hit"; }
  const spent = d => d.idx != null && wasRerolled(side, d.idx);   // used its one re-roll
  function draw(d) {
    const lift = d.mode === "held" ? 1.15 : 1, c = d.el.classList;
    d.el.dataset.f = d.face;
    d.el.style.transform = `translate(${d.x - R}px, ${d.y - R}px) rotate(${d.rot}deg) scale(${lift})`;
    const res = d.idx != null && (d.mode === "slot" || d.mode === "glide") ? result(d.val) : "";
    for (const k of ["crit", "hit", "miss"]) c.toggle(k, res === k);
    c.toggle("held", d.mode === "held"); c.toggle("sel", d.sel);
    c.toggle("rr", !!res && spent(d));
  }
  // a free spot on the mat for a new loose die
  function freeSpot(b) {
    let best = null, bestGap = -1;
    for (let k = 0; k < 40; k++) {
      const x = rnd(b.x0 + R + 2, b.x1 - R - 2), y = rnd(b.y0 + R + 2, b.y1 - R - 2);
      const gap = Math.min(...dice.filter(d => d.mode === "loose").map(d => Math.hypot(d.x - x, d.y - y)), 1e9);
      if (gap > S * 1.25) return [x, y];
      if (gap > bestGap) { bestGap = gap; best = [x, y]; }
    }
    return best;
  }

  /* ---------- the loop: runs only while something moves ---------- */
  function kick() { if (!raf) { lastT = performance.now(); raf = requestAnimationFrame(frame); } }
  function frame(t) {
    raf = 0;
    const dt = Math.min(0.033, (t - lastT) / 1000); lastT = t;
    let busy = false;
    if (hand && hand.lifted) {
      busy = true;
      const jig = 2 + hand.sh.level * 7;
      for (const d of hand.group) {
        const k = Math.min(1, dt * 22);
        d.x += (hand.px + d.ox + rnd(-jig, jig) - d.x) * k;
        d.y += (hand.py + d.oy + rnd(-jig, jig) - d.y) * k;
        d.rot += rnd(-1, 1) * hand.sh.level * 30;
      }
    }
    const rolling = dice.filter(d => d.mode === "rolling");
    if (rolling.length) {
      busy = true;
      if (t - rollT0 > 2600) for (const d of rolling) d.vx = d.vy = 0;   // never wait forever
      const hit = stepDice(rolling, geo.box, R, dt);
      if (hit > 90) clack(hit);
      for (const d of rolling) {
        if (speed(d) > 70) { if (t - d.flick > 65) { d.face = 1 + Math.floor(Math.random() * 6); d.flick = t; } }
        else d.face = d.val;   // tumbling over: the face it was always going to land on
      }
      if (rolling.every(atRest)) { if (!settleT) settleT = t; else if (t - settleT > 300) settle(rolling); }
      else settleT = 0;
    }
    for (const d of dice) if (d.mode === "glide") {
      busy = true;
      const u = Math.min(1, Math.max(0, (t - d.g.t0) / d.g.dur)), e = 1 - Math.pow(1 - u, 3);
      d.x = d.g.x0 + (d.g.x - d.g.x0) * e; d.y = d.g.y0 + (d.g.y - d.g.y0) * e;
      d.rot = d.g.r0 + (d.g.r - d.g.r0) * e;
      if (u >= 1) d.mode = d.g.then;
    }
    for (const d of dice) draw(d);
    if (busy) raf = requestAnimationFrame(frame);
  }
  function glide(d, x, y, then, delay = 0, rot = rnd(-6, 6)) {
    d.mode = "glide";
    d.g = { x0: d.x, y0: d.y, r0: d.rot, x, y, r: rot, then, t0: performance.now() + delay, dur: 360 };
  }
  // every rolled die to its slot; `now` skips the slide (opening the box, resizing)
  function toSlots(now = false) {
    const ds = dice.filter(d => d.idx != null).sort((a, b) => a.idx - b.idx);
    const spots = slotSpots(ds.map(d => d.val), geo.slots, S);
    let k = 0;
    ds.forEach((d, i) => {
      if (d.mode === "held" || d.mode === "rolling") return;
      const [x, y] = spots[i];
      if (now) { Object.assign(d, { x, y, mode: "slot" }); return; }
      if (d.mode === "slot" && Math.hypot(d.x - x, d.y - y) < 0.5) return;
      d.face = d.val; glide(d, x, y, "slot", 40 * k++);
    });
    kick();
  }

  // The thrown dice stopped: tell the tray (it logs and shares the roll), then slot them.
  function settle(rolling) {
    settleT = 0;
    const thrown = rolling.filter(d => d.commit);
    for (const d of rolling) { d.mode = "glide"; d.commit = false; d.face = d.val; }
    if (thrown.length) {
      const fresh = thrown.filter(d => d.idx == null);
      if (fresh.length) {
        // new dice join whatever is already in the slots, as one roll; slotted dice thrown
        // with them have used their re-roll, and ones that already had keep that
        const used = [...tray().rerolled, ...thrown.filter(d => d.idx != null).map(d => d.idx)];
        const all = [...dice.filter(d => d.idx != null).sort((a, b) => a.idx - b.idx), ...fresh];
        all.forEach((d, i) => d.idx = i);
        setRoll(all.map(d => d.val), side, "", used);
      } else rerollDice(side, thrown.map(d => d.idx), thrown.map(d => d.val));
    }
    toSlots();
    sync();   // anything that changed in the tray while these were in the air
  }

  function throwDice(group, v) {
    const b = geo.box;
    let [vx, vy] = v;
    const s = Math.hypot(vx, vy);
    if (s > 1500) { vx *= 1500 / s; vy *= 1500 / s; }
    for (const d of group) {
      clampTo(b, d);
      const a = rnd(0, 2 * Math.PI), toss = rnd(200, 460);
      Object.assign(d, { mode: "rolling", commit: true, val: d6(), sel: false,
                         vx: vx * 0.8 + Math.cos(a) * toss, vy: vy * 0.8 + Math.sin(a) * toss, vr: rnd(-1400, 1400) });
    }
    rollT0 = performance.now(); settleT = 0;
    clack(1200);
    kick();
  }
  // dice that arrive from elsewhere (Shoot / Fight, the other player) roll in from the box's
  // left edge, already knowing their faces
  function tumbleIn(d, v, i) {
    const b = geo.box;
    Object.assign(d, { val: v, mode: "rolling", commit: false,
                       x: b.x0 + R + rnd(0, 18), y: rnd(b.y0 + R, b.y1 - R),
                       vx: rnd(500, 900), vy: rnd(-250, 250), vr: rnd(-1200, 1200), flick: i });
  }

  /* ---------- hands ---------- */
  const grabbable = d => d.mode === "loose" || (d.mode === "slot" && !spent(d));
  function press(ev, d) {
    if (ev.button > 0 || !grabbable(d)) return;
    ev.preventDefault(); ev.stopPropagation();
    if (!mayRoll(side)) return;
    const group = d.sel ? dice.filter(x => x.sel && grabbable(x))
      : d.mode === "loose" ? dice.filter(x => x.mode === "loose") : [d];
    measure();
    const [x, y] = local(ev);
    hand = { die: d, group, x0: x, y0: y, px: x, py: y, lifted: false, sh: shaker() };
    try { mat.setPointerCapture(ev.pointerId); } catch (e) { /* already let go */ }
    audio();   // browsers only start sound from a press
  }
  function pressMat(ev) {
    if (ev.button > 0 || ev.target.closest("button, select, label")) return;
    measure();
    const [x, y] = local(ev);
    hand = { lasso: true, x0: x, y0: y, px: x, py: y };
    try { mat.setPointerCapture(ev.pointerId); } catch (e) { /* already let go */ }
  }
  function move(ev) {
    if (!hand) return;
    const [x, y] = local(ev);
    hand.px = x; hand.py = y;
    if (hand.lasso) {
      if (Math.hypot(x - hand.x0, y - hand.y0) < 4 && lasso.hidden) return;
      lasso.hidden = false;
      Object.assign(lasso.style, { left: Math.min(x, hand.x0) + "px", top: Math.min(y, hand.y0) + "px",
                                   width: Math.abs(x - hand.x0) + "px", height: Math.abs(y - hand.y0) + "px" });
      return;
    }
    if (!hand.lifted) {
      if (Math.hypot(x - hand.x0, y - hand.y0) < 5) return;
      hand.lifted = true;
      const offs = handOffsets(hand.group.length, S * 0.95);
      hand.group.forEach((d, i) => { d.from = d.mode; d.mode = "held"; d.sel = false; [d.ox, d.oy] = offs[i]; });
      rattle(hand.group.length);
    }
    if (hand.sh.push(x, y, ev.timeStamp || performance.now())) {
      rattle(hand.group.length);
      for (const d of hand.group) d.face = 1 + Math.floor(Math.random() * 6);
    }
    box.classList.toggle("armed", inside(geo.outer, x, y));
    kick();
  }
  function release(ev) {
    if (!hand) return;
    const h = hand; hand = null;
    box.classList.remove("armed");
    if (h.lasso) {
      if (lasso.hidden) for (const d of dice) d.sel = false;   // a click on the mat: nothing selected
      else {
        const b = { x0: Math.min(h.x0, h.px), x1: Math.max(h.x0, h.px), y0: Math.min(h.y0, h.py), y1: Math.max(h.y0, h.py) };
        for (const d of dice) d.sel = grabbable(d) && inside(b, d.x, d.y);
      }
      lasso.hidden = true;
      dice.forEach(draw);
      return;
    }
    if (!h.lifted) { h.die.sel = !h.die.sel; draw(h.die); return; }   // a click picks dice to carry
    if (ev.type !== "pointercancel" && inside(geo.outer, h.px, h.py)) { throwDice(h.group, h.sh.velocity(ev.timeStamp || performance.now())); return; }
    // put down outside the box: loose dice stay where they fell, rolled dice go back to their slots
    for (const d of h.group) {
      if (d.from === "loose") { d.mode = "loose"; const p = { x: d.x, y: d.y }; clampTo(geo.felt, p); glide(d, p.x, p.y, "loose", 0, d.rot); }
      else d.mode = "slot";
    }
    toSlots();
    sync();   // a roll that landed in this tray while the dice were in the hand (Shoot / Fight)
  }

  /* ---------- buttons ---------- */
  function spawn(n, add) {
    measure();
    if (!add) {
      for (const d of [...dice]) removeDie(d);
      if (tray().dice.length) clearDice(side);
    }
    const room = 20 - dice.length;
    for (let i = 0; i < Math.min(n, room); i++) {
      const [x, y] = freeSpot(geo.felt), d = makeDie(x, y);
      d.el.classList.add("drop");
      click(0.2, i * 0.03 + rnd(0, 0.02));
    }
    dice.forEach(draw);
  }
  // for the impatient: throw the loose (or selected) dice in for you
  function autoThrow() {
    measure();
    const sel = dice.filter(d => d.sel && grabbable(d)), group = sel.length ? sel : dice.filter(d => d.mode === "loose");
    if (!group.length) return;
    const b = geo.box;
    for (const d of group) { d.x = b.x0 + R + rnd(0, 20); d.y = rnd(b.y0 + R, b.y1 - R); }
    throwDice(group, [rnd(700, 1000), rnd(-200, 200)]);
  }
  function updateBar() {
    const off = !mayRoll(side), t = tray();
    bar.querySelectorAll("[data-n], .dmadd, .dmthrow, .dmhit").forEach(b => b.disabled = off);
    bar.querySelector(".dmhit").value = String(t.hit);
    bar.querySelector(".dmsound").textContent = sound ? "Sound on" : "Sound off";
    slotEls.forEach((e, i) => { e.className = "dmslot " + result(i + 1); });
    const c = tally(t.dice, t.hit);
    sum.innerHTML = t.dice.length
      ? `${t.label ? t.label + " · " : ""}<b>${c.crit}</b> crit · <b>${c.norm}</b> hit · ${t.dice.length - c.crit - c.norm} miss` +
        (t.rerolled.length ? ` · ${t.rerolled.length} re-rolled` : "")
      : `<span class="hint">${off ? "The other player rolls here." : "Pick how many, then grab, shake and drop them in the box."}</span>`;
    badge.textContent = t.dice.length ? `${c.crit}·${c.norm}` : "";
  }

  /* ---------- following the tray ---------- */
  // The tray changed (a roll here, Shoot / Fight, the other player, Clear, the hit number):
  // make the slotted dice match it. Dice not ours to settle yet are left alone.
  function sync() {
    updateBar();
    if (dice.some(d => d.mode === "held" || d.mode === "rolling")) { dice.forEach(draw); return; }
    const vals = tray().dice, byIdx = new Map(dice.filter(d => d.idx != null).map(d => [d.idx, d]));
    for (const [i, d] of byIdx) if (i >= vals.length) { removeDie(d); byIdx.delete(i); }
    // a new roll tumbles every die, even one that lands on its old face; a re-roll only the changed
    const fresh = !tray().rerolled.length && vals.some((v, i) => !byIdx.has(i) || byIdx.get(i).val !== v);
    // a roll from elsewhere (Shoot / Fight, the other player) opens the box to watch it land
    if (fresh && vals.length && !open && innerWidth >= NARROW) show(true);
    if (open) measure();
    let n = 0;
    vals.forEach((v, i) => {
      let d = byIdx.get(i);
      if (d && d.val === v && !fresh) return;
      if (!d) { d = makeDie(0, 0); d.idx = i; }
      if (open) tumbleIn(d, v, n++);
      else { d.val = d.face = v; d.mode = "slot"; }
    });
    if (!open) return;
    if (n) { rollT0 = performance.now(); settleT = 0; kick(); }
    else toSlots();
  }

  function show(on) {
    open = on;
    mat.hidden = !on;
    icon.classList.toggle("on", on);
    icon.setAttribute("aria-expanded", on);
    if (on && innerWidth < NARROW) for (const b of boxes) if (b.side !== side && b.isOpen()) b.show(false);   // a phone has room for one
    if (on) { measure(); toSlots(true); for (const d of dice) if (d.mode === "loose") clampTo(geo.felt, d); dice.forEach(draw); }
  }

  bar.querySelectorAll("[data-n]").forEach(b => b.onclick = () => spawn(+b.dataset.n, false));
  bar.querySelector(".dmadd").onclick = () => spawn(1, true);
  bar.querySelector(".dmthrow").onclick = autoThrow;
  bar.querySelector(".dmhit").onchange = e => setHit(side, +e.target.value);
  bar.querySelector(".dmsound").onclick = () => setSound(!sound);
  bar.querySelector(".dmclose").onclick = () => show(false);
  mat.addEventListener("pointerdown", pressMat);
  mat.addEventListener("pointermove", move);
  mat.addEventListener("pointerup", release);
  mat.addEventListener("pointercancel", release);
  icon.onclick = () => show(!open);
  window.addEventListener("resize", () => { if (open) show(true); });
  return { side, sync, show, updateBar, isOpen: () => open };
}

export function wireDiceBox() {
  for (const side of [0, 1]) {
    const dock = document.getElementById("dicedock" + side);
    if (dock) boxes.push(makeBox(side, dock));
  }
  onDiceRender(() => { for (const b of boxes) b.sync(); });
  for (const b of boxes) b.sync();
}
