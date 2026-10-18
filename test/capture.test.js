'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ResolveBridge } = require('../src/resolve');
const { classifyPress } = require('../src/marks');
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

test('a hold becomes a cut marker, a tap a still marker, both relative to the timeline start', async () => {
  const { bridge, tl } = setup();
  const press = classifyPress({ absIn: 86400 + 48, absOut: 86400 + 48 + 71, fps: 24 });
  const afterCut = await bridge.addMark(press);
  assert.equal(afterCut.added.kind, 'cut');
  assert.equal(afterCut.added.index, 1);
  assert.deepEqual(tl.markers[48] && [tl.markers[48].color, tl.markers[48].duration, tl.markers[48].customData], ['Cyan', 72, 'exportx:cut']);

  const tap = classifyPress({ absIn: 86400 + 200, absOut: 86400 + 203, fps: 24 });
  const afterStill = await bridge.addMark(tap);
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
