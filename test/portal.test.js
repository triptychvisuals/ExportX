'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { PortalClient, PortalError, normalizeBaseUrl, findOutputs, buildManifest } = require('../src/portal');
const { createServer, validateManifest } = require('../portal-kit/reference-server/server');

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

test('normalizeBaseUrl adds the scheme and the API suffix once', () => {
  assert.equal(normalizeBaseUrl('portal.triptychstudios.com'), 'https://portal.triptychstudios.com/api/exportx');
  assert.equal(normalizeBaseUrl('https://portal.example.com/'), 'https://portal.example.com/api/exportx');
  assert.equal(normalizeBaseUrl('http://localhost:8787/api/exportx/'), 'http://localhost:8787/api/exportx');
  assert.throws(() => normalizeBaseUrl(''), /No portal URL/);
});

test('findOutputs matches Resolve names with and without frame numbers, ignoring old files', () => {
  const dir = tmpDir();
  const now = Date.now();
  fs.writeFileSync(path.join(dir, '261018_SpotA_Final.mp4'), 'a');
  fs.writeFileSync(path.join(dir, '261018_SpotA_Still_01_0086412.tif'), 'b');
  fs.writeFileSync(path.join(dir, '261018_SpotA_Still_010_0086412.tif'), 'c');
  fs.writeFileSync(path.join(dir, '261018_SpotA_Final_old.mp4'), 'd');
  fs.writeFileSync(path.join(dir, 'other.mp4'), 'e');
  const old = path.join(dir, '261018_SpotA_Web.mp4');
  fs.writeFileSync(old, 'f');
  fs.utimesSync(old, new Date(now - 3600_000), new Date(now - 3600_000));
  assert.deepEqual(findOutputs(dir, '261018_SpotA_Final').map((p) => path.basename(p)), ['261018_SpotA_Final.mp4']);
  assert.deepEqual(findOutputs(dir, '261018_SpotA_Still_01').map((p) => path.basename(p)), ['261018_SpotA_Still_01_0086412.tif']);
  assert.deepEqual(findOutputs(dir, '261018_SpotA_Web', { since: now - 60_000 }), []);
  assert.deepEqual(findOutputs(dir, '261018_SpotA_Web').map((p) => path.basename(p)), ['261018_SpotA_Web.mp4']);
  assert.deepEqual(findOutputs(path.join(dir, 'nope'), 'x'), []);
});

test('buildManifest turns finished jobs into file entries and reports missing ones', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '261018_SpotA_Final.mp4'), Buffer.alloc(10));
  fs.writeFileSync(path.join(dir, '261018_SpotA_Social_01.mp4'), Buffer.alloc(5));
  const jobs = [
    { jobId: 'job-1', kind: 'final', profileId: 'final-4k-h265', profileName: 'Final 4K', label: 'Final', timeline: 'Main Edit', targetDir: dir, fileName: '261018_SpotA_Final', format: 'mp4', codec: 'H265', settings: { FormatWidth: 3840, FormatHeight: 2160 } },
    { jobId: 'job-2', kind: 'cut', profileId: 'cuts-social-1080', profileName: 'Social cuts', label: 'Social', timeline: 'Main Edit', targetDir: dir, fileName: '261018_SpotA_Social_01', format: 'mp4', codec: 'H264', mark: { index: 1, tcIn: '01:00:04:00', tcOut: '01:00:09:11', durationFrames: 132 } },
    { jobId: 'job-3', kind: 'still', profileId: 'stills-tiff', profileName: 'Stills TIFF', label: 'Still', timeline: 'Main Edit', targetDir: dir, fileName: '261018_SpotA_Still_01', format: 'tif', codec: 'auto' },
  ];
  const { manifest, files, missing } = buildManifest({ project: 'SpotA', timeline: 'Main Edit', jobs, namePattern: '{yymmdd}_{project}_{label}', exportxVersion: '0.1.0', fps: 24 });
  assert.equal(manifest.source, 'exportx');
  assert.equal(manifest.files.length, 2);
  assert.equal(files.length, 2);
  assert.equal(manifest.files[0].key, 'job-1');
  assert.equal(manifest.files[0].kind, 'final');
  assert.equal(manifest.files[0].width, 3840);
  assert.equal(manifest.files[0].bytes, 10);
  assert.equal(manifest.files[1].tcIn, '01:00:04:00');
  assert.equal(manifest.files[1].durationFrames, 132);
  assert.equal(manifest.files[0].path, undefined, 'local paths never leave the machine');
  assert.deepEqual(missing.map((m) => m.jobId), ['job-3']);
  assert.deepEqual(validateManifest(manifest), []);
});

