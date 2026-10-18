'use strict';

/**
 * ExportX: Electron main process for the DaVinci Resolve Workflow Integration plugin.
 *
 * Resolve launches this file inside its bundled Electron runtime when you pick
 * Workspace > Workflow Integrations > ExportX. The native WorkflowIntegration.node
 * module (copied from Resolve's Developer folder at install time) hands us the
 * same scripting object the Python/Lua API exposes; src/resolve.js wraps it and
 * src/batch.js does the batching. The renderer (ui/) talks to this process over
 * IPC only, via preload.js.
 *
 * Capture: while the timeline plays in Resolve, the panel's pad turns a hold
 * into a cut mark and a tap into a still mark. Marks are Resolve timeline
 * markers (see src/marks.js). This process polls the playhead a few times a
 * second and pushes it to the window.
 *
 * Set EXPORTX_MOCK=1 to run the UI against test/helpers/mock-resolve.js outside Resolve.
 */

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');

const { ResolveBridge } = require('./src/resolve');
const { BatchExporter, DEFAULT_TEMPLATE, TARGETS } = require('./src/batch');
const { framesToTc } = require('./src/timecode');
const { sanitize } = require('./src/naming');
const profilesLib = require('./src/profiles');

const PLUGIN_ID = 'com.triptychvisuals.exportx';
const MOCK = Boolean(process.env.EXPORTX_MOCK);
const USER_DIR = profilesLib.userDir();
const SETTINGS_FILE = path.join(USER_DIR, 'settings.json');
const DEFAULT_SETTINGS = {
  targetDir: '',
  nameTemplate: DEFAULT_TEMPLATE,
  underscoreSpaces: true,
  selectedProfiles: null,
  clearExisting: false,
  startRender: true,
  keyCut: 'c',
  keyStill: 's',
};
const PREVIEW_DIR = path.join(USER_DIR, 'previews');
// The preview proxy: small, fast, same engine. Height follows the timeline's aspect ratio.
const PREVIEW_PROFILE = {
  id: 'exportx-preview',
  name: 'ExportX preview proxy',
  label: 'Preview',
  target: 'timeline',
  format: 'mp4',
  codec: 'H264',
  renderMode: 'single',
  resolution: { width: 1280, height: 720 },
  settings: { ExportVideo: true, ExportAudio: true, VideoQuality: 'Medium', AudioCodec: 'aac', AudioBitDepth: 16, AudioSampleRate: 48000, NetworkOptimization: true },
  subfolder: '',
  fileSuffix: '',
};
const PLAYHEAD_INTERVAL_MS = 150;
const MARKS_INTERVAL_MS = 2000;
const INFO_INTERVAL_MS = 2000;

const state = {
  win: null,
  wi: null,
  bridge: null,
  exporter: null,
  initError: null,
  jobs: [],
  monitor: null,
  logBuffer: [],
  press: null,
  preview: { rendering: false, jobId: null, key: null, percent: 0 },
  playhead: { timer: null, inFlight: false, info: null, infoAt: 0, last: null, marksAt: 0, marksKey: null },
};

// ---------------------------------------------------------------- helpers

function send(channel, payload) {
  if (state.win && !state.win.isDestroyed()) state.win.webContents.send(channel, payload);
}

