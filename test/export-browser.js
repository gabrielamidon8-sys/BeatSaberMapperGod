// Full export in a real browser: load an MP3, generate, export with a stand-in downloads capability, save the zip.
// node test/export-browser.js <song.mp3> <outdir> [v2|v4]
const path = require('path'), fs = require('fs');
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const [song, outDir, fmt] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.exposeFunction('__save', (name, b64) => { fs.writeFileSync(path.join(outDir, name), Buffer.from(b64, 'base64')); });
  await page.addInitScript(() => {
    window.claude = { use: async name => name === 'downloads' ? { save: async ({ filename, data }) => {
      let bin = ''; const u = new Uint8Array(data.buffer ? data.buffer : data);
      for (let i = 0; i < u.length; i += 32768) bin += String.fromCharCode.apply(null, u.subarray(i, i + 32768));
      await window.__save(filename, btoa(bin));
    } } : null };
  });
  await page.goto('file://' + path.join(__dirname, '..', 'dist', 'beat-mapper.html'));
  await page.setInputFiles('#fileSong', song);
  await page.waitForFunction(() => !document.getElementById('btnGenerate').disabled, null, { timeout: 90000 });
  await page.selectOption('#format', fmt || 'v2');
  await page.click('#btnGenerate');
  await page.waitForFunction(() => document.querySelectorAll('#diffTable tbody tr').length >= 2, null, { timeout: 90000 });
  await page.waitForFunction(() => !document.getElementById('btnExport').hidden, null, { timeout: 5000 });
  await page.click('#btnExport');
  await page.waitForFunction(() => /Saved/.test(document.getElementById('log').textContent), null, { timeout: 120000 });
  console.log((await page.$$eval('#log li', li => li.slice(0, 5).map(x => x.textContent))).join('\n'));
  console.log('errors', JSON.stringify(errors));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
