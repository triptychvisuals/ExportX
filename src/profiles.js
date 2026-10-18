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
const { defaultLabel } = require('./naming');

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
    label: p.label ? String(p.label) : defaultLabel(p.name),
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
  if (p.label !== undefined && p.label !== null && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(String(p.label))) {
    errors.push(`label "${p.label}" may only contain letters, digits, "-" and "_"`);
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

/** Profiles with provenance: isUser (lives in the user folder) and hasBundled (a bundled one with the same id exists). */
function loadProfilesWithOrigin() {
  const bundled = loadProfilesSafe([bundledProfilesDir()]);
  const user = loadProfilesSafe([userProfilesDir()]);
  const bundledIds = new Set(bundled.profiles.map((p) => p.id));
  const byId = new Map();
  for (const p of bundled.profiles) byId.set(p.id, { ...p, isUser: false, hasBundled: true });
  for (const p of user.profiles) byId.set(p.id, { ...p, isUser: true, hasBundled: bundledIds.has(p.id) });
  return { profiles: [...byId.values()], errors: [...bundled.errors, ...user.errors] };
}

function userProfilePath(id) {
  return path.join(userProfilesDir(), `${id}.json`);
}

/** Validate and write one profile to the user folder (overrides a bundled one with the same id). */
function saveUserProfile(raw) {
  const profile = validateProfile(raw, 'settings');
  fs.mkdirSync(userProfilesDir(), { recursive: true });
  const { source, isUser, hasBundled, ...clean } = profile; // eslint-disable-line no-unused-vars
  fs.writeFileSync(userProfilePath(profile.id), JSON.stringify(clean, null, 2) + '\n');
  return profile;
}

/** Remove a user profile file; a bundled profile with that id comes back. Returns true if a file was removed. */
function deleteUserProfile(id) {
  const file = userProfilePath(id);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'deliverable';
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
  loadProfilesWithOrigin,
  userProfilePath,
  saveUserProfile,
  deleteUserProfile,
  slugify,
};
