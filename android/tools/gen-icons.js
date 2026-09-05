/* Rasterize the wallet's SVG emblem into every Android icon the app needs:
   legacy launcher icons (48–192 px), adaptive-icon foregrounds (the glyph
   alone, inside the 66 dp safe zone of a 108 dp canvas) and the 512 px
   splash. Run from the repository root:  node android/tools/gen-icons.js
   Needs Playwright with Chromium (npm i -D playwright && npx playwright
   install chromium). The PNGs are committed, so this is only needed when
   the emblem changes. */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');
const svg = fs.readFileSync(path.join(ROOT, 'public', 'assets', 'icon.svg'), 'utf8');
/* The strokes only (no rounded square): what an adaptive icon draws over
   the solid background colour. */
const glyph = svg.match(/<g[\s\S]*<\/g>/)[0];

const DENSITY = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

function loadPlaywright() {
  try { return require('playwright'); } catch (_) {}
  for (const p of ['/opt/node22/lib/node_modules/playwright', '/usr/lib/node_modules/playwright']) {
    try { return require(p); } catch (_) {}
  }
  throw new Error('playwright not found: npm i -D playwright && npx playwright install chromium');
}

(async () => {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    executablePath: fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined,
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });

  async function shoot(markup, size, out) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${markup.replace('<svg ', `<svg width="${size}" height="${size}" style="display:block" `)}</body></html>`);
    await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    console.log('wrote', path.relative(ROOT, out));
  }

  /* Legacy launcher icon: the full emblem, rounded square included. */
  const legacy = svg.replace(/^\s*<\?xml[^>]*>\s*/, '');
  /* Adaptive foreground: glyph centred in the 66/108 safe zone. */
  const foreground = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108"><g transform="translate(21 21) scale(1.03125)">${glyph}</g></svg>`;
  /* Round legacy icon: the emblem clipped to a circle. */
  const round = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><clipPath id="c"><circle cx="32" cy="32" r="32"/></clipPath></defs><g clip-path="url(#c)">${legacy.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')}</g></svg>`;

  for (const [name, scale] of Object.entries(DENSITY)) {
    const dir = path.join(RES, `mipmap-${name}`);
    fs.mkdirSync(dir, { recursive: true });
    await shoot(legacy, Math.round(48 * scale), path.join(dir, 'ic_launcher.png'));
    await shoot(round, Math.round(48 * scale), path.join(dir, 'ic_launcher_round.png'));
    await shoot(foreground, Math.round(108 * scale), path.join(dir, 'ic_launcher_foreground.png'));
  }
  fs.mkdirSync(path.join(RES, 'drawable'), { recursive: true });
  await shoot(legacy, 512, path.join(RES, 'drawable', 'splash.png'));
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
