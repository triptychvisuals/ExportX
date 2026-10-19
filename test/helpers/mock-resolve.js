'use strict';

/**
 * A small stand-in for the Resolve scripting object. It mirrors the shape of
 * the real API closely enough for unit tests and for running the plugin UI
 * outside Resolve (EXPORTX_MOCK=1 npx electron .).
 *
 * Render jobs "progress" a fixed amount on each GetRenderJobStatus call so a
 * polling loop terminates quickly. Timelines carry markers, a frame rate and
 * a playhead so the capture (cuts/stills) flow can be exercised too.
 */

const DEFAULT_FORMATS = { QuickTime: 'mov', MP4: 'mp4', 'MXF OP1A': 'mxf_op1a', TIFF: 'tif', JPEG: 'jpg', PNG: 'png' };
const DEFAULT_CODECS = {
  mov: {
    'Apple ProRes 422 HQ': 'ProRes422HQ',
    'Apple ProRes 422': 'ProRes422',
    'Apple ProRes 4444': 'ProRes4444',
    'DNxHR HQX': 'DNxHR HQX',
    'H.264': 'H264',
  },
  mp4: { 'H.264': 'H264', 'H.265': 'H265' },
  mxf_op1a: { 'DNxHR HQX': 'DNxHR HQX', 'DNxHD 1080p 220/185/175': 'DNxHD1080p220' },
  tif: { 'RGB 8 bits': 'RGB8', 'RGB 16 bits': 'RGB16' },
  jpg: { JPEG: 'JPEG' },
  png: { 'RGB 8 bits': 'RGB8', 'RGB 16 bits': 'RGB16' },
};

function pad(n) {
  return String(n).padStart(2, '0');
}

function simpleTcToFrames(tc, fps) {
  const [h, m, s, f] = String(tc).split(/[:;]/).map(Number);
  return (h * 3600 + m * 60 + s) * Math.round(fps) + f;
}

