'use strict';

/**
 * BatchExporter turns "these profiles × these timelines (× these marks) → this
 * folder" into render jobs in Resolve's queue, and can start/monitor the render.
 *
 * Profiles have a target:
 *   timeline  one job for the whole timeline (final exports)
 *   cuts      one job per cut mark, rendered as a MarkIn/MarkOut range (social cuts)
 *   stills    one single-frame job per still mark (frame grabs via the Deliver engine)
 */

const path = require('path');
const { renderName, DEFAULT_TEMPLATE, defaultLabel } = require('./naming');
const { ResolveError } = require('./resolve');
const { tcForFilename, pad } = require('./timecode');

const TERMINAL = new Set(['complete', 'failed', 'cancelled']);
const TARGETS = ['timeline', 'cuts', 'stills'];
const KIND_FOR_TARGET = { timeline: 'final', cuts: 'cut', stills: 'still' };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarize(statuses) {
  const counts = { total: statuses.length, ready: 0, rendering: 0, complete: 0, failed: 0, cancelled: 0, other: 0 };
  let percentSum = 0;
  for (const s of statuses) {
    if (counts[s.status] !== undefined) counts[s.status] += 1;
    else counts.other += 1;
    percentSum += s.status === 'complete' ? 100 : s.percent || 0;
  }
  counts.percent = statuses.length ? Math.round(percentSum / statuses.length) : 0;
  counts.done = statuses.length > 0 && statuses.every((s) => TERMINAL.has(s.status));
  return counts;
}

function profileTarget(profile) {
  return TARGETS.includes(profile.target) ? profile.target : 'timeline';
}

/** Guarantee per-mark filenames differ: append a counter if the template has no per-mark token. */
function ensureUniqueToken(template, target) {
  const t = template || DEFAULT_TEMPLATE;
  if ((target === 'cuts' || target === 'stills') && !/\{(cut|still|n|tc|in)\}/.test(t)) return `${t}_{n}`;
  return t;
}

function targetDirFor(targetDir, profile) {
  return profile.subfolder ? path.join(targetDir, profile.subfolder) : targetDir;
}

/**
 * Pure expansion of one timeline into job items. No Resolve calls.
 * @returns {{items: Array, notes: Array}} notes are soft problems (e.g. a cuts profile with no cuts marked)
 */
function expandItems({ profiles = [], targets = TARGETS, timelineName, projectName, marks = [], template, targetDir = '', now = new Date(), nameOptions = {} }) {
  const items = [];
  const notes = [];
  const base = {
    project: projectName,
    timeline: timelineName,
    now,
  };
  for (const profile of profiles) {
    const target = profileTarget(profile);
    if (!targets.includes(target)) continue;
    const dir = targetDirFor(targetDir, profile);
    const ctx = {
      ...base,
      profile: profile.id,
      profileName: profile.name,
      label: profile.label || defaultLabel(profile.name),
      format: profile.format,
      codec: profile.codec,
      width: profile.resolution ? profile.resolution.width : '',
      height: profile.resolution ? profile.resolution.height : '',
    };
    const common = { timeline: timelineName, profileId: profile.id, profileName: profile.name, label: ctx.label, profile, target, kind: KIND_FOR_TARGET[target], targetDir: dir };

    if (target === 'timeline') {
      const fileName = renderName(template || DEFAULT_TEMPLATE, ctx, nameOptions) + (profile.fileSuffix || '');
      items.push({ ...common, fileName, range: null, mark: null });
      continue;
    }

    const kind = target === 'cuts' ? 'cut' : 'still';
    const list = marks.filter((m) => m.kind === kind);
    if (!list.length) {
      notes.push({ timeline: timelineName, profileId: profile.id, profileName: profile.name, message: `No ${kind}s marked on "${timelineName}"` });
      continue;
    }
    const tpl = ensureUniqueToken(template, target);
    for (const mark of list) {
      const n = pad(mark.index, 2);
      const fileName =
        renderName(tpl, { ...ctx, cut: n, still: n, n, tc: tcForFilename(mark.tcIn), tcout: tcForFilename(mark.tcOut), in: mark.absIn, out: mark.absOut }, nameOptions) +
        (profile.fileSuffix || '');
      items.push({
        ...common,
        fileName,
        range: { markIn: mark.absIn, markOut: mark.absOut },
        mark: { index: mark.index, kind: mark.kind, tcIn: mark.tcIn, tcOut: mark.tcOut, duration: mark.duration, durationFrames: mark.durationFrames },
      });
    }
  }
  return { items, notes };
}

