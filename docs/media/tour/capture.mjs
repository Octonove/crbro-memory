// Frame capture for tour.html: node capture.mjs [--stills 1.2,5.0,...] [--out DIR]
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const stillsArg = args.includes('--stills') ? args[args.indexOf('--stills') + 1] : null;
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'frames';
mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--force-color-profile=srgb', '--hide-scrollbars', '--font-render-hinting=none'],
});
const page = await browser.newPage();
await page.setViewport({ width: 960, height: 600, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(process.cwd(), 'tour.html')).href, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
const total = await page.evaluate(() => window.TOTAL);
const fps = await page.evaluate(() => window.FPS);

const times = stillsArg ? stillsArg.split(',').map(Number) : Array.from({ length: Math.round(total * fps) }, (_, i) => i / fps);
let n = 0;
for (const t of times) {
  await page.evaluate(x => window.render(x), t);
  const name = stillsArg ? `still_${t.toFixed(2)}.png` : `f${String(n).padStart(4, '0')}.png`;
  await page.screenshot({ path: join(out, name), type: 'png' });
  n++;
}
await browser.close();
console.log(`${n} frame(s) · total ${total.toFixed(1)} s · ${fps} fps → ${out}`);