function simpleFramesToTc(frames, fps) {
  const tb = Math.round(fps);
  const f = frames % tb;
  const s = Math.floor(frames / tb) % 60;
  const m = Math.floor(frames / (tb * 60)) % 60;
  const h = Math.floor(frames / (tb * 3600)) % 24;
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`;
}

class MockTimeline {
  constructor(spec, index) {
    const o = typeof spec === 'string' ? { name: spec } : spec;
    this.name = o.name;
    this.index = index;
    this.fps = o.fps || 24;
    this.startFrame = o.startFrame != null ? o.startFrame : 3600 * Math.round(this.fps); // 01:00:00:00
    this.endFrame = o.endFrame != null ? o.endFrame : this.startFrame + 10 * 60 * Math.round(this.fps) - 1;
    this.markers = {};
    for (const [k, v] of Object.entries(o.markers || {})) this.markers[k] = { color: 'Blue', duration: 1, note: '', name: '', customData: '', ...v };
    this.playheadAbs = o.playheadAbs != null ? o.playheadAbs : this.startFrame;
    this.width = o.width || 1920;
    this.height = o.height || 1080;
    // In and Out points (I and O in Resolve), relative frames like Resolve 19 reports them; null = none set
    this.inOut = o.inOut || null;
    // How this "Resolve" deletes markers, to exercise the bridge's fallbacks:
    // relative (default) | absolute (DeleteMarkerAtFrame wants absolute frames) | customData | color | never
    this.deleteMode = o.deleteMode || 'relative';
    this.calls = [];
  }
  GetName() {
    return this.name;
  }
  GetMarkInOut() {
    if (!this.inOut) return {};
    return { video: { in: this.inOut.in, out: this.inOut.out }, audio: { in: this.inOut.in, out: this.inOut.out } };
  }
  SetMarkInOut(relIn, relOut) {
    this.calls.push(['SetMarkInOut', relIn, relOut]);
    this.inOut = { in: relIn, out: relOut };
    return true;
  }
  ClearMarkInOut() {
    this.inOut = null;
    return true;
  }
  GetStartFrame() {
    return this.startFrame;
  }
  GetEndFrame() {
    return this.endFrame;
  }
  GetStartTimecode() {
    return simpleFramesToTc(this.startFrame, this.fps);
  }
  GetSetting(name) {
    if (name === 'timelineFrameRate') return String(this.fps);
    if (name === 'timelineDropFrameTimecode') return '0';
    if (name === 'timelineResolutionWidth') return String(this.width);
    if (name === 'timelineResolutionHeight') return String(this.height);
    return '';
  }
  GetCurrentTimecode() {
    return simpleFramesToTc(this.playheadAbs, this.fps);
  }
  SetCurrentTimecode(tc) {
    this.calls.push(['SetCurrentTimecode', tc]);
    this.playheadAbs = simpleTcToFrames(tc, this.fps);
    return true;
  }
  GetMarkers() {
    const out = {};
    for (const [k, v] of Object.entries(this.markers)) out[k] = { ...v };
    return out;
  }
  AddMarker(frameId, color, name, note, duration, customData) {
    this.calls.push(['AddMarker', frameId, color, name, note, duration, customData]);
    if (this.markers[frameId]) return false;
    this.markers[frameId] = { color, name, note, duration, customData: customData || '' };
    return true;
  }
  DeleteMarkerAtFrame(frameId) {
    this.calls.push(['DeleteMarkerAtFrame', frameId]);
    if (['customData', 'color', 'never'].includes(this.deleteMode)) return false;
    const key = this.deleteMode === 'absolute' ? Number(frameId) - this.startFrame : Number(frameId);
    if (!this.markers[key]) return false;
    delete this.markers[key];
    return true;
  }
  UpdateMarkerCustomData(frameId, customData) {
    this.calls.push(['UpdateMarkerCustomData', frameId, customData]);
    if (['color', 'never'].includes(this.deleteMode)) return false;
    if (!this.markers[frameId]) return false;
    this.markers[frameId].customData = customData;
    return true;
  }
  GetMarkerCustomData(frameId) {
    return this.markers[frameId] ? this.markers[frameId].customData : '';
  }
  DeleteMarkerByCustomData(customData) {
    this.calls.push(['DeleteMarkerByCustomData', customData]);
    if (this.deleteMode === 'never') return false;
    const hit = Object.entries(this.markers).find(([, v]) => v.customData === customData);
    if (!hit) return false;
    delete this.markers[hit[0]];
    return true;
  }
  DeleteMarkersByColor(color) {
    this.calls.push(['DeleteMarkersByColor', color]);
    if (this.deleteMode === 'never') return false;
    for (const [k, v] of Object.entries(this.markers)) if (v.color === color) delete this.markers[k];
    return true;
  }
}

class MockProject {
  constructor({
    name = 'Mock Project',
    timelines = ['Main Edit', 'Trailer'],
    presets = ['YouTube 1080p', 'ProRes Master'],
    formats = DEFAULT_FORMATS,
    codecs = DEFAULT_CODECS,
    progressStep = 50,
    failJobsMatching = null,
    rejectSettings = null,
  } = {}) {
    this.name = name;
    this.timelines = timelines.map((spec, i) => new MockTimeline(spec, i + 1));
    this.currentTimeline = this.timelines[0] || null;
    this.presets = presets;
    this.formats = formats;
    this.codecs = codecs;
    this.progressStep = progressStep;
    this.failJobsMatching = failJobsMatching;
    this.rejectSettings = rejectSettings;

    this.currentFormat = 'mov';
    this.currentCodec = 'ProRes422HQ';
    this.currentRenderMode = 1;
    this.currentSettings = {};
    this.loadedPreset = null;
    this.jobs = [];
    this.rendering = false;
    this.calls = [];
    this.nextJobId = 1;
  }

  _record(name, args) {
    this.calls.push({ name, args });
  }

  GetName() {
    return this.name;
  }
  GetTimelineCount() {
    return this.timelines.length;
  }
  GetTimelineByIndex(i) {
    return this.timelines[i - 1] || null;
  }
  GetCurrentTimeline() {
    return this.currentTimeline;
  }
  SetCurrentTimeline(tl) {
    this._record('SetCurrentTimeline', [tl && tl.name]);
    if (!tl || !this.timelines.includes(tl)) return false;
    this.currentTimeline = tl;
    return true;
  }

  GetRenderPresetList() {
    return [...this.presets];
  }
  LoadRenderPreset(name) {
    this._record('LoadRenderPreset', [name]);
    if (!this.presets.includes(name)) return false;
    this.loadedPreset = name;
    return true;
  }
  GetRenderFormats() {
    return { ...this.formats };
  }
  GetRenderCodecs(format) {
    return { ...(this.codecs[format] || {}) };
  }
  GetRenderResolutions(format, codec) {
    this._record('GetRenderResolutions', [format, codec]);
    if (format && !Object.values(this.formats).includes(format)) return [];
    return [
      { Width: 3840, Height: 2160 },
      { Width: 1920, Height: 1080 },
      { Width: 1280, Height: 720 },
      { Width: 1080, Height: 1920 },
      { Width: 1080, Height: 1080 },
    ];
  }
  GetCurrentRenderFormatAndCodec() {
    return { format: this.currentFormat, codec: this.currentCodec };
  }
  SetCurrentRenderFormatAndCodec(format, codec) {
    this._record('SetCurrentRenderFormatAndCodec', [format, codec]);
    if (!Object.values(this.formats).includes(format)) return false;
    if (!Object.values(this.codecs[format] || {}).includes(codec)) return false;
    this.currentFormat = format;
    this.currentCodec = codec;
    return true;
  }
  GetCurrentRenderMode() {
    return this.currentRenderMode;
  }
  SetCurrentRenderMode(mode) {
    this._record('SetCurrentRenderMode', [mode]);
    this.currentRenderMode = mode;
    return true;
  }
  SetRenderSettings(settings) {
    this._record('SetRenderSettings', [settings]);
    if (this.rejectSettings && this.rejectSettings(settings)) return false;
    // Resolve keeps the keys a call leaves out; partial dictionaries are the normal way to use it.
    this.currentSettings = { ...this.currentSettings, ...settings };
    return true;
  }

  AddRenderJob() {
    const id = `job-${this.nextJobId++}`;
    this.jobs.push({
      JobId: id,
      TimelineName: this.currentTimeline ? this.currentTimeline.name : null,
      RenderMode: this.currentRenderMode === 1 ? 'Single clip' : 'Individual clips',
      Format: this.currentFormat,
      Codec: this.currentCodec,
      TargetDir: this.currentSettings.TargetDir,
      OutputFilename: this.currentSettings.CustomName,
      MarkIn: this.currentSettings.MarkIn,
      MarkOut: this.currentSettings.MarkOut,
      settings: { ...this.currentSettings },
      status: 'Ready',
      percent: 0,
    });
    this._record('AddRenderJob', [id]);
    return id;
  }
  GetRenderJobList() {
    return this.jobs.map((j) => ({ ...j }));
  }
  DeleteRenderJob(id) {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.JobId !== id);
    return this.jobs.length !== before;
  }
  DeleteAllRenderJobs() {
    this._record('DeleteAllRenderJobs', []);
    this.jobs = [];
    return true;
  }
  StartRendering(...args) {
    const ids = Array.isArray(args[0]) ? args[0] : args.filter((a) => typeof a === 'string');
    this._record('StartRendering', [ids]);
    if (this.rendering) return false;
    const targets = ids.length ? this.jobs.filter((j) => ids.includes(j.JobId)) : this.jobs;
    if (!targets.length) return false;
    for (const j of targets) j.status = 'Rendering';
    this.rendering = true;
    return true;
  }
  StopRendering() {
    for (const j of this.jobs) if (j.status === 'Rendering') j.status = 'Cancelled';
    this.rendering = false;
    return true;
  }
  IsRenderingInProgress() {
    return this.rendering;
  }
  GetRenderJobStatus(id) {
    const job = this.jobs.find((j) => j.JobId === id);
    if (!job) return {};
    if (job.status === 'Rendering') {
      job.percent = Math.min(100, job.percent + this.progressStep);
      if (this.failJobsMatching && this.failJobsMatching(job)) {
        job.status = 'Failed';
        job.error = 'Mock failure';
      } else if (job.percent >= 100) {
        job.status = 'Complete';
      }
      if (!this.jobs.some((j) => j.status === 'Rendering')) this.rendering = false;
    }
    const out = { JobStatus: job.status, CompletionPercentage: job.percent };
    if (job.error) out.Error = job.error;
    if (job.status === 'Complete') out.TimeTakenToRenderInMs = 1234;
    return out;
  }
}

class MockProjectManager {
  constructor(project) {
    this.project = project;
  }
  GetCurrentProject() {
    return this.project;
  }
}

class MockResolve {
  constructor(projectOptions) {
    this.project = projectOptions === null ? null : new MockProject(projectOptions || {});
    this.pm = new MockProjectManager(this.project);
  }
  GetProductName() {
    return 'DaVinci Resolve Studio (mock)';
  }
  GetVersionString() {
    return '20.0.0 mock';
  }
  GetProjectManager() {
    return this.pm;
  }
}

/**
 * Same as MockResolve but every method returns a Promise, to exercise the
 * code path where the native binding is asynchronous.
 */
function asyncify(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  return new Proxy(obj, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      return (...args) => Promise.resolve(value.apply(target, args)).then(asyncify);
    },
  });
}

function createMockResolve(options) {
  return new MockResolve(options);
}

module.exports = { MockResolve, MockProject, MockTimeline, createMockResolve, asyncify, DEFAULT_FORMATS, DEFAULT_CODECS };
