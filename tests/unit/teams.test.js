// The team catalog the Miniatures panel offers: links only, every one on the Steam CDN.
import { describe, it, expect } from 'vitest';
import { TTS_TEAMS } from '../../src/data/tts-teams.js';

const onCdn = e => /^https:\/\/cdn\.steamusercontent\.com\/ugc\//.test(e.obj || e.bundle || '');

describe('TTS_TEAMS', () => {
  it('lists named teams, each with operative models', () => {
    expect(TTS_TEAMS.length).toBeGreaterThan(10);
    for (const t of TTS_TEAMS) {
      expect(t.name, t.id).toMatch(/\S/);
      expect(t.models.length, t.name).toBeGreaterThan(0);
    }
  });

  it('gives every model a name, wounds, and a base and parts on the Steam CDN', () => {
    for (const t of TTS_TEAMS) for (const m of t.models) {
      expect(m.name, t.name).toMatch(/\S/);
      expect(m.w, `${t.name} ${m.name}`).toBeGreaterThan(0);
      expect(onCdn(m.base), `${t.name} ${m.name}`).toBe(true);
      for (const p of m.parts) {
        expect(onCdn(p), `${t.name} ${m.name}`).toBe(true);
        expect(p.p.length + p.r.length + p.s.length).toBe(9);
      }
    }
  });
});
