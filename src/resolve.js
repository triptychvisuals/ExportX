'use strict';

/**
 * ResolveBridge: a small, promise-friendly wrapper around the DaVinci Resolve
 * scripting object that a Workflow Integration plugin receives from
 * WorkflowIntegration.GetResolve().
 *
 * Every Resolve call is awaited. The native binding has returned plain values
 * in some Resolve versions and Promises in others; awaiting both is harmless,
 * so this module works either way. The same wrapper also runs against the
 * mock in test/helpers/mock-resolve.js.
 *
 * API surface used (see docs/RESOLVE_API.md):
 *   Project:  render presets/formats/codecs, SetRenderSettings, AddRenderJob,
 *             StartRendering, StopRendering, GetRenderJobStatus, timelines
 *   Timeline: GetStartFrame/GetEndFrame, GetSetting, GetCurrentTimecode,
 *             SetCurrentTimecode, GetMarkers, AddMarker, DeleteMarkerAtFrame
 */

const { parseFps, tcToFrames, framesToTc, isDropFrameTimecode } = require('./timecode');
const { KINDS, marksFromMarkers } = require('./marks');

class ResolveError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ResolveError';
    if (details !== undefined) this.details = details;
  }
}

const STATUS_MAP = {
  ready: 'ready',
  queued: 'ready',
  rendering: 'rendering',
  complete: 'complete',
  completed: 'complete',
  failed: 'failed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
};

const AUTO_CODEC = /^(auto|\*|first|default)$/i;

function normKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Find an entry in a Resolve {description: id} map by id or description.
 * Matching ignores case and punctuation, so "ProRes 422 HQ", "ProRes422HQ"
 * and "Apple ProRes 422 HQ" all resolve to the same codec.
 */
function matchEntry(map, wanted) {
  if (!map || wanted === undefined || wanted === null) return null;
  const target = normKey(wanted);
  if (!target) return null;
  const entries = Object.entries(map);
  for (const [description, id] of entries) {
    if (normKey(id) === target || normKey(description) === target) return { description, id };
  }
  for (const [description, id] of entries) {
    if (normKey(description).includes(target)) return { description, id };
  }
  return null;
}

function normalizeJobStatus(jobId, raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const text = String(r.JobStatus ?? r.Status ?? '').toLowerCase();
  return {
    jobId,
    status: STATUS_MAP[text] || (text || 'unknown'),
    percent: Math.max(0, Math.min(100, Number(r.CompletionPercentage ?? 0) || 0)),
    etaMs: r.EstimatedTimeRemainingInMs != null ? Number(r.EstimatedTimeRemainingInMs) : null,
    tookMs: r.TimeTakenToRenderInMs != null ? Number(r.TimeTakenToRenderInMs) : null,
    error: r.Error ? String(r.Error) : null,
  };
}

/**
 * Turn a profile plus per-run options into the dictionary that
 * Project.SetRenderSettings() expects. `opts.range` holds absolute frames.
 */
function buildRenderSettings(profile, opts = {}) {
  const settings = { ...(profile.settings || {}) };
  if (opts.targetDir) settings.TargetDir = opts.targetDir;
  if (opts.customName) settings.CustomName = opts.customName;
  if (profile.resolution) {
    settings.FormatWidth = profile.resolution.width;
    settings.FormatHeight = profile.resolution.height;
  }
  if (profile.frameRate != null) settings.FrameRate = profile.frameRate;
  if (opts.range && opts.range.markIn != null && opts.range.markOut != null) {
    settings.SelectAllFrames = false;
    settings.MarkIn = Number(opts.range.markIn);
    settings.MarkOut = Number(opts.range.markOut);
  } else if (settings.SelectAllFrames === undefined) {
    settings.SelectAllFrames = true;
  }
  if (settings.ExportVideo === undefined) settings.ExportVideo = true;
  if (profile.target === 'stills') settings.ExportAudio = false;
  else if (settings.ExportAudio === undefined) settings.ExportAudio = true;
  return settings;
}

