'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateBytes, formatBytes, sizeLabel } = require('../src/estimate');
const { ResolveBridge } = require('../src/resolve');
const { BatchExporter, expandItems } = require('../src/batch');
const { createMockResolve } = require('./helpers/mock-resolve');

const HD = { width: 1920, height: 1080, fps: 24, frames: 1440 }; // one minute

test('a bit rate is close to exact: bit rate × seconds, plus the audio', () => {
  const aac = estimateBytes({ format: 'mp4', codec: 'H264', settings: { VideoQuality: 16000, ExportAudio: true, AudioCodec: 'aac' }, ...HD, kind: 'final' });
  assert.equal(aac.videoBytes, 120_000_000);
  assert.equal(aac.audioBytes, 2_400_000, 'AAC at Resolve\'s default data rate');
  assert.equal(aac.bytes, Math.round(122_400_000 * 1.01));
  assert.equal(aac.exact, false, 'the AAC rate is typical, so the whole is marked typical');
  assert.equal(aac.basis, '16,000 kb/s');
  const pcm = estimateBytes({ format: 'mov', codec: 'H264', settings: { VideoQuality: 16000, AudioCodec: 'lpcm', AudioBitDepth: 24, AudioSampleRate: 48000 }, ...HD, kind: 'final' });
  assert.equal(pcm.audioBytes, 17_280_000);
  assert.equal(pcm.exact, true);
  const silent = estimateBytes({ format: 'mp4', codec: 'H264', settings: { VideoQuality: 16000, ExportAudio: false }, ...HD, kind: 'final' });
  assert.equal(silent.audioBytes, 0);
});

test('fixed-rate codecs use their published data rate, automatic quality a typical one', () => {
  const hq = estimateBytes({ format: 'mov', codec: 'ProRes422HQ', settings: { ExportAudio: false }, width: 1920, height: 1080, fps: 30, frames: 30, kind: 'final' });
  assert.ok(Math.abs(hq.videoBytes - 27_500_000) < 300_000, `one second of ProRes 422 HQ at 1080p30 is about 27.5 MB, got ${hq.videoBytes}`);
  assert.equal(hq.exact, false);
  assert.match(hq.basis, /ProRes 422 HQ/);
  const auto264 = estimateBytes({ format: 'mp4', codec: 'H264', settings: { ExportAudio: false }, ...HD, kind: 'final' });
  const auto265 = estimateBytes({ format: 'mp4', codec: 'H265', settings: { ExportAudio: false }, ...HD, kind: 'final' });
  assert.ok(auto265.videoBytes < auto264.videoBytes, 'H.265 lands smaller than H.264 on automatic');
  assert.match(auto264.basis, /automatic quality/);
  const level = estimateBytes({ format: 'mov', codec: 'Photo JPEG', settings: { VideoQuality: 'Best', ExportAudio: false }, ...HD, kind: 'final' });
  const low = estimateBytes({ format: 'mov', codec: 'Photo JPEG', settings: { VideoQuality: 'Low', ExportAudio: false }, ...HD, kind: 'final' });
  assert.ok(level.videoBytes > low.videoBytes * 2);
});

test('stills count bytes per pixel for the format and bit depth, one frame each, no audio', () => {
  const tif16 = estimateBytes({ format: 'tif', codec: 'RGB16', settings: { ExportVideo: true }, width: 3840, height: 2160, fps: 24, frames: 1, kind: 'still' });
  assert.equal(tif16.videoBytes, 3840 * 2160 * 6);
  assert.equal(tif16.audioBytes, 0);
  assert.equal(tif16.exact, true);
  const tif8 = estimateBytes({ format: 'tif', codec: 'RGB8', width: 3840, height: 2160, fps: 24, frames: 1, kind: 'still' });
  assert.equal(tif8.videoBytes, 3840 * 2160 * 3);
  const jpgBest = estimateBytes({ format: 'jpg', codec: 'auto', settings: { VideoQuality: 'Best' }, width: 1920, height: 1080, fps: 24, frames: 1, kind: 'still' });
  const jpgHigh = estimateBytes({ format: 'jpg', codec: 'auto', settings: { VideoQuality: 'High' }, width: 1920, height: 1080, fps: 24, frames: 1, kind: 'still' });
  assert.ok(jpgBest.bytes > jpgHigh.bytes && !jpgBest.exact);
  const exr = estimateBytes({ format: 'exr', codec: 'RGB half (PIZ)', width: 1920, height: 1080, fps: 24, frames: 1, kind: 'still' });
  assert.equal(exr.videoBytes, 1920 * 1080 * 3);
  assert.equal(estimateBytes({ format: 'tif', codec: 'RGB16', width: 0, height: 0, frames: 1 }).bytes, null);
});

