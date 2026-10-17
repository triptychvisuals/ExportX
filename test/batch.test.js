'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ResolveBridge, matchEntry, buildRenderSettings } = require('../src/resolve');
const { BatchExporter, summarize } = require('../src/batch');
const { createMockResolve, asyncify } = require('./helpers/mock-resolve');

const PRORES = {
  id: 'prores-master',
  name: 'ProRes Master',
  format: 'QuickTime',
  codec: 'prores 422 hq',
  renderMode: 'single',
  settings: { AudioCodec: 'lpcm', AudioBitDepth: 24 },
  subfolder: '01_Masters',
  fileSuffix: '_MASTER',
};
const H264 = {
  id: 'h264-web',
  name: 'H.264 Web',
  format: 'mp4',
  codec: 'H264',
  renderMode: 'single',
  resolution: { width: 1920, height: 1080 },
  settings: { VideoQuality: 'High' },
  subfolder: '02_Web',
  fileSuffix: '',
};

function setup(options, { async = false } = {}) {
  const resolve = createMockResolve(options);
  const bridge = new ResolveBridge(async ? asyncify(resolve) : resolve);
  const logs = [];
  const dirs = [];
  const exporter = new BatchExporter(bridge, {
    log: (m) => logs.push(m),
    ensureDir: (d) => dirs.push(d),
    now: () => new Date(2026, 0, 2, 3, 4, 5),
  });
  return { resolve, project: resolve.project, bridge, exporter, logs, dirs };
}

test('matchEntry is forgiving about ids and descriptions', () => {
  const codecs = { 'Apple ProRes 422 HQ': 'ProRes422HQ', 'Apple ProRes 422': 'ProRes422', 'H.264': 'H264' };
  assert.equal(matchEntry(codecs, 'ProRes422HQ').id, 'ProRes422HQ');
  assert.equal(matchEntry(codecs, 'prores 422 hq').id, 'ProRes422HQ');
  assert.equal(matchEntry(codecs, 'Apple ProRes 422').id, 'ProRes422');
  assert.equal(matchEntry(codecs, 'ProRes422').id, 'ProRes422');
  assert.equal(matchEntry(codecs, 'h.264').id, 'H264');
  assert.equal(matchEntry(codecs, 'av1'), null);
});

test('buildRenderSettings merges profile settings with run options', () => {
  const s = buildRenderSettings(H264, { targetDir: '/out', customName: 'clip' });
  assert.equal(s.TargetDir, '/out');
  assert.equal(s.CustomName, 'clip');
  assert.equal(s.FormatWidth, 1920);
  assert.equal(s.FormatHeight, 1080);
  assert.equal(s.VideoQuality, 'High');
  assert.equal(s.SelectAllFrames, true);
  assert.equal(s.ExportVideo, true);
  const ranged = buildRenderSettings(H264, { range: { markIn: 10, markOut: 200 } });
  assert.equal(ranged.SelectAllFrames, false);
  assert.equal(ranged.MarkIn, 10);
  assert.equal(ranged.MarkOut, 200);
});

test('queues one job per profile for the current timeline', async () => {
  const { project, exporter, dirs } = setup();
  const { jobs, errors } = await exporter.queue({
    profiles: [PRORES, H264],
    targetDir: '/deliver/Job42',
    nameTemplate: '{timeline}_{profile}',
  });
  assert.equal(errors.length, 0);
  assert.equal(jobs.length, 2);
  assert.deepEqual(
    jobs.map((j) => j.fileName),
    ['Main Edit_prores-master_MASTER', 'Main Edit_h264-web'],
  );
  assert.equal(jobs[0].targetDir, path.join('/deliver/Job42', '01_Masters'));
  assert.deepEqual(dirs, [path.join('/deliver/Job42', '01_Masters'), path.join('/deliver/Job42', '02_Web')]);

  const queued = project.GetRenderJobList();
  assert.equal(queued.length, 2);
  assert.equal(queued[0].Format, 'mov');
  assert.equal(queued[0].Codec, 'ProRes422HQ');
  assert.equal(queued[0].settings.AudioCodec, 'lpcm');
  assert.equal(queued[1].Format, 'mp4');
  assert.equal(queued[1].Codec, 'H264');
  assert.equal(queued[1].settings.FormatWidth, 1920);
  assert.equal(queued[1].settings.CustomName, 'Main Edit_h264-web');
});