class BatchExporter {
  /**
   * @param {ResolveBridge} bridge
   * @param {object} [opts]
   * @param {(msg: string) => void} [opts.log]
   * @param {(dir: string) => void} [opts.ensureDir]  create output folders (fs.mkdirSync in the plugin)
   * @param {() => Date} [opts.now]
   */
  constructor(bridge, { log = () => {}, ensureDir = null, now = () => new Date(), nameOptions = {} } = {}) {
    this.bridge = bridge;
    this.log = log;
    this.ensureDir = ensureDir;
    this.now = now;
    this.nameOptions = nameOptions;
  }

  async _timelineTargets(requested) {
    const { current, list } = await this.bridge.timelines();
    if (requested && requested.length) {
      const known = new Set(list.map((t) => t.name));
      const missing = requested.filter((n) => !known.has(n));
      if (missing.length) throw new ResolveError(`Unknown timeline(s): ${missing.join(', ')}`);
      return { current, targets: [...requested] };
    }
    if (!current) throw new ResolveError('No timeline is open. Open one in Resolve or pick timelines explicitly.');
    return { current, targets: [current] };
  }

  async _expandTimeline({ profiles, targets, timelineName, projectName, nameTemplate, targetDir, nameOptions }) {
    const wantsMarks = profiles.some((p) => {
      const t = profileTarget(p);
      return targets.includes(t) && t !== 'timeline';
    });
    const marks = wantsMarks ? (await this.bridge.marksForTimeline(timelineName)).marks : [];
    return expandItems({ profiles, targets, timelineName, projectName, marks, template: nameTemplate, targetDir, now: this.now(), nameOptions: { ...this.nameOptions, ...(nameOptions || {}) } });
  }

  /** Dry run: what would be queued, without touching Resolve's render settings. */
  async plan({ profiles = [], targets = TARGETS, targetDir = '', nameTemplate, timelines, nameOptions } = {}) {
    const projectName = await this.bridge.projectName();
    const { targets: timelineNames } = await this._timelineTargets(timelines);
    const items = [];
    const notes = [];
    for (const timelineName of timelineNames) {
      const r = await this._expandTimeline({ profiles, targets, timelineName, projectName, nameTemplate, targetDir, nameOptions });
      items.push(...r.items.map(({ profile, ...rest }) => rest));
      notes.push(...r.notes);
    }
    return { items, notes };
  }

