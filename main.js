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
 * Capture: while the preview plays, holding the cut key marks a cut and the
 * still key marks a still. Marks are Resolve timeline markers (see src/marks.js).
 * This process polls the playhead a few times a second and pushes it to the window.
 *
 * Rendering and uploading run in the background: the window stays usable, the
 * taskbar/dock icon shows progress, and a system notification pops when a batch
 * (or its upload to the Triptych Studios portal, see src/portal.js) finishes.
 *
 * Set EXPORTX_MOCK=1 to run the UI against test/helpers/mock-resolve.js outside Resolve.
 */

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, safeStorage } = require('electron');

const { ResolveBridge } = require('./src/resolve');
const { BatchExporter, DEFAULT_TEMPLATE, TARGETS } = require('./src/batch');
const { framesToTc } = require('./src/timecode');
const { sanitize } = require('./src/naming');
const profilesLib = require('./src/profiles');
const { PortalClient, buildManifest, normalizeBaseUrl, PROTOCOL_VERSION } = require('./src/portal');
const PKG = require('./package.json');

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
  // Export only between the timeline's In and Out points when they are set (I and O in Resolve).
  useInOut: true,
  // Triptych Studios portal (optional). The key is stored encrypted when the OS keychain is available.
  portalUrl: '',
  portalToken: '',
  portalAuto: false,
  portalName: '',
  portalKeyLabel: '',
  portalProjects: [], // the last list fetched, so the picker fills before the portal answers
  portalProjectByResolve: {}, // Resolve project name -> portal project id, the last choice made for it
};
const TOKEN_PREFIX = 'enc:';
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
  // Only what every H.264/MP4 takes. Quality and audio stay on Resolve's automatic
  // settings: a quality level or an AAC bit depth is refused by some versions, and
  // one refused key used to fail the whole preview.
  settings: { ExportVideo: true, ExportAudio: true },
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
  batch: null, // the last queued batch: { queuedAt, project, timeline, fps, frames, namePattern, upload, portalProjectId, statuses }
  upload: { running: false },
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
  const patch = { ...(partial || {}) };
  if (Object.prototype.hasOwnProperty.call(patch, 'portalToken')) patch.portalToken = sealToken(patch.portalToken);
  const merged = { ...readSettings(), ...patch };
  ensureDir(USER_DIR);
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
  return merged;
}

// The portal token never goes to the renderer; it only sees whether one is saved.
function canEncrypt() {
  try {
    return Boolean(safeStorage && safeStorage.isEncryptionAvailable());
  } catch (_err) {
    return false;
  }
}

function sealToken(plain) {
  const t = String(plain || '').trim();
  if (!t || t.startsWith(TOKEN_PREFIX)) return t;
  return canEncrypt() ? TOKEN_PREFIX + safeStorage.encryptString(t).toString('base64') : t;
}

function openToken(stored) {
  const s = String(stored || '');
  if (!s.startsWith(TOKEN_PREFIX)) return s;
  try {
    return safeStorage.decryptString(Buffer.from(s.slice(TOKEN_PREFIX.length), 'base64'));
  } catch (_err) {
    return '';
  }
}

function publicSettings(settings) {
  const { portalToken, ...rest } = settings;
  return { ...rest, portalTokenSet: Boolean(portalToken), portalTokenEncrypted: String(portalToken || '').startsWith(TOKEN_PREFIX) };
}

