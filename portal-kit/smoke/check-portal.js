#!/usr/bin/env node
'use strict';

/**
 * End-to-end check of a portal's ExportX plugin API (v2).
 *
 *   node check-portal.js <portalUrl> <key> [--project <id>] [--big <MB>]
 *
 * Pings, lists the projects, picks one (the --project id, else the first),
 * generates three small files (a "final", a "cut" and a "still"), and runs
 * the plugin's own client through plan → bytes → register for each, then
 * the batch note. Exits 1 on the first failure and prints the portal's
 * message. Pass --big 2048 to add one 2 GB file and check the multipart
 * path and any proxy limits.
 *
 * Against the real portal this lands files on that project's Delivery tab
 * (remove them there afterwards); against the reference server they go to
 * its inbox folder.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { PortalClient, buildManifest, PROTOCOL_VERSION } = require('../client/portal');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && (i === 0 || !all[i - 1].startsWith('--')));
const [portalUrl, token] = positional;
if (!portalUrl || !token) {
  console.error('Usage: node check-portal.js <portalUrl> <key> [--project <id>] [--big <MB>]');
  process.exit(2);
}
const wantProject = arg('--project', null);
const bigMb = Number(arg('--big', 0));

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
  const client = new PortalClient({ portalUrl, token, timeoutMs: 60000, userAgent: 'ExportX-smoke' });
  console.log(`1. GET ${client.base}/api/plugin/ping`);
  const ping = await client.ping();
  console.log(`   ok: portal="${ping.portal}" version=${ping.version} storage=${ping.storage || '?'} key="${ping.key ? ping.key.label : '?'}"`);
  if (String(ping.version) !== PROTOCOL_VERSION) console.log(`   note: this client expects v${PROTOCOL_VERSION}`);

  console.log('2. GET /api/plugin/projects');
  const projects = await client.projects();
  if (!projects.length) throw new Error('the portal has no projects to upload into');
  const project = wantProject ? projects.find((p) => p.id === wantProject) : projects[0];
  if (!project) throw new Error(`no project with id ${wantProject}; the portal has: ${projects.map((p) => p.id).join(', ')}`);
  console.log(`   ${projects.length} project(s); using "${project.name}" (${project.id}${project.jobNumber ? `, ${project.jobNumber}` : ''})`);

  console.log(`3. GET /api/plugin/deliverables?projectId=${project.id}`);
  const view = await client.projectFiles(project.id);
  console.log(`   boxes: ${view.boxes.map((b) => `${b.name} (${b.files})`).join(', ') || '(none; files keep their deliverable name)'}; ${view.files.length} file(s) there already`);

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
    console.log(`   writing a ${bigMb} MB file…`);
    writeFile(dir, '261018_Smoke_Master.mov', bigMb * 1024 * 1024);
  }
  const bundle = buildManifest({ project: 'ExportX smoke', timeline: 'Smoke Test', fps: 24, frames: 240, jobs, namePattern: '{yymmdd}_{project}_{label}', exportxVersion: 'smoke' }, { since });
  if (bundle.missing.length) throw new Error(`files not found: ${JSON.stringify(bundle.missing)}`);

  console.log(`4. ${bundle.files.length} file(s): plan, bytes, register`);
  let last = -1;
  const result = await client.uploadBatch(bundle, {
    projectId: project.id,
    onFile: (ev) => {
      if (ev.state === 'uploading' && ev.percent !== last && ev.percent % 25 === 0) {
        process.stdout.write(`   ${ev.key}: ${ev.percent}%\n`);
        last = ev.percent;
      }
      if (ev.state === 'uploaded') console.log(`   ${ev.key}: registered as "${ev.label}"${ev.box ? ` in box ${ev.box}` : ' (not in a box yet)'}`);
      if (ev.state === 'failed') console.log(`   ${ev.key}: FAILED ${ev.error}`);
    },
  });
  console.log(`5. batch note → ${result.url}`);
  fs.rmSync(dir, { recursive: true, force: true });
  if (result.failed.length) {
    console.error(`FAILED: ${result.failed.length} step(s) failed: ${result.failed.map((f) => `${f.label}: ${f.error}`).join('; ')}`);
    process.exit(1);
  }
  console.log(`OK: the portal speaks the ExportX plugin API v${PROTOCOL_VERSION}. ${result.uploaded.length} file(s) landed in "${project.name}"; open ${result.url} and remove them when you are done.`);
})().catch((err) => {
  console.error(`FAILED: ${err.message}${err.status ? ` (HTTP ${err.status})` : ''}`);
  process.exit(1);
});
