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
  assert.ok(ids.includes('final-prores-master'));
  assert.ok(ids.includes('cuts-social-1080'));
  assert.ok(ids.includes('stills-tiff'));
  const targets = new Set(list.map((p) => p.target));
  assert.deepEqual([...targets].sort(), ['cuts', 'stills', 'timeline']);
  for (const p of list) {
    assert.ok(p.format && p.codec, `${p.id} needs format and codec`);
  }
});

test('user profiles override bundled ones by id', () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, 'mine.json'),
    JSON.stringify({ id: 'final-prores-master', name: 'My Master', format: 'mov', codec: 'ProRes4444' }),
  );
  const list = profiles.loadProfiles([profiles.bundledProfilesDir(), dir]);
  const master = list.find((p) => p.id === 'final-prores-master');
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
  assert.throws(() => profiles.validateProfile({ id: 'x', name: 'X', format: 'tif', codec: 'auto', target: 'frames' }), /target must be/);
  assert.equal(profiles.validateProfile({ id: 'x', name: 'X', format: 'tif', codec: 'auto', target: 'stills' }).target, 'stills');
  assert.equal(profiles.validateProfile({ id: 'y', name: 'Y', format: 'mp4', codec: 'H264' }).target, 'timeline');
});

test('labels default to the first word and must be filename-safe', () => {
  assert.equal(profiles.validateProfile({ id: 'x', name: 'Social cuts', format: 'mp4', codec: 'H264' }).label, 'Social');
  assert.equal(profiles.validateProfile({ id: 'x', name: 'Final 4K', label: 'Final', format: 'mp4', codec: 'H264' }).label, 'Final');
  assert.throws(() => profiles.validateProfile({ id: 'x', name: 'X', label: 'Fin al', format: 'mp4', codec: 'H264' }), /label/);
  for (const p of profiles.loadProfiles([profiles.bundledProfilesDir()])) assert.match(p.label, /^[A-Za-z0-9_-]+$/);
});

test('user profiles save to EXPORTX_HOME, override bundled ones, and can be removed again', () => {
  const home = tmpDir();
  const prev = process.env.EXPORTX_HOME;
  process.env.EXPORTX_HOME = home;
  try {
    const before = profiles.loadProfilesWithOrigin().profiles.find((p) => p.id === 'final-4k-h265');
    assert.equal(before.isUser, false);
    assert.equal(before.hasBundled, true);
    const saved = profiles.saveUserProfile({ ...before, codec: 'H264', label: 'Final' });
    assert.equal(saved.codec, 'H264');
    assert.ok(fs.existsSync(profiles.userProfilePath('final-4k-h265')));
    const after = profiles.loadProfilesWithOrigin().profiles.find((p) => p.id === 'final-4k-h265');
    assert.equal(after.isUser, true);
    assert.equal(after.hasBundled, true);
    assert.equal(after.codec, 'H264');
    const written = JSON.parse(fs.readFileSync(profiles.userProfilePath('final-4k-h265'), 'utf8'));
    assert.equal(written.source, undefined);
    assert.equal(written.isUser, undefined);
    assert.equal(profiles.deleteUserProfile('final-4k-h265'), true);
    assert.equal(profiles.deleteUserProfile('final-4k-h265'), false);
    const restored = profiles.loadProfilesWithOrigin().profiles.find((p) => p.id === 'final-4k-h265');
    assert.equal(restored.isUser, false);
    assert.equal(restored.codec, 'H265');
    assert.throws(() => profiles.saveUserProfile({ id: 'bad id', name: 'B', format: 'mp4', codec: 'H264' }), /may only contain/);
    assert.equal(profiles.slugify('Client HEVC 10-bit!'), 'client-hevc-10-bit');
  } finally {
    if (prev === undefined) delete process.env.EXPORTX_HOME;
    else process.env.EXPORTX_HOME = prev;
  }
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
