import { describe, expect, it } from 'vitest';
import { BREATH_UP, idleFields, idlePhase } from '../../src/view3d/idle.js';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const frame = { x: 0, z: 0, foot: 0.1, H: 1.2 };
const at = (f, v) => [f[3 * v], f[3 * v + 1], f[3 * v + 2]];

describe('idle motion fields', () => {
  // a foot, a chest point out front, the head, an arm held far out at chest height
  const pos = new Float32Array([0.1, 0.12, 0, 0, 0.8, 0.15, 0, 1.3, 0, 0.9, 0.8, 0]);
  const f = idleFields(pos, I, frame);

  it('keeps the feet and base still', () => {
    for (const k of ['breath', 'lean', 'side']) expect(at(f[k], 0)).toEqual([0, 0, 0]);
    expect(idleFields(new Float32Array([0, 0.1, 0, 0.5, 0.11, 0.5]), I, frame)).toBeNull();
  });
  it('swells the chest outward and lifts the head', () => {
    const [x, y, z] = at(f.breath, 1);
    expect(z).toBeGreaterThan(0); expect(x).toBeCloseTo(0);
    expect(y).toBeGreaterThan(0);
    expect(at(f.breath, 2)[1]).toBeCloseTo(BREATH_UP * frame.H);   // the head rises the full amount
  });
  it('moves an arm held out rigidly, no further than the chest swells', () => {
    const out = at(f.breath, 3)[0];
    expect(out).toBeGreaterThan(0);
    expect(out).toBeLessThan(0.01 * frame.H);
  });
  it('leans more the higher up, forward for lean and sideways for side', () => {
    expect(at(f.lean, 2)[2]).toBeGreaterThan(at(f.lean, 1)[2]);
    expect(at(f.side, 2)[0]).toBeLessThan(0);
  });
  it('puts the displacement back into the mesh space', () => {
    // the mesh is mirrored in z and scaled ×2 into the model's frame
    const M = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, -2, 0, 0, 0, 0, 1];
    const local = new Float32Array([0, 0.4, -0.075]);   // the chest point, at (0, 0.8, 0.15) in the frame
    const g = idleFields(local, M, frame), [x, y, z] = at(g.breath, 0), [, Y, Z] = at(f.breath, 1);
    expect(x).toBeCloseTo(0); expect(2 * y).toBeCloseTo(Y); expect(-2 * z).toBeCloseTo(Z);
  });
  it('gives each operative a steady phase of its own', () => {
    expect(idlePhase('0A1')).toBe(idlePhase('0A1'));
    expect(idlePhase('0A1')).not.toBe(idlePhase('0A2'));
    expect(idlePhase('1B3')).toBeGreaterThanOrEqual(0); expect(idlePhase('1B3')).toBeLessThan(60);
  });
});