/**
 * Project.SetRenderSettings() takes the whole dictionary or none of it: one key
 * Resolve does not offer for the format and codec in front of it (a quality
 * level H.264 has no use for, an AAC bit depth, an encoding profile) and the
 * call answers false. So the settings go in in layers:
 *
 *   1. the ones a job cannot do without, together: the folder, the name, the
 *      frame range. Refused, they are tried group by group to name the culprit,
 *      and that is an error worth stopping for;
 *   2. the picture size, as a pair: an error for a deliverable (a "Final 4K"
 *      at timeline size is the wrong file), dropped with a note when `lenient`
 *      (the preview proxy);
 *   3. everything else one key at a time; a refused key is dropped and reported,
 *      and the job renders without it.
 */
const HARD_GROUPS = [['TargetDir'], ['CustomName'], ['SelectAllFrames', 'MarkIn', 'MarkOut']];
const SIZE_KEYS = ['FormatWidth', 'FormatHeight'];
const SETTING_HINTS = {
  TargetDir: 'Check that the output folder exists and that Resolve can write to it.',
  CustomName: 'The file name has a character Resolve does not accept; change the name pattern under Settings.',
  SelectAllFrames: 'Resolve did not accept the frame range; clear the marks and set them again.',
  MarkIn: 'The in and out frames fall outside the timeline; clear the marks and set them again.',
  MarkOut: 'The in and out frames fall outside the timeline; clear the marks and set them again.',
  FormatWidth: "That size is not offered for this codec. Pick a standard size for the deliverable under Settings, or leave the size empty to use the timeline's.",
  FormatHeight: "That size is not offered for this codec. Pick a standard size for the deliverable under Settings, or leave the size empty to use the timeline's.",
};

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/**
 * Set `settings` on the Deliver page the layered way described above.
 * Resolves with { applied, rejected: [{ key, value }] }; throws a ResolveError
 * naming the key when an essential one is refused.
 */
async function applyRenderSettings(project, settings, { lenient = false, label = '' } = {}) {
  const applied = {};
  const rejected = [];
  const trySet = async (part) => {
    if (!Object.keys(part).length) return true;
    const ok = await project.SetRenderSettings(part);
    if (ok) Object.assign(applied, part);
    return Boolean(ok);
  };
  const refuse = (key) =>
    new ResolveError(`Resolve refused the render setting ${key} = ${JSON.stringify(settings[key])}${label}. ${SETTING_HINTS[key] || ''}`.trim(), { key, value: settings[key], settings });

  const hard = pick(settings, HARD_GROUPS.flat());
  if (!(await trySet(hard))) {
    for (const group of HARD_GROUPS) {
      const part = pick(settings, group);
      if (Object.keys(part).length && !(await trySet(part))) throw refuse(Object.keys(part)[0]);
    }
  }
  const size = pick(settings, SIZE_KEYS);
  if (Object.keys(size).length && !(await trySet(size))) {
    if (!lenient) throw refuse('FormatWidth');
    for (const key of Object.keys(size)) rejected.push({ key, value: size[key] });
  }
  const done = new Set([...HARD_GROUPS.flat(), ...SIZE_KEYS]);
  for (const key of Object.keys(settings)) {
    if (done.has(key) || settings[key] === undefined) continue;
    if (!(await trySet({ [key]: settings[key] }))) rejected.push({ key, value: settings[key] });
  }
  return { applied, rejected };
}

class ResolveBridge {
  constructor(resolve) {
    if (!resolve) throw new ResolveError('No Resolve scripting object was provided');
    this.resolve = resolve;
  }

  // ------------------------------------------------------------ project

  async info() {
    const product = await this.resolve.GetProductName();
    const version = await this.resolve.GetVersionString();
    return { product: String(product || 'DaVinci Resolve'), version: String(version || '') };
  }

  async projectManager() {
    const pm = await this.resolve.GetProjectManager();
    if (!pm) throw new ResolveError('Resolve did not return a project manager');
    return pm;
  }

  async project() {
    const pm = await this.projectManager();
    const project = await pm.GetCurrentProject();
    if (!project) throw new ResolveError('No project is open in Resolve');
    return project;
  }

  async projectName() {
    const project = await this.project();
    return String(await project.GetName());
  }

  // ------------------------------------------------------------ timelines

