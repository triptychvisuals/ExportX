'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFps, tcToFrames, framesToTc, formatDuration, tcForFilename } = require('../src/timecode');

test('parseFps normalises Resolve strings', () => {
  assert.equal(parseFps('24'), 24);
  assert.equal(parseFps('25'), 25);
  assert.equal(parseFps('23.976'), 24000 / 1001);
  assert.equal(parseFps('29.97'), 30000 / 1001);
  assert.equal(parseFps('59.94'), 60000 / 1001);
  assert.equal(parseFps(''), 24);
});

test('non-drop timecode round-trips', () => {
  assert.equal(tcToFrames('01:00:00:00', 24), 86400);
  assert.equal(tcToFrames('01:00:12:05', 24), 86400 + 12 * 24 + 5);
  assert.equal(framesToTc(86400 + 12 * 24 + 5, 24), '01:00:12:05');
  assert.equal(framesToTc(tcToFrames('00:59:59:23', 23.976), 23.976), '00:59:59:23');
  assert.equal(framesToTc(tcToFrames('10:20:30:24', 25), 25), '10:20:30:24');
});

test('drop-frame timecode follows the 29.97 and 59.94 rules', () => {
  assert.equal(tcToFrames('00:01:00;02', 29.97), 1800);
  assert.equal(tcToFrames('00:10:00;00', 29.97), 17982);
  assert.equal(framesToTc(1800, 29.97, true), '00:01:00;02');
  assert.equal(framesToTc(17982, 29.97, true), '00:10:00;00');
  assert.equal(framesToTc(1799, 29.97, true), '00:00:59;29');
  for (const n of [0, 1, 1797, 1798, 1799, 1800, 17981, 17982, 17983, 107892, 2589407]) {
    assert.equal(tcToFrames(framesToTc(n, 29.97, true), 29.97), n, `29.97 DF frame ${n}`);
    assert.equal(tcToFrames(framesToTc(n, 59.94, true), 59.94), n, `59.94 DF frame ${n}`);
  }
});

test('rejects garbage', () => {
  assert.throws(() => tcToFrames('nope', 24), /Bad timecode/);
});

test('formatting helpers', () => {
  assert.equal(formatDuration(48, 24), '2.0s');
  assert.equal(formatDuration(24 * 90, 24), '1m 30.0s');
  assert.equal(tcForFilename('01:00:12;05'), '01.00.12.05');
});
