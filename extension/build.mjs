// Builds dist/extension.js for Roam Depot (developer mode: load the dist folder).
// The indexer worker is bundled first and inlined as a string, then started from a Blob URL.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import zlib from 'node:zlib';

const common = { bundle: true, minify: false, target: 'es2022', legalComments: 'none', logLevel: 'warning' };
// SQLite's wasm build has no import.meta in a classic worker; it is never asked to find its .wasm
// file, because the page hands it a compiled module.
const worker = await esbuild.build({ ...common, entryPoints: ['src/worker.ts'], format: 'iife', write: false, define: { 'import.meta.url': '""' } });
// SQLite's .wasm, gzipped and inlined: Roam Depot allows no code from the network.
const wasm = zlib.gzipSync(fs.readFileSync('node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm'), { level: 9 }).toString('base64');
await esbuild.build({
  ...common,
  entryPoints: ['src/main/index.ts'],
  format: 'esm',
  outfile: 'dist/extension.js',
  define: { WORKER_SOURCE: JSON.stringify(worker.outputFiles[0].text), SQLITE_WASM: JSON.stringify(wasm) },
});
for (const f of ['README.md', 'CHANGELOG.md']) fs.copyFileSync(f, `dist/${f}`);
console.log('built dist/extension.js', fs.statSync('dist/extension.js').size, 'bytes');
