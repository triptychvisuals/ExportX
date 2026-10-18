// Render ui/index.html in headless Chromium against a fake window.exportx and write screenshots.
// Usage: node scripts/screenshot.js [outDir]   (needs playwright + chromium; `npm i -g playwright && npx playwright install chromium`)
'use strict';
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
const profilesJson = fs.readFileSync(path.join(REPO, 'profiles', 'default.json'), 'utf8');

const initScript = `
(() => {
  const profiles = (${profilesJson}).profiles.map(p => ({
    description: '', target: 'timeline', renderPreset: null, renderMode: 'single', resolution: null, frameRate: null,
    settings: {}, subfolder: '', fileSuffix: '', enabledByDefault: true, tags: [], ...p,
    source: '/Applications/ExportX/profiles/default.json',
  }));
  profiles[3].source = '/Users/law/.exportx/profiles/social.json';
  const FPS = 24, START = 86400;
  const pad2 = (n) => String(n).padStart(2, '0');
  const tc = (abs) => { const n = Math.max(0, abs); const f = n % FPS, s = Math.floor(n / FPS) % 60, m = Math.floor(n / (FPS*60)) % 60, h = Math.floor(n / (FPS*3600)); return pad2(h)+':'+pad2(m)+':'+pad2(s)+':'+pad2(f); };
  const dur = (fr) => (fr / FPS).toFixed(1) + 's';
  const timelines = [
    { index: 1, name: 'Main Edit', current: true },
    { index: 2, name: 'Trailer 30s', current: false },
    { index: 3, name: 'Social Cut', current: false },
  ];
  const info = { name: 'Main Edit', startFrame: START, endFrame: START + 24*60*3, fps: FPS, dropFrame: false };
  let markers = { 96: { kind: 'cut', dur: 132 }, 340: { kind: 'cut', dur: 60 }, 500: { kind: 'still', dur: 1 } };
  const buildMarks = () => {
    const list = Object.entries(markers).map(([k, v]) => { const relIn = Number(k), relOut = v.kind === 'still' ? relIn : relIn + v.dur - 1; return { id: v.kind + '@' + relIn, kind: v.kind, relIn, relOut, absIn: START + relIn, absOut: START + relOut, durationFrames: relOut - relIn + 1, tcIn: tc(START + relIn), tcOut: tc(START + relOut), duration: dur(relOut - relIn + 1), index: 0 }; })
      .sort((a, b) => a.relIn - b.relIn);
    let c = 0, s = 0; for (const m of list) m.index = m.kind === 'cut' ? ++c : ++s;
    return list;
  };
  const listeners = { log: [], progress: [], done: [], playhead: [], marks: [] };
  const sub = (k) => (cb) => { listeners[k].push(cb); return () => {}; };
  const emit = (k, data) => { for (const cb of listeners[k]) cb(data); };
  let playheadAbs = START + 24*41 + 7, playing = true, press = null;
  setInterval(() => { if (playing) playheadAbs += 4; emit('playhead', { ok: true, tc: tc(playheadAbs), absFrame: playheadAbs, relFrame: playheadAbs - START, timeline: 'Main Edit', fps: FPS, playing, info }); }, 150);
  const name = (tpl, ctx) => tpl.replace(/\\{(\\w+)\\}/g, (m, k) => ctx[k] ?? '').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
  const plan = (req) => {
    const tls = req.timelines || ['Main Edit'];
    const targets = req.targets || ['timeline', 'cuts', 'stills'];
    const items = [], notes = [];
    const marks = buildMarks();
    for (const tl of tls) for (const id of req.profileIds) {
      const p = profiles.find(x => x.id === id);
      if (!targets.includes(p.target)) continue;
      const dir = p.subfolder ? req.targetDir + '/' + p.subfolder : req.targetDir;
      const ctx = { project: 'SpotA_Launch', timeline: tl, profile: p.id, profileName: p.name, format: p.format, codec: p.codec, width: p.resolution ? p.resolution.width : '', height: p.resolution ? p.resolution.height : '', date: '20261018', time: '101500' };
      if (p.target === 'timeline') { items.push({ timeline: tl, profileId: p.id, profileName: p.name, target: p.target, kind: 'final', targetDir: dir, fileName: name(req.nameTemplate, ctx) + (p.fileSuffix || ''), range: null, mark: null }); continue; }
      const kind = p.target === 'cuts' ? 'cut' : 'still';
      const list = marks.filter(m => m.kind === kind);
      if (!list.length) { notes.push({ profileId: p.id, profileName: p.name, timeline: tl, message: 'No ' + kind + 's marked on "' + tl + '"' }); continue; }
      let tpl = req.nameTemplate; if (!/\\{(cut|n|tc|in|still)\\}/.test(tpl)) tpl += kind === 'cut' ? '_cut{cut}' : '_still{still}';
      for (const m of list) items.push({ timeline: tl, profileId: p.id, profileName: p.name, target: p.target, kind, targetDir: dir, fileName: name(tpl, { ...ctx, cut: pad2(m.index), still: pad2(m.index), n: pad2(m.index), tc: m.tcIn.replace(/:/g, '.') }) + (p.fileSuffix || ''), range: { markIn: m.absIn, markOut: m.absOut }, mark: { index: m.index, kind, tcIn: m.tcIn, tcOut: m.tcOut, duration: m.duration } });
    }
    return { items, notes };
  };
  let jobs = [];
  window.__mock = { listeners, emit, get jobs() { return jobs; }, setPlaying(v) { playing = v; } };
  window.exportx = {
    status: async () => ({ connected: true, mock: false, product: 'DaVinci Resolve Studio', version: '20.1', project: 'SpotA_Launch', timeline: 'Main Edit', timelines, rendering: false, userDir: '/Users/law/.exportx' }),
    profiles: async () => ({ profiles, errors: [] }),
    capabilities: async () => ({ formats: [], presets: [] }),
    pickFolder: async () => '/Volumes/Deliver/SpotA_Launch',
    openFolder: async () => true, openProfilesFolder: async () => true, openProfileFile: async () => true,
    marks: async () => ({ info, marks: buildMarks() }),
    markBegin: async () => { press = { absIn: playheadAbs, tc: tc(playheadAbs), fps: FPS, startedAt: Date.now() }; return press; },
    markEnd: async () => { const a = press.absIn, b = playheadAbs; press = null; const frames = b - a + 1; const kind = frames <= 7 ? 'still' : 'cut'; markers[a - START] = { kind, dur: kind === 'still' ? 1 : frames }; const marks = buildMarks(); return { info, marks, added: marks.find(m => m.relIn === a - START) }; },
    markCancel: async () => true,
    markStill: async () => { markers[playheadAbs - START] = { kind: 'still', dur: 1 }; const marks = buildMarks(); return { info, marks, added: marks.find(m => m.relIn === playheadAbs - START) }; },
    markDelete: async (relIn) => { delete markers[relIn]; return { info, marks: buildMarks() }; },
    marksClear: async (kind) => { for (const k of Object.keys(markers)) if (!kind || markers[k].kind === kind) delete markers[k]; return { info, marks: buildMarks() }; },
    seek: async (abs) => { playheadAbs = abs; return tc(abs); },
    plan: async (req) => plan(req),
    queue: async (req) => { jobs = plan(req).items.map((it, i) => ({ jobId: 'job-' + (i + 1), ...it, format: 'x', codec: 'y' })); return { jobs, errors: [], notes: [], rendering: !!req.startRender }; },
    render: async () => true, stop: async () => true, jobStatus: async () => [],
    getSettings: async () => ({ targetDir: '/Volumes/Deliver/SpotA_Launch', nameTemplate: '{project}_{timeline}_{date}', selectedProfiles: null, clearExisting: false, startRender: true }),
    saveSettings: async (s) => s,
    logHistory: async () => ['[10:14:58] Connected to DaVinci Resolve Studio 20.1', '[10:14:58] Loaded 9 profiles from 2 folders'],
    onLog: sub('log'), onProgress: sub('progress'), onDone: sub('done'), onPlayhead: sub('playhead'), onMarks: sub('marks'),
  };
})();
`;

