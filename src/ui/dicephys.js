/**
 * The dice box's physics and layout, kept free of the DOM so the unit tests can run it.
 * Everything is in pixels of the dice mat, dice are circles of radius r for collisions, and
 * a die is {x, y, vx, vy, rot, vr}. The faces are decided when the dice leave the hand; this
 * only makes them bounce round the box until they stop.
 */

// Friction: speed falls by (DRAG·speed + DECEL) px/s every second, so a hard throw slides
// and a gentle one stops quickly. Under STOP px/s a die is at rest.
const DRAG = 1.6, DECEL = 320, STOP = 14, WALL = 0.55, BUMP = 0.7;
export const speed = d => Math.hypot(d.vx, d.vy);

// One step for the dice rolling in box {x0, y0, x1, y1}. Returns the hardest impact (px/s)
// so the caller can play a clack that loud.
export function stepDice(dice, box, r, dt) {
  let hit = 0;
  for (const d of dice) {
    d.x += d.vx * dt; d.y += d.vy * dt; d.rot += d.vr * dt;
    if (d.x < box.x0 + r) { d.x = box.x0 + r; hit = Math.max(hit, Math.abs(d.vx)); d.vx = Math.abs(d.vx) * WALL; d.vr = -d.vr * 0.8; }
    if (d.x > box.x1 - r) { d.x = box.x1 - r; hit = Math.max(hit, Math.abs(d.vx)); d.vx = -Math.abs(d.vx) * WALL; d.vr = -d.vr * 0.8; }
    if (d.y < box.y0 + r) { d.y = box.y0 + r; hit = Math.max(hit, Math.abs(d.vy)); d.vy = Math.abs(d.vy) * WALL; d.vr = -d.vr * 0.8; }
    if (d.y > box.y1 - r) { d.y = box.y1 - r; hit = Math.max(hit, Math.abs(d.vy)); d.vy = -Math.abs(d.vy) * WALL; d.vr = -d.vr * 0.8; }
  }
  // dice knock each other: push apart, then swap the closing speed along the line between them
  for (let i = 0; i < dice.length; i++) for (let j = i + 1; j < dice.length; j++) {
    const a = dice[i], b = dice[j], dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
    if (L >= 2 * r) continue;
    const nx = L ? dx / L : 1, ny = L ? dy / L : 0, push = (2 * r - L) / 2;
    a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push;
    const closing = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
    if (closing <= 0) continue;
    const k = closing * (1 + BUMP) / 2;
    a.vx -= k * nx; a.vy -= k * ny; b.vx += k * nx; b.vy += k * ny;
    a.vr += (Math.random() - 0.5) * closing; b.vr += (Math.random() - 0.5) * closing;
    hit = Math.max(hit, closing);
  }
  for (const d of dice) {
    const s = speed(d), s2 = Math.max(0, s - (DRAG * s + DECEL) * dt);
    if (s2 < STOP) { d.vx = d.vy = 0; d.vr *= 0.5; } else { d.vx *= s2 / s; d.vy *= s2 / s; }
    d.vr *= Math.exp(-2.5 * dt);
    // keep the dice inside even when a push shoved one through a wall
    d.x = Math.min(box.x1 - r, Math.max(box.x0 + r, d.x));
    d.y = Math.min(box.y1 - r, Math.max(box.y0 + r, d.y));
  }
  return hit;
}
export const atRest = d => d.vx === 0 && d.vy === 0;

// Where each held die sits round the pointer: a tight bunch, as in a fist.
export function handOffsets(n, gap) {
  const out = [[0, 0]];
  for (let ring = 1; out.length < n; ring++) {
    const k = ring * 6;
    for (let i = 0; i < k && out.length < n; i++) {
      const a = i / k * 2 * Math.PI + ring * 0.5;
      out.push([Math.cos(a) * ring * gap, Math.sin(a) * ring * gap]);
    }
  }
  return out.slice(0, n);
}

// Results stacked in six slots, one per face, in roll order. slots[f-1] = {x, y, w, h};
// returns the centre of each die, by index. A slot that overflows squeezes its rows together.
export function slotSpots(values, slots, size, gap = 2, top = 14) {
  const out = [], seen = [0, 0, 0, 0, 0, 0], count = [0, 0, 0, 0, 0, 0];
  for (const v of values) count[v - 1]++;
  values.forEach((v, i) => {
    const s = slots[v - 1], k = seen[v - 1]++;
    const cols = Math.max(1, Math.floor((s.w - 4 + gap) / (size + gap)));
    const rows = Math.ceil(count[v - 1] / cols), room = s.h - top - 4 - size;
    const step = rows > 1 ? Math.min(size + gap, room / (rows - 1)) : 0;
    const used = Math.min(cols, count[v - 1]) * (size + gap) - gap;
    out[i] = [s.x + (s.w - used) / 2 + (k % cols) * (size + gap) + size / 2,
              s.y + top + Math.floor(k / cols) * step + size / 2];
  });
  return out;
}

// Shaking: a hard change of direction while the dice are held is one shake. Feed it pointer
// samples (px, ms); `level` rises with every shake and dies away when the hand is still.
export function shaker() {
  const pts = [];
  let level = 0, last = null, lastT = 0;
  return {
    push(x, y, t) {
      pts.push([x, y, t]);
      while (pts.length > 2 && t - pts[0][2] > 90) pts.shift();
      if (lastT) level *= Math.exp(-2.5 * (t - lastT) / 1000);
      lastT = t;
      const v = this.velocity(t);
      if (Math.hypot(v[0], v[1]) < 260) return false;
      const shook = last && v[0] * last[0] + v[1] * last[1] < 0;
      last = v;
      if (shook) level = Math.min(1.5, level + 0.35);
      return !!shook;
    },
    // px/s over the last ~90 ms; a hand held still since then (`now`, ms) isn't moving
    velocity(now) {
      if (pts.length < 2 || now - pts[pts.length - 1][2] > 100) return [0, 0];
      const a = pts[0], b = pts[pts.length - 1], dt = Math.max(1, b[2] - a[2]) / 1000;
      return [(b[0] - a[0]) / dt, (b[1] - a[1]) / dt];
    },
    get level() { return level; },
  };
}
