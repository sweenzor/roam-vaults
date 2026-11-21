// Builds extension.js for Roam Depot (developer mode: load this folder).
import * as esbuild from 'esbuild';
import fs from 'node:fs';

await esbuild.build({
  bundle: true, minify: false, target: 'es2022', legalComments: 'none', logLevel: 'warning',
  entryPoints: ['src/index.ts'], format: 'esm', outfile: 'extension.js',
});
console.log('built extension.js', fs.statSync('extension.js').size, 'bytes');