test('sizes read the way people say them', () => {
  assert.equal(formatBytes(850), '850 B');
  assert.equal(formatBytes(24_883_200), '24.9 MB');
  assert.equal(formatBytes(412_000_000), '412 MB');
  assert.equal(formatBytes(2_457_600_000), '2.5 GB');
  assert.equal(formatBytes(45_000_000_000), '45 GB');
  assert.equal(sizeLabel({ bytes: 2_457_600_000, exact: false }), '≈ 2.5 GB');
  assert.equal(sizeLabel({ bytes: 49_766_400, exact: true }), '49.8 MB');
  assert.equal(sizeLabel(null), '');
});

test('timelineInfo carries the size, the In/Out range as absolute frames, and nothing when the range is the whole timeline', async () => {
  const resolve = createMockResolve({ timelines: [{ name: 'Vertical', fps: 24, width: 1080, height: 1920, inOut: { in: 48, out: 1223 } }, { name: 'Whole', fps: 24, inOut: { in: 0, out: 10 * 60 * 24 - 1 } }, 'Plain'] });
  const bridge = new ResolveBridge(resolve);
  const v = await bridge.timelineInfo();
  assert.equal(v.width, 1080);
  assert.equal(v.height, 1920);
  assert.equal(v.vertical, true);
  assert.deepEqual({ absIn: v.inOut.absIn, absOut: v.inOut.absOut, frames: v.inOut.frames }, { absIn: 86400 + 48, absOut: 86400 + 1223, frames: 1176 });
  assert.equal(v.inOut.tcIn, '01:00:02:00');
  assert.equal(v.inOut.tcOut, '01:00:50:23');
  const whole = await bridge.timelineInfoByName('Whole');
  assert.equal(whole.inOut, null, 'In at the first frame and Out at the last is no range');
  const plain = await bridge.timelineInfoByName('Plain');
  assert.equal(plain.inOut, null);
  assert.equal(plain.vertical, false);
  // absolute frames from a future Resolve are taken as they are
  resolve.project.timelines[2].inOut = { in: 86400 + 100, out: 86400 + 200 };
  const abs = await bridge.timelineInfoByName('Plain');
  assert.deepEqual([abs.inOut.absIn, abs.inOut.absOut], [86500, 86600]);
  const sizes = await bridge.renderResolutions('mp4', 'H264');
  assert.ok(sizes.some((s) => s.width === 1080 && s.height === 1920));
  assert.deepEqual(await bridge.renderResolutions('nope', 'x'), []);
});