  async timelines() {
    const project = await this.project();
    const count = Number(await project.GetTimelineCount()) || 0;
    const current = await project.GetCurrentTimeline();
    const currentName = current ? String(await current.GetName()) : null;
    const list = [];
    for (let i = 1; i <= count; i += 1) {
      const tl = await project.GetTimelineByIndex(i);
      if (!tl) continue;
      const name = String(await tl.GetName());
      list.push({ index: i, name, current: name === currentName });
    }
    return { current: currentName, list };
  }

  async timelineByName(name) {
    const project = await this.project();
    const count = Number(await project.GetTimelineCount()) || 0;
    for (let i = 1; i <= count; i += 1) {
      const tl = await project.GetTimelineByIndex(i);
      if (tl && String(await tl.GetName()) === name) return tl;
    }
    throw new ResolveError(`Timeline "${name}" was not found in the current project`);
  }

  async setCurrentTimeline(name) {
    const project = await this.project();
    const tl = await this.timelineByName(name);
    const ok = await project.SetCurrentTimeline(tl);
    if (!ok) throw new ResolveError(`Resolve refused to switch to timeline "${name}"`);
    return tl;
  }

  async currentTimeline() {
    const project = await this.project();
    const tl = await project.GetCurrentTimeline();
    if (!tl) throw new ResolveError('No timeline is open in Resolve');
    return tl;
  }

  /** Name, frame range and frame rate of a timeline (default: the current one). */
  async timelineInfo(tl) {
    const timeline = tl || (await this.currentTimeline());
    const name = String(await timeline.GetName());
    const startFrame = Number(await timeline.GetStartFrame()) || 0;
    const endFrame = Number(await timeline.GetEndFrame()) || startFrame;
    const fps = parseFps(await timeline.GetSetting('timelineFrameRate'));
    let dropFrame = false;
    try {
      dropFrame = String(await timeline.GetSetting('timelineDropFrameTimecode')) === '1';
    } catch (_err) {
      dropFrame = false;
    }
    let width = 0;
    let height = 0;
    try {
      width = Number(await timeline.GetSetting('timelineResolutionWidth')) || 0;
      height = Number(await timeline.GetSetting('timelineResolutionHeight')) || 0;
    } catch (_err) {
      width = 0;
      height = 0;
    }
    const inOut = await this.timelineInOut(timeline, { startFrame, endFrame, fps, dropFrame });
    return { name, startFrame, endFrame, fps, dropFrame, frames: endFrame - startFrame + 1, width, height, vertical: height > width, inOut };
  }

  /** timelineInfo for a timeline named in the project, without switching to it. */
  async timelineInfoByName(name) {
    return this.timelineInfo(await this.timelineByName(name));
  }

  /**
   * The In and Out points set on the timeline (I and O in Resolve), as absolute
   * frames, or null when none is set or the whole timeline is between them.
   * Resolve 19 exposes them (Timeline.GetMarkInOut); older versions have no way
   * to read them, so they answer null and the whole timeline is the range.
   * Resolve reports them like marker frames, relative to the timeline start.
   */
  async timelineInOut(timeline, { startFrame, endFrame, fps, dropFrame }) {
    if (typeof timeline.GetMarkInOut !== 'function') return null;
    let raw;
    try {
      raw = await timeline.GetMarkInOut();
    } catch (_err) {
      return null;
    }
    const pick = raw && typeof raw === 'object' ? raw.video || raw.audio : null;
    if (!pick || pick.in === undefined || pick.in === null || pick.out === undefined || pick.out === null) return null;
    let absIn = Number(pick.in);
    let absOut = Number(pick.out);
    if (!Number.isFinite(absIn) || !Number.isFinite(absOut)) return null;
    // Relative to the timeline start (what Resolve does) unless the numbers only make sense as absolute frames.
    if (absOut <= endFrame - startFrame || absIn < startFrame) {
      absIn += startFrame;
      absOut += startFrame;
    }
    if (absOut < absIn) [absIn, absOut] = [absOut, absIn];
    absIn = Math.min(endFrame, Math.max(startFrame, Math.round(absIn)));
    absOut = Math.min(endFrame, Math.max(startFrame, Math.round(absOut)));
    if (absIn === startFrame && absOut === endFrame) return null;
    return { absIn, absOut, frames: absOut - absIn + 1, tcIn: framesToTc(absIn, fps, dropFrame), tcOut: framesToTc(absOut, fps, dropFrame) };
  }

