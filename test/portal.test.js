'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { PortalClient, PortalError, normalizeBaseUrl, findOutputs, buildManifest, registerInput, contentTypeFor } = require('../src/portal');
const { createServer, validateRegister, boxForKind, fileLabel } = require('../portal-kit/reference-server/server');

function tmpDir(prefix = 'exportx-portal-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function withServer(fn, options = {}) {
  const inbox = tmpDir('exportx-inbox-');
  const server = createServer({ token: 'secret', inbox, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await fn({ port, inbox, server, url: `http://127.0.0.1:${port}` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function writeBytes(file, size, fill = 0x58) {
  const fd = fs.openSync(file, 'w');
  const chunk = Buffer.alloc(64 * 1024, fill);
  let left = size;
  while (left > 0) {
    const n = Math.min(left, chunk.length);
    fs.writeSync(fd, chunk, 0, n);
    left -= n;
  }
  fs.closeSync(fd);
}

const JOBS = (dir) => [
  { jobId: 'job-1', kind: 'final', label: 'Final', profileId: 'final-4k-h265', profileName: 'Final 4K', timeline: 'Main Edit', targetDir: dir, fileName: '261018_SpotA_Final', format: 'mp4', codec: 'H265', settings: { FormatWidth: 3840, FormatHeight: 2160 }, mark: null },
  { jobId: 'job-2', kind: 'cut', label: 'Social', profileId: 'cuts-social-1080', profileName: 'Social cuts', timeline: 'Main Edit', targetDir: dir, fileName: '261018_SpotA_Social_01', format: 'mp4', codec: 'H264', settings: { FormatWidth: 1920, FormatHeight: 1080 }, mark: { index: 1, kind: 'cut', tcIn: '01:00:04:00', tcOut: '01:00:09:11', durationFrames: 132 } },
  { jobId: 'job-3', kind: 'still', label: 'Still', profileId: 'stills-tiff', profileName: 'Stills TIFF', timeline: 'Main Edit', targetDir: dir, fileName: '261018_SpotA_Still_01', format: 'tif', codec: 'RGB16', settings: {}, mark: { index: 1, kind: 'still', tcIn: '01:00:20:20', tcOut: '01:00:20:20', durationFrames: 1 } },
];

function makeBatch(dir, { sizes = { final: 300 * 1024, cut: 100 * 1024, still: 10 * 1024 } } = {}) {
  writeBytes(path.join(dir, '261018_SpotA_Final.mp4'), sizes.final);
  writeBytes(path.join(dir, '261018_SpotA_Social_01.mp4'), sizes.cut, 0x41);
  writeBytes(path.join(dir, '261018_SpotA_Still_01_0086500.tif'), sizes.still, 0x42);
  return buildManifest({ project: 'SpotA_Launch', timeline: 'Main Edit', fps: 24, frames: 1440, jobs: JOBS(dir), namePattern: '{yymmdd}_{project}_{label}', exportxVersion: 'test' }, { since: 0 });
}

test('normalizeBaseUrl adds the scheme and drops a pasted API path', () => {
  assert.equal(normalizeBaseUrl('portal.triptychstudios.co'), 'https://portal.triptychstudios.co');
  assert.equal(normalizeBaseUrl('https://portal.example.com/'), 'https://portal.example.com');
  assert.equal(normalizeBaseUrl('http://localhost:8787/api/plugin/ping'), 'http://localhost:8787');
  assert.equal(normalizeBaseUrl('https://portal.example.com/api/exportx'), 'https://portal.example.com');
  assert.throws(() => normalizeBaseUrl(''), /No portal URL/);
});

test('findOutputs matches Resolve names with and without frame numbers, ignoring old files', () => {
  const dir = tmpDir();
  const now = Date.now();
  fs.writeFileSync(path.join(dir, '261018_SpotA_Final.mp4'), 'a');
  fs.writeFileSync(path.join(dir, '261018_SpotA_Still_01_0086412.tif'), 'b');
  fs.writeFileSync(path.join(dir, '261018_SpotA_Still_010_0086412.tif'), 'c');
  fs.writeFileSync(path.join(dir, '261018_SpotA_Final.mp4.tmp'), 'd');
  const old = path.join(dir, '261018_SpotA_Web.mp4');
  fs.writeFileSync(old, 'e');
  fs.utimesSync(old, new Date(now - 60000), new Date(now - 60000));
  assert.deepEqual(findOutputs(dir, '261018_SpotA_Final').map((p) => path.basename(p)), ['261018_SpotA_Final.mp4']);
  assert.deepEqual(findOutputs(dir, '261018_SpotA_Still_01').map((p) => path.basename(p)), ['261018_SpotA_Still_01_0086412.tif']);
  assert.deepEqual(findOutputs(dir, '261018_SpotA_Web', { since: now - 5000 }), [], 'older than the queue time');
  assert.deepEqual(findOutputs(path.join(dir, 'nope'), 'x'), []);
});

test('buildManifest describes every file found, reports the missing ones, and the register call carries what the portal shows', () => {
  const dir = tmpDir();
  const { manifest, files, missing } = makeBatch(dir);
  assert.equal(manifest.source, 'exportx');
  assert.match(manifest.batchId, /^\d{8}-[a-f0-9]{8}$/);
  assert.equal(files.length, 3);
  assert.equal(files[0].jobId, 'job-1');
  assert.ok(files[0].path.endsWith('261018_SpotA_Final.mp4'));
  assert.equal(manifest.files[0].path, undefined, 'local paths never leave the machine');
  assert.equal(manifest.files[0].jobId, undefined);
  assert.deepEqual(missing, []);
  const noneYet = buildManifest({ project: 'P', timeline: 'T', jobs: [{ ...JOBS(dir)[0], fileName: 'not_rendered' }] }, { since: 0 });
  assert.equal(noneYet.files.length, 0);
  assert.equal(noneYet.missing[0].fileName, 'not_rendered');

  const final = registerInput(manifest, files[0]);
  assert.equal(final.kind, 'final');
  assert.equal(final.content_type, 'video/mp4');
  assert.equal(final.width, 3840);
  assert.equal(final.duration_seconds, 60, 'the timeline length, for a final');
  assert.equal(final.deliverableName, 'Final 4K');
  assert.equal(final.meta.resolveProject, 'SpotA_Launch');
  assert.equal(final.meta.batchId, manifest.batchId);
  const cut = registerInput(manifest, files[1]);
  assert.equal(cut.duration_seconds, 5.5);
  assert.equal(cut.meta.tcIn, '01:00:04:00');
  assert.equal(cut.meta.markIndex, 1);
  const still = registerInput(manifest, files[2]);
  assert.equal(still.content_type, 'image/tiff');
  assert.equal(still.duration_seconds, undefined);
  assert.equal(still.width, undefined, 'no size set on the deliverable: the timeline size, which the portal reads from the file');
  assert.equal(contentTypeFor('x.MOV'), 'video/quicktime');
  assert.equal(contentTypeFor('x.unknownext'), 'application/octet-stream');
  assert.deepEqual(validateRegister({ projectId: 'p', file_path: 'deliverables/p/a', fileName: 'a.mp4', kind: 'final', size_bytes: 1 }), []);
  assert.ok(validateRegister({ projectId: 'p', kind: 'trailer' }).length >= 3);
});

test('the reference server files a kind under the box its name fits, like the portal does', () => {
  const boxes = [{ name: 'Hero cut 16:9', spec: 'ProRes' }, { name: 'Social cutdowns', spec: '9:16' }, { name: 'Stills', spec: '' }];
  assert.equal(boxForKind('final', boxes).name, 'Hero cut 16:9');
  assert.equal(boxForKind('cut', boxes).name, 'Social cutdowns');
  assert.equal(boxForKind('still', boxes).name, 'Stills');
  assert.equal(boxForKind('final', boxes.slice(1)), null);
  assert.equal(fileLabel('Stills', 'a.tif', 'Stills TIFF'), 'Stills · a.tif');
  assert.equal(fileLabel(null, 'a.tif', 'Stills TIFF'), 'Stills TIFF · a.tif');
});

test('ping, projects and the project view answer with the key and refuse without it', async () => {
  await withServer(async ({ url }) => {
    const client = new PortalClient({ portalUrl: url, token: 'secret' });
    const ping = await client.ping();
    assert.equal(ping.ok, true);
    assert.equal(ping.version, '2');
    assert.equal(ping.key.label, 'reference key');
    const projects = await client.projects();
    assert.equal(projects.length, 3);
    assert.equal(projects[0].id, 'proj-spota');
    assert.equal(projects[0].jobNumber, 'TRP-2026-4821');
    const view = await client.projectFiles('proj-spota');
    assert.equal(view.project.name, 'SpotA Launch');
    assert.deepEqual(view.boxes.map((b) => b.name), ['Hero cut 16:9', 'Social cutdowns', 'Stills']);
    assert.deepEqual(view.files, []);

    const bad = new PortalClient({ portalUrl: url, token: 'wrong' });
    await assert.rejects(bad.ping(), (err) => err instanceof PortalError && err.status === 401 && /Settings > ExportX/.test(err.message));
    const none = new PortalClient({ portalUrl: url, token: '' });
    await assert.rejects(none.ping(), (err) => err.status === 401 && err.code === 'missing_plugin_key');
    await assert.rejects(client.projectFiles('proj-nope'), (err) => err.status === 404 && /Refresh the project list/.test(err.message));
  });
});

test('a batch goes in with single PUTs, each file filed into its box, then the batch note', async () => {
  await withServer(async ({ url, inbox, server }) => {
    const dir = tmpDir();
    const bundle = makeBatch(dir);
    const client = new PortalClient({ portalUrl: url, token: 'secret' });
    const events = [];
    const result = await client.uploadBatch(bundle, { projectId: 'proj-spota', onFile: (ev) => events.push(ev) });
    assert.equal(result.uploaded.length, 3);
    assert.deepEqual(result.failed, []);
    assert.equal(result.projectId, 'proj-spota');
    assert.equal(result.bytes, 300 * 1024 + 100 * 1024 + 10 * 1024);
    assert.equal(result.url, `${url}/projects/proj-spota/delivery`);
    assert.deepEqual(result.uploaded, ['Hero cut 16:9 · 261018_SpotA_Final.mp4', 'Social cutdowns · 261018_SpotA_Social_01.mp4', 'Stills · 261018_SpotA_Still_01_0086500.tif']);

    const uploadedEvents = events.filter((e) => e.state === 'uploaded');
    assert.deepEqual(uploadedEvents.map((e) => e.box), ['Hero cut 16:9', 'Social cutdowns', 'Stills']);
    assert.ok(events.some((e) => e.state === 'uploading' && e.percent > 0 && e.percent < 100), 'progress is reported mid-file');

    const files = server.readFiles('proj-spota');
    assert.equal(files.length, 3);
    assert.equal(files[0].source, 'exportx');
    assert.equal(files[0].meta.kind, 'final');
    assert.equal(files[1].meta.tcIn, '01:00:04:00');
    assert.equal(files[1].duration_seconds, 5.5);
    const stored = fs.readdirSync(path.join(inbox, 'proj-spota', 'files')).sort();
    assert.equal(stored.length, 3);
    const final = stored.find((f) => f.endsWith('261018_SpotA_Final.mp4'));
    assert.equal(fs.statSync(path.join(inbox, 'proj-spota', 'files', final)).size, 300 * 1024);
    const batches = fs.readdirSync(path.join(inbox, 'proj-spota', 'batches'));
    assert.equal(batches.length, 1);
    const note = JSON.parse(fs.readFileSync(path.join(inbox, 'proj-spota', 'batches', batches[0]), 'utf8'));
    assert.equal(note.resolveProject, 'SpotA_Launch');
    assert.equal(note.uploaded.length, 3);

    const view = await client.projectFiles('proj-spota');
    assert.deepEqual(view.boxes.map((b) => b.files), [1, 1, 1]);
  });
});

test('a multipart plan is uploaded in parts, three at a time, and closed with the receipts', async () => {
  await withServer(
    async ({ url, inbox }) => {
      const dir = tmpDir();
      // the final is 2.5 parts at a 1 MB part size; the still is one part
      const bundle = makeBatch(dir, { sizes: { final: 2.5 * 1024 * 1024, cut: 1024 * 1024 + 1, still: 2048 } });
      const client = new PortalClient({ portalUrl: url, token: 'secret' });
      const percents = [];
      const result = await client.uploadBatch(bundle, { projectId: 'proj-gls', onFile: (ev) => percents.push(ev.percent) });
      assert.deepEqual(result.failed, []);
      assert.ok(percents.some((p) => p > 0 && p < 100));
      const stored = fs.readdirSync(path.join(inbox, 'proj-gls', 'files'));
      assert.ok(!stored.some((f) => /\.part\d+$/.test(f)), 'parts are assembled and gone');
      const final = stored.find((f) => f.endsWith('261018_SpotA_Final.mp4'));
      const bytes = fs.readFileSync(path.join(inbox, 'proj-gls', 'files', final));
      assert.equal(bytes.length, 2.5 * 1024 * 1024);
      assert.ok(bytes.every((b) => b === 0x58), 'the parts came back in order with the right bytes');
      const cut = stored.find((f) => f.endsWith('Social_01.mp4'));
      assert.equal(fs.statSync(path.join(inbox, 'proj-gls', 'files', cut)).size, 1024 * 1024 + 1);
      // the project without boxes files everything under its deliverable's own name
      const view = await client.projectFiles('proj-gls');
      assert.deepEqual(view.files.map((f) => f.label), ['Music video · 261018_SpotA_Final.mp4', 'Vertical cut · 261018_SpotA_Social_01.mp4', 'Stills TIFF · 261018_SpotA_Still_01_0086500.tif']);
    },
    { storage: 'multipart', partSizeMb: 1 },
  );
});

test('a tus plan is asked again as one signed PUT, so Supabase storage works without a browser session', async () => {
  await withServer(
    async ({ url, inbox }) => {
      const dir = tmpDir();
      const bundle = makeBatch(dir, { sizes: { final: 5000, cut: 4000, still: 300 } });
      const client = new PortalClient({ portalUrl: url, token: 'secret' });
      const result = await client.uploadBatch(bundle, { projectId: 'proj-night' });
      assert.deepEqual(result.failed, []);
      assert.equal(fs.readdirSync(path.join(inbox, 'proj-night', 'files')).length, 3);
      // no boxes on that project: the deliverable names are the boxes
      assert.equal(result.uploaded[0], 'Final 4K · 261018_SpotA_Final.mp4');
    },
    { storage: 'tus' },
  );
});

test('an unknown project and an unreachable portal fail with sentences, before any bytes move', async () => {
  await withServer(async ({ url }) => {
    const dir = tmpDir();
    const bundle = makeBatch(dir);
    const client = new PortalClient({ portalUrl: url, token: 'secret' });
    await assert.rejects(client.uploadBatch(bundle, { projectId: '' }), /Pick the portal project/);
    const events = [];
    const result = await client.uploadBatch(bundle, { projectId: 'proj-gone', onFile: (ev) => events.push(ev) });
    assert.equal(result.uploaded.length, 0);
    assert.equal(result.failed.length, 4, 'every file, and the batch note');
    assert.match(result.failed[0].error, /No such project/);
    assert.ok(events.every((e) => e.state !== 'uploaded'));
  });
  const nowhere = new PortalClient({ portalUrl: 'http://127.0.0.1:9', token: 'x', timeoutMs: 2000 });
  await assert.rejects(nowhere.ping(), (err) => err instanceof PortalError && /ping/.test(err.message));
});

test('the portal kit smoke script passes against the reference server', async () => {
  await withServer(async ({ url }) => {
    const script = path.join(__dirname, '..', 'portal-kit', 'smoke', 'check-portal.js');
    const { stdout: out } = await promisify(execFile)(process.execPath, [script, url, 'secret', '--project', 'proj-spota'], { encoding: 'utf8' });
    assert.match(out, /OK: the portal speaks the ExportX plugin API v2/);
    assert.match(out, /Stills · /);
  });
});

test('jobs carry the deliverable label for the portal', () => {
  const { expandItems } = require('../src/batch');
  const { items } = expandItems({
    profiles: [{ id: 'final-4k-h265', name: 'Final 4K', label: 'Final', target: 'timeline', format: 'mp4', codec: 'H265' }],
    timelineName: 'TL',
    projectName: 'P',
    template: '{project}_{label}',
    targetDir: '/out',
  });
  assert.equal(items[0].label, 'Final');
  assert.equal(items[0].fileName, 'P_Final');
});
