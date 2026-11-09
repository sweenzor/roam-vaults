// Builds dist/extension.js for Roam Depot (developer mode: load the dist folder).
// The indexer worker is bundled first and inlined as a string, then started from a Blob URL.
import * as esbuild from 'esbuild';
import fs from 'node:fs';

const common = { bundle: true, minify: false, target: 'es2022', legalComments: 'none', logLevel: 'warning' };
const worker = await esbuild.build({ ...common, entryPoints: ['src/worker.ts'], format: 'iife', write: false });
await esbuild.build({
  ...common,
  entryPoints: ['src/main/index.ts'],
  format: 'esm',
  outfile: 'dist/extension.js',
  define: { WORKER_SOURCE: JSON.stringify(worker.outputFiles[0].text) },
});
for (const f of ['README.md', 'CHANGELOG.md']) fs.copyFileSync(f, `dist/${f}`);
console.log('built dist/extension.js', fs.statSync('dist/extension.js').size, 'bytes');