function portalConfig() {
  const s = readSettings();
  return { url: String(s.portalUrl || '').trim(), token: openToken(s.portalToken), auto: Boolean(s.portalAuto), name: s.portalName || '' };
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

// ---------------------------------------------------------------- background feedback

/** Progress on the dock/taskbar icon; -1 clears it. */
function taskbarProgress(fraction, mode) {
  if (!state.win || state.win.isDestroyed()) return;
  try {
    state.win.setProgressBar(fraction, mode ? { mode } : undefined);
  } catch (_err) {
    /* not supported on this platform */
  }
}

function flashError() {
  taskbarProgress(1, 'error');
  setTimeout(() => taskbarProgress(-1), 5000);
}

/** A system notification when the window is not in front; clicking it brings the panel back. */
function notify(title, body) {
  if (state.win && !state.win.isDestroyed() && state.win.isFocused() && state.win.isVisible()) return;
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body: String(body || '').slice(0, 200) });
    n.on('click', () => {
      if (!state.win || state.win.isDestroyed()) return;
      if (state.win.isMinimized()) state.win.restore();
      state.win.show();
      state.win.focus();
    });
    n.show();
  } catch (err) {
    log(`Notification failed: ${err.message}`);
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
      onProgress: (statuses, summary) => {
        taskbarProgress(summary.percent / 100);
        send('exportx:progress', { statuses, summary });
      },
    })
    .then((result) => {
      if (state.monitor === controller) state.monitor = null;
      const { summary } = result;
      const stopped = result.stopped && !summary.done;
      log(`Render finished: ${summary.complete} complete, ${summary.failed} failed, ${summary.cancelled} cancelled${stopped ? ' (stopped early)' : ''}`);
      if (state.batch) state.batch.statuses = result.statuses;
      if (summary.failed) flashError();
      else taskbarProgress(-1);
      send('exportx:done', result);
      const batch = state.batch;
      const willUpload = Boolean(batch && batch.upload && batch.portalProjectId && !stopped && summary.complete > 0);
      notify(
        summary.failed ? 'ExportX: render finished with errors' : 'ExportX: render finished',
        `${summary.complete} of ${summary.total} files done${batch && batch.project ? ` · ${batch.project}` : ''}${willUpload ? ' · uploading to the portal' : ''}`,
      );
      if (willUpload) {
        uploadBatch({ trigger: 'auto' }).catch((err) => {
          log(`Upload not started: ${err.message}`);
          send('exportx:upload', { phase: 'error', error: err.message });
          notify('ExportX: upload not started', err.message);
        });
      }
    })
    .catch((err) => {
      if (state.monitor === controller) state.monitor = null;
      log(`Render monitor error: ${err.message}`);
      flashError();
      send('exportx:done', { statuses: [], summary: null, error: err.message });
    });
  return true;
}

// ---------------------------------------------------------------- portal upload

function portalClient(cfg, timeoutMs) {
  return new PortalClient({ portalUrl: cfg.url, token: cfg.token, timeoutMs, userAgent: `ExportX/${PKG.version}` });
}

/**
 * Push the finished files of the last batch into a project on the portal.
 * Resolves as soon as the upload has started (progress goes out as
 * exportx:upload events).
 */
