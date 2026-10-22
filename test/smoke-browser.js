// Headless smoke test for dist/beat-mapper.html.
// Usage: node test/smoke-browser.js <song.ogg> <map.zip> <outdir>
// Checks: no JS errors, learning from a zip, generating two difficulties, export hidden without
// the downloads capability, no horizontal scroll at phone width, and screenshots for review.
const path = require('path');
const fs = require('fs');
const { chromium } = require('/opt/npm-tools/node_modules/playwright');

const PAGE = path.join(__dirname, '..', 'dist', 'beat-mapper.html');
const [song, zip, outDir] = process.argv.slice(2);
if (!song || !zip || !outDir) {
  console.error('usage: node test/smoke-browser.js <song.ogg> <map.zip> <outdir>');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const report = {};

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  phone.on('pageerror', e => errors.push('pageerror: ' + e.message));
  phone.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await phone.goto('file://' + PAGE);
  await phone.waitForTimeout(400);

  report.brainAtStart = await phone.textContent('#brainSummary');
  report.exportVisibleWithoutDownloads = await phone.isVisible('#btnExport');

  await phone.setInputFiles('#fileLearn', zip);
  await phone.waitForFunction(() => /Learned/.test(document.getElementById('log').textContent), null, { timeout: 90000 });
  report.brainAfterLearn = await phone.textContent('#brainSummary');

  await phone.setInputFiles('#fileSong', song);
  await phone.waitForFunction(() => !document.getElementById('songInfo').hidden, null, { timeout: 90000 });
  await phone.waitForFunction(() => !document.getElementById('btnGenerate').disabled, null, { timeout: 5000 });
  report.songFacts = await phone.textContent('#songInfo');

  await phone.fill('#seed', '4242');
  await phone.click('#btnGenerate');
  await phone.waitForFunction(() => document.querySelectorAll('#diffTable tbody tr').length >= 2, null, { timeout: 90000 });
  report.table = await phone.$$eval('#diffTable tbody tr', rows => rows.map(r => r.textContent.replace(/\s+/g, ' ').trim()));
  report.statsText = (await phone.textContent('#stats')).replace(/\s+/g, ' ').trim();
  report.logTail = await phone.$$eval('#log li', items => items.slice(0, 6).map(li => li.textContent));

  // Canvas drew something: the stage is not a flat colour.
  report.trackPixelsVaried = await phone.evaluate(() => {
    const c = document.getElementById('track');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4 * 97) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return seen.size;
  });

  // Let the animation run a moment so the playhead and notes are on screen.
  await phone.waitForTimeout(600);
  report.horizontalOverflowPx = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await phone.screenshot({ path: path.join(outDir, 'phone.png'), fullPage: true });

  const desk = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  desk.on('pageerror', e => errors.push('desktop pageerror: ' + e.message));
  await desk.goto('file://' + PAGE);
  await desk.setInputFiles('#fileSong', song);
  await desk.waitForFunction(() => !document.getElementById('btnGenerate').disabled, null, { timeout: 90000 });
  await desk.click('#btnGenerate');
  await desk.waitForFunction(() => document.querySelectorAll('#diffTable tbody tr').length >= 2, null, { timeout: 90000 });
  await desk.waitForTimeout(400);
  report.desktopOverflowPx = await desk.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await desk.screenshot({ path: path.join(outDir, 'desktop.png'), fullPage: true });

  report.errors = errors;
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch(async e => {
  console.error('smoke test crashed:', e && e.stack ? e.stack : e);
  process.exit(1);
});