test('the client talks to the reference server end to end', async () => {
  await withServer(async ({ url, inbox }) => {
    const client = new PortalClient({ portalUrl: url, token: 'secret' });
    const ping = await client.ping();
    assert.equal(ping.ok, true);
    assert.ok(Array.isArray(ping.categories) && ping.categories.length > 0);

    const dir = tmpDir();
    const big = Buffer.alloc(300 * 1024, 7);
    fs.writeFileSync(path.join(dir, '261018_SpotA_Final.mp4'), big);
    fs.writeFileSync(path.join(dir, '261018_SpotA_Still_01_0086412.tif'), Buffer.alloc(2048, 1));
    const jobs = [
      { jobId: 'job-1', kind: 'final', profileId: 'final-4k-h265', profileName: 'Final 4K', label: 'Final', timeline: 'Main Edit', targetDir: dir, fileName: '261018_SpotA_Final', format: 'mp4', codec: 'H265' },
      { jobId: 'job-2', kind: 'still', profileId: 'stills-tiff', profileName: 'Stills TIFF', label: 'Still', timeline: 'Main Edit', targetDir: dir, fileName: '261018_SpotA_Still_01', format: 'tif', codec: 'auto', mark: { index: 1, tcIn: '01:00:20:20', tcOut: '01:00:20:20', durationFrames: 1 } },
    ];
    const bundle = buildManifest({ project: 'SpotA', timeline: 'Main Edit', jobs, category: 'commercial' });
    const events = [];
    const result = await client.uploadBatch(bundle, { onFile: (e) => events.push(e) });
    assert.ok(result.batchId);
    assert.deepEqual(result.uploaded, ['job-1', 'job-2']);
    assert.equal(result.failed.length, 0);
    assert.match(result.url, /\/batches\//);
    assert.ok(events.some((e) => e.key === 'job-1' && e.state === 'uploading' && e.percent > 0 && e.percent < 100), 'progress is reported mid-upload');
    assert.ok(events.some((e) => e.key === 'job-2' && e.state === 'uploaded' && e.fileId));

    const stored = path.join(inbox, result.batchId);
    const manifest = JSON.parse(fs.readFileSync(path.join(stored, 'manifest.json'), 'utf8'));
    assert.equal(manifest.category, 'commercial');
    assert.equal(fs.statSync(path.join(stored, 'files', '261018_SpotA_Final.mp4')).size, big.length);
    assert.equal(fs.readFileSync(path.join(stored, 'files', '261018_SpotA_Final.mp4'))[12345], 7);
    assert.ok(fs.existsSync(path.join(stored, 'files', '261018_SpotA_Still_01_0086412.tif')));
    const status = JSON.parse(fs.readFileSync(path.join(stored, 'status.json'), 'utf8'));
    assert.equal(status.status, 'complete');
  });
});

test('bad tokens and bad manifests are rejected with readable errors', async () => {
  await withServer(async ({ url }) => {
    const wrong = new PortalClient({ portalUrl: url, token: 'nope' });
    await assert.rejects(wrong.ping(), (err) => err instanceof PortalError && err.status === 401 && /bearer token/i.test(err.message));
    const right = new PortalClient({ portalUrl: url, token: 'secret' });
    await assert.rejects(right.createBatch({ source: 'exportx', files: [] }), /project is required/);
    await assert.rejects(right.uploadBatch({ manifest: {}, files: [] }), /Nothing to upload/);
  });
});

test('unreachable portals fail fast with a PortalError', async () => {
  const client = new PortalClient({ portalUrl: 'http://127.0.0.1:1', token: 'x', timeoutMs: 2000 });
  await assert.rejects(client.ping(), (err) => err instanceof PortalError);
});

test('the portal kit smoke script passes against the reference server', async () => {
  await withServer(async ({ url }) => {
    const script = path.join(__dirname, '..', 'portal-kit', 'smoke', 'check-portal.js');
    const { stdout: out } = await promisify(execFile)(process.execPath, [script, url, 'secret', '--category', 'social'], { encoding: 'utf8' });
    assert.match(out, /OK: the portal speaks ExportX v1/);
    assert.match(out, /smoke-still: uploaded/);
  });
});

test('jobs carry the deliverable label for the manifest', () => {
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
