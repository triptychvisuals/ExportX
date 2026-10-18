'use strict';

/**
 * Marks are the cuts and stills the user captured with the cut and still keys.
 * They are stored as Resolve timeline markers so they are visible on the
 * timeline, survive restarts, travel with the project, and can be removed in
 * Resolve. ExportX recognises its markers by customData.
 */

const { framesToTc, formatDuration } = require('./timecode');

const KINDS = {
  cut: { customData: 'exportx:cut', color: 'Cyan', label: 'Cut', plural: 'cuts' },
  still: { customData: 'exportx:still', color: 'Pink', label: 'Still', plural: 'stills' },
};

function kindFromMarker(marker) {
  const cd = String((marker && marker.customData) || '');
  if (cd.startsWith(KINDS.cut.customData)) return 'cut';
  if (cd.startsWith(KINDS.still.customData)) return 'still';
  return null;
}

function buildMark({ kind, relIn, relOut, name, note, color }, info = {}) {
  const { startFrame = 0, fps = 24, dropFrame = false } = info;
  const absIn = startFrame + relIn;
  const absOut = startFrame + relOut;
  const durationFrames = relOut - relIn + 1;
  return {
    id: `${kind}@${relIn}`,
    kind,
    relIn,
    relOut,
    absIn,
    absOut,
    durationFrames,
    seconds: durationFrames / fps,
    tcIn: framesToTc(absIn, fps, dropFrame),
    tcOut: framesToTc(absOut, fps, dropFrame),
    duration: formatDuration(durationFrames, fps),
    name: name || '',
    note: note || '',
    color: color || KINDS[kind].color,
    index: 0,
  };
}

/**
 * @param {Object} markers  Timeline.GetMarkers() result: { frameId: { color, duration, note, name, customData } }
 * @param {{startFrame:number, fps:number, dropFrame?:boolean}} info
 */
function marksFromMarkers(markers, info) {
  const list = [];
  for (const [key, marker] of Object.entries(markers || {})) {
    const kind = kindFromMarker(marker);
    if (!kind) continue;
    const relIn = Number(key);
    if (!Number.isFinite(relIn)) continue;
    const duration = Math.max(1, Number(marker.duration) || 1);
    const relOut = kind === 'still' ? relIn : relIn + duration - 1;
    list.push(buildMark({ kind, relIn, relOut, name: marker.name, note: marker.note, color: marker.color }, info));
  }
  list.sort((a, b) => a.relIn - b.relIn || a.kind.localeCompare(b.kind));
  let cuts = 0;
  let stills = 0;
  for (const m of list) m.index = m.kind === 'cut' ? ++cuts : ++stills;
  return list;
}

module.exports = { KINDS, kindFromMarker, buildMark, marksFromMarkers };
