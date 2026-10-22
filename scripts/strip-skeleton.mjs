// Claude artifacts wrap a published page in their own document skeleton, so the
// artifact build keeps only what goes inside it: <title>, the head links/scripts,
// the inlined <style>/<script>, and the body markup.
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
const html = readFileSync(file, 'utf8');
const head = html.match(/<head>([\s\S]*?)<\/head>/i)[1]
  .replace(/<meta[^>]*>\s*/gi, '')
  .trim();
const body = html.match(/<body>([\s\S]*?)<\/body>/i)[1].trim();
writeFileSync(file, `${head}\n${body}\n`);
console.log(`wrote ${file} (${(Buffer.byteLength(head + body) / 1024).toFixed(0)} KB, no document skeleton)`);