async function uploadBatch({ projectId, trigger = 'manual' } = {}) {
  const cfg = portalConfig();
  if (!cfg.url) throw new Error('No portal URL is set. Add it under Settings › Portal.');
  if (!cfg.token) throw new Error('No portal key is saved. Make one under Settings › ExportX on the portal and paste it under Settings › Portal here.');
  if (state.upload.running) throw new Error('An upload is already running');
  const batch = state.batch;
  if (!batch || !state.jobs.length) throw new Error('Nothing to upload yet: export a batch first.');
  const portalProjectId = String(projectId || batch.portalProjectId || '').trim();
  if (!portalProjectId) throw new Error('Pick the portal project the files go in first.');
  const projects = readSettings().portalProjects || [];
  const portalProject = projects.find((p) => p.id === portalProjectId) || { id: portalProjectId, name: portalProjectId };
  const statuses = batch.statuses && batch.statuses.length ? batch.statuses : await requireExporter().status(state.jobs.map((j) => j.jobId));
  const complete = new Set(statuses.filter((s) => s.status === 'complete').map((s) => s.jobId));
  const jobs = state.jobs.filter((j) => complete.has(j.jobId));
  if (!jobs.length) throw new Error('No finished files to upload yet.');
  const bundle = buildManifest(
    { project: batch.project, timeline: batch.timeline, fps: batch.fps, frames: batch.frames, jobs, namePattern: batch.namePattern, exportxVersion: PKG.version },
    { since: batch.queuedAt },
  );
  for (const m of bundle.missing) log(`Upload: no file named ${m.fileName}.* in ${m.targetDir}`);
  if (!bundle.files.length) throw new Error(`Resolve reported the renders complete, but no files were found in ${jobs[0].targetDir}.`);

  const files = bundle.files.map((f) => ({ key: f.key, jobId: f.jobId, fileName: f.fileName, bytes: f.bytes }));
  const totalBytes = files.reduce((n, f) => n + f.bytes, 0);
  const sent = new Map();
  state.upload.running = true;
  taskbarProgress(0);
  log(`Uploading ${files.length} file(s) (${(totalBytes / 1048576).toFixed(1)} MB) to ${normalizeBaseUrl(cfg.url)} › ${portalProject.name}`);
  send('exportx:upload', { phase: 'start', trigger, portal: cfg.url, project: portalProject, files, totalBytes, missing: bundle.missing });
  if (batch.project) writeSettings({ portalProjectByResolve: { ...(readSettings().portalProjectByResolve || {}), [batch.project]: portalProjectId } });

  portalClient(cfg, 60000)
    .uploadBatch(bundle, {
      projectId: portalProjectId,
      onFile: (ev) => {
        const f = bundle.files.find((x) => x.key === ev.key);
        const bytes = f ? f.bytes : 0;
        sent.set(ev.key, ev.state === 'uploaded' ? bytes : ev.state === 'uploading' ? Math.round((ev.percent / 100) * bytes) : 0);
        const done = [...sent.values()].reduce((a, b) => a + b, 0);
        const percentTotal = totalBytes ? Math.round((done / totalBytes) * 100) : 0;
        taskbarProgress(percentTotal / 100);
        if (ev.state === 'failed') log(`Upload failed for ${f ? f.fileName : ev.key}: ${ev.error}`);
        if (ev.state === 'uploaded') log(`On the portal: ${ev.label || (f ? f.fileName : ev.key)}${ev.box ? ` (box: ${ev.box})` : ' (not in a box yet)'}`);
        send('exportx:upload', { phase: 'file', key: ev.key, jobId: f ? f.jobId : null, state: ev.state, percent: ev.percent, error: ev.error || null, label: ev.label || null, box: ev.box || null, percentTotal });
      },
    })
    .then((result) => {
      state.upload.running = false;
      const summary = `${result.uploaded.length} of ${files.length} uploaded`;
      if (result.failed.length) flashError();
      else taskbarProgress(-1);
      log(`Upload ${result.failed.length ? 'finished with errors' : 'complete'}: ${summary} → ${portalProject.name}${result.url ? ` (${result.url})` : ''}`);
      send('exportx:upload', { phase: 'done', batchId: result.batchId, project: portalProject, url: result.url, uploaded: result.uploaded, failed: result.failed, missing: bundle.missing });
      notify(result.failed.length ? 'ExportX: upload finished with errors' : `ExportX: delivered to ${portalProject.name}`, `${summary}. Check the boxes on the Delivery tab, then send the final delivery.`);
    })
    .catch((err) => {
      state.upload.running = false;
      flashError();
      log(`Upload failed: ${err.message}`);
      send('exportx:upload', { phase: 'error', error: err.message });
      notify('ExportX: upload failed', err.message);
    });
  return { files, totalBytes, missing: bundle.missing };
}

/** The portal's projects, fetched fresh and remembered for the picker. */
async function fetchPortalProjects(cfg) {
  const projects = await portalClient(cfg, 15000).projects();
  writeSettings({ portalProjects: projects });
  return projects;
}