  async playhead(info) {
    const tl = await this.currentTimeline();
    const tlInfo = info || (await this.timelineInfo(tl));
    const tc = String(await tl.GetCurrentTimecode());
    const dropFrame = tlInfo.dropFrame || isDropFrameTimecode(tc);
    const absFrame = tcToFrames(tc, tlInfo.fps, dropFrame);
    return { tc, absFrame, relFrame: absFrame - tlInfo.startFrame, timeline: tlInfo.name, fps: tlInfo.fps };
  }

  async seek(absFrame, info) {
    const tl = await this.currentTimeline();
    const tlInfo = info || (await this.timelineInfo(tl));
    const tc = framesToTc(absFrame, tlInfo.fps, tlInfo.dropFrame);
    const ok = await tl.SetCurrentTimecode(tc);
    if (!ok) throw new ResolveError(`Resolve refused to move the playhead to ${tc}`);
    return tc;
  }

  // ------------------------------------------------------------ marks (timeline markers)

  async marks(tl) {
    const timeline = tl || (await this.currentTimeline());
    const info = await this.timelineInfo(timeline);
    const markers = (await timeline.GetMarkers()) || {};
    return { info, marks: marksFromMarkers(markers, info) };
  }

  async marksForTimeline(name) {
    return this.marks(await this.timelineByName(name));
  }

  async addMark({ kind, absIn, absOut }) {
    const def = KINDS[kind];
    if (!def) throw new ResolveError(`Unknown mark kind "${kind}"`);
    const tl = await this.currentTimeline();
    const info = await this.timelineInfo(tl);
    const relIn = Math.max(0, absIn - info.startFrame);
    const duration = kind === 'still' ? 1 : Math.max(1, absOut - absIn + 1);
    const before = await this.marks(tl);
    const n = before.marks.filter((m) => m.kind === kind).length + 1;
    const ok = await tl.AddMarker(relIn, def.color, `${def.label} ${n}`, 'Marked with ExportX', duration, def.customData);
    if (!ok) {
      throw new ResolveError(`Resolve refused a marker at ${framesToTc(absIn, info.fps, info.dropFrame)} (is there already a marker on that frame?)`);
    }
    const after = await this.marks(tl);
    const added = after.marks.find((m) => m.kind === kind && m.relIn === relIn) || null;
    return { ...after, added };
  }

  async deleteMark(relIn) {
    const tl = await this.currentTimeline();
    await tl.DeleteMarkerAtFrame(Number(relIn));
    return this.marks(tl);
  }

  async clearMarks(kind) {
    const tl = await this.currentTimeline();
    const { marks } = await this.marks(tl);
    for (const m of marks) {
      if (!kind || m.kind === kind) await tl.DeleteMarkerAtFrame(m.relIn);
    }
    return this.marks(tl);
  }

  // ------------------------------------------------------------ render settings

  async renderPresets() {
    const project = await this.project();
    const list = await project.GetRenderPresetList();
    return Array.isArray(list) ? list.map(String) : Object.values(list || {}).map(String);
  }

  async renderFormats() {
    const project = await this.project();
    return (await project.GetRenderFormats()) || {};
  }

  async renderCodecs(formatId) {
    const project = await this.project();
    return (await project.GetRenderCodecs(formatId)) || {};
  }

  /** Full format/codec catalogue, handy for writing profiles. */
  /** The sizes Resolve offers for a format and codec (its Deliver page's resolution list), or [] when it cannot say. */
  async renderResolutions(format, codec) {
    const project = await this.project();
    if (typeof project.GetRenderResolutions !== 'function') return [];
    let list;
    try {
      list = await project.GetRenderResolutions(format, codec);
    } catch (_err) {
      return [];
    }
    return (Array.isArray(list) ? list : [])
      .map((r) => ({ width: Number(r.Width !== undefined ? r.Width : r.width), height: Number(r.Height !== undefined ? r.Height : r.height) }))
      .filter((r) => r.width > 0 && r.height > 0);
  }

  async capabilities() {
    const formats = await this.renderFormats();
    const out = [];
    for (const [description, id] of Object.entries(formats)) {
      const codecs = await this.renderCodecs(id);
      out.push({
        description,
        id,
        codecs: Object.entries(codecs).map(([desc, codecId]) => ({ description: desc, id: codecId })),
      });
    }
    return { formats: out, presets: await this.renderPresets() };
  }