  /** Add render jobs. Returns { jobs, errors, notes, warnings } (warnings: settings Resolve refused and the job renders without). */
  async queue({ profiles = [], targets = TARGETS, targetDir = '', nameTemplate, timelines, clearExisting = false, nameOptions } = {}) {
    if (!profiles.length) throw new ResolveError('Pick at least one deliverable profile.');
    if (!targetDir) throw new ResolveError('Pick an output folder.');

    const projectName = await this.bridge.projectName();
    const { current, targets: timelineNames } = await this._timelineTargets(timelines);

    if (clearExisting) {
      await this.bridge.deleteAllRenderJobs();
      this.log('Cleared the existing render queue');
    }

    const jobs = [];

    const errors = [];

    const notes = [];

    const warnings = [];
    let active = current;
    try {
      for (const timelineName of timelineNames) {
        const expanded = await this._expandTimeline({ profiles, targets, timelineName, projectName, nameTemplate, targetDir, nameOptions });
        notes.push(...expanded.notes);
        for (const note of expanded.notes) this.log(`${note.profileName}: ${note.message}`);
        if (!expanded.items.length) continue;
        if (timelineName !== active) {
          await this.bridge.setCurrentTimeline(timelineName);
          active = timelineName;
        }
        for (const item of expanded.items) {
          const { profile, ...info } = item;
          try {
            if (this.ensureDir) this.ensureDir(item.targetDir);
            const applied = await this.bridge.applyProfile(profile, { targetDir: item.targetDir, customName: item.fileName, range: item.range });
            const jobId = await this.bridge.addRenderJob();
            const formatId = applied.format ? applied.format.id : profile.format;
            const codecId = applied.codec ? applied.codec.id : profile.codec;
            const rejected = applied.rejected || [];
            jobs.push({
              jobId,
              ...info,
              format: formatId,
              codec: codecId,
              settings: applied.settings,
              rejected,
            });
            if (rejected.length) {
              const what = rejected.map((r) => `${r.key} = ${JSON.stringify(r.value)}`).join(', ');
              const message = `Resolve does not offer ${what} for ${formatId}/${codecId}; "${profile.name}" renders without`;
              warnings.push({ timeline: timelineName, profileId: profile.id, profileName: profile.name, fileName: item.fileName, message });
              this.log(message);
            }
            const where = item.mark ? ` [${item.mark.tcIn}${item.kind === 'cut' ? ` → ${item.mark.tcOut}` : ''}]` : '';
            this.log(`Queued "${profile.name}" for "${timelineName}"${where} → ${path.join(item.targetDir, item.fileName)}`);
          } catch (err) {
            errors.push({ timeline: timelineName, profileId: profile.id, profileName: profile.name, kind: item.kind, fileName: item.fileName, message: err.message });
            this.log(`Skipped "${profile.name}" (${item.fileName}): ${err.message}`);
          }
        }
      }
    } finally {
      if (current && active !== current) {
        try {
          await this.bridge.setCurrentTimeline(current);
        } catch (err) {
          this.log(`Could not switch back to timeline "${current}": ${err.message}`);
        }
      }
    }
    return { jobs, errors, notes, warnings };
  }

  async render(jobIds = []) {
    if (!jobIds.length) throw new ResolveError('Nothing to render: queue some jobs first.');
    const ok = await this.bridge.startRendering(jobIds, false);
    if (!ok) throw new ResolveError('Resolve refused to start rendering. Is a render already running?');
    this.log(`Rendering ${jobIds.length} job(s)`);
    return true;
  }

  async stop() {
    await this.bridge.stopRendering();
    this.log('Stop requested');
    return true;
  }

  async status(jobIds = []) {
    const out = [];
    for (const id of jobIds) out.push(await this.bridge.jobStatus(id));
    return out;
  }

  /**
   * Poll until every job is complete/failed/cancelled, or Resolve reports that
   * rendering stopped (e.g. the user hit Stop in the Deliver page).
   */
  async waitForCompletion(jobIds, { intervalMs = 1000, onProgress = () => {}, signal } = {}) {
    let idlePolls = 0;
    for (;;) {
      const statuses = await this.status(jobIds);
      const summary = summarize(statuses);
      onProgress(statuses, summary);
      if (summary.done) return { statuses, summary, stopped: false };
      if (signal && signal.aborted) return { statuses, summary, stopped: true };
      const rendering = await this.bridge.isRendering();
      idlePolls = rendering ? 0 : idlePolls + 1;
      if (idlePolls >= 3) return { statuses, summary, stopped: true };
      await sleep(intervalMs);
    }
  }
}

module.exports = { BatchExporter, TERMINAL, DEFAULT_TEMPLATE, TARGETS, summarize, expandItems, ensureUniqueToken, profileTarget };
