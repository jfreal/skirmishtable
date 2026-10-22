/**
 * Wavefront OBJ reader for the Tabletop Simulator scans, loaded live from the Steam CDN.
 * Mirrors read_obj() in tools/model_pack.py, so a model read here matches the packed
 * public/models/<KEY>.bin: de-indexed on (v, vt, vn), X negated (TTS imports OBJ that
 * way), winding reversed to stay counter-clockwise, normals computed when absent.
 */
export function parseOBJ(text) {
  // Damaged uploads exist (a run of binary in the middle of the file): faces naming a
  // vertex that isn't there are skipped, and missing texture coordinates are counted.
  const V = [], T = [], N = [], P = [], U = [], NN = [], idx = [], keyOf = new Map();
  let missingUV = 0, missingN = 0;
  const ref = (s, len) => { const i = parseInt(s, 10); return i > 0 ? i - 1 : len + i; };
  for (const line of text.split("\n")) {
    const c0 = line.charCodeAt(0), c1 = line.charCodeAt(1);
    if (c0 === 118 && c1 === 32) {                      // "v "
      const p = line.trim().split(/\s+/); V.push(+p[1], +p[2], +p[3]);
    } else if (c0 === 118 && c1 === 116) {              // "vt"
      const p = line.trim().split(/\s+/); T.push(+p[1], p.length > 2 ? +p[2] : 0);
    } else if (c0 === 118 && c1 === 110) {              // "vn"
      const p = line.trim().split(/\s+/); N.push(+p[1], +p[2], +p[3]);
    } else if (c0 === 102 && c1 === 32) {               // "f "
      const corners = [];
      for (const tok of line.trim().split(/\s+/).slice(1)) {
        let k = keyOf.get(tok);
        if (k === undefined) {
          const [vs, ts, ns] = tok.split("/");
          const vi = ref(vs, V.length / 3);
          if (!(vi >= 0 && vi * 3 < V.length)) { corners.length = 0; break; }
          const ti = ts ? ref(ts, T.length / 2) : -1;
          const ni = ns ? ref(ns, N.length / 3) : -1;
          k = P.length / 3;
          keyOf.set(tok, k);
          P.push(V[vi * 3], V[vi * 3 + 1], V[vi * 3 + 2]);
          if (ti >= 0 && ti * 2 < T.length) U.push(T[ti * 2], T[ti * 2 + 1]);
          else { U.push(0, 0); if (ts) missingUV++; }
          if (ni >= 0 && ni * 3 < N.length) NN.push(N[ni * 3], N[ni * 3 + 1], N[ni * 3 + 2]);
          else { NN.push(0, 0, 0); if (ns) missingN++; }
        }
        corners.push(k);
      }
      for (let i = 1; i < corners.length - 1; i++) idx.push(corners[0], corners[i + 1], corners[i]);  // reversed
    }
  }
  const pos = new Float32Array(P), uv = new Float32Array(U), index = new Uint32Array(idx);
  let nrm = new Float32Array(NN);
  if (missingN || !nrm.some(v => v !== 0)) nrm = vertexNormals(pos, index, true);   // none, or damaged
  for (let i = 0; i < pos.length; i += 3) { pos[i] = -pos[i]; nrm[i] = -nrm[i]; }
  return { pos, nrm, uv, idx: index, missingUV };
}

// Area-weighted vertex normals. `flipped` says the winding was already reversed, so the
// face normal is negated to match the original orientation (before X is mirrored).
function vertexNormals(pos, idx, flipped) {
  const n = new Float32Array(pos.length), s = flipped ? -1 : 1;
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f] * 3, b = idx[f + 1] * 3, c = idx[f + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = s * (uy * vz - uz * vy), ny = s * (uz * vx - ux * vz), nz = s * (ux * vy - uy * vx);
    for (const v of [a, b, c]) { n[v] += nx; n[v + 1] += ny; n[v + 2] += nz; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1e-12;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}
