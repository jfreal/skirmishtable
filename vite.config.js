import { defineConfig } from 'vite';
import { inlineIntoHtml } from './scripts/inline-plugin.js';

// The production build is one self-contained HTML file (all JS and CSS inlined), so it
// can be opened from disk, dropped on any static host, or published as a Claude artifact.
// three.js and the fonts still load from their CDNs (see index.html).
export default defineConfig({
  plugins: [inlineIntoHtml()],
  build: { target: 'es2020', outDir: 'dist', cssCodeSplit: false, modulePreload: false, assetsInlineLimit: 100000000 },
  test: { include: ['tests/unit/**/*.test.js'], environment: 'node' },
});
