'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderName, sanitize } = require('../src/naming');

const fixedDate = new Date(2026, 9, 17, 14, 5, 9); // 2026-10-17 14:05:09 local

test('renders tokens and stamps', () => {
  const name = renderName('{project}-{timeline}_{profile}_{date}-{time}', {
    project: 'Spot A',
    timeline: 'Main Edit',
    profile: 'h264-web',
    now: fixedDate,
  });
  assert.equal(name, 'Spot A-Main Edit_h264-web_20261017-140509');
});

test('unknown tokens vanish and doubled separators collapse', () => {
  assert.equal(renderName('{timeline}_{nope}_{profile}', { timeline: 'TL', profile: 'p' }), 'TL_p');
});

test('strips characters that are unsafe in filenames', () => {
  assert.equal(sanitize('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(renderName('{timeline}', { timeline: 'Reel 1: Final?' }), 'Reel 1_ Final');
});

test('never returns an empty name', () => {
  assert.equal(renderName('{nope}', {}), 'export');
  assert.equal(renderName('', {}), 'export');
});
