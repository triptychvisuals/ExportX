'use strict';

/**
 * Output filename templating.
 *
 * Templates use {token} placeholders. Available tokens:
 *   {yymmdd} {date} (YYYYMMDD) {time} (HHMMSS)
 *   {project} {timeline} {label} {profile} {profileName} {format} {codec} {width} {height}
 *   per-mark: {n} {cut} {still} {tc} {tcout} {in} {out}
 * Unknown tokens render as an empty string. The result is made filesystem
 * safe (no path separators, no control characters).
 *
 * The default convention is {yymmdd}_{project}_{label}, e.g. 251018_SpotA_Final.
 */

const UNSAFE = /[\\/:*?"<>|\u0000-\u001f]/g;
const DEFAULT_TEMPLATE = '{yymmdd}_{project}_{label}';

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
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  return {
    yymmdd: `${String(yyyy).slice(-2)}${mm}${dd}`,
    date: `${yyyy}${mm}${dd}`,
    yyyymmdd: `${yyyy}${mm}${dd}`,
    time: `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  };
}

/**
 * @param {string} template
 * @param {object} context  token values; `now` (Date) sets the date tokens
 * @param {object} [opts]
 * @param {boolean} [opts.underscoreSpaces]  turn spaces into underscores (251018_Spot_A_Final)
 */
function renderName(template, context = {}, opts = {}) {
  const { now, ...rest } = context;
  const values = { ...stamp(now instanceof Date ? now : undefined), ...rest };
  const rendered = String(template ?? '').replace(/\{(\w+)\}/g, (_match, key) => {
    const value = values[key];
    return value === undefined || value === null ? '' : String(value);
  });
  let clean = sanitize(rendered);
  if (opts.underscoreSpaces) clean = clean.replace(/\s+/g, '_');
  clean = clean.replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
  return clean || 'export';
}

/** A short label for a deliverable when its profile does not set one: first word of the name. */
function defaultLabel(name) {
  const first = String(name ?? '').trim().split(/\s+/)[0] || 'Export';
  const clean = first.replace(/[^A-Za-z0-9]/g, '');
  return clean ? clean[0].toUpperCase() + clean.slice(1) : 'Export';
}

const TOKENS = [
  ['{yymmdd}', 'Today as YYMMDD (251018)'],
  ['{date}', 'Today as YYYYMMDD'],
  ['{time}', 'Now as HHMMSS'],
  ['{project}', 'Resolve project name'],
  ['{timeline}', 'Timeline name'],
  ['{label}', 'Deliverable label (Final, Master, Social, Still)'],
  ['{profile}', 'Deliverable id'],
  ['{n}', 'Cut or still number, 01, 02, …'],
  ['{tc}', 'In point of the cut or still, 01.00.12.05'],
  ['{width}', 'Output width, if the deliverable sets one'],
  ['{height}', 'Output height, if the deliverable sets one'],
];

module.exports = { sanitize, renderName, stamp, defaultLabel, DEFAULT_TEMPLATE, TOKENS };
