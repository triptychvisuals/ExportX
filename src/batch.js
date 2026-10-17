'use strict';

/**
 * BatchExporter turns "these profiles × these timelines → this folder" into
 * render jobs in Resolve's queue, and can start/monitor the render.
 */

const path = require('path');
const { renderName } = require('./naming');
const { ResolveError } = require('./resolve');

const TERMINAL = new Set(['complete', 'failed', 'cancelled']);
const DEFAULT_TEMPLATE = '{timeline}_{profile}';

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

class BatchExporter {
  /**
   * @param {ResolveBridge} bridge
   * @param {object} [opts]
   * @param {(msg: string) => void} [opts.log]
   * @param {(dir: string) => void} [opts.ensureDir]  create output folders (fs.mkdirSync in the plugin)
   * @param {() => Date} [opts.now]
   */
  constructor(bridge, { log = () => {}, ensureDir = null, now = () => new Date() } = {}) {
    this.bridge = bridge;
    this.log = log;
    this.ensureDir = ensureDir;
    this.now = now;
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

  _nameFor({ template, projectName, timelineName, profile }) {
    const base = renderName(template || DEFAULT_TEMPLATE, {
      project: projectName,
      timeline: timelineName,
      profile: profile.id,
      profileName: profile.name,
      format: profile.format,
      codec: profile.codec,
      width: profile.resolution ? profile.resolution.width : '',
      height: profile.resolution ? profile.resolution.height : '',
      now: this.now(),
    });
    return profile.fileSuffix ? `${base}${profile.fileSuffix}` : base;
  }

  _targetDirFor(targetDir, profile) {
    return profile.subfolder ? path.join(targetDir, profile.subfolder) : targetDir;
  }

  /** Dry run: what would be queued, without touching Resolve's render settings. */
  async plan({ profiles = [], targetDir = '', nameTemplate, timelines } = {}) {
    const projectName = await this.bridge.projectName();
    const { targets } = await this._timelineTargets(timelines);
    const items = [];
    for (const timelineName of targets) {
      for (const profile of profiles) {
        items.push({
          timeline: timelineName,
          profileId: profile.id,
          profileName: profile.name,
          targetDir: this._targetDirFor(targetDir, profile),
          fileName: this._nameFor({ template: nameTemplate, projectName, timelineName, profile }),
        });
      }
    }
    return items;
  }

  /** Add one render job per (timeline × profile). Returns { jobs, errors }. */
  async queue({ profiles = [], targetDir = '', nameTemplate, timelines, clearExisting = false } = {}) {
    if (!profiles.length) throw new ResolveError('Pick at least one deliverable profile.');
    if (!targetDir) throw new ResolveError('Pick an output folder.');

    const projectName = await this.bridge.projectName();
    const { current, targets } = await this._timelineTargets(timelines);

    if (clearExisting) {
      await this.bridge.deleteAllRenderJobs();
      this.log('Cleared the existing render queue');
    }

    const jobs = [];
    const errors = [];
    let active = current;
    try {
      for (const timelineName of targets) {
        if (timelineName !== active) {
          await this.bridge.setCurrentTimeline(timelineName);
          active = timelineName;
        }
        for (const profile of profiles) {
          const dir = this._targetDirFor(targetDir, profile);
          const fileName = this._nameFor({ template: nameTemplate, projectName, timelineName, profile });
          try {
            if (this.ensureDir) this.ensureDir(dir);
            const applied = await this.bridge.applyProfile(profile, { targetDir: dir, customName: fileName });
            const jobId = await this.bridge.addRenderJob();
            jobs.push({
              jobId,
              timeline: timelineName,
              profileId: profile.id,
              profileName: profile.name,
              targetDir: dir,
              fileName,
              format: applied.format ? applied.format.id : profile.format,
              codec: applied.codec ? applied.codec.id : profile.codec,
              settings: applied.settings,
            });
            this.log(`Queued "${profile.name}" for timeline "${timelineName}" → ${path.join(dir, fileName)}`);
          } catch (err) {
            errors.push({ timeline: timelineName, profileId: profile.id, profileName: profile.name, message: err.message });
            this.log(`Skipped "${profile.name}" for timeline "${timelineName}": ${err.message}`);
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
    return { jobs, errors };
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

module.exports = { BatchExporter, TERMINAL, DEFAULT_TEMPLATE, summarize };