test('an In/Out range narrows the final, drops marks outside it, clips one that runs past Out, and sizes every item', () => {
  const timeline = { name: 'TL', fps: 24, frames: 1440, width: 1920, height: 1080, dropFrame: false, startFrame: 86400, endFrame: 87839 };
  const range = { absIn: 86448, absOut: 87623, frames: 1176 };
  const marks = [
    { id: 'c1', kind: 'cut', index: 1, absIn: 86400, absOut: 86430, durationFrames: 31, tcIn: '01:00:00:00', tcOut: '01:00:01:06', duration: '1.3s' },
    { id: 'c2', kind: 'cut', index: 2, absIn: 87000, absOut: 87100, durationFrames: 101, tcIn: '01:00:25:00', tcOut: '01:00:29:04', duration: '4.2s' },
    { id: 'c3', kind: 'cut', index: 3, absIn: 87600, absOut: 87700, durationFrames: 101, tcIn: '01:00:50:00', tcOut: '01:00:54:04', duration: '4.2s' },
    { id: 's1', kind: 'still', index: 1, absIn: 87800, absOut: 87800, durationFrames: 1, tcIn: '01:00:58:08', tcOut: '01:00:58:08', duration: '1f' },
    { id: 's2', kind: 'still', index: 2, absIn: 86500, absOut: 86500, durationFrames: 1, tcIn: '01:00:04:04', tcOut: '01:00:04:04', duration: '1f' },
  ];
  const profiles = [
    { id: 'final', name: 'Final 4K', label: 'Final', target: 'timeline', format: 'mp4', codec: 'H265', resolution: { width: 3840, height: 2160 }, settings: { VideoQuality: 45000 } },
    { id: 'social', name: 'Social', label: 'Social', target: 'cuts', format: 'mp4', codec: 'H264', settings: { VideoQuality: 12000 } },
    { id: 'stills', name: 'Stills TIFF', label: 'Still', target: 'stills', format: 'tif', codec: 'RGB16' },
  ];
  const { items, notes } = expandItems({ profiles, timelineName: 'TL', projectName: 'P', marks, template: '{label}', targetDir: '/out', timeline, range });
  const final = items.find((i) => i.kind === 'final');
  assert.deepEqual(final.range, { markIn: 86448, markOut: 87623 });
  assert.equal(final.durationFrames, 1176);
  assert.equal(final.estimate.videoBytes, Math.round((45000 * 1000 * (1176 / 24)) / 8));
  const cuts = items.filter((i) => i.kind === 'cut');
  assert.deepEqual(cuts.map((c) => c.mark.index), [2, 3], 'the cut before In is out; the one across Out stays');
  assert.equal(cuts[1].range.markOut, 87623, 'clipped at Out');
  assert.equal(cuts[1].mark.clipped, true);
  assert.equal(cuts[1].mark.tcOut, '01:00:50:23');
  assert.equal(cuts[1].durationFrames, 24);
  const stills = items.filter((i) => i.kind === 'still');
  assert.deepEqual(stills.map((s) => s.mark.index), [2]);
  assert.equal(stills[0].estimate.bytes, Math.round(1920 * 1080 * 6 * 1.01));
  assert.ok(notes.some((n) => /1 cut outside In\/Out/.test(n.message)));
  assert.ok(notes.some((n) => /1 still outside In\/Out/.test(n.message)));

  const whole = expandItems({ profiles, timelineName: 'TL', projectName: 'P', marks, template: '{label}', targetDir: '/out', timeline });
  assert.equal(whole.items.find((i) => i.kind === 'final').range, null);
  assert.equal(whole.items.filter((i) => i.kind === 'cut').length, 3);
  assert.equal(whole.notes.length, 0);
});

test('plan() reports each timeline\'s facts and range, and queue() honours useInOut', async () => {
  const resolve = createMockResolve({ name: 'P', timelines: [{ name: 'Main', fps: 24, inOut: { in: 240, out: 479 } }] });
  resolve.project.timelines[0].markers[300] = { color: 'Cyan', duration: 48, note: '', name: '', customData: 'exportx:cut' };
  resolve.project.timelines[0].markers[10] = { color: 'Cyan', duration: 48, note: '', name: '', customData: 'exportx:cut' };
  const exporter = new BatchExporter(new ResolveBridge(resolve), { log: () => {} });
  const profiles = [
    { id: 'web', name: 'Web', label: 'Web', target: 'timeline', format: 'mp4', codec: 'H264', settings: { VideoQuality: 16000 } },
    { id: 'social', name: 'Social', label: 'Social', target: 'cuts', format: 'mp4', codec: 'H264', settings: { VideoQuality: 12000 } },
  ];
  const plan = await exporter.plan({ profiles, targetDir: '/out', nameTemplate: '{label}' });
  assert.equal(plan.timelines.Main.range.absIn, 86640);
  assert.equal(plan.timelines.Main.width, 1920);
  assert.equal(plan.items.find((i) => i.kind === 'final').durationFrames, 240);
  assert.equal(plan.items.filter((i) => i.kind === 'cut').length, 1);
  assert.ok(plan.items.every((i) => i.estimate && i.estimate.bytes > 0));
  const wholePlan = await exporter.plan({ profiles, targetDir: '/out', nameTemplate: '{label}', useInOut: false });
  assert.equal(wholePlan.timelines.Main.range, null);
  assert.equal(wholePlan.items.filter((i) => i.kind === 'cut').length, 2);
  const { jobs } = await exporter.queue({ profiles, targetDir: '/out', nameTemplate: '{label}' });
  const finalJob = jobs.find((j) => j.kind === 'final');
  assert.equal(finalJob.settings.MarkIn, 86640);
  assert.equal(finalJob.settings.MarkOut, 86879);
  assert.equal(finalJob.settings.SelectAllFrames, false);
  assert.ok(finalJob.estimate.bytes > 0);
});