  async resolveFormat(wanted) {
    const formats = await this.renderFormats();
    const hit = matchEntry(formats, wanted);
    if (!hit) {
      throw new ResolveError(
        `Unknown render format "${wanted}". Available: ${Object.values(formats).join(', ') || 'none'}`,
      );
    }
    return hit;
  }

  async resolveCodec(formatId, wanted) {
    const codecs = await this.renderCodecs(formatId);
    if (AUTO_CODEC.test(String(wanted))) {
      const [description, id] = Object.entries(codecs)[0] || [];
      if (!id) throw new ResolveError(`Format "${formatId}" offers no codecs`);
      return { description, id };
    }
    const hit = matchEntry(codecs, wanted);
    if (!hit) {
      throw new ResolveError(
        `Unknown codec "${wanted}" for format "${formatId}". Available: ${
          Object.entries(codecs)
            .map(([d, id]) => `${id} (${d})`)
            .join(', ') || 'none'
        }`,
      );
    }
    return hit;
  }

  /**
   * Point Resolve's current render settings at a profile. Order matters:
   * preset first (it resets most fields), then format/codec, then mode, then
   * the explicit settings dictionary, which wins over everything.
   */
  async applyProfile(profile, opts = {}) {
    const project = await this.project();
    if (profile.renderPreset) {
      const ok = await project.LoadRenderPreset(profile.renderPreset);
      if (!ok) throw new ResolveError(`Render preset "${profile.renderPreset}" could not be loaded`);
    }
    let format = null;
    let codec = null;
    if (profile.format && profile.codec) {
      format = await this.resolveFormat(profile.format);
      codec = await this.resolveCodec(format.id, profile.codec);
      const ok = await project.SetCurrentRenderFormatAndCodec(format.id, codec.id);
      if (!ok) throw new ResolveError(`Resolve rejected format/codec ${format.id}/${codec.id}`);
    }
    if (profile.renderMode) {
      // 0 = individual clips, 1 = single clip
      await project.SetCurrentRenderMode(profile.renderMode === 'individual' ? 0 : 1);
    }
    const wanted = buildRenderSettings(profile, opts);
    const label = ` for "${profile.name || profile.id}"${format && codec ? ` (${format.id}/${codec.id})` : ''}`;
    const { applied, rejected } = await applyRenderSettings(project, wanted, { lenient: Boolean(opts.lenient), label });
    return { settings: applied, requested: wanted, rejected, format, codec };
  }

  // ------------------------------------------------------------ render queue

  async addRenderJob() {
    const project = await this.project();
    const jobId = await project.AddRenderJob();
    if (!jobId) throw new ResolveError('Resolve did not add a render job (check the Deliver page for errors)');
    return String(jobId);
  }

  async renderJobs() {
    const project = await this.project();
    const list = await project.GetRenderJobList();
    return Array.isArray(list) ? list : Object.values(list || {});
  }

  async jobStatus(jobId) {
    const project = await this.project();
    return normalizeJobStatus(jobId, await project.GetRenderJobStatus(jobId));
  }

  async startRendering(jobIds = [], interactive = false) {
    const project = await this.project();
    if (jobIds.length) {
      let ok = await project.StartRendering(jobIds, interactive);
      if (!ok) ok = await project.StartRendering(...jobIds);
      return Boolean(ok);
    }
    return Boolean(await project.StartRendering(interactive));
  }

  async stopRendering() {
    const project = await this.project();
    await project.StopRendering();
    return true;
  }

  async isRendering() {
    const project = await this.project();
    return Boolean(await project.IsRenderingInProgress());
  }

  async deleteRenderJob(jobId) {
    const project = await this.project();
    return Boolean(await project.DeleteRenderJob(jobId));
  }

  async deleteAllRenderJobs() {
    const project = await this.project();
    return Boolean(await project.DeleteAllRenderJobs());
  }
}

module.exports = {
  ResolveBridge,
  ResolveError,
  matchEntry,
  normKey,
  normalizeJobStatus,
  buildRenderSettings,
  applyRenderSettings,
  SETTING_HINTS,
};