handle('exportx:portal-test', async (opts) => {
  const saved = portalConfig();
  const url = String((opts && opts.portalUrl) || saved.url || '').trim();
  const token = (opts && opts.token) || saved.token;
  if (!url) throw new Error('Enter the portal URL first.');
  if (!token) throw new Error('Paste the key from the portal (Settings › ExportX › Make a key) first.');
  const client = portalClient({ url, token }, 10000);
  const res = await client.ping();
  if (res.version && String(res.version) !== PROTOCOL_VERSION) log(`Portal speaks plugin API v${res.version}; this ExportX expects v${PROTOCOL_VERSION}`);
  const projects = await client.projects();
  writeSettings({ portalName: res.portal || '', portalKeyLabel: res.key && res.key.label ? res.key.label : '', portalProjects: projects });
  log(`Portal OK: ${res.portal || url} (API v${res.version || '?'}, ${res.storage || 'unknown'} storage), key "${res.key && res.key.label ? res.key.label : '?'}", ${projects.length} projects`);
  return { ok: true, portal: res.portal || null, version: res.version || null, storage: res.storage || null, key: res.key || null, projects, url: normalizeBaseUrl(url) };
});

handle('exportx:portal-projects', async () => {
  const cfg = portalConfig();
  if (!cfg.url || !cfg.token) throw new Error('Set the portal URL and key under Settings › Portal first.');
  return fetchPortalProjects(cfg);
});

handle('exportx:portal-upload', async (opts) => uploadBatch({ projectId: opts && opts.projectId, trigger: 'manual' }));

handle('exportx:open-url', async (url) => {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) throw new Error('Only http(s) links can be opened');
  await shell.openExternal(u);
  return true;
});

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

/** Make another timeline of the project the one the panel marks, previews and exports. */
handle('exportx:set-timeline', async (name) => {
  const bridge = requireBridge();
  const wanted = String(name || '').trim();
  if (!wanted) throw new Error('Pick a timeline');
  await bridge.setCurrentTimeline(wanted);
  state.playhead.info = null;
  state.playhead.last = null;
  state.playhead.marksKey = null;
  state.press = null;
  const info = await currentInfo(true);
  log(`Switched to timeline "${info.name}"`);
  const result = await bridge.marks();
  broadcastMarks(result);
  return info;
});

/** The sizes Resolve offers for a format and codec, for the Settings form. */
handle('exportx:resolutions', async (q) => {
  const bridge = requireBridge();
  const format = q && q.format ? await bridge.resolveFormat(q.format) : null;
  const codec = format && q.codec && !/^(auto|\*|first|default)$/i.test(q.codec) ? await bridge.resolveCodec(format.id, q.codec) : null;
  return bridge.renderResolutions(format ? format.id : undefined, codec ? codec.id : undefined);
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
  // The preview covers the In/Out range when one is set, so its frames are the range's, not the timeline's.
  const range = previewRange(info);
  const stale = Boolean(meta && (meta.startFrame !== range.startFrame || meta.endFrame !== range.endFrame || Math.abs(meta.fps - info.fps) > 0.001));
  return {
    key,
    project,
    timeline: info.name,
    fps: info.fps,
    startFrame: meta ? meta.startFrame : range.startFrame,
    endFrame: meta ? meta.endFrame : range.endFrame,
    timelineStart: info.startFrame,
    timelineEnd: info.endFrame,
    inOut: info.inOut,
    ranged: Boolean(range.ranged),
    dropFrame: info.dropFrame,
    width: meta ? meta.width : null,
    height: meta ? meta.height : null,
    vertical: Boolean(info.vertical),
    ready: Boolean(meta),
    stale,
    file: meta ? pathToFileURL(meta.file).href : null,
    renderedAt: meta ? meta.renderedAt : null,
    rendering: state.preview.rendering && state.preview.key === key ? state.preview.percent : null,
  };
}

/** The frames the preview covers: the In/Out range when one is set and wanted, else the whole timeline. */
function previewRange(info) {
  const useInOut = readSettings().useInOut !== false;
  if (useInOut && info.inOut) return { startFrame: info.inOut.absIn, endFrame: info.inOut.absOut, ranged: true };
  return { startFrame: info.startFrame, endFrame: info.endFrame, ranged: false };
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
  const tlW = info.width || 1920;
  const tlH = info.height || 1080;
  // The long side is 1280: a 16:9 timeline previews at 1280×720, a 9:16 one at 720×1280.
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const width = tlH > tlW ? even((1280 * tlW) / tlH) : 1280;
  const height = tlH > tlW ? 1280 : even((1280 * tlH) / tlW);
  const range = previewRange(info);
  const profile = { ...PREVIEW_PROFILE, resolution: { width, height } };
  // lenient: a preview at the timeline's own size is still a preview
  const applied = await bridge.applyProfile(profile, { targetDir: PREVIEW_DIR, customName: key, lenient: true, range: range.ranged ? { markIn: range.startFrame, markOut: range.endFrame } : null });
  if (applied.rejected.length) log(`Preview: Resolve did not take ${applied.rejected.map((r) => r.key).join(', ')} for mp4/H264; rendering without`);
  const jobId = await bridge.addRenderJob();
  const ok = await bridge.startRendering([jobId]);
  if (!ok) throw new Error('Resolve refused to start the preview render');
  state.preview = { rendering: true, jobId, key, percent: 0 };
  log(`Rendering preview of "${info.name}" (${width}×${height} H.264${range.ranged ? `, In to Out ${info.inOut.tcIn} → ${info.inOut.tcOut}` : ''}) → ${PREVIEW_DIR}`);
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
      const meta = { file, project, timeline: info.name, startFrame: range.startFrame, endFrame: range.endFrame, ranged: range.ranged, timelineStart: info.startFrame, timelineEnd: info.endFrame, fps: info.fps, dropFrame: info.dropFrame, width, height, renderedAt: new Date().toISOString() };
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
    useInOut: r.useInOut === undefined ? readSettings().useInOut !== false : Boolean(r.useInOut),
  };
}

