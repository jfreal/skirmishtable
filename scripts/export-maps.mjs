// Export the built-in Volkus maps (terrain rects, fire steps, objectives, deployment) as
// JSON for tools/verify_maps.py, which scores them against the official map cards.
// Usage: npm run export:maps  ->  cache/export/maps-24.json, maps-25.json
import { mkdirSync, writeFileSync } from 'node:fs';
import * as world from '../src/engine/world.js';

const out = new URL('../cache/export/', import.meta.url);
mkdirSync(out, { recursive: true });
world.initMaps();
for (const [year, prefix] of [['24', 'v'], ['25', 'y']]) {
  const maps = {};
  for (let i = 1; i <= 6; i++) {
    world.buildWorld(world.MAPS[prefix + i]);
    const rect = t => ({ x: t.x, y: t.y, w: t.w, h: t.h, kind: t.kind });
    maps['v' + i] = {
      terrain: world.TERRAIN.map(rect), decor: world.DECOR.map(t => ({ ...rect(t), kind: 'step' })),
      objectives: world.OBJECTIVES, dropEdge: world.MAP.dropEdge, dropDepth: world.MAP.dropDepth,
    };
  }
  writeFileSync(new URL(`maps-${year}.json`, out), JSON.stringify(maps));
  console.log(`wrote cache/export/maps-${year}.json`);
}
