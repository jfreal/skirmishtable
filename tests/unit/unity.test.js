// Decompressors behind the Unity bundle reader (the bundles themselves are third-party,
// so they aren't in the repo; tools-side checks compare whole bundles against UnityPy).
import { describe, it, expect } from 'vitest';
import { lzmaDecode } from '../../src/import/lzma.js';
import { lz4Block, readContainer } from '../../src/import/unity.js';

const TEXT = 'SkirmishTable reads Unity bundles. '.repeat(20) + 'Volkus rubble, fire steps and ruins! '.repeat(10);
// Python's lzma (FORMAT_ALONE, LZMA1) with the 8-byte size field removed, as Unity stores blocks
const SAMPLE = 'XQAAAQAAKZrJJ1Xi4/IUjNWpe+FiREJhsDQBWhJSeFr0xK8sYzwdI9w+gLy3RhkE/+D3seEDiTkrwyS4Wa+mM3OipGEXozmytiSN0hhOLqlqm3JApCC//xAkAAA=';

describe('lzmaDecode', () => {
  it('unpacks a stream from another LZMA encoder exactly', () => {
    const out = lzmaDecode(new Uint8Array(Buffer.from(SAMPLE, 'base64')), TEXT.length);
    expect(new TextDecoder().decode(out)).toBe(TEXT);
  });
});

describe('lz4Block', () => {
  it('copies literals and overlapping matches', () => {
    // "abc" then a match of length 9 at offset 3 -> "abcabcabcabc", then literal "!"
    const block = new Uint8Array([0x35, 97, 98, 99, 3, 0, 0x10, 33]);
    expect(new TextDecoder().decode(lz4Block(block, 13))).toBe('abcabcabcabc!');
  });
});

describe('readContainer', () => {
  it('rejects files that are not UnityFS bundles', () => {
    expect(() => readContainer(new TextEncoder().encode('UnityWeb\0').buffer)).toThrow(/UnityFS/);
  });
});
