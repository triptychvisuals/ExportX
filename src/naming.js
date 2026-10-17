'use strict';

/**
 * Output filename templating.
 *
 * Templates use {token} placeholders. Available tokens:
 *   {project} {timeline} {profile} {profileName} {format} {codec}
 *   {width} {height} {date} (YYYYMMDD) {time} (HHMMSS)
 * Unknown tokens render as an empty string. The result is made filesystem
 * safe (no path separators, no control characters).
 */

const UNSAFE = /[\\/:*?"<>|\u0000-\u001f]/g;

function sanitize(name) {
  return String(name ?? '')
    .replace(UNSAFE, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

function stamp(date = new Date()) {
  return {
    date: `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    time: `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  };
}

function renderName(template, context = {}) {
  const { now, ...rest } = context;
  const values = { ...stamp(now instanceof Date ? now : undefined), ...rest };
  const rendered = String(template ?? '').replace(/\{(\w+)\}/g, (_match, key) => {
    const value = values[key];
    return value === undefined || value === null ? '' : String(value);
  });
  const clean = sanitize(rendered).replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
  return clean || 'export';
}

const TOKENS = [
  ['{project}', 'Resolve project name'],
  ['{timeline}', 'Timeline name'],
  ['{profile}', 'Deliverable profile id'],
  ['{profileName}', 'Deliverable profile display name'],
  ['{format}', 'Container (mov, mp4, ...)'],
  ['{codec}', 'Codec id'],
  ['{width}', 'Output width, if the profile sets one'],
  ['{height}', 'Output height, if the profile sets one'],
  ['{date}', 'Today as YYYYMMDD'],
  ['{time}', 'Now as HHMMSS'],
];

module.exports = { sanitize, renderName, stamp, TOKENS };
