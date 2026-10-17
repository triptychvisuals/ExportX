'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const profiles = require('../src/profiles');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'exportx-profiles-'));
}

test('bundled profiles load and are valid', () => {
  const list = profiles.loadProfiles([profiles.bundledProfilesDir()]);
  assert.ok(list.length >= 3, 'expected at least three bundled profiles');
  const ids = list.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'profile ids must be unique');
  assert.ok(ids.includes('prores-master'));
  for (const p of list) {
    assert.ok(p.format && p.codec, `${p.id} needs format and codec`);
  }
});

test('user profiles override bundled ones by id', () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, 'mine.json'),
    JSON.stringify({ id: 'prores-master', name: 'My Master', format: 'mov', codec: 'ProRes4444' }),
  );
  const list = profiles.loadProfiles([profiles.bundledProfilesDir(), dir]);
  const master = list.find((p) => p.id === 'prores-master');
  assert.equal(master.name, 'My Master');
  assert.equal(master.codec, 'ProRes4444');
});

test('accepts single object, array, and { profiles: [] } shapes', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ id: 'a', name: 'A', format: 'mp4', codec: 'H264' }));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify([{ id: 'b', name: 'B', format: 'mp4', codec: 'H264' }]));
  fs.writeFileSync(
    path.join(dir, 'c.json'),
    JSON.stringify({ profiles: [{ id: 'c', name: 'C', format: 'mp4', codec: 'H264' }] }),
  );
  const ids = profiles.loadProfiles([dir]).map((p) => p.id).sort();
  assert.deepEqual(ids, ['a', 'b', 'c']);
});

test('rejects malformed profiles with a useful message', () => {
  assert.throws(() => profiles.validateProfile({ id: 'x', name: 'X' }, 'test'), /missing "format"; missing "codec"/);
  assert.throws(() => profiles.validateProfile({ id: 'bad id!', name: 'X', format: 'mp4', codec: 'H264' }), /may only contain/);
  assert.throws(
    () => profiles.validateProfile({ id: 'x', name: 'X', format: 'mp4', codec: 'H264', subfolder: '../escape' }),
    /\.\./,
  );
  assert.throws(
    () => profiles.validateProfile({ id: 'x', name: 'X', format: 'mp4', codec: 'H264', resolution: { width: '1920' } }),
    /resolution/,
  );
});

test('loadProfilesSafe reports broken files without dropping good ones', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify({ id: 'good', name: 'G', format: 'mp4', codec: 'H264' }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
  const { profiles: list, errors } = profiles.loadProfilesSafe([dir]);
  assert.equal(list.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Could not parse/);
});