function log(message) {
  const line = `[${new Date().toTimeString().slice(0, 8)}] ${message}`;
  console.log('[ExportX]', message);
  state.logBuffer.push(line);
  if (state.logBuffer.length > 500) state.logBuffer.shift();
  send('exportx:log', line);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch (_err) {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(partial) {
  const merged = { ...readSettings(), ...(partial || {}) };
  ensureDir(USER_DIR);
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
  return merged;
}

function loadProfiles() {
  const { profiles, errors } = profilesLib.loadProfilesWithOrigin();
  for (const e of errors) log(`Profile file skipped: ${e.message}`);
  return { profiles, errors, dirs: profilesLib.defaultProfileDirs(), userDir: profilesLib.userProfilesDir() };
}

function nameOptions() {
  const s = readSettings();
  return { underscoreSpaces: s.underscoreSpaces !== false };
}

function requireBridge() {
  if (!state.bridge) throw new Error(state.initError || 'Not connected to DaVinci Resolve');
  return state.bridge;
}

function requireExporter() {
  if (!state.exporter) throw new Error(state.initError || 'Not connected to DaVinci Resolve');
  return state.exporter;
}

/** Wrap an IPC handler so the renderer always gets { ok, data | error }. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      return { ok: true, data: await fn(payload) };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      log(`Error (${channel.replace('exportx:', '')}): ${message}`);
      return { ok: false, error: message };
    }
  });
}

// ---------------------------------------------------------------- Resolve

async function connectResolve() {
  if (MOCK) {
    const { createMockResolve } = require('./test/helpers/mock-resolve');
    const resolve = createMockResolve({
      name: 'Mock Project',
      timelines: [{ name: 'Main Edit', fps: 24 }, 'Trailer 30s', 'Social Cut'],
      progressStep: 7,
    });
    // let the mock playhead "play" so the capture pad can be tried
    setInterval(() => {
      const tl = resolve.project.GetCurrentTimeline();
      if (tl) tl.playheadAbs = tl.playheadAbs + 4 > tl.endFrame ? tl.startFrame : tl.playheadAbs + 4;
    }, PLAYHEAD_INTERVAL_MS);
    state.bridge = new ResolveBridge(resolve);
    log('Mock mode: not connected to a real Resolve instance');
  } else {
    const modPath = path.join(__dirname, 'WorkflowIntegration.node');
    if (!fs.existsSync(modPath)) {
      state.initError =
        `WorkflowIntegration.node is missing from ${__dirname}. ` +
        'Copy it from Resolve\'s "Developer/Workflow Integrations/Examples/SamplePlugin" folder (see docs/INSTALL.md).';
      log(state.initError);
      return;
    }
    let wi;
    try {
      wi = require(modPath);
    } catch (err) {
      state.initError = `Could not load WorkflowIntegration.node: ${err.message}`;
      log(state.initError);
      return;
    }
    const ok = await wi.Initialize(PLUGIN_ID);
    if (!ok) {
      state.initError =
        'WorkflowIntegration.Initialize() failed. ExportX has to be launched from DaVinci Resolve Studio ' +
        '(Workspace > Workflow Integrations > ExportX).';
      log(state.initError);
      return;
    }
    const resolve = await wi.GetResolve();
    if (!resolve) {
      state.initError = 'Resolve did not hand back a scripting object.';
      log(state.initError);
      return;
    }
    state.wi = wi;
    state.bridge = new ResolveBridge(resolve);
  }
  state.exporter = new BatchExporter(state.bridge, { log, ensureDir });
  try {
    const info = await state.bridge.info();
    log(`Connected to ${info.product} ${info.version}`);
  } catch (err) {
    log(`Connected, but could not read version: ${err.message}`);
  }
  startPlayheadPolling();
}

function cleanup() {
  stopMonitor();
  stopPlayheadPolling();
  if (state.wi) {
    try {
      state.wi.CleanUp();
    } catch (err) {
      console.error('[ExportX] CleanUp failed:', err);
    }
    state.wi = null;
  }
}

// ---------------------------------------------------------------- playhead + marks polling

function startPlayheadPolling() {
  if (state.playhead.timer || !state.bridge) return;
  state.playhead.timer = setInterval(pollPlayhead, PLAYHEAD_INTERVAL_MS);
}

function stopPlayheadPolling() {
  if (state.playhead.timer) clearInterval(state.playhead.timer);
  state.playhead.timer = null;
}

async function currentInfo(force = false) {
  const ph = state.playhead;
  const now = Date.now();
  const tl = await state.bridge.currentTimeline();
  const name = String(await tl.GetName());
  if (force || !ph.info || ph.info.name !== name || now - ph.infoAt > INFO_INTERVAL_MS) {
    ph.info = await state.bridge.timelineInfo(tl);
    ph.infoAt = now;
  }
  return ph.info;
}

function marksKey(marks) {
  return marks.map((m) => `${m.id}:${m.relOut}`).join('|');
}

function broadcastMarks(result) {
  state.playhead.marksKey = marksKey(result.marks);
  state.playhead.marksAt = Date.now();
  send('exportx:marks', { info: result.info, marks: result.marks });
}

async function pollPlayhead() {
  const ph = state.playhead;
  if (ph.inFlight || !state.bridge || !state.win || state.win.isDestroyed()) return;
  ph.inFlight = true;
  try {
    const info = await currentInfo();
    const pos = await state.bridge.playhead(info);
    const playing = ph.last ? pos.absFrame !== ph.last.absFrame && ph.last.timeline === pos.timeline : false;
    ph.last = pos;
    send('exportx:playhead', { ok: true, ...pos, playing, info });
    if (Date.now() - ph.marksAt > MARKS_INTERVAL_MS) {
      const result = await state.bridge.marks();
      ph.marksAt = Date.now();
      const key = marksKey(result.marks);
      if (key !== ph.marksKey) broadcastMarks(result);
    }
  } catch (err) {
    ph.last = null;
    send('exportx:playhead', { ok: false, error: err.message });
  } finally {
    ph.inFlight = false;
  }
}

// ---------------------------------------------------------------- render monitor

function stopMonitor() {
  if (state.monitor) {
    state.monitor.abort();
    state.monitor = null;
  }
}

async function startRender(jobIds) {
  const exporter = requireExporter();
  stopMonitor();
  await exporter.render(jobIds);
  const controller = new AbortController();
  state.monitor = controller;
  exporter
    .waitForCompletion(jobIds, {
      intervalMs: 1000,
      signal: controller.signal,
      onProgress: (statuses, summary) => send('exportx:progress', { statuses, summary }),
    })
    .then((result) => {
      if (state.monitor === controller) state.monitor = null;
      const { summary } = result;
      log(
        `Render finished: ${summary.complete} complete, ${summary.failed} failed, ${summary.cancelled} cancelled` +
          (result.stopped && !summary.done ? ' (stopped early)' : ''),
      );
      send('exportx:done', result);
    })
    .catch((err) => {
      if (state.monitor === controller) state.monitor = null;
      log(`Render monitor error: ${err.message}`);
      send('exportx:done', { statuses: [], summary: null, error: err.message });
    });
  return true;
}

// ---------------------------------------------------------------- IPC: status, profiles, folders

handle('exportx:status', async () => {
  const base = { connected: Boolean(state.bridge), mock: MOCK, error: state.initError, userDir: USER_DIR };
  if (!state.bridge) return base;
  try {
    const info = await state.bridge.info();
    const project = await state.bridge.projectName();
    const timelines = await state.bridge.timelines();
    const rendering = await state.bridge.isRendering();
    return { ...base, ...info, project, timeline: timelines.current, timelines: timelines.list, rendering };
  } catch (err) {
    return { ...base, error: err.message };
  }
});

handle('exportx:profiles', async () => loadProfiles());

handle('exportx:capabilities', async (opts) => {
  const caps = await requireBridge().capabilities();
  if (!(opts && opts.quiet)) {
    log(`Render presets: ${caps.presets.join(', ') || 'none'}`);
    for (const f of caps.formats) {
      log(`Format ${f.id} (${f.description}): ${f.codecs.map((c) => `${c.id} [${c.description}]`).join(', ')}`);
    }
  }
  return caps;
});

// ---------------------------------------------------------------- IPC: deliverable settings

handle('exportx:save-profile', async (raw) => {
  if (!raw || typeof raw !== 'object') throw new Error('Nothing to save');
  const profile = { ...raw };
  if (!profile.id) profile.id = profilesLib.slugify(profile.name || profile.label);
  const saved = profilesLib.saveUserProfile(profile);
  log(`Saved deliverable "${saved.name}" to ${profilesLib.userProfilePath(saved.id)}`);
  return loadProfiles();
});

handle('exportx:delete-profile', async (id) => {
  const removed = profilesLib.deleteUserProfile(String(id));
  log(removed ? `Removed your copy of "${id}"` : `No user file for "${id}"`);
  return loadProfiles();
});

handle('exportx:pick-folder', async (current) => {
  const result = await dialog.showOpenDialog(state.win, {
    title: 'Choose the deliverables folder',
    defaultPath: current || undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

handle('exportx:open-folder', async (dir) => {
  if (!dir) throw new Error('No folder to open');
  ensureDir(dir);
  const problem = await shell.openPath(dir);
  if (problem) throw new Error(problem);
  return true;
});

handle('exportx:open-profiles-folder', async () => {
  const dir = profilesLib.userProfilesDir();
  ensureDir(dir);
  const readme = path.join(dir, 'README.txt');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      'Drop ExportX profile JSON files in this folder. They override bundled profiles with the same id.\n' +
        'See docs/PROFILES.md in the ExportX repository for the schema.\n',
    );
  }
  const problem = await shell.openPath(dir);
  if (problem) throw new Error(problem);
  return dir;
});

handle('exportx:open-profile-file', async (profileId) => {
  const { profiles } = loadProfiles();
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile || !profile.source) throw new Error(`Profile "${profileId}" has no source file`);
  const problem = await shell.openPath(profile.source);
  if (problem) shell.showItemInFolder(profile.source);
  return profile.source;
});

// ---------------------------------------------------------------- IPC: capture (marks)

handle('exportx:marks', async () => {
  const result = await requireBridge().marks();
  broadcastMarks(result);
  return result;
});

function clampFrame(n, info) {
  return Math.min(info.endFrame, Math.max(info.startFrame, Math.round(n)));
}

/** Where a press happens: an explicit frame from the preview video, or Resolve's playhead. */
async function pressFrame(at, info) {
  if (at && Number.isFinite(Number(at.absFrame))) {
    const absFrame = clampFrame(Number(at.absFrame), info);
    return { absFrame, tc: framesToTc(absFrame, info.fps, info.dropFrame), source: 'preview' };
  }
  const pos = await requireBridge().playhead(info);
  return { absFrame: pos.absFrame, tc: pos.tc, source: 'resolve' };
}

handle('exportx:mark-begin', async (at) => {
  const info = await currentInfo();
  const pos = await pressFrame(at, info);
  state.press = { absIn: pos.absFrame, tc: pos.tc, fps: info.fps, startedAt: Date.now(), timeline: info.name, source: pos.source };
  return state.press;
});

handle('exportx:mark-cancel', async () => {
  state.press = null;
  return true;
});

handle('exportx:mark-end', async (at) => {
  const bridge = requireBridge();
  const press = state.press;
  state.press = null;
  if (!press) throw new Error('No press in progress');
  const info = await currentInfo();
  if (info.name !== press.timeline) throw new Error('The timeline changed during the press; mark discarded');
  const pos = await pressFrame(at, info);
  const kind = at && at.kind === 'still' ? 'still' : 'cut';
  const absIn = Math.min(press.absIn, pos.absFrame);
  const absOut = kind === 'still' ? absIn : Math.max(press.absIn, pos.absFrame);
  const result = await bridge.addMark({ kind, absIn, absOut });
  broadcastMarks(result);
  const a = result.added;
  log(a ? `Marked ${a.kind} ${a.index}: ${a.tcIn}${a.kind === 'cut' ? ` → ${a.tcOut} (${a.duration})` : ''}` : `Marked ${kind}`);
  return result;
});

handle('exportx:mark-still', async (at) => {
  const bridge = requireBridge();
  const info = await currentInfo();
  const pos = await pressFrame(at, info);
  const result = await bridge.addMark({ kind: 'still', absIn: pos.absFrame, absOut: pos.absFrame });
  broadcastMarks(result);
  if (result.added) log(`Marked still ${result.added.index}: ${result.added.tcIn}`);
  return result;
});

handle('exportx:mark-delete', async (relIn) => {
  const result = await requireBridge().deleteMark(Number(relIn));
  broadcastMarks(result);
  return result;
});

handle('exportx:marks-clear', async (kind) => {
  const result = await requireBridge().clearMarks(kind || null);
  broadcastMarks(result);
  log(kind ? `Cleared all ${kind} marks` : 'Cleared all marks');
  return result;
});

handle('exportx:seek', async (absFrame) => {
  const info = await currentInfo();
  return requireBridge().seek(Number(absFrame), info);
});

// ---------------------------------------------------------------- IPC: preview video

function previewKey(project, timeline) {
  return sanitize(`${project}__${timeline}`).replace(/\s+/g, '_');
}

function previewMetaPath(key) {
  return path.join(PREVIEW_DIR, `${key}.json`);
}

function readPreviewMeta(key) {
  try {
    const meta = JSON.parse(fs.readFileSync(previewMetaPath(key), 'utf8'));
    return meta && meta.file && fs.existsSync(meta.file) ? meta : null;
  } catch (_err) {
    return null;
  }
}

function findPreviewOutput(key) {
  if (!fs.existsSync(PREVIEW_DIR)) return null;
  const candidates = fs
    .readdirSync(PREVIEW_DIR)
    .filter((f) => f.startsWith(key) && /\.(mp4|mov|m4v)$/i.test(f))
    .map((f) => path.join(PREVIEW_DIR, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] || null;
}

async function previewStatus() {
  const bridge = requireBridge();
  const project = await bridge.projectName();
  const info = await currentInfo();
  const key = previewKey(project, info.name);
  const meta = readPreviewMeta(key);
  const stale = Boolean(meta && (meta.startFrame !== info.startFrame || meta.endFrame !== info.endFrame || Math.abs(meta.fps - info.fps) > 0.001));
  return {
    key,
    project,
    timeline: info.name,
    fps: info.fps,
    startFrame: info.startFrame,
    endFrame: info.endFrame,
    dropFrame: info.dropFrame,
    ready: Boolean(meta),
    stale,
    file: meta ? pathToFileURL(meta.file).href : null,
    renderedAt: meta ? meta.renderedAt : null,
    width: meta ? meta.width : null,
    height: meta ? meta.height : null,
    rendering: state.preview.rendering && state.preview.key === key ? state.preview.percent : null,
  };
}

handle('exportx:preview-status', async () => previewStatus());

handle('exportx:preview-render', async () => {
  const bridge = requireBridge();
  const exporter = requireExporter();
  if (state.preview.rendering) throw new Error('A preview is already rendering');
  if (await bridge.isRendering()) throw new Error('Resolve is already rendering. Wait for it to finish, then render the preview.');
  const project = await bridge.projectName();
  const info = await currentInfo(true);
  const key = previewKey(project, info.name);
  ensureDir(PREVIEW_DIR);
  const old = readPreviewMeta(key);
  if (old) {
    try {
      fs.unlinkSync(old.file);
    } catch (_err) {
      /* ignore */
    }
  }
  const tl = await bridge.currentTimeline();
  const tlW = Number(await tl.GetSetting('timelineResolutionWidth')) || 1920;
  const tlH = Number(await tl.GetSetting('timelineResolutionHeight')) || 1080;
  const width = 1280;
  const height = Math.max(2, Math.round((width * tlH) / tlW / 2) * 2);
  const profile = { ...PREVIEW_PROFILE, resolution: { width, height } };
  await bridge.applyProfile(profile, { targetDir: PREVIEW_DIR, customName: key });
  const jobId = await bridge.addRenderJob();
  const ok = await bridge.startRendering([jobId]);
  if (!ok) throw new Error('Resolve refused to start the preview render');
  state.preview = { rendering: true, jobId, key, percent: 0 };
  log(`Rendering preview of "${info.name}" (${width}×${height} H.264) → ${PREVIEW_DIR}`);
  send('exportx:preview', { key, rendering: true, percent: 0 });
  exporter
    .waitForCompletion([jobId], {
      intervalMs: 1000,
      onProgress: (statuses) => {
        state.preview.percent = statuses[0] ? statuses[0].percent : 0;
        send('exportx:preview', { key, rendering: true, percent: state.preview.percent });
      },
    })
    .then(async ({ statuses }) => {
      state.preview.rendering = false;
      const st = statuses[0] || { status: 'unknown' };
      if (st.status !== 'complete') {
        log(`Preview render ${st.status}${st.error ? `: ${st.error}` : ''}`);
        send('exportx:preview', { key, rendering: false, error: st.error || `Preview render ${st.status}` });
        return;
      }
      const file = findPreviewOutput(key);
      if (!file) {
        send('exportx:preview', { key, rendering: false, error: `Preview rendered but no file was found in ${PREVIEW_DIR}` });
        return;
      }
      const meta = { file, project, timeline: info.name, startFrame: info.startFrame, endFrame: info.endFrame, fps: info.fps, dropFrame: info.dropFrame, width, height, renderedAt: new Date().toISOString() };
      fs.writeFileSync(previewMetaPath(key), JSON.stringify(meta, null, 2));
      try {
        await bridge.deleteRenderJob(jobId);
      } catch (_err) {
        /* leave it in the queue */
      }
      log(`Preview ready: ${file}`);
      send('exportx:preview', { key, rendering: false, ready: true, stale: false, file: pathToFileURL(file).href, ...meta });
    })
    .catch((err) => {
      state.preview.rendering = false;
      send('exportx:preview', { key, rendering: false, error: err.message });
    });
  return { jobId, key };
});

// ---------------------------------------------------------------- IPC: plan, queue, render

function selectProfiles(ids) {
  const { profiles } = loadProfiles();
  const wanted = new Set(ids || []);
  const picked = profiles.filter((p) => wanted.has(p.id));
  const missing = [...wanted].filter((id) => !profiles.some((p) => p.id === id));
  if (missing.length) throw new Error(`Unknown profile(s): ${missing.join(', ')}`);
  return picked;
}

function toRequest(req) {
  const r = req || {};
  const targets = Array.isArray(r.targets) ? r.targets.filter((t) => TARGETS.includes(t)) : [];
  return {
    profiles: selectProfiles(r.profileIds),
    targets: targets.length ? targets : TARGETS,
    targetDir: r.targetDir || '',
    nameTemplate: r.nameTemplate || DEFAULT_TEMPLATE,
    nameOptions: nameOptions(),
    timelines: Array.isArray(r.timelines) && r.timelines.length ? r.timelines : null,
    clearExisting: Boolean(r.clearExisting),
  };
}

handle('exportx:plan', async (req) => requireExporter().plan(toRequest(req)));

handle('exportx:queue', async (req) => {
  const exporter = requireExporter();
  const request = toRequest(req);
  const { jobs, errors, notes } = await exporter.queue(request);
  state.jobs = jobs;
  writeSettings({
    targetDir: request.targetDir,
    nameTemplate: request.nameTemplate,
    selectedProfiles: request.profiles.map((p) => p.id),
    clearExisting: request.clearExisting,
    startRender: Boolean(req && req.startRender),
  });
  let rendering = false;
  if (req && req.startRender && jobs.length) {
    await startRender(jobs.map((j) => j.jobId));
    rendering = true;
  }
  return { jobs, errors, notes, rendering };
});

handle('exportx:render', async (jobIds) => {
  const ids = Array.isArray(jobIds) && jobIds.length ? jobIds : state.jobs.map((j) => j.jobId);
  return startRender(ids);
});

handle('exportx:stop', async () => {
  stopMonitor();
  return requireExporter().stop();
});

handle('exportx:job-status', async (jobIds) => {
  const ids = Array.isArray(jobIds) && jobIds.length ? jobIds : state.jobs.map((j) => j.jobId);
  return requireExporter().status(ids);
});

handle('exportx:get-settings', async () => readSettings());
handle('exportx:save-settings', async (settings) => writeSettings(settings));
handle('exportx:log-history', async () => [...state.logBuffer]);

// ---------------------------------------------------------------- window

function createWindow() {
  state.win = new BrowserWindow({
    width: 1240,
    height: 780,
    minWidth: 720,
    minHeight: 560,
    title: 'ExportX',
    backgroundColor: '#0f0f0f',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  state.win.setMenuBarVisibility(false);
  state.win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  state.win.on('closed', () => {
    state.win = null;
  });
}

app.whenReady().then(async () => {
  await connectResolve();
  createWindow();
});

app.on('window-all-closed', () => {
  cleanup();
  app.quit();
});

app.on('before-quit', cleanup);