test('queues across several timelines and restores the original one', async () => {
  const { project, exporter } = setup({ timelines: ['A', 'B', 'C'] });
  const { jobs } = await exporter.queue({
    profiles: [H264],
    targetDir: '/out',
    timelines: ['B', 'C'],
  });
  assert.deepEqual(
    jobs.map((j) => j.timeline),
    ['B', 'C'],
  );
  assert.deepEqual(
    project.GetRenderJobList().map((j) => j.TimelineName),
    ['B', 'C'],
  );
  assert.equal(project.GetCurrentTimeline().GetName(), 'A', 'should switch back to the original timeline');
});

test('a bad profile is reported and does not block the others', async () => {
  const { exporter } = setup();
  const bad = { ...H264, id: 'bad', name: 'Bad', codec: 'AV1' };
  const { jobs, errors } = await exporter.queue({ profiles: [bad, PRORES], targetDir: '/out' });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].profileId, 'prores-master');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Unknown codec "AV1"/);
});

test('rejects unknown timelines and an empty selection', async () => {
  const { exporter } = setup();
  await assert.rejects(exporter.queue({ profiles: [H264], targetDir: '/out', timelines: ['Nope'] }), /Unknown timeline/);
  await assert.rejects(exporter.queue({ profiles: [], targetDir: '/out' }), /at least one/);
  await assert.rejects(exporter.queue({ profiles: [H264], targetDir: '' }), /output folder/);
});

test('clearExisting empties the queue first', async () => {
  const { project, exporter } = setup();
  project.AddRenderJob();
  assert.equal(project.GetRenderJobList().length, 1);
  await exporter.queue({ profiles: [H264], targetDir: '/out', clearExisting: true });
  assert.equal(project.GetRenderJobList().length, 1);
  assert.equal(project.GetRenderJobList()[0].OutputFilename, 'Main Edit_h264-web');
});

test('renders and reports progress until completion', async () => {
  const { exporter } = setup({ progressStep: 50 });
  const { jobs } = await exporter.queue({ profiles: [PRORES, H264], targetDir: '/out' });
  const ids = jobs.map((j) => j.jobId);
  await exporter.render(ids);
  const ticks = [];
  const { statuses, summary, stopped } = await exporter.waitForCompletion(ids, {
    intervalMs: 1,
    onProgress: (_s, sum) => ticks.push(sum.percent),
  });
  assert.equal(stopped, false);
  assert.equal(summary.complete, 2);
  assert.ok(statuses.every((s) => s.status === 'complete'));
  assert.deepEqual(ticks, [50, 100]);
});

test('a failed job surfaces its error', async () => {
  const { exporter } = setup({ failJobsMatching: (job) => job.Codec === 'H264' });
  const { jobs } = await exporter.queue({ profiles: [PRORES, H264], targetDir: '/out' });
  const ids = jobs.map((j) => j.jobId);
  await exporter.render(ids);
  const { statuses, summary } = await exporter.waitForCompletion(ids, { intervalMs: 1 });
  assert.equal(summary.failed, 1);
  assert.equal(summary.complete, 1);
  assert.equal(statuses.find((s) => s.status === 'failed').error, 'Mock failure');
});

test('plan is a dry run', async () => {
  const { project, exporter } = setup();
  const items = await exporter.plan({ profiles: [PRORES, H264], targetDir: '/out', nameTemplate: '{profile}' });
  assert.equal(items.length, 2);
  assert.equal(items[0].fileName, 'prores-master_MASTER');
  assert.equal(project.GetRenderJobList().length, 0);
  assert.equal(project.calls.length, 0);
});

test('works when the Resolve binding returns Promises', async () => {
  const { exporter } = setup({}, { async: true });
  const { jobs, errors } = await exporter.queue({ profiles: [PRORES, H264], targetDir: '/out' });
  assert.equal(errors.length, 0);
  assert.equal(jobs.length, 2);
  await exporter.render(jobs.map((j) => j.jobId));
  const { summary } = await exporter.waitForCompletion(
    jobs.map((j) => j.jobId),
    { intervalMs: 1 },
  );
  assert.equal(summary.complete, 2);
});

test('summarize counts states', () => {
  const s = summarize([
    { status: 'complete', percent: 100 },
    { status: 'rendering', percent: 50 },
    { status: 'ready', percent: 0 },
  ]);
  assert.equal(s.total, 3);
  assert.equal(s.complete, 1);
  assert.equal(s.rendering, 1);
  assert.equal(s.ready, 1);
  assert.equal(s.percent, 50);
  assert.equal(s.done, false);
});

test('bridge reports no project clearly', async () => {
  const bridge = new ResolveBridge(createMockResolve(null));
  await assert.rejects(bridge.projectName(), /No project is open/);
});