(async () => {
  const browser = await pw.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1240, height: 880 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
  await page.addInitScript(initScript);
  await page.goto('file://' + path.join(REPO, 'ui', 'index.html'));
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, 'panel.png') });

  // hold the pad mid-press
  const pad = await page.$('#pad');
  const box = await pad.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, 'holding.png') });
  await page.mouse.up();
  await page.waitForTimeout(400);

  // select the cuts profile in the rail, pick a second timeline
  await page.evaluate(() => { const row = [...document.querySelectorAll('.layer')].find((l) => l.querySelector('.name').textContent.includes('Social 1080p')); row.scrollIntoView(); row.click(); });
  await page.click('.chip:nth-child(2)');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'inspector.png') });

  // export stills via the capture button, then simulate progress on everything
  await page.click('.chip:nth-child(2)');
  await page.click('#btn-go');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.__mock.setPlaying(false);
    const jobs = window.__mock.jobs;
    const statuses = jobs.map((j, i) => ({ jobId: j.jobId, status: i < 2 ? 'complete' : i === 2 ? 'rendering' : i === 4 ? 'failed' : 'ready', percent: i < 2 ? 100 : i === 2 ? 62 : 0, error: i === 4 ? 'Codec not available on this platform' : null }));
    const summary = { total: jobs.length, ready: jobs.length - 4, rendering: 1, complete: 2, failed: 1, cancelled: 0, other: 0, percent: Math.round((200 + 62) / jobs.length), done: false };
    window.__mock.emit('log', '[10:15:01] Rendering ' + jobs.length + ' job(s)');
    window.__mock.emit('progress', { statuses, summary });
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'rendering.png') });

  await page.click('#drawer-toggle');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'log.png') });

  await page.setViewportSize({ width: 920, height: 680 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'narrow.png') });

  const fonts = await page.evaluate(() => Array.from(document.fonts).filter((f) => f.status === 'loaded').map((f) => f.family + ' ' + f.weight));
  console.log('fonts loaded:', fonts.join(' | '));
  const tally = await page.evaluate(() => ({ chips: document.querySelectorAll('.chip').length, layers: document.querySelectorAll('.layer').length, groups: document.querySelectorAll('.layer-group').length, cuts: document.getElementById('cuts-count').textContent, stills: document.getElementById('stills-count').textContent, jobs: document.querySelectorAll('#jobs tr').length, previewCount: document.getElementById('preview-count').textContent, inspector: document.querySelector('.insp-title h3') && document.querySelector('.insp-title h3').textContent, playhead: document.getElementById('playhead').textContent }));
  console.log('tally:', JSON.stringify(tally));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
