/* global window */
/**
 * Browser-side stand-in for the plugin's window.exportx bridge, used by
 * scripts/build-preview.js (the clickable HTML preview) and scripts/screenshot.js.
 * It fakes a Resolve project with a playing 24 fps timeline, timeline markers
 * for cuts and stills, and a render queue that progresses on its own.
 *
 * Profiles come from window.__EXPORTX_PROFILES__ (inlined by the build scripts).
 */
(function mock() {
  'use strict';
  if (window.exportx) return;

  const FPS = 24;
  const START = 86400; // 01:00:00:00
  const END = START + FPS * 60 * 3 - 1;
  const pad2 = (n) => String(n).padStart(2, '0');
  const tc = (abs) => {
    const n = Math.max(0, abs);
    return `${pad2(Math.floor(n / (FPS * 3600)))}:${pad2(Math.floor(n / (FPS * 60)) % 60)}:${pad2(Math.floor(n / FPS) % 60)}:${pad2(n % FPS)}`;
  };
  const dur = (frames) => `${(frames / FPS).toFixed(1)}s`;

  const profiles = (window.__EXPORTX_PROFILES__ || []).map((p) => ({
    description: '', target: 'timeline', renderPreset: null, renderMode: 'single', resolution: null, frameRate: null,
    settings: {}, subfolder: '', fileSuffix: '', enabledByDefault: true, tags: [], ...p,
    source: '/Applications/ExportX/profiles/default.json',
  }));
  const timelines = [
    { index: 1, name: 'Main Edit', current: true },
    { index: 2, name: 'Trailer 30s', current: false },
    { index: 3, name: 'Social Cut', current: false },
  ];
  const info = { name: 'Main Edit', startFrame: START, endFrame: END, fps: FPS, dropFrame: false, frames: END - START + 1 };
  const markers = { 96: { kind: 'cut', dur: 132 }, 500: { kind: 'still', dur: 1 } };

  function buildMarks() {
    const list = Object.entries(markers)
      .map(([k, v]) => {
        const relIn = Number(k);
        const relOut = v.kind === 'still' ? relIn : relIn + v.dur - 1;
        return {
          id: `${v.kind}@${relIn}`, kind: v.kind, relIn, relOut, absIn: START + relIn, absOut: START + relOut,
          durationFrames: relOut - relIn + 1, seconds: (relOut - relIn + 1) / FPS,
          tcIn: tc(START + relIn), tcOut: tc(START + relOut), duration: dur(relOut - relIn + 1), index: 0,
        };
      })
      .sort((a, b) => a.relIn - b.relIn);
    let c = 0;
    let s = 0;
    for (const m of list) m.index = m.kind === 'cut' ? ++c : ++s;
    return list;
  }

  const listeners = { log: [], progress: [], done: [], playhead: [], marks: [] };
  const sub = (k) => (cb) => {
    listeners[k].push(cb);
    return () => {
      listeners[k] = listeners[k].filter((f) => f !== cb);
    };
  };
  const emit = (k, data) => {
    for (const cb of listeners[k]) cb(data);
  };
  const stamp = () => `[${new Date().toTimeString().slice(0, 8)}] `;
  const log = (m) => emit('log', stamp() + m);

  let playheadAbs = START + FPS * 41 + 7;
  let playing = true;
  let press = null;
  setInterval(() => {
    if (playing) playheadAbs = playheadAbs + 4 > END ? START : playheadAbs + 4;
    emit('playhead', { ok: true, tc: tc(playheadAbs), absFrame: playheadAbs, relFrame: playheadAbs - START, timeline: 'Main Edit', fps: FPS, playing, info });
  }, 150);

  const sanitize = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
  const name = (tpl, ctx) => sanitize(tpl.replace(/\{(\w+)\}/g, (m, k) => (ctx[k] == null ? '' : ctx[k]))) || 'export';
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  };

  function plan(req) {
    const tls = req.timelines || ['Main Edit'];
    const targets = req.targets || ['timeline', 'cuts', 'stills'];
    const items = [];
    const notes = [];
    const marks = buildMarks();
    for (const tl of tls) {
      for (const id of req.profileIds) {
        const p = profiles.find((x) => x.id === id);
        if (!p || !targets.includes(p.target)) continue;
        const dir = p.subfolder ? `${req.targetDir}/${p.subfolder}` : req.targetDir;
        const ctx = { project: 'SpotA_Launch', timeline: tl, profile: p.id, profileName: p.name, format: p.format, codec: p.codec, width: p.resolution ? p.resolution.width : '', height: p.resolution ? p.resolution.height : '', date: today(), time: '101500' };
        const base = { timeline: tl, profileId: p.id, profileName: p.name, target: p.target, targetDir: dir };
        if (p.target === 'timeline') {
          items.push({ ...base, kind: 'final', fileName: name(req.nameTemplate, ctx) + (p.fileSuffix || ''), range: null, mark: null });
          continue;
        }
        const kind = p.target === 'cuts' ? 'cut' : 'still';
        const list = marks.filter((m) => m.kind === kind);
        if (!list.length) {
          notes.push({ profileId: p.id, profileName: p.name, timeline: tl, message: `No ${kind}s marked on "${tl}"` });
          continue;
        }
        let tpl = req.nameTemplate;
        if (!/\{(cut|n|tc|in|still)\}/.test(tpl)) tpl += kind === 'cut' ? '_cut{cut}' : '_still{still}';
        for (const m of list) {
          const n = pad2(m.index);
          items.push({
            ...base, kind,
            fileName: name(tpl, { ...ctx, cut: n, still: n, n, tc: m.tcIn.replace(/:/g, '.'), tcout: m.tcOut.replace(/:/g, '.'), in: m.absIn, out: m.absOut }) + (p.fileSuffix || ''),
            range: { markIn: m.absIn, markOut: m.absOut },
            mark: { index: m.index, kind, tcIn: m.tcIn, tcOut: m.tcOut, duration: m.duration, durationFrames: m.durationFrames },
          });
        }
      }
    }
    return { items, notes };
  }

  // ---- fake render queue
  let jobs = [];
  let renderTimer = null;
  let statuses = new Map();
  function summarize(list) {
    const c = { total: list.length, ready: 0, rendering: 0, complete: 0, failed: 0, cancelled: 0, other: 0 };
    let sum = 0;
    for (const s of list) {
      c[s.status] = (c[s.status] || 0) + 1;
      sum += s.status === 'complete' ? 100 : s.percent || 0;
    }
    c.percent = list.length ? Math.round(sum / list.length) : 0;
    c.done = list.length > 0 && list.every((s) => ['complete', 'failed', 'cancelled'].includes(s.status));
    return c;
  }
  function tick() {
    const list = jobs.map((j) => statuses.get(j.jobId));
    const current = list.find((s) => s.status === 'rendering') || list.find((s) => s.status === 'ready');
    if (current) {
      current.status = 'rendering';
      current.percent = Math.min(100, current.percent + 12 + Math.round(Math.random() * 14));
      if (current.percent >= 100) current.status = 'complete';
    }
    const summary = summarize(list);
    emit('progress', { statuses: list.map((s) => ({ ...s })), summary });
    if (summary.done) {
      clearInterval(renderTimer);
      renderTimer = null;
      log(`Render finished: ${summary.complete} complete, ${summary.failed} failed, ${summary.cancelled} cancelled`);
      emit('done', { statuses: list.map((s) => ({ ...s })), summary, stopped: false });
    }
  }
  function startRender() {
    log(`Rendering ${jobs.length} job(s)`);
    if (renderTimer) clearInterval(renderTimer);
    renderTimer = setInterval(tick, 350);
  }

  window.__exportxMock = { emit, get jobs() { return jobs; }, setPlaying: (v) => { playing = v; } };

  window.exportx = {
    status: async () => ({ connected: true, mock: true, product: 'DaVinci Resolve Studio', version: '20.1', project: 'SpotA_Launch', timeline: 'Main Edit', timelines, rendering: Boolean(renderTimer), userDir: '/Users/you/.exportx' }),
    profiles: async () => ({ profiles, errors: [] }),
    capabilities: async () => {
      log('Formats: mov (QuickTime): ProRes422HQ, ProRes422, ProRes4444 · mp4 (MP4): H264, H265 · tif (TIFF): RGB8, RGB16 · jpg (JPEG): JPEG');
      return { formats: [], presets: [] };
    },
    pickFolder: async () => '/Volumes/Deliver/SpotA_Launch',
    openFolder: async () => { log('Would open the output folder'); return true; },
    openProfilesFolder: async () => { log('Would open ~/.exportx/profiles'); return true; },
    openProfileFile: async () => true,
    marks: async () => ({ info, marks: buildMarks() }),
    markBegin: async () => { press = { absIn: playheadAbs, tc: tc(playheadAbs), fps: FPS, startedAt: Date.now(), timeline: 'Main Edit' }; return press; },
    markEnd: async () => {
      if (!press) throw new Error('No press in progress');
      const a = Math.min(press.absIn, playheadAbs);
      const b = Math.max(press.absIn, playheadAbs);
      press = null;
      const frames = b - a + 1;
      const kind = frames <= 7 ? 'still' : 'cut';
      if (markers[a - START]) throw new Error(`There is already a marker at ${tc(a)}`);
      markers[a - START] = { kind, dur: kind === 'still' ? 1 : frames };
      const marks = buildMarks();
      const added = marks.find((m) => m.relIn === a - START);
      log(`Marked ${kind} ${added.index}: ${added.tcIn}${kind === 'cut' ? ` → ${added.tcOut} (${added.duration})` : ''}`);
      return { info, marks, added };
    },
    markCancel: async () => { press = null; return true; },
    markStill: async () => { markers[playheadAbs - START] = { kind: 'still', dur: 1 }; const marks = buildMarks(); return { info, marks, added: marks.find((m) => m.relIn === playheadAbs - START) }; },
    markDelete: async (relIn) => { delete markers[relIn]; return { info, marks: buildMarks() }; },
    marksClear: async (kind) => { for (const k of Object.keys(markers)) if (!kind || markers[k].kind === kind) delete markers[k]; return { info, marks: buildMarks() }; },
    seek: async (abs) => { playheadAbs = abs; return tc(abs); },
    plan: async (req) => plan(req),
    queue: async (req) => {
      const { items, notes } = plan(req);
      jobs = items.map((it, i) => ({ jobId: `job-${Date.now()}-${i}`, ...it, format: 'x', codec: 'y' }));
      statuses = new Map(jobs.map((j) => [j.jobId, { jobId: j.jobId, status: 'ready', percent: 0, error: null }]));
      for (const j of jobs) log(`Queued "${j.profileName}" → ${j.targetDir}/${j.fileName}`);
      if (req.startRender && jobs.length) startRender();
      return { jobs, errors: [], notes, rendering: Boolean(req.startRender && jobs.length) };
    },
    render: async () => { startRender(); return true; },
    stop: async () => {
      if (renderTimer) clearInterval(renderTimer);
      renderTimer = null;
      for (const s of statuses.values()) if (s.status !== 'complete') s.status = 'cancelled';
      const list = jobs.map((j) => statuses.get(j.jobId));
      log('Stop requested');
      emit('done', { statuses: list, summary: summarize(list), stopped: true });
      return true;
    },
    jobStatus: async () => jobs.map((j) => statuses.get(j.jobId)),
    getSettings: async () => ({ targetDir: '/Volumes/Deliver/SpotA_Launch', nameTemplate: '{project}_{timeline}_{date}', selectedProfiles: null, clearExisting: false, startRender: true }),
    saveSettings: async (s) => s,
    logHistory: async () => [`${stamp()}Preview mode: this is a fake Resolve. Nothing is rendered.`, `${stamp()}Connected to DaVinci Resolve Studio 20.1 (preview)`],
    onLog: sub('log'), onProgress: sub('progress'), onDone: sub('done'), onPlayhead: sub('playhead'), onMarks: sub('marks'),
  };
})();
