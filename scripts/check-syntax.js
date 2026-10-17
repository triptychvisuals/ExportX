'use strict';
// Syntax-check every JavaScript file the plugin ships, without needing Electron.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = ['main.js', 'preload.js'];
for (const dir of ['src', 'ui', 'test', 'test/helpers', 'scripts']) {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) continue;
  for (const f of fs.readdirSync(full)) if (f.endsWith('.js')) files.push(path.join(dir, f));
}
let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'pipe' });
    console.log(`ok   ${f}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${f}\n${err.stderr}`);
  }
}
JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
console.log(failed ? `${failed} file(s) failed` : 'all files parse');
process.exit(failed ? 1 : 0);
