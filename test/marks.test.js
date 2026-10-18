'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { marksFromMarkers, KINDS } = require('../src/marks');

const info = { startFrame: 86400, fps: 24, dropFrame: false };

test('marks are rebuilt from timeline markers in order, ignoring foreign markers', () => {
  const markers = {
    240: { color: 'Pink', duration: 1, name: 'Still 1', note: '', customData: 'exportx:still' },
    48: { color: 'Cyan', duration: 72, name: 'Cut 1', note: '', customData: 'exportx:cut' },
    100: { color: 'Blue', duration: 1, name: 'Editor note', note: 'fix flash frame', customData: '' },
    500: { color: 'Cyan', duration: 24, name: 'Cut 2', note: '', customData: 'exportx:cut' },
    10: { color: 'Pink', duration: 1, name: 'Still', note: '', customData: 'exportx:still' },
  };
  const marks = marksFromMarkers(markers, info);
  assert.deepEqual(
    marks.map((m) => `${m.kind}#${m.index}@${m.relIn}`),
    ['still#1@10', 'cut#1@48', 'still#2@240', 'cut#2@500'],
  );
  const cut = marks[1];
  assert.equal(cut.absIn, 86448);
  assert.equal(cut.absOut, 86448 + 71);
  assert.equal(cut.durationFrames, 72);
  assert.equal(cut.tcIn, '01:00:02:00');
  assert.equal(cut.tcOut, '01:00:04:23');
  assert.equal(cut.duration, '3.0s');
  const still = marks[0];
  assert.equal(still.absIn, still.absOut);
  assert.equal(still.durationFrames, 1);
});

test('kinds carry the marker colour and customData used in Resolve', () => {
  assert.equal(KINDS.cut.customData, 'exportx:cut');
  assert.equal(KINDS.still.customData, 'exportx:still');
  assert.ok(KINDS.cut.color && KINDS.still.color);
});