handle('exportx:plan', async (req) => requireExporter().plan(toRequest(req)));

handle('exportx:queue', async (req) => {
  const exporter = requireExporter();
  const request = toRequest(req);
  if (state.upload.running) throw new Error('Wait for the current upload to finish before exporting again.');
  const project = await state.bridge.projectName();
  const info = await currentInfo(true);
  const queuedAt = Date.now();
  const { jobs, errors, notes, warnings } = await exporter.queue(request);
  state.jobs = jobs;
  const portal = portalConfig();
  const upload = req && typeof req.upload === 'boolean' ? req.upload : portal.auto;
  const portalProjectId = req && req.portalProjectId ? String(req.portalProjectId) : '';
  if (upload && portal.url && !portalProjectId) throw new Error('Pick the portal project the files go in, or turn the upload switch off.');
  state.batch = {
    queuedAt,
    project,
    timeline: request.timelines ? request.timelines.join(', ') : info.name,
    fps: info.fps,
    frames: info.endFrame - info.startFrame + 1,
    namePattern: request.nameTemplate,
    upload: upload && Boolean(portal.url),
    portalProjectId,
    statuses: [],
  };
  writeSettings({
    targetDir: request.targetDir,
    nameTemplate: request.nameTemplate,
    selectedProfiles: request.profiles.map((p) => p.id),
    clearExisting: request.clearExisting,
    startRender: Boolean(req && req.startRender),
    useInOut: request.useInOut,
    ...(req && typeof req.upload === 'boolean' ? { portalAuto: req.upload } : {}),
    ...(portalProjectId && project ? { portalProjectByResolve: { ...(readSettings().portalProjectByResolve || {}), [project]: portalProjectId } } : {}),
  });
  let rendering = false;
  if (req && req.startRender && jobs.length) {
    await startRender(jobs.map((j) => j.jobId));
    rendering = true;
  }
  return { jobs, errors, notes, warnings, rendering };
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

handle('exportx:get-settings', async () => publicSettings(readSettings()));
handle('exportx:save-settings', async (settings) => publicSettings(writeSettings(settings)));
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
