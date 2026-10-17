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
 * Render-related API surface used here (Project object):
 *   GetRenderPresetList / LoadRenderPreset
 *   GetRenderFormats / GetRenderCodecs / SetCurrentRenderFormatAndCodec
 *   SetCurrentRenderMode / SetRenderSettings / AddRenderJob
 *   GetRenderJobList / GetRenderJobStatus / DeleteRenderJob / DeleteAllRenderJobs
 *   StartRendering / StopRendering / IsRenderingInProgress
 * See docs/RESOLVE_API.md.
 */

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
 * Project.SetRenderSettings() expects.
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
  if (settings.ExportAudio === undefined) settings.ExportAudio = true;
  return settings;
}

class ResolveBridge {
  constructor(resolve) {
    if (!resolve) throw new ResolveError('No Resolve scripting object was provided');
    this.resolve = resolve;
  }

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

  async setCurrentTimeline(name) {
    const project = await this.project();
    const count = Number(await project.GetTimelineCount()) || 0;
    for (let i = 1; i <= count; i += 1) {
      const tl = await project.GetTimelineByIndex(i);
      if (!tl) continue;
      if (String(await tl.GetName()) === name) {
        const ok = await project.SetCurrentTimeline(tl);
        if (!ok) throw new ResolveError(`Resolve refused to switch to timeline "${name}"`);
        return tl;
      }
    }
    throw new ResolveError(`Timeline "${name}" was not found in the current project`);
  }

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
    const settings = buildRenderSettings(profile, opts);
    const ok = await project.SetRenderSettings(settings);
    if (!ok) {
      throw new ResolveError(`Resolve rejected the render settings for profile "${profile.id}"`, settings);
    }
    return { settings, format, codec };
  }

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
};
