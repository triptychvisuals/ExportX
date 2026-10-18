'use strict';

/**
 * Timecode <-> frame helpers for Resolve timelines.
 *
 * Resolve reports the playhead as "HH:MM:SS:FF" (non-drop) or "HH:MM:SS;FF"
 * (drop-frame). Frame numbers used for MarkIn/MarkOut and GetStartFrame() are
 * absolute, i.e. a timeline that starts at 01:00:00:00 @ 24 fps starts at
 * frame 86400. Marker frameIds, by contrast, are relative to the timeline
 * start. Keep both in mind; the marks module does the conversion.
 */

const FRACTIONAL = {
  23.976: 24000 / 1001,
  23.98: 24000 / 1001,
  29.97: 30000 / 1001,
  47.952: 48000 / 1001,
  47.95: 48000 / 1001,
  59.94: 60000 / 1001,
  119.88: 120000 / 1001,
};

function parseFps(value) {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return 24;
  return FRACTIONAL[n] || n;
}

function timebase(fps) {
  return Math.max(1, Math.round(fps));
}

function isDropFrameTimecode(tc) {
  return /[;,]/.test(String(tc ?? ''));
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

function tcToFrames(tc, fps, dropFrame = isDropFrameTimecode(tc)) {
  const parts = String(tc ?? '')
    .trim()
    .split(/[:;,.]/)
    .map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`Bad timecode "${tc}"`);
  }
  const [h, m, s, f] = parts;
  const tb = timebase(fps);
  let frames = (h * 3600 + m * 60 + s) * tb + f;
  if (dropFrame && (tb === 30 || tb === 60)) {
    const drop = tb === 30 ? 2 : 4;
    const totalMinutes = h * 60 + m;
    frames -= drop * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return frames;
}

function framesToTc(frames, fps, dropFrame = false) {
  const tb = timebase(fps);
  let n = Math.max(0, Math.round(Number(frames) || 0));
  if (dropFrame && (tb === 30 || tb === 60)) {
    const drop = tb === 30 ? 2 : 4;
    const per10Min = Math.round(fps * 600);
    const perMin = tb * 60 - drop;
    const tens = Math.floor(n / per10Min);
    const rem = n % per10Min;
    n += drop * 9 * tens;
    if (rem > drop) n += drop * Math.floor((rem - drop) / perMin);
    const f = n % tb;
    const s = Math.floor(n / tb) % 60;
    const m = Math.floor(n / (tb * 60)) % 60;
    const h = Math.floor(n / (tb * 3600)) % 24;
    return `${pad(h)}:${pad(m)}:${pad(s)};${pad(f)}`;
  }
  const f = n % tb;
  const s = Math.floor(n / tb) % 60;
  const m = Math.floor(n / (tb * 60)) % 60;
  const h = Math.floor(n / (tb * 3600)) % 24;
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`;
}

function formatDuration(frames, fps) {
  const seconds = Math.max(0, Number(frames) || 0) / (fps || 24);
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`;
  return `${seconds.toFixed(1)}s`;
}

/** "01:00:12:05" -> "01.00.12.05", safe in a filename. */
function tcForFilename(tc) {
  return String(tc ?? '').replace(/[:;,]/g, '.');
}

module.exports = { parseFps, timebase, isDropFrameTimecode, tcToFrames, framesToTc, formatDuration, tcForFilename, pad };
