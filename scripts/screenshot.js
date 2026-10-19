'use strict';
// Render ui/index.html in headless Chromium against ui/mock-api.js and write screenshots.
// Usage: node scripts/screenshot.js [outDir]   (needs playwright + chromium)
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

let pw;
try {
  pw = require('playwright');
} catch (_err) {
  pw = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
}

const REPO = path.join(__dirname, '..');
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(REPO, 'docs', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const profiles = JSON.parse(fs.readFileSync(path.join(REPO, 'profiles', 'default.json'), 'utf8')).profiles;
const mock = fs.readFileSync(path.join(REPO, 'ui', 'mock-api.js'), 'utf8');
const estimate = fs.readFileSync(path.join(REPO, 'src', 'estimate.js'), 'utf8');

(async () => {
  const browser = await pw.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
  const videoUrl = 'file://' + path.join(REPO, 'ui', 'mock-preview.webm');
  await page.addInitScript(`window.__EXPORTX_PROFILES__ = ${JSON.stringify(profiles)}; window.__EXPORTX_PREVIEW_VIDEO__ = ${JSON.stringify(videoUrl)};\n${estimate}\n${mock}`);
  await page.goto('file://' + path.join(REPO, 'ui', 'index.html'));
  await page.waitForTimeout(800);
  // start the preview video (a click counts as the user gesture autoplay policies want)
  const overlay = await page.$('#pv-overlay');
  if (overlay && (await overlay.isVisible())) {
    await overlay.click();
    await page.waitForTimeout(700);
  }
  await page.screenshot({ path: path.join(OUT, 'panel.png') });

  // hold the cut key (C) for a second, then press S for a still
  await page.$eval('#key-cut', (node) => node.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(200);
  await page.keyboard.down('c');
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, 'holding.png') });
  await page.keyboard.up('c');
  await page.waitForTimeout(400);
  await page.keyboard.press('s');
  await page.waitForTimeout(400);

  await page.$eval('#btn-go', (node) => node.scrollIntoView({ block: 'center' }));
  await page.click('#btn-go');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, 'exporting.png') });

  // finish the fake render; the mock then uploads to the fake portal
  await page.evaluate(() => window.__exportxMock.finishRender());
  await page.waitForTimeout(1300);
  await page.screenshot({ path: path.join(OUT, 'uploading.png') });
  await page.waitForFunction(() => /on Triptych Studios/.test(document.getElementById('upload-text').textContent), null, { timeout: 15000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'uploaded.png') });

  await page.click('#tab-settings');
  await page.waitForTimeout(400);
  await page.evaluate(() => { const first = document.querySelector('.deliv-head'); if (first) first.click(); });
  await page.waitForTimeout(300);
  await page.evaluate(() => { const more = document.querySelector('.deliv.open details.more'); if (more) more.open = true; });
  await page.click('#btn-portal-test');
  await page.waitForTimeout(900);
  await page.setViewportSize({ width: 1280, height: 2400 });
  await page.evaluate(() => { window.scrollTo(0, 0); document.querySelectorAll('main, .view, #view-settings').forEach((n) => { n.scrollTop = 0; }); });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'settings.png') });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('#tab-export');
  await page.waitForTimeout(300);

  await page.setViewportSize({ width: 400, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'narrow.png') });

  // A 9:16 timeline: the picker switches, the viewer turns vertical, the range row says "Whole timeline".
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.selectOption('#timeline-pick', 'Social Cut');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, 'vertical.png') });
  const vertical = await page.evaluate(() => ({
    timeline: document.getElementById('timeline-pick').value,
    viewer: document.querySelector('.viewer').className,
    range: document.getElementById('range-text').textContent,
    summary: document.getElementById('export-summary').textContent,
    conn: document.querySelector('.conn span').textContent,
  }));
  console.log('vertical:', JSON.stringify(vertical));
  await page.selectOption('#timeline-pick', 'Main Edit');
  await page.waitForTimeout(600);
  await page.setViewportSize({ width: 400, height: 900 });
  await page.waitForTimeout(300);

  const fonts = await page.evaluate(() => Array.from(document.fonts).filter((f) => f.status === 'loaded').map((f) => f.family + ' ' + f.weight));
  console.log('fonts loaded:', fonts.join(' | '));
  const tally = await page.evaluate(() => ({
    choices: document.querySelectorAll('.choice').length,
    cuts: document.getElementById('cuts-count').textContent,
    stills: document.getElementById('stills-count').textContent,
    files: document.querySelectorAll('.file').length,
    go: document.getElementById('btn-go').textContent,
    video: (() => { const v = document.getElementById('pv'); return v ? `${v.readyState}/${v.videoWidth}x${v.videoHeight}/${v.paused ? 'paused' : 'playing'}` : 'none'; })(),
    pvtc: document.getElementById('pv-tc').textContent,
    delivs: document.querySelectorAll('.deliv').length,
    summary: document.getElementById('export-summary').textContent,
    total: document.getElementById('total-text').textContent,
    range: document.getElementById('range-text').textContent,
    timeline: document.getElementById('timeline-pick').value,
    estimates: Array.from(document.querySelectorAll('.file .est')).map((e) => e.textContent).slice(0, 3),
    formEst: (document.querySelector('.deliv-est') || {}).textContent || '',
    upload: document.getElementById('upload-text').textContent,
    portal: document.getElementById('portal-result').textContent,
    uploadedRows: document.querySelectorAll('.file.up-uploaded').length,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  console.log('tally:', JSON.stringify(tally));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
