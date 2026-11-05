// Runs browser/bench.html in headless Chrome via Playwright; serves spike/ over http://localhost.
// node src/harness/browser-bench.ts synthetic hub
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const root = path.join(import.meta.dirname, '../..');
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  if (process.env.DEBUG) console.log('GET', req.url);
  const p = path.join(root, decodeURIComponent(new URL(req.url!, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || !/^(browser|build|out)\//.test(path.relative(root, p))) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}).listen(0);
const port = (server.address() as any).port;
const launchArgs = { executablePath: '/usr/bin/google-chrome', args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'],
  env: { ...process.env, LANG: process.env.CHROME_LANG ?? process.env.LANG ?? '' } };
// --persistent: disk-backed profile (incognito/in-memory OPFS behaves differently, e.g. rejects non-ASCII names)
const persistent = process.argv.includes('--persistent');
const profileDir = path.join(root, 'out/chrome-profile');
if (persistent) fs.rmSync(profileDir, { recursive: true, force: true });
const ctx = persistent ? await chromium.launchPersistentContext(profileDir, launchArgs) : null;
const browser = ctx ? ctx.browser() ?? { version: () => 'persistent', close: () => ctx.close() } : await chromium.launch(launchArgs);
const page = ctx ? await ctx.newPage() : await browser.newPage();
page.on('console', (m: any) => console.log('[page]', m.text()));
page.on('pageerror', (e: any) => console.log('[pageerror]', e.message));
console.log('goto', port);
await page.goto(`http://localhost:${port}/browser/bench.html`, { timeout: 30000 });
console.log('loaded');
await page.waitForFunction('window.ready === true', null, { timeout: 30000 });
console.log('chrome', browser.version());
console.log('nameTest', JSON.stringify(await page.evaluate(() => (window as any).nameTest()), null, 1));
const results: unknown[] = [];
for (const name of process.argv.slice(2).filter((a) => !a.startsWith('--'))) {
  const seed = await page.evaluate(([n, u]: string[]) => (window as any).seed(n, u), [name, `/out/bundle-${name}.json`]);
  console.log('seeded', name, seed);
  const r: any = await page.evaluate((n: string) => (window as any).bench(n), name);
  r.seed = seed;
  r.readSplit = await page.evaluate((n: string) => (window as any).readSplit(n), name);
  console.log(JSON.stringify(r, null, 1));
  results.push(r);
}
fs.writeFileSync(path.join(root, `out/browser-bench${persistent ? '-persistent' : ''}.json`), JSON.stringify(results, null, 1));
await (ctx ? ctx.close() : browser.close());
server.close();
