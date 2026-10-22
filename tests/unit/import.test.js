// Tabletop Simulator importers, run on the real Workshop saves. Those are third-party
// content, so they're never in the repo: `npm run fetch:saves` downloads them into
// cache/workshop/ (git-ignored), and these tests skip when they aren't there.
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import * as tts from '../../src/import/tts.js';
import * as world from '../../src/engine/world.js';

const save = id => new URL(`../../cache/workshop/${id}.bson`, import.meta.url);
const read = id => {
  const buf = readFileSync(save(id));
  return buf[0] === 0x7b ? JSON.parse(buf) : tts.parseBSON(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
};
const VOLKUS = '3573927734', GALLOWDARK1 = '3353224453';
beforeAll(() => world.initMaps());

describe.skipIf(!existsSync(save(VOLKUS)))('Volkus layout bags (KT24 Killzone Mod save)', () => {
  let doc;
  beforeAll(() => { doc = read(VOLKUS); });

  it('reads the WorkshopUpload BSON save and finds all twelve layout bags', () => {
    const names = new Set(tts.findVolkusBags(doc).map(b => b.Nickname));
    for (const y of ['24', '25']) for (let i = 1; i <= 6; i++) expect(names).toContain(`Volkus ${y} 0${i}`);
  });

  it('converts a bag to exactly the placements built into the app', () => {
    const bag = tts.findVolkusBags(doc).find(b => b.Nickname === 'Volkus 24 01');
    const m = tts.convertVolkusBag(bag, 'imported');
    expect(m.fine).toBe(true);
    expect(m.dropEdge).toBe('short');
    // the built-in layouts store transforms rounded to 3-4 decimals; the save has full precision
    const builtIn = world.MAPS.v1.place;
    expect(m.place.map(p => p.k)).toEqual(builtIn.map(p => p.k));
    m.place.forEach((p, i) => {
      for (const f of ['x', 'y', 'a', 's']) expect(p[f]).toBeCloseTo(builtIn[i][f], 1);
    });
    expect(m.objectives).toEqual(world.MAPS.v1.objectives);
  });
});

describe.skipIf(!existsSync(save(GALLOWDARK1)))('Gallowdark (Approved Ops 1 save)', () => {
  it('converts walls, hatchways and objectives like the built-in map', () => {
    const m = tts.convertGallowdark(read(GALLOWDARK1), 'imported');
    const builtIn = world.MAPS.gd1;
    expect(m.terrain).toHaveLength(builtIn.terrain.length);
    expect(m.terrain.filter(t => t.hatch)).toHaveLength(builtIn.terrain.filter(t => t.hatch).length);
    expect(m.objectives).toHaveLength(3);
    world.buildWorld(m);
    expect(world.OPS).toHaveLength(12);
  });
});
