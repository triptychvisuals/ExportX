#!/usr/bin/env node
'use strict';

/**
 * End-to-end smoke test for an ExportX portal implementation.
 *
 *   node check-portal.js <portalUrl> <token> [--big <MB>] [--category <id>]
 *
 * Generates three small files (a "final", a "cut" and a "still"), builds a
 * manifest exactly like the plugin does, and runs ping → create → PUT × 3 →
 * complete with the plugin's own client. Exits 1 on the first failure and
 * prints the portal's error text. Pass --big 2048 to add one 2 GB file and
 * check proxy limits and timeouts.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { PortalClient, buildManifest } = require('../client/portal');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const [portalUrl, token] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && (i === 0 || !all[i - 1].startsWith('--')));
if (!portalUrl || !token) {
  console.error('Usage: node check-portal.js <portalUrl> <token> [--big <MB>] [--category <id>]');
  process.exit(2);
}
const bigMb = Number(arg('--big', 0));
const category = arg('--category', null);

function writeFile(dir, name, bytes) {
  const p = path.join(dir, name);
  const fd = fs.openSync(p, 'w');
  const chunk = Buffer.alloc(1024 * 1024, 0x58);
  let left = bytes;
  while (left > 0) {
    const n = Math.min(left, chunk.length);
    fs.writeSync(fd, chunk, 0, n);
    left -= n;
  }
  fs.closeSync(fd);
  return p;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exportx-smoke-'));
  const since = Date.now();
  const jobs = [
    { jobId: 'smoke-final', kind: 'final', label: 'Final', profileId: 'final-4k-h265', profileName: 'Final 4K', timeline: 'Smoke Test', targetDir: dir, fileName: '261018_Smoke_Final', format: 'mp4', codec: 'H265', settings: { FormatWidth: 3840, FormatHeight: 2160 }, mark: null },
    { jobId: 'smoke-cut', kind: 'cut', label: 'Social', profileId: 'cuts-social-1080', profileName: 'Social cuts', timeline: 'Smoke Test', targetDir: dir, fileName: '261018_Smoke_Social_01', format: 'mp4', codec: 'H264', settings: { FormatWidth: 1920, FormatHeight: 1080 }, mark: { index: 1, kind: 'cut', tcIn: '01:00:04:00', tcOut: '01:00:09:11', durationFrames: 132 } },
    { jobId: 'smoke-still', kind: 'still', label: 'Still', profileId: 'stills-tiff', profileName: 'Stills TIFF', timeline: 'Smoke Test', targetDir: dir, fileName: '261018_Smoke_Still_01', format: 'tif', codec: 'RGB16', settings: {}, mark: { index: 1, kind: 'still', tcIn: '01:00:20:20', tcOut: '01:00:20:20', durationFrames: 1 } },
  ];
  writeFile(dir, '261018_Smoke_Final.mp4', 3 * 1024 * 1024);
  writeFile(dir, '261018_Smoke_Social_01.mp4', 1024 * 1024);
  writeFile(dir, '261018_Smoke_Still_01_0086500.tif', 512 * 1024);
  if (bigMb > 0) {
    jobs.push({ jobId: 'smoke-big', kind: 'final', label: 'Master', profileId: 'final-prores-master', profileName: 'Master', timeline: 'Smoke Test', targetDir: dir, fileName: '261018_Smoke_Master', format: 'mov', codec: 'ProRes422HQ', settings: {}, mark: null });
    console.log(`writing a ${bigMb} MB file…`);
    writeFile(dir, '261018_Smoke_Master.mov', bigMb * 1024 * 1024);
  }

  const client = new PortalClient({ portalUrl, token, timeoutMs: 60000, userAgent: 'ExportX-smoke' });
  console.log(`1. GET ${client.base}/ping`);
  const ping = await client.ping();
  console.log(`   ok: portal="${ping.portal}" version=${ping.version} categories=${(ping.categories || []).map((c) => c.id || c).join(',') || '(none)'}`);

  const bundle = buildManifest({ project: 'ExportX smoke', timeline: 'Smoke Test', fps: 24, jobs, namePattern: '{yymmdd}_{project}_{label}', exportxVersion: 'smoke', category }, { since });
  if (bundle.missing.length) throw new Error(`files not found: ${JSON.stringify(bundle.missing)}`);
  console.log(`2. POST /batches with ${bundle.files.length} file(s)`);
  let last = null;
  const result = await client.uploadBatch(bundle, {
    onFile: (ev) => {
      if (ev.state === 'uploading' && ev.percent !== last && ev.percent % 25 === 0) {
        process.stdout.write(`   ${ev.key}: ${ev.percent}%\n`);
        last = ev.percent;
      }
      if (ev.state === 'uploaded') console.log(`3. PUT ${ev.key}: uploaded${ev.fileId ? ` (fileId ${ev.fileId})` : ''}`);
      if (ev.state === 'failed') console.log(`3. PUT ${ev.key}: FAILED ${ev.error}`);
    },
  });
  console.log(`4. POST /batches/${result.batchId}/complete → ${result.failed.length ? 'partial' : 'complete'}${result.url ? ` ${result.url}` : ''}`);
  fs.rmSync(dir, { recursive: true, force: true });
  if (result.failed.length) {
    console.error(`FAILED: ${result.failed.length} file(s) rejected`);
    process.exit(1);
  }
  console.log('OK: the portal speaks ExportX v1.');
})().catch((err) => {
  console.error(`FAILED: ${err.message}${err.status ? ` (HTTP ${err.status})` : ''}`);
  process.exit(1);
});
