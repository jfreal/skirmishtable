// OBJ reader for the scans loaded from Steam: same conventions as tools/model_pack.py.
import { describe, it, expect } from 'vitest';
import { parseOBJ } from '../../src/import/obj.js';
import { TTS_SOURCES } from '../../src/data/tts-sources.js';

const QUAD = `# unit quad in the xz plane, facing up
v 0 0 0
v 1 0 0
v 1 0 1
v 0 0 1
vt 0 0
vt 1 0
vt 1 1
vt 0 1
f 1/1 4/4 3/3 2/2
`;

describe('parseOBJ', () => {
  const o = parseOBJ(QUAD);

  it('splits a quad into two triangles over four vertices', () => {
    expect(o.pos.length).toBe(12);
    expect(o.idx.length).toBe(6);
    expect(Array.from(o.uv)).toEqual([0, 0, 0, 1, 1, 1, 1, 0]);
  });

  it('negates X the way TTS imports OBJ', () => {
    expect(Array.from(o.pos.filter((_, i) => i % 3 === 0))).toEqual([-0, -0, -1, -1]);
  });

  it('computes normals when the file has none, still facing up after the mirror', () => {
    for (let i = 0; i < 4; i++) expect(o.nrm[i * 3 + 1]).toBeCloseTo(1);
  });

  it('keeps faces counter-clockwise seen from their normal', () => {
    const p = i => [o.pos[i * 3], o.pos[i * 3 + 1], o.pos[i * 3 + 2]];
    const [a, b, c] = [p(o.idx[0]), p(o.idx[1]), p(o.idx[2])];
    const u = b.map((v, i) => v - a[i]), w = c.map((v, i) => v - a[i]);
    expect(u[2] * w[0] - u[0] * w[2]).toBeGreaterThan(0);   // (u x w).y
  });

  it('survives a damaged file: skips faces with missing vertices, counts lost texture coordinates, rebuilds normals', () => {
    // vt 2 and vn 2 were lost (as when an upload has binary garbage mid-file); vertex 9 never existed
    const t = parseOBJ('v 0 0 0\nv 1 0 0\nv 0 0 1\nvt 0 0\nvn 0 1 0\nf 1/1/1 3/2/2 2/1/1\nf 1/1/1 9/1/1 2/1/1\n');
    expect(t.idx.length).toBe(3);
    expect(t.missingUV).toBe(1);
    for (let i = 0; i < 3; i++) expect(t.nrm[i * 3 + 1]).toBeCloseTo(1);
  });

  it('reuses a vertex referenced twice with the same v/vt/vn', () => {
    const t = parseOBJ('v 0 0 0\nv 1 0 0\nv 0 1 0\nv 1 1 0\nf 1 2 3\nf 3 2 4\n');
    expect(t.pos.length).toBe(12);
  });
});

describe('TTS_SOURCES', () => {
  it('links every model to the current Steam CDN, as OBJ or bundle', () => {
    for (const [k, e] of Object.entries(TTS_SOURCES)) {
      const url = e.obj || e.bundle;
      expect(url, k).toMatch(/^https:\/\/cdn\.steamusercontent\.com\/ugc\//);
      expect(url.endsWith(k + '/'), k).toBe(true);
      expect(e.bounds.length).toBe(2);
    }
  });
});
