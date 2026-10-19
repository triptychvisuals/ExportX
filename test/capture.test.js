'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ResolveBridge } = require('../src/resolve');
const { createMockResolve } = require('./helpers/mock-resolve');

function setup() {
  const resolve = createMockResolve({ timelines: [{ name: 'Main Edit', fps: 24, startFrame: 86400 }] });
  const tl = resolve.project.timelines[0];
  return { bridge: new ResolveBridge(resolve), tl };
}

test('timelineInfo and playhead read Resolve timecode as absolute frames', async () => {
  const { bridge, tl } = setup();
  const info = await bridge.timelineInfo();
  assert.equal(info.name, 'Main Edit');
  assert.equal(info.startFrame, 86400);
  assert.equal(info.fps, 24);
  tl.playheadAbs = 86400 + 24 * 12 + 5;
  const ph = await bridge.playhead(info);
  assert.equal(ph.tc, '01:00:12:05');
  assert.equal(ph.absFrame, 86400 + 24 * 12 + 5);
  assert.equal(ph.relFrame, 24 * 12 + 5);
});

test('a held cut key becomes a cut marker, the still key a still marker, both relative to the timeline start', async () => {
  const { bridge, tl } = setup();
  const afterCut = await bridge.addMark({ kind: 'cut', absIn: 86400 + 48, absOut: 86400 + 48 + 71 });
  assert.equal(afterCut.added.kind, 'cut');
  assert.equal(afterCut.added.index, 1);
  assert.deepEqual(tl.markers[48] && [tl.markers[48].color, tl.markers[48].duration, tl.markers[48].customData], ['Cyan', 72, 'exportx:cut']);

  const afterStill = await bridge.addMark({ kind: 'still', absIn: 86400 + 200, absOut: 86400 + 200 });
  assert.equal(afterStill.added.kind, 'still');
  assert.equal(tl.markers[200].customData, 'exportx:still');
  assert.equal(tl.markers[200].duration, 1);
  assert.equal(afterStill.marks.length, 2);
  assert.equal(afterStill.marks[1].name, 'Still 1');
});

test('marks number per kind and can be deleted or cleared by kind', async () => {
  const { bridge } = setup();
  await bridge.addMark({ kind: 'cut', absIn: 86410, absOut: 86430 });
  await bridge.addMark({ kind: 'still', absIn: 86500, absOut: 86500 });
  await bridge.addMark({ kind: 'cut', absIn: 86600, absOut: 86700 });
  let { marks } = await bridge.marks();
  assert.deepEqual(
    marks.map((m) => `${m.kind}${m.index}`),
    ['cut1', 'still1', 'cut2'],
  );
  ({ marks } = await bridge.deleteMark(10));
  assert.deepEqual(
    marks.map((m) => `${m.kind}${m.index}`),
    ['still1', 'cut1'],
  );
  ({ marks } = await bridge.clearMarks('cut'));
  assert.deepEqual(
    marks.map((m) => m.kind),
    ['still'],
  );
  ({ marks } = await bridge.clearMarks());
  assert.equal(marks.length, 0);
});

test('a marker collision is reported with the timecode', async () => {
  const { bridge } = setup();
  await bridge.addMark({ kind: 'still', absIn: 86424, absOut: 86424 });
  await assert.rejects(bridge.addMark({ kind: 'still', absIn: 86424, absOut: 86424 }), /01:00:01:00/);
});

test('seek moves the Resolve playhead', async () => {
  const { bridge, tl } = setup();
  await bridge.seek(86400 + 24 * 5);
  assert.equal(tl.playheadAbs, 86400 + 24 * 5);
  assert.deepEqual(tl.calls[0], ['SetCurrentTimecode', '01:00:05:00']);
});

function setupWith(deleteMode, markers) {
  const resolve = createMockResolve({ timelines: [{ name: 'Main Edit', fps: 24, startFrame: 86400, deleteMode, markers }] });
  return { bridge: new ResolveBridge(resolve), tl: resolve.project.timelines[0] };
}

test('deleting a mark is verified against GetMarkers and falls back to the absolute frame', async () => {
  const { bridge, tl } = setupWith('absolute');
  await bridge.addMark({ kind: 'cut', absIn: 86410, absOut: 86430 });
  const r = await bridge.deleteMark(10);
  assert.equal(r.marks.length, 0);
  assert.match(r.removed.how, /absolute/);
  assert.deepEqual(tl.calls.filter((c) => c[0] === 'DeleteMarkerAtFrame').map((c) => c[1]), [10, 86410]);
});

test('deleting a mark falls back to a unique customData tag without touching the other marks', async () => {
  const { bridge, tl } = setupWith('customData');
  await bridge.addMark({ kind: 'still', absIn: 86500, absOut: 86500 });
  await bridge.addMark({ kind: 'still', absIn: 86600, absOut: 86600 });
  const r = await bridge.deleteMark(100);
  assert.deepEqual(r.marks.map((m) => m.relIn), [200]);
  assert.match(r.removed.how, /DeleteMarkerByCustomData/);
  assert.equal(tl.markers[200].customData, 'exportx:still');
});

test('as a last resort a mark is deleted by colour and the other markers of that colour are put back', async () => {
  const { bridge, tl } = setupWith('color', { 50: { color: 'Cyan', name: 'Client note', note: 'keep me', duration: 5 } });
  await bridge.addMark({ kind: 'cut', absIn: 86410, absOut: 86430 });
  await bridge.addMark({ kind: 'cut', absIn: 86600, absOut: 86700 });
  const r = await bridge.deleteMark(10);
  assert.deepEqual(r.marks.map((m) => `${m.kind}@${m.relIn}`), ['cut@200']);
  assert.match(r.removed.how, /DeleteMarkersByColor/);
  assert.equal(r.removed.readded, 2);
  assert.deepEqual(r.removed.lost, []);
  assert.deepEqual([tl.markers[50].name, tl.markers[50].note, tl.markers[50].duration, tl.markers[50].customData], ['Client note', 'keep me', 5, '']);
  assert.deepEqual([tl.markers[200].customData, tl.markers[200].duration, tl.markers[200].name], ['exportx:cut', 101, 'Cut 2']);
  // clearing a kind sweeps the colour once and keeps the marker that is not ours
  await bridge.addMark({ kind: 'cut', absIn: 86900, absOut: 86910 });
  const c = await bridge.clearMarks('cut');
  assert.equal(c.failed.length, 0);
  assert.equal(c.removed, 2);
  assert.equal(c.marks.length, 0);
  assert.ok(tl.markers[50]);
  assert.equal(tl.calls.filter((x) => x[0] === 'DeleteMarkersByColor').length, 2);
});

test('when Resolve refuses every way the error names the marker and says what to do, and clear reports it', async () => {
  const { bridge } = setupWith('never');
  await bridge.addMark({ kind: 'cut', absIn: 86410, absOut: 86430 });
  await assert.rejects(bridge.deleteMark(10), /01:00:00:10.*DeleteMarkerAtFrame\(10\).*timeline in Resolve/s);
  const c = await bridge.clearMarks('cut');
  assert.equal(c.failed.length, 1);
  assert.equal(c.removed, 0);
  assert.equal(c.marks.length, 1);
});

test('deleting a mark that is already gone is not an error', async () => {
  const { bridge } = setup();
  const r = await bridge.deleteMark(999);
  assert.equal(r.removed, null);
});
