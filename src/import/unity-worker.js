// Reads Unity asset bundles and OBJ scans off the main thread: a big LZMA bundle takes
// seconds to unpack and a big OBJ a few hundred ms, which would otherwise freeze the table.
// Loaded inline by src/view3d/models.js.
import { readBundle } from './unity.js';
import { parseOBJ } from './obj.js';

self.onmessage = ({ data: { id, buf, kind } }) => {
  try {
    const parts = kind === "obj" ? [parseOBJ(new TextDecoder().decode(buf))] : readBundle(buf), transfer = new Set();
    for (const p of parts) {
      for (const a of [p.pos, p.nrm, p.uv, p.idx]) transfer.add(a.buffer);
      if (p.tex) transfer.add(p.tex.rgba.buffer);
    }
    self.postMessage({ id, parts }, [...transfer]);
  } catch (e) {
    self.postMessage({ id, error: String((e && e.message) || e) });
  }
};
