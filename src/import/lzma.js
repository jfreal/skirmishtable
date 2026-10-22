/**
 * LZMA decoder for Unity asset bundle blocks (5 property bytes, then the raw stream,
 * with the unpacked size known from the bundle's block table). A straight port of
 * Igor Pavlov's public-domain reference decoder, LzmaSpec.cpp.
 */
export function lzmaDecode(src, outSize) {
  let d = src[0];
  const lc = d % 9; d = (d / 9) | 0;
  const lp = d % 5, pb = (d / 5) | 0;
  const out = new Uint8Array(outSize);
  let p = 5, range = 0xffffffff, code = 0;
  if (src[p++] !== 0) throw new Error("LZMA: bad stream start");
  for (let i = 0; i < 4; i++) code = ((code << 8) | src[p++]) >>> 0;

  const probs = n => new Uint16Array(n).fill(1024);
  function bit(pr, i) {
    const v = pr[i], bound = (range >>> 11) * v;
    let b;
    if (code < bound) { range = bound; pr[i] = v + ((2048 - v) >>> 5); b = 0; }
    else { code = (code - bound) >>> 0; range = (range - bound) >>> 0; pr[i] = v - (v >>> 5); b = 1; }
    if (range < 0x1000000) { range = (range << 8) >>> 0; code = ((code << 8) | src[p++]) >>> 0; }
    return b;
  }
  function direct(n) {
    let res = 0;
    for (; n > 0; n--) {
      range >>>= 1;
      let b = 0;
      if (code >= range) { code = (code - range) >>> 0; b = 1; }
      res = ((res << 1) | b) >>> 0;
      if (range < 0x1000000) { range = (range << 8) >>> 0; code = ((code << 8) | src[p++]) >>> 0; }
    }
    return res;
  }
  const tree = (pr, base, n) => { let m = 1; for (let i = 0; i < n; i++) m = (m << 1) + bit(pr, base + m); return m - (1 << n); };
  const reverse = (pr, base, n) => { let m = 1, s = 0; for (let i = 0; i < n; i++) { const b = bit(pr, base + m); m = (m << 1) + b; s |= b << i; } return s; };
  const lenCoder = () => ({ choice: probs(2), low: probs(16 << 3), mid: probs(16 << 3), high: probs(256) });
  const lenDecode = (L, posState) => !bit(L.choice, 0) ? tree(L.low, posState << 3, 3)
    : !bit(L.choice, 1) ? 8 + tree(L.mid, posState << 3, 3) : 16 + tree(L.high, 0, 8);

  const literal = probs(0x300 << (lc + lp));
  const isMatch = probs(12 << 4), isRep = probs(12), isRepG0 = probs(12), isRepG1 = probs(12), isRepG2 = probs(12);
  const isRep0Long = probs(12 << 4), posSlot = probs(4 << 6), posDec = probs(115), align = probs(16);
  const len = lenCoder(), repLen = lenCoder();
  let state = 0, rep0 = 0, rep1 = 0, rep2 = 0, rep3 = 0, o = 0;
  const pbMask = (1 << pb) - 1, lpMask = (1 << lp) - 1;

  while (o < outSize) {
    const posState = o & pbMask;
    if (!bit(isMatch, (state << 4) + posState)) {
      const prev = o > 0 ? out[o - 1] : 0;
      const base = 0x300 * (((o & lpMask) << lc) + (prev >>> (8 - lc)));
      let sym = 1;
      if (state >= 7) {
        let match = out[o - rep0 - 1];
        do {
          const mb = (match >>> 7) & 1; match <<= 1;
          const b = bit(literal, base + ((1 + mb) << 8) + sym);
          sym = (sym << 1) | b;
          if (mb !== b) break;
        } while (sym < 0x100);
      }
      while (sym < 0x100) sym = (sym << 1) | bit(literal, base + sym);
      out[o++] = sym - 0x100;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }
    let n;
    if (bit(isRep, state)) {
      if (o === 0) throw new Error("LZMA: rep match at start");
      if (!bit(isRepG0, state)) {
        if (!bit(isRep0Long, (state << 4) + posState)) {
          state = state < 7 ? 9 : 11;
          out[o] = out[o - rep0 - 1]; o++;
          continue;
        }
      } else {
        let dist;
        if (!bit(isRepG1, state)) dist = rep1;
        else { if (!bit(isRepG2, state)) dist = rep2; else { dist = rep3; rep3 = rep2; } rep2 = rep1; }
        rep1 = rep0; rep0 = dist;
      }
      n = lenDecode(repLen, posState);
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2; rep2 = rep1; rep1 = rep0;
      n = lenDecode(len, posState);
      state = state < 7 ? 7 : 10;
      const slot = tree(posSlot, Math.min(n, 3) << 6, 6);
      if (slot < 4) rep0 = slot;
      else {
        const nd = (slot >>> 1) - 1;
        let dist = ((2 | (slot & 1)) << nd) >>> 0;
        if (slot < 14) dist += reverse(posDec, dist - slot, nd);
        else dist += (direct(nd - 4) << 4) + reverse(align, 0, 4);
        rep0 = dist >>> 0;
      }
      if (rep0 === 0xffffffff) break;               // end marker
      if (rep0 >= o) throw new Error("LZMA: distance past start");
    }
    n += 2;
    for (; n > 0 && o < outSize; n--, o++) out[o] = out[o - rep0 - 1];
  }
  return out;
}
