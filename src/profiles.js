'use strict';

/**
 * Deliverable profiles: small JSON documents that describe one output
 * (container, codec, resolution, Resolve render settings, naming).
 *
 * Profiles are read from two places, later ones overriding earlier ones by id:
 *   1. <plugin>/profiles/*.json        (bundled defaults)
 *   2. ~/.exportx/profiles/*.json      (your own; EXPORTX_HOME overrides ~/.exportx)
 *
 * A file may hold a single profile object, an array of profiles, or
 * { "profiles": [...] }. See docs/PROFILES.md for the schema.
 *
 * target decides what a profile is applied to: "timeline" (the whole
 * timeline), "cuts" (each cut mark) or "stills" (each still mark). codec may
 * be "auto" to take the first codec Resolve offers for the format.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REQUIRED = ['id', 'name', 'format', 'codec'];
const RENDER_MODES = ['single', 'individual'];
const TARGETS = ['timeline', 'cuts', 'stills'];

function userDir() {
  return process.env.EXPORTX_HOME || path.join(os.homedir(), '.exportx');
}

function userProfilesDir() {
  return path.join(userDir(), 'profiles');
}

function bundledProfilesDir() {
  return path.join(__dirname, '..', 'profiles');
}

function normalize(p) {
  return {
    id: String(p.id),
    name: String(p.name),
    description: p.description ? String(p.description) : '',
    renderPreset: p.renderPreset ? String(p.renderPreset) : null,
    format: String(p.format),
    codec: String(p.codec),
    target: p.target || 'timeline',
    renderMode: p.renderMode || 'single',
    resolution: p.resolution
      ? { width: Number(p.resolution.width), height: Number(p.resolution.height) }
      : null,
    frameRate: p.frameRate != null ? p.frameRate : null,
    settings: { ...(p.settings || {}) },
    subfolder: p.subfolder ? String(p.subfolder) : '',
    fileSuffix: p.fileSuffix ? String(p.fileSuffix) : '',
    enabledByDefault: p.enabledByDefault !== false,
    tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
  };
}

function validateProfile(p, source = 'profile') {
  const errors = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    throw new Error(`Invalid profile in ${source}: expected an object`);
  }
  for (const key of REQUIRED) {
    if (p[key] === undefined || p[key] === null || p[key] === '') errors.push(`missing "${key}"`);
  }
  if (p.id && !/^[a-z0-9][a-z0-9_-]*$/i.test(String(p.id))) {
    errors.push(`id "${p.id}" may only contain letters, digits, "-" and "_"`);
  }
  if (p.renderMode && !RENDER_MODES.includes(p.renderMode)) {
    errors.push(`renderMode must be one of ${RENDER_MODES.join(', ')}`);
  }
  if (p.target && !TARGETS.includes(p.target)) {
    errors.push(`target must be one of ${TARGETS.join(', ')}`);
  }
  if (p.resolution) {
    const { width, height } = p.resolution;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      errors.push('resolution must be { "width": int, "height": int }');
    }
  }
  if (p.settings && (typeof p.settings !== 'object' || Array.isArray(p.settings))) {
    errors.push('"settings" must be an object of Resolve render settings');
  }
  if (p.subfolder && /(^|[\\/])\.\.([\\/]|$)/.test(String(p.subfolder))) {
    errors.push('subfolder may not contain ".."');
  }
  if (p.subfolder && path.isAbsolute(String(p.subfolder))) {
    errors.push('subfolder must be relative to the output folder');
  }
  if (errors.length) throw new Error(`Invalid profile in ${source}: ${errors.join('; ')}`);
  return normalize(p);
}

function parseProfileFile(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`Could not parse ${filePath}: ${err.message}`);
  }
  let list;
  if (Array.isArray(parsed)) list = parsed;
  else if (parsed && Array.isArray(parsed.profiles)) list = parsed.profiles;
  else list = [parsed];
  return list.map((p, i) => ({ ...validateProfile(p, `${filePath}[${i}]`), source: filePath }));
}

function loadProfilesFromDir(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .sort();
  const out = [];
  for (const file of files) out.push(...parseProfileFile(path.join(dir, file)));
  return out;
}

/** Strict load: throws on the first problem. */
function loadProfiles(dirs) {
  const byId = new Map();
  for (const dir of dirs) {
    for (const p of loadProfilesFromDir(dir)) byId.set(p.id, p);
  }
  return [...byId.values()];
}

/** Lenient load: one broken file does not hide the others. */
function loadProfilesSafe(dirs) {
  const byId = new Map();
  const errors = [];
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.json'))
      .sort();
    for (const file of files) {
      const full = path.join(dir, file);
      try {
        for (const p of parseProfileFile(full)) byId.set(p.id, p);
      } catch (err) {
        errors.push({ file: full, message: err.message });
      }
    }
  }
  return { profiles: [...byId.values()], errors };
}

function defaultProfileDirs() {
  return [bundledProfilesDir(), userProfilesDir()];
}

module.exports = {
  TARGETS,
  userDir,
  userProfilesDir,
  bundledProfilesDir,
  defaultProfileDirs,
  normalize,
  validateProfile,
  parseProfileFile,
  loadProfilesFromDir,
  loadProfiles,
  loadProfilesSafe,
};
