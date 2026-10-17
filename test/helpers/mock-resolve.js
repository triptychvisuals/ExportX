'use strict';

/**
 * A small stand-in for the Resolve scripting object. It mirrors the shape of
 * the real API closely enough for unit tests and for running the plugin UI
 * outside Resolve (EXPORTX_MOCK=1 npx electron .).
 *
 * Render jobs "progress" a fixed amount on each GetRenderJobStatus call so a
 * polling loop terminates quickly.
 */

const DEFAULT_FORMATS = { QuickTime: 'mov', MP4: 'mp4', 'MXF OP1A': 'mxf_op1a' };
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
};

class MockTimeline {
  constructor(name, index) {
    this.name = name;
    this.index = index;
  }
  GetName() {
    return this.name;
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
    this.timelines = timelines.map((n, i) => new MockTimeline(n, i + 1));
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
    this.currentSettings = { ...settings };
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
