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
 * Set EXPORTX_MOCK=1 to run the UI against test/helpers/mock-resolve.js outside Resolve.
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');

const { ResolveBridge } = require('./src/resolve');
const { BatchExporter, DEFAULT_TEMPLATE } = require('./src/batch');
const profilesLib = require('./src/profiles');

const PLUGIN_ID = 'com.triptychvisuals.exportx';
const MOCK = Boolean(process.env.EXPORTX_MOCK);
const USER_DIR = profilesLib.userDir();
const SETTINGS_FILE = path.join(USER_DIR, 'settings.json');
const DEFAULT_SETTINGS = {
  targetDir: '',
  nameTemplate: DEFAULT_TEMPLATE,
  selectedProfiles: null,
  clearExisting: false,
  startRender: true,
};

const state = {
  win: null,
  wi: null,
  bridge: null,
  exporter: null,
  initError: null,
  jobs: [],
  monitor: null,
  logBuffer: [],
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
  const { profiles, errors } = profilesLib.loadProfilesSafe(profilesLib.defaultProfileDirs());
  for (const e of errors) log(`Profile file skipped: ${e.message}`);
  return { profiles, errors, dirs: profilesLib.defaultProfileDirs() };
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
    state.bridge = new ResolveBridge(createMockResolve({ progressStep: 7 }));
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
}

function cleanup() {
  stopMonitor();
  if (state.wi) {
    try {
      state.wi.CleanUp();
    } catch (err) {
      console.error('[ExportX] CleanUp failed:', err);
    }
    state.wi = null;
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

// ---------------------------------------------------------------- IPC

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

handle('exportx:capabilities', async () => {
  const caps = await requireExporter().bridge.capabilities();
  log(`Render presets: ${caps.presets.join(', ') || 'none'}`);
  for (const f of caps.formats) {
    log(`Format ${f.id} (${f.description}): ${f.codecs.map((c) => `${c.id} [${c.description}]`).join(', ')}`);
  }
  return caps;
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
  return {
    profiles: selectProfiles(r.profileIds),
    targetDir: r.targetDir || '',
    nameTemplate: r.nameTemplate || DEFAULT_TEMPLATE,
    timelines: Array.isArray(r.timelines) && r.timelines.length ? r.timelines : null,
    clearExisting: Boolean(r.clearExisting),
  };
}

handle('exportx:plan', async (req) => requireExporter().plan(toRequest(req)));

handle('exportx:queue', async (req) => {
  const exporter = requireExporter();
  const request = toRequest(req);
  const { jobs, errors } = await exporter.queue(request);
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
  return { jobs, errors, rendering };
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
    width: 960,
    height: 760,
    minWidth: 760,
    minHeight: 540,
    title: 'ExportX',
    backgroundColor: '#1a1a1c',
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
