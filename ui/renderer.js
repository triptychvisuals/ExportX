/* global window, document */
'use strict';

(function main() {
  const api = window.exportx;
  const $ = (id) => document.getElementById(id);

  const el = {
    connDot: $('conn-dot'),
    connText: $('conn-text'),
    banner: $('banner'),
    progressLine: $('progress-line'),
    progressFill: $('progress-fill'),
    viewExport: $('view-export'),
    viewSettings: $('view-settings'),
    tabExport: $('tab-export'),
    tabSettings: $('tab-settings'),
    // step 1
    profiles: $('profiles'),
    targetDir: $('target-dir'),
    chooseHint: $('choose-hint'),
    // step 2: viewer
    viewer: $('viewer'),
    pv: $('pv'),
    viewerEmpty: $('viewer-empty'),
    viewerBusy: $('viewer-busy'),
    pvProgress: $('pv-progress'),
    pvProgressText: $('pv-progress-text'),
    pvOverlay: $('pv-overlay'),
    scrub: $('scrub'),
    scrubMarks: $('scrub-marks'),
    pvScrub: $('pv-scrub'),
    transport: $('transport'),
    pvPlay: $('pv-play'),
    pvMute: $('pv-mute'),
    pvTc: $('pv-tc'),
    markSource: $('mark-source'),
    btnMarkSource: $('btn-mark-source'),
    // step 2: capture
    timelinePick: $('timeline-pick'),
    captureFps: $('capture-fps'),
    rangeRow: $('range-row'),
    rangeText: $('range-text'),
    rangeSwitch: $('range-switch'),
    optInOut: $('opt-inout'),
    playState: $('play-state'),
    playhead: $('playhead'),
    keyCut: $('key-cut'),
    keyCutLive: $('key-cut-live'),
    keyStill: $('key-still'),
    kbdCut: $('kbd-cut'),
    kbdStill: $('kbd-still'),
    pickCut: $('pick-cut'),
    pickStill: $('pick-still'),
    keysHint: $('keys-hint'),
    cuts: $('cuts'),
    stills: $('stills'),
    cutsCount: $('cuts-count'),
    stillsCount: $('stills-count'),
    captureHint: $('capture-hint'),
    // step 3
    btnGo: $('btn-go'),
    btnStop: $('btn-stop'),
    btnExportCuts: $('btn-export-cuts'),
    btnExportStills: $('btn-export-stills'),
    exportSummary: $('export-summary'),
    progress: $('progress'),
    totalFill: $('total-fill'),
    totalText: $('total-text'),
    bgHint: $('bg-hint'),
    jobs: $('jobs'),
    // portal upload
    uploadSwitch: $('upload-switch'),
    optUpload: $('opt-upload'),
    upload: $('upload'),
    uploadText: $('upload-text'),
    uploadFill: $('upload-fill'),
    btnUpload: $('btn-upload'),
    btnUploadOpen: $('btn-upload-open'),
    portalUrl: $('portal-url'),
    portalToken: $('portal-token'),
    btnPortalTest: $('btn-portal-test'),
    portalResult: $('portal-result'),
    optPortalAuto: $('opt-portal-auto'),
    portalProjectRow: $('portal-project-row'),
    portalProject: $('portal-project'),
    btnPortalRefresh: $('btn-portal-refresh'),
    // settings
    nameTemplate: $('name-template'),
    tokens: $('tokens'),
    optUnderscore: $('opt-underscore'),
    nameExample: $('name-example'),
    nameExampleCut: $('name-example-cut'),
    settingsProfiles: $('settings-profiles'),
    userDir: $('user-dir'),
    timelines: $('timelines'),
    navHint: $('nav-hint'),
    optStart: $('opt-start'),
    optClear: $('opt-clear'),
    log: $('log'),
  };

  const DEFAULT_TEMPLATE = '{yymmdd}_{project}_{label}';
  const TOKENS = ['{yymmdd}', '{project}', '{label}', '{timeline}', '{date}', '{time}', '{n}', '{tc}'];
  const CHECK = '<svg viewBox="0 0 16 16"><path d="M3 8.5l3 3 7-7"/></svg>';
  const TARGET_TAG = { cuts: ['per cut', 'cut'], stills: ['per still', 'still'] };
  const TARGET_LABEL = { timeline: 'Whole timeline', cuts: 'Each cut', stills: 'Each still' };
  const QUALITIES = ['Least', 'Low', 'Medium', 'High', 'Best'];
  const AUTO_CODEC = /^(auto|\*|first|default)$/i;
  const EST = window.ExportXEstimate || null;
  const CUT_SUB = 'hold while it plays, release to finish';
  const FRAME_RATES = ['23.976', '24', '25', '29.97', '30', '47.952', '48', '50', '59.94', '60'];
  const ENCODING_PROFILES = { h264: ['Baseline', 'Main', 'High', 'High 4:2:2', 'High 4:4:4'], h265: ['Main', 'Main10', 'Main 4:2:2 10', 'Main 4:4:4'] };
  const AUDIO_CODECS = [['aac', 'AAC'], ['lpcm', 'Linear PCM'], ['mp3', 'MP3']];
  const COLOR_SPACES = ['Same as Project', 'Rec.709', 'Rec.2020', 'Rec.2100 ST2084', 'Rec.2100 HLG', 'P3-D65', 'sRGB'];
  const GAMMAS = ['Same as Project', 'Rec.709', 'Gamma 2.2', 'Gamma 2.4', 'sRGB', 'ST2084', 'HLG', 'ACEScct', 'Linear'];

  const state = {
    view: 'export',
    status: null,
    profiles: [],
    included: new Set(),
    timelinesPicked: new Set(),
    plan: { items: [], notes: [] },
    jobs: [],
    statuses: new Map(),
    rendering: false,
    busy: false,
    marks: [],
    pressing: false,
    press: null,
    pressPromise: null,
    settings: {},
    keys: { cut: 'c', still: 's' },
    picking: null,
    caps: null,
    capsPromise: null,
    openDelivs: new Set(),
    resolutions: new Map(),
    resolvePlayhead: null,
    preview: { status: null, source: 'preview', mediaTime: null, loadedFile: null, rvfc: 0, seekTimer: null },
    lastSummary: null,
    portal: { url: '', tokenSet: false, name: '', projects: [], projectId: '', byResolve: {}, loading: false, loadError: '' },
    upload: { running: false, files: new Map(), result: null, error: null, total: 0, percentTotal: 0 },
  };

  // ------------------------------------------------------------ utilities

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function appendLog(line) {
    el.log.textContent += (el.log.textContent ? '\n' : '') + line;
    el.log.scrollTop = el.log.scrollHeight;
  }

  function showBanner(message, kind = 'error') {
    if (!message) {
      el.banner.classList.add('hidden');
      return;
    }
    el.banner.textContent = message;
    el.banner.className = `banner${kind === 'info' ? ' info' : ''}`;
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function slash(p) {
    return String(p ?? '').replace(/\\/g, '/');
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function fpsLabel(fps) {
    if (!fps) return '';
    const r = Math.round(fps * 1000) / 1000;
    return `${Number.isInteger(r) ? r : r.toFixed(3).replace(/0+$/, '')} fps`;
  }

  function secondsLabel(frames, fps) {
    const s = Math.max(0, frames) / (fps || 24);
    return s >= 60 ? `${Math.floor(s / 60)}m ${(s % 60).toFixed(1)}s` : `${s.toFixed(1)}s`;
  }

  function framesToTc(frames, fps) {
    const tb = Math.max(1, Math.round(fps || 24));
    const n = Math.max(0, Math.round(frames));
    return `${pad2(Math.floor(n / (tb * 3600)) % 24)}:${pad2(Math.floor(n / (tb * 60)) % 60)}:${pad2(Math.floor(n / tb) % 60)}:${pad2(n % tb)}`;
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  function isConnected() {
    return Boolean(state.status && state.status.connected && !state.status.error);
  }

  function profileTarget(p) {
    return p.target === 'cuts' || p.target === 'stills' ? p.target : 'timeline';
  }

  function labelOf(p) {
    if (p.label) return p.label;
    const first = String(p.name || 'Export').trim().split(/\s+/)[0].replace(/[^A-Za-z0-9]/g, '');
    return first ? first[0].toUpperCase() + first.slice(1) : 'Export';
  }

  function includedIds() {
    return state.profiles.filter((p) => state.included.has(p.id)).map((p) => p.id);
  }

  function countIncluded(target) {
    return state.profiles.filter((p) => state.included.has(p.id) && profileTarget(p) === target).length;
  }

  function timelineList() {
    return (state.status && state.status.timelines) || [];
  }

  function pickedTimelines() {
    const names = timelineList().map((t) => t.name).filter((n) => state.timelinesPicked.has(n));
    return names.length ? names : null;
  }

  function currentRequest(startRender, targets) {
    return {
      profileIds: includedIds(),
      targets: targets || null,
      targetDir: el.targetDir.value.trim(),
      nameTemplate: el.nameTemplate.value.trim() || DEFAULT_TEMPLATE,
      timelines: pickedTimelines(),
      clearExisting: el.optClear.checked,
      startRender: Boolean(startRender),
      useInOut: el.optInOut.checked,
      upload: portalConfigured() ? el.optUpload.checked : undefined,
      portalProjectId: uploadWanted() ? state.portal.projectId || undefined : undefined,
    };
  }

  function setBusy(busy) {
    state.busy = busy;
    updateButtons();
  }

  function updateButtons() {
    const needProject = uploadWanted() && !state.portal.projectId;
    const ready = isConnected() && el.targetDir.value.trim().length > 0 && !state.busy && !state.rendering && !needProject;
    const cuts = state.marks.filter((m) => m.kind === 'cut').length;
    const stills = state.marks.filter((m) => m.kind === 'still').length;
    el.btnGo.disabled = !(ready && state.plan.items.length > 0);
    el.btnExportCuts.disabled = !(ready && cuts > 0 && countIncluded('cuts') > 0);
    el.btnExportStills.disabled = !(ready && stills > 0 && countIncluded('stills') > 0);
    el.btnStop.classList.toggle('hidden', !state.rendering);
    el.btnGo.classList.toggle('hidden', state.rendering);
    el.bgHint.classList.toggle('hidden', !state.rendering);
    el.keyCut.classList.toggle('off', !isConnected());
    el.keyStill.classList.toggle('off', !isConnected());
    el.timelinePick.disabled = !isConnected() || state.busy || state.rendering;
    const n = state.plan.items.length;
    const verb = el.optStart.checked ? 'Export' : 'Queue';
    el.btnGo.textContent = n ? `${verb} everything · ${plural(n, 'file')}` : `${verb} everything`;
    el.btnGo.title = needProject ? 'Pick the portal project the files go in first' : '';
    el.portalProjectRow.classList.toggle('missing', needProject);
  }

  // ------------------------------------------------------------ tabs

  function switchView(name) {
    state.view = name;
    const settings = name === 'settings';
    el.viewExport.hidden = settings;
    el.viewSettings.hidden = !settings;
    el.tabExport.classList.toggle('on', !settings);
    el.tabSettings.classList.toggle('on', settings);
    el.tabExport.setAttribute('aria-selected', String(!settings));
    el.tabSettings.setAttribute('aria-selected', String(settings));
    if (settings) {
      loadCaps().then(renderSettingsProfiles);
      renderSettingsProfiles();
      renderNameExamples();
    }
    window.scrollTo({ top: 0 });
    el.viewSettings.scrollTop = 0;
  }

  // ------------------------------------------------------------ status

  async function refreshStatus() {
    try {
      state.status = await api.status();
    } catch (err) {
      state.status = { connected: false, error: err.message };
    }
    const s = state.status;
    if (s.userDir) el.userDir.textContent = `${slash(s.userDir)}/profiles/`;
    if (!s.connected) {
      el.connDot.className = 'dot bad';
      el.connText.textContent = 'Not connected to Resolve';
      showBanner(s.error || 'Not connected to DaVinci Resolve.');
    } else if (s.error) {
      el.connDot.className = 'dot';
      el.connText.textContent = `${s.product || 'Resolve'}`;
      showBanner(s.error, 'info');
    } else {
      el.connDot.className = 'dot ok';
      el.connText.textContent = `${s.project}${s.timeline ? ` › ${s.timeline}` : ''}${s.mock ? ' · preview' : ''}`;
      showBanner(null);
      if (s.rendering && !state.rendering) showBanner('Resolve is already rendering. Wait for it to finish before exporting more.', 'info');
    }
    renderTimelines();
    renderTimelinePick();
    renderRangeRow();
    renderNameExamples();
    pickDefaultProject();
    renderPortalControls();
    updateButtons();
    schedulePlan();
    if (isConnected()) {
      api.marks().then(applyMarks).catch(() => {});
      api.previewStatus().then(applyPreviewStatus).catch(() => {});
    }
  }

  function renderTimelines() {
    const list = timelineList();
    const known = new Set(list.map((t) => t.name));
    for (const name of [...state.timelinesPicked]) if (!known.has(name)) state.timelinesPicked.delete(name);
    const current = list.find((t) => t.current);
    if (!state.timelinesPicked.size && current) state.timelinesPicked.add(current.name);
    el.timelines.innerHTML = '';
    for (const tl of list) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `chip${state.timelinesPicked.has(tl.name) ? ' on' : ''}`;
      chip.innerHTML = `${tl.current ? '<i class="cur"></i>' : ''}${escapeHtml(tl.name)}`;
      chip.addEventListener('click', () => {
        if (state.timelinesPicked.has(tl.name)) state.timelinesPicked.delete(tl.name);
        else state.timelinesPicked.add(tl.name);
        renderTimelines();
        schedulePlan();
      });
      el.timelines.appendChild(chip);
    }
    const picked = pickedTimelines();
    el.navHint.textContent = !list.length ? '' : !picked || picked.length === 1 ? 'Exports the current timeline. Pick more to export them too.' : `Exports ${picked.length} timelines.`;
  }

  // ------------------------------------------------------------ which timeline, which part of it

  function renderTimelinePick() {
    const list = timelineList();
    const current = list.find((t) => t.current);
    el.timelinePick.innerHTML = '';
    if (!list.length) {
      el.timelinePick.appendChild(option('', isConnected() ? 'No timeline open' : 'No timeline', true));
      return;
    }
    for (const tl of list) el.timelinePick.appendChild(option(tl.name, tl.name, Boolean(tl.current)));
    if (!current) el.timelinePick.insertBefore(option('', 'Pick a timeline', true), el.timelinePick.firstChild);
  }

  /** Make another timeline the one the panel marks, previews and exports. */
  async function switchTimeline(name) {
    if (!name || !isConnected()) return;
    setBusy(true);
    try {
      await api.setTimeline(name);
      state.timelinesPicked = new Set([name]);
      state.marks = [];
      state.resolvePlayhead = null;
      state.preview.loadedFile = null;
      showBanner(null);
      await refreshStatus();
    } catch (err) {
      showBanner(err.message);
      renderTimelinePick();
    } finally {
      setBusy(false);
    }
  }

  /** The facts of the timeline the panel is on: from the last plan (which knows the In/Out range), else from the playhead poll. */
  function currentTimelineFacts() {
    const name = (state.status && state.status.timeline) || null;
    const fromPlan = state.plan && state.plan.timelines && name ? state.plan.timelines[name] : null;
    if (fromPlan) return fromPlan;
    const info = state.resolvePlayhead && state.resolvePlayhead.info;
    if (info) return { ...info, range: el.optInOut.checked && info.inOut ? info.inOut : null };
    return null;
  }

  function renderRangeRow() {
    const facts = currentTimelineFacts();
    const inOut = facts && facts.inOut;
    el.rangeSwitch.classList.toggle('hidden', !inOut);
    el.rangeRow.classList.toggle('ranged', Boolean(inOut && el.optInOut.checked));
    if (!facts) {
      el.rangeText.textContent = 'Whole timeline';
      return;
    }
    const fps = facts.fps || 24;
    if (inOut) {
      el.rangeText.innerHTML = el.optInOut.checked
        ? `In to Out <b>${escapeHtml(inOut.tcIn)}</b> → <b>${escapeHtml(inOut.tcOut)}</b> · ${escapeHtml(secondsLabel(inOut.frames, fps))}`
        : `Whole timeline · ${escapeHtml(secondsLabel(facts.frames, fps))} (In to Out is set but off)`;
    } else {
      el.rangeText.textContent = `Whole timeline · ${secondsLabel(facts.frames || 0, fps)}${facts.frames ? ' · set In and Out in Resolve (I, O) to export a part' : ''}`;
    }
  }

  function sumEstimates(items) {
    let bytes = 0;
    let exact = true;
    let any = false;
    for (const it of items) {
      if (!it.estimate || it.estimate.bytes === null || it.estimate.bytes === undefined) continue;
      any = true;
      bytes += it.estimate.bytes;
      if (!it.estimate.exact) exact = false;
    }
    return { bytes: any ? bytes : null, exact };
  }

  function estHtml(est) {
    const text = EST ? EST.sizeLabel(est) : '';
    return text ? `<span class="est">${escapeHtml(text)}</span>` : '';
  }

  /** What the plan says this deliverable weighs on the current timeline (all its files together). */
  function profileEstimate(p) {
    const items = (state.plan.items || []).filter((it) => it.profileId === p.id);
    if (!items.length) return null;
    const total = sumEstimates(items);
    return total.bytes === null ? null : { bytes: total.bytes, exact: total.exact };
  }

  // ------------------------------------------------------------ profiles (shared by step 1 and settings)

  function applyProfiles(result, settings) {
    const { profiles, errors } = result;
    state.profiles = profiles;
    const saved = settings && Array.isArray(settings.selectedProfiles) ? new Set(settings.selectedProfiles) : null;
    const known = new Set(profiles.map((p) => p.id));
    if (saved) state.included = new Set(profiles.filter((p) => saved.has(p.id)).map((p) => p.id));
    else if (!state.included.size) state.included = new Set(profiles.filter((p) => p.enabledByDefault).map((p) => p.id));
    for (const id of [...state.included]) if (!known.has(id)) state.included.delete(id);
    if (result.userDir) el.userDir.textContent = `${slash(result.userDir)}/`;
    if (errors && errors.length) showBanner(`${errors.length} deliverable file(s) could not be read. See the log under Settings › Advanced.`, 'info');
    renderProfiles();
    renderSettingsProfiles();
    renderNameExamples();
    updateButtons();
    schedulePlan();
  }

  async function loadProfiles(settings) {
    applyProfiles(await api.profiles(), settings);
  }

  function profileMeta(p) {
    const parts = [p.format, AUTO_CODEC.test(p.codec) ? '' : p.codec];
    if (p.resolution) parts.push(`${p.resolution.width}×${p.resolution.height}`);
    if (p.renderMode === 'individual') parts.push('per clip');
    return parts.filter(Boolean).join(' · ');
  }

  function sortedProfiles() {
    const order = ['timeline', 'cuts', 'stills'];
    return [...state.profiles].sort((a, b) => order.indexOf(profileTarget(a)) - order.indexOf(profileTarget(b)));
  }

  function renderProfiles() {
    el.profiles.innerHTML = '';
    if (!state.profiles.length) {
      el.profiles.innerHTML = '<li class="none">No deliverables yet. Add one in Settings.</li>';
      return;
    }
    for (const p of sortedProfiles()) {
      const on = state.included.has(p.id);
      const target = profileTarget(p);
      const tag = TARGET_TAG[target] ? `<span class="tag ${TARGET_TAG[target][1]}">${TARGET_TAG[target][0]}</span>` : '';
      const li = document.createElement('li');
      li.className = `choice ${on ? 'on' : 'off'}`;
      li.title = p.description || '';
      li.innerHTML =
        `<span class="inc" role="checkbox" aria-checked="${on}">${CHECK}</span>` +
        `<div class="name">${escapeHtml(p.name)}${tag}</div>` +
        `<span class="meta">${escapeHtml(profileMeta(p))}${estHtml(profileEstimate(p))}</span>`;
      li.addEventListener('click', () => {
        if (state.included.has(p.id)) state.included.delete(p.id);
        else state.included.add(p.id);
        renderProfiles();
        updateButtons();
        schedulePlan();
        api.saveSettings({ selectedProfiles: includedIds() }).catch(() => {});
      });
      el.profiles.appendChild(li);
    }
  }

  // ------------------------------------------------------------ naming

  function exampleName(label, perMark) {
    const tpl = el.nameTemplate.value.trim() || DEFAULT_TEMPLATE;
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const values = {
      yymmdd: `${yyyy.slice(-2)}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`,
      date: `${yyyy}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`,
      time: `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`,
      project: (state.status && state.status.project) || 'Project',
      timeline: (state.status && state.status.timeline) || 'Timeline',
      label,
      profile: label.toLowerCase(),
      n: '01',
      cut: '01',
      still: '01',
      tc: '01.00.12.05',
      width: '',
      height: '',
    };
    let t = tpl;
    if (perMark && !/\{(cut|still|n|tc|in)\}/.test(t)) t += '_{n}';
    let out = t.replace(/\{(\w+)\}/g, (_m, k) => (values[k] == null ? '' : values[k]));
    out = out.replace(/[\\/:*?"<>|]/g, '_');
    if (el.optUnderscore.checked) out = out.replace(/\s+/g, '_');
    return out.replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '') || 'export';
  }

  function renderNameExamples() {
    const finalP = state.profiles.find((p) => profileTarget(p) === 'timeline' && state.included.has(p.id)) || state.profiles.find((p) => profileTarget(p) === 'timeline');
    const cutP = state.profiles.find((p) => profileTarget(p) === 'cuts');
    const ext = (p, d) => (p && /^[a-z0-9]{2,4}$/i.test(p.format) ? p.format : d);
    el.nameExample.textContent = `${exampleName(finalP ? labelOf(finalP) : 'Final', false)}.${ext(finalP, 'mp4')}`;
    el.nameExampleCut.textContent = `${exampleName(cutP ? labelOf(cutP) : 'Social', true)}.${ext(cutP, 'mp4')}`;
    el.chooseHint.textContent = `Files are named ${el.nameExample.textContent} and so on. Change the pattern, formats and codecs under Settings.`;
  }

  function renderTokens() {
    el.tokens.innerHTML = TOKENS.map((t) => `<code title="Insert ${escapeHtml(t)}">${escapeHtml(t)}</code>`).join('');
    el.tokens.querySelectorAll('code').forEach((c) => {
      c.addEventListener('click', () => {
        const input = el.nameTemplate;
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? input.value.length;
        input.value = input.value.slice(0, start) + c.textContent + input.value.slice(end);
        input.focus();
        input.setSelectionRange(start + c.textContent.length, start + c.textContent.length);
        api.saveSettings({ nameTemplate: input.value }).catch(() => {});
        renderNameExamples();
        schedulePlan();
      });
    });
  }

  // ------------------------------------------------------------ settings: deliverable cards

  function loadCaps() {
    if (state.caps) return Promise.resolve(state.caps);
    if (!isConnected()) return Promise.resolve(null);
    if (!state.capsPromise) {
      state.capsPromise = api
        .capabilities({ quiet: true })
        .then((caps) => {
          state.caps = caps && caps.formats && caps.formats.length ? caps : null;
          return state.caps;
        })
        .catch(() => null);
    }
    return state.capsPromise;
  }

  function formatEntry(formatId) {
    if (!state.caps) return null;
    const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return state.caps.formats.find((f) => norm(f.id) === norm(formatId) || norm(f.description) === norm(formatId)) || null;
  }

  function option(value, text, selected) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    if (selected) o.selected = true;
    return o;
  }

  function fillFormatSelect(select, current) {
    select.innerHTML = '';
    const entry = formatEntry(current);
    for (const f of state.caps.formats) select.appendChild(option(f.id, `${f.description} (${f.id})`, entry ? f.id === entry.id : false));
    if (!entry && current) select.appendChild(option(current, `${current} (not offered by this Resolve)`, true));
  }

  function fillCodecSelect(select, formatId, current) {
    select.innerHTML = '';
    const entry = formatEntry(formatId);
    const codecs = entry ? entry.codecs : [];
    const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const auto = AUTO_CODEC.test(current || '');
    select.appendChild(option('auto', 'First available', auto));
    let found = auto;
    for (const c of codecs) {
      const hit = !auto && (norm(c.id) === norm(current) || norm(c.description) === norm(current));
      if (hit) found = true;
      select.appendChild(option(c.id, `${c.description}${c.description !== c.id ? ` (${c.id})` : ''}`, hit));
    }
    if (!found && current) select.appendChild(option(current, `${current} (not offered for this format)`, true));
  }

  function qualityOf(settings) {
    const q = settings ? settings.VideoQuality : undefined;
    if (q === undefined || q === null || q === '' || q === 0 || q === '0') return { select: '', bitrate: '' };
    if (typeof q === 'number') return { select: 'custom', bitrate: String(q) };
    return { select: String(q), bitrate: '' };
  }

  function delivSummary(p) {
    const parts = [p.format, AUTO_CODEC.test(p.codec) ? 'auto' : p.codec];
    if (p.resolution) parts.push(`${p.resolution.width}×${p.resolution.height}`);
    if (p.renderPreset) parts.push(`preset: ${p.renderPreset}`);
    if (p.subfolder) parts.push(p.subfolder);
    return parts.filter(Boolean).join(' · ');
  }

  function buildDelivForm(p) {
    const form = document.createElement('form');
    form.className = 'deliv-body';
    form.noValidate = true;
    const q = qualityOf(p.settings);
    const haveCaps = Boolean(state.caps);
    const audioOn = !(p.settings && p.settings.ExportAudio === false);
    const presets = (state.caps && state.caps.presets) || [];
    form.innerHTML =
      `<div class="grid2">` +
      `<label>Name<input type="text" name="name" value="${escapeHtml(p.name)}" required></label>` +
      `<label>Label in the file name<input type="text" name="label" value="${escapeHtml(labelOf(p))}" placeholder="Final" pattern="[A-Za-z0-9][A-Za-z0-9_-]*"></label>` +
      `<label>Applies to<select name="target">${Object.entries(TARGET_LABEL)
        .map(([v, t]) => `<option value="${v}"${profileTarget(p) === v ? ' selected' : ''}>${t}</option>`)
        .join('')}</select></label>` +
      `<label>Start from Deliver preset<select name="renderPreset"><option value="">None</option>${presets
        .map((n) => `<option value="${escapeHtml(n)}"${p.renderPreset === n ? ' selected' : ''}>${escapeHtml(n)}</option>`)
        .join('')}${p.renderPreset && !presets.includes(p.renderPreset) ? `<option value="${escapeHtml(p.renderPreset)}" selected>${escapeHtml(p.renderPreset)} (not found)</option>` : ''}</select></label>` +
      `<label>Format${haveCaps ? '<select name="format"></select>' : `<input type="text" name="format" value="${escapeHtml(p.format)}" placeholder="mp4">`}</label>` +
      `<label>Codec${haveCaps ? '<select name="codec"></select>' : `<input type="text" name="codec" value="${escapeHtml(p.codec)}" placeholder="H264 or auto">`}</label>` +
      `<label>Size<span class="size"><select name="sizepick"><option value="">Timeline's</option></select><input type="text" name="width" inputmode="numeric" value="${p.resolution ? p.resolution.width : ''}" placeholder="w" hidden><span class="size-x" hidden>×</span><input type="text" name="height" inputmode="numeric" value="${p.resolution ? p.resolution.height : ''}" placeholder="h" hidden></span></label>` +
      `<label>Quality<span class="quality"><select name="quality"><option value=""${q.select === '' ? ' selected' : ''}>Automatic</option>${QUALITIES.map((v) => `<option value="${v}"${q.select === v ? ' selected' : ''}>${v}</option>`).join('')}<option value="custom"${q.select === 'custom' ? ' selected' : ''}>Bit rate…</option></select><input type="text" name="bitrate" inputmode="numeric" placeholder="kb/s" value="${escapeHtml(q.bitrate)}"${q.select === 'custom' ? '' : ' hidden'}></span></label>` +
      `<label class="wide">Folder inside the output folder<input type="text" name="subfolder" value="${escapeHtml(p.subfolder || '')}" placeholder="(none)"></label>` +
      `<div class="switches">` +
      `<label class="switch"><input type="checkbox" name="audio"${audioOn ? ' checked' : ''}><i></i><span>Include audio</span></label>` +
      `<label class="switch"><input type="checkbox" name="enabledByDefault"${p.enabledByDefault !== false ? ' checked' : ''}><i></i><span>Ticked by default</span></label>` +
      `</div>` +
      `</div>` +
      moreSettingsHtml(p) +
      `<p class="deliv-est" data-est></p>` +
      `<div class="row wrap deliv-actions">` +
      `<button type="submit" class="btn small primary">Save</button>` +
      `<button type="button" class="btn small" data-act="duplicate">Duplicate</button>` +
      (p.isUser && p.hasBundled ? `<button type="button" class="btn small" data-act="reset">Reset to default</button>` : '') +
      (p.isUser && !p.hasBundled ? `<button type="button" class="btn small quiet-danger" data-act="delete">Delete</button>` : '') +
      `<button type="button" class="link" data-act="json">Open JSON</button>` +
      `</div>` +
      `<p class="deliv-note" data-note></p>`;

    const f = (n) => form.querySelector(`[name="${n}"]`);
    const note = form.querySelector('[data-note]');
    const say = (text, warn) => {
      note.textContent = text || '';
      note.className = `deliv-note${warn ? ' warn' : ''}`;
    };
    if (haveCaps) {
      fillFormatSelect(f('format'), p.format);
      fillCodecSelect(f('codec'), f('format').value, p.codec);
      f('format').addEventListener('change', () => {
        fillCodecSelect(f('codec'), f('format').value, 'auto');
        loadSizes();
      });
      f('codec').addEventListener('change', loadSizes);
    }
    // Size: the list Resolve offers for this format and codec, the timeline's own, or a custom pair.
    const sizeInputs = [f('width'), f('height'), form.querySelector('.size-x')];
    const showSizeInputs = (on) => sizeInputs.forEach((n) => { n.hidden = !on; });
    function fillSizes(list) {
      const sel = f('sizepick');
      const w = f('width').value.trim();
      const h = f('height').value.trim();
      const current = w && h ? `${w}×${h}` : '';
      sel.innerHTML = '';
      sel.appendChild(option('', "Timeline's", !current));
      let found = !current;
      for (const r of list) {
        const v = `${r.width}×${r.height}`;
        if (v === current) found = true;
        sel.appendChild(option(v, `${r.width} × ${r.height}${r.width === 1080 && r.height === 1920 ? ' (vertical)' : ''}`, v === current));
      }
      sel.appendChild(option('custom', 'Custom…', Boolean(current) && !found));
      showSizeInputs(Boolean(current) && !found);
    }
    function loadSizes() {
      const key = `${f('format').value}|${f('codec').value}`;
      const cached = state.resolutions.get(key);
      fillSizes(cached || []);
      if (cached || !isConnected()) return;
      api.resolutions({ format: f('format').value, codec: f('codec').value })
        .then((list) => {
          state.resolutions.set(key, list || []);
          if (form.isConnected) fillSizes(list || []);
        })
        .catch(() => state.resolutions.set(key, []));
    }
    f('sizepick').addEventListener('change', () => {
      const v = f('sizepick').value;
      if (v === 'custom') {
        showSizeInputs(true);
        f('width').focus();
      } else {
        const [w, h] = v ? v.split('×') : ['', ''];
        f('width').value = w;
        f('height').value = h;
        showSizeInputs(false);
      }
      updateEstimate();
    });
    loadSizes();
    const estLine = form.querySelector('[data-est]');
    function updateEstimate() {
      if (!EST) return;
      const { out } = readForm(f, p);
      const facts = currentTimelineFacts();
      if (!facts || !facts.fps) {
        estLine.textContent = isConnected() ? '' : 'Connect to Resolve to see a file size for this timeline.';
        return;
      }
      const width = out.resolution ? out.resolution.width : facts.width;
      const height = out.resolution ? out.resolution.height : facts.height;
      const fps = out.frameRate || facts.fps;
      const base = { format: out.format, codec: out.codec, settings: out.settings, width, height, fps };
      let text = '';
      if (out.target === 'stills') {
        const e = EST.estimateBytes({ ...base, frames: 1, kind: 'still' });
        text = e.bytes ? `<b>${EST.sizeLabel(e)}</b> per still at ${width}×${height}` : '';
      } else if (out.target === 'cuts') {
        const e = EST.estimateBytes({ ...base, frames: Math.round(fps * 10), kind: 'cut' });
        text = e.bytes ? `<b>${EST.sizeLabel(e)}</b> per 10-second cut (${e.basis})` : '';
      } else {
        const frames = facts.range ? facts.range.frames : facts.frames;
        const e = EST.estimateBytes({ ...base, frames, kind: 'final' });
        text = e.bytes ? `<b>${EST.sizeLabel(e)}</b> for ${escapeHtml(facts.name || 'this timeline')} (${secondsLabel(frames, fps)}${facts.range ? ', In to Out' : ''}, ${e.basis})` : '';
      }
      estLine.innerHTML = text;
    }
    form.addEventListener('input', updateEstimate);
    form.addEventListener('change', updateEstimate);
    setTimeout(updateEstimate, 0);
    const levelNote = () => {
      const level = QUALITIES.includes(f('quality').value);
      const h26x = /^h\.?26[45]$/i.test(String(f('codec').value || '').trim());
      if (level && h26x) say('H.264 and H.265 take a bit rate (choose "Bit rate…", in kb/s; 16000 suits 1080p, 45000 suits 4K). Resolve refuses the Least to Best levels for them, so this one would be dropped and the file would use Resolve\'s automatic quality.', true);
      else if (note.textContent.startsWith('H.264 and H.265 take a bit rate')) say('');
    };
    f('quality').addEventListener('change', () => {
      f('bitrate').hidden = f('quality').value !== 'custom';
      levelNote();
    });
    f('codec').addEventListener('change', levelNote);
    levelNote();
    f('target').addEventListener('change', () => {
      const stills = f('target').value === 'stills';
      f('audio').closest('.switch').style.display = stills ? 'none' : '';
    });
    if (profileTarget(p) === 'stills') f('audio').closest('.switch').style.display = 'none';
    if (!haveCaps) say(isConnected() ? 'Format and codec lists are not available right now; type the ids Resolve uses (see Advanced › List formats & codecs).' : 'Connect to Resolve to pick formats and codecs from a list.');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const { out, problem } = readForm(f, p);
      if (problem) return say(problem, true);
      try {
        say('Saving…');
        const result = await api.saveProfile(out);
        applyProfiles(result);
        showBanner(null);
      } catch (err) {
        say(err.message, true);
      }
      return undefined;
    });

    form.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      const kind = act.dataset.act;
      try {
        if (kind === 'json') await api.openProfileFile(p.id);
        if (kind === 'duplicate') {
          const { source, isUser, hasBundled, ...rest } = p; // eslint-disable-line no-unused-vars
          const id = uniqueId(`${p.id}-copy`);
          const result = await api.saveProfile({ ...rest, id, name: `${p.name} copy`, enabledByDefault: false });
          state.openDelivs.add(id);
          applyProfiles(result);
        }
        if (kind === 'reset' || kind === 'delete') {
          if (act.dataset.armed !== '1') {
            act.dataset.armed = '1';
            act.textContent = kind === 'reset' ? 'Click again to reset' : 'Click again to delete';
            setTimeout(() => {
              act.dataset.armed = '';
              act.textContent = kind === 'reset' ? 'Reset to default' : 'Delete';
            }, 4000);
            return;
          }
          const result = await api.deleteProfile(p.id);
          state.openDelivs.delete(p.id);
          applyProfiles(result);
        }
      } catch (err) {
        say(err.message, true);
      }
    });
    return form;
  }

  /**
   * The deliverable as the form describes it right now. `problem` is the one
   * sentence to show instead of saving; `out` is always filled, so the size
   * estimate can follow every keystroke.
   */
  function readForm(f, p) {
    let problem = '';
    const name = f('name').value.trim();
    if (!name) problem = 'Give the deliverable a name.';
    const w = f('width').value.trim();
    const h = f('height').value.trim();
    if (!problem && ((w && !h) || (!w && h))) problem = 'Set both width and height, or leave both empty to use the timeline size.';
    const settings = { ...(p.settings || {}) };
    const quality = f('quality').value;
    if (quality === '') delete settings.VideoQuality;
    else if (quality === 'custom') {
      const kb = Number(f('bitrate').value);
      if (!kb && !problem) problem = 'Enter a bit rate in kb/s, or pick a quality level.';
      if (kb) settings.VideoQuality = kb;
      else delete settings.VideoQuality;
    } else settings.VideoQuality = quality;
    const target = f('target').value;
    if (target !== 'stills') settings.ExportAudio = f('audio').checked;
    const setOrDrop = (key, value) => {
      if (value === '' || value === null || value === undefined || value === false) delete settings[key];
      else settings[key] = value;
    };
    const num = (v) => (v === '' ? '' : Number(v));
    setOrDrop('EncodingProfile', f('encodingProfile').value);
    setOrDrop('MultiPassEncode', f('multipass').checked);
    setOrDrop('AudioCodec', f('audioCodec').value);
    setOrDrop('AudioBitDepth', num(f('audioBitDepth').value));
    setOrDrop('AudioSampleRate', num(f('audioSampleRate').value));
    setOrDrop('ColorSpaceTag', f('colorSpace').value.trim());
    setOrDrop('GammaTag', f('gamma').value.trim());
    setOrDrop('PixelAspectRatio', f('par').value);
    setOrDrop('ExportAlpha', f('alpha').checked);
    setOrDrop('AlphaMode', f('alpha').checked ? num(f('alphaMode').value) : '');
    setOrDrop('NetworkOptimization', f('netopt').checked);
    setOrDrop('UniqueFilenameStyle', num(f('uniqueName').value));
    const { source, isUser, hasBundled, ...rest } = p; // eslint-disable-line no-unused-vars
    const out = {
      ...rest,
      name,
      label: f('label').value.trim() || undefined,
      target,
      format: f('format').value.trim(),
      codec: f('codec').value.trim() || 'auto',
      renderPreset: f('renderPreset').value || null,
      renderMode: f('renderMode').value === 'individual' ? 'individual' : 'single',
      frameRate: f('frameRate').value ? Number(f('frameRate').value) : null,
      resolution: w && h ? { width: Number(w), height: Number(h) } : null,
      settings,
      subfolder: f('subfolder').value.trim().replace(/^[\\/]+|[\\/]+$/g, ''),
      enabledByDefault: f('enabledByDefault').checked,
    };
    if (!out.label) delete out.label;
    return { out, problem };
  }

  /** The rest of what Project.SetRenderSettings() takes, folded away until wanted. */
  function moreSettingsHtml(p) {
    const s = p.settings || {};
    const sel = (name, options, current, first) =>
      `<select name="${name}">${first ? `<option value="">${escapeHtml(first)}</option>` : ''}${options
        .map((o) => {
          const [v, t] = Array.isArray(o) ? o : [o, o];
          return `<option value="${escapeHtml(String(v))}"${String(current) === String(v) ? ' selected' : ''}>${escapeHtml(String(t))}</option>`;
        })
        .join('')}</select>`;
    const codecKey = /h\.?265|hevc/i.test(p.codec) ? 'h265' : /h\.?264|avc/i.test(p.codec) ? 'h264' : null;
    const encodings = codecKey ? ENCODING_PROFILES[codecKey] : [...ENCODING_PROFILES.h264, ...ENCODING_PROFILES.h265.filter((x) => !ENCODING_PROFILES.h264.includes(x))];
    const open = Boolean(p.frameRate || s.EncodingProfile || s.ColorSpaceTag || s.GammaTag || s.ExportAlpha || s.PixelAspectRatio);
    return (
      `<details class="more"${open ? ' open' : ''}><summary>More settings: frame rate, audio, encoding, colour tags, alpha</summary><div class="grid2">` +
      `<label>Frame rate${sel('frameRate', FRAME_RATES, p.frameRate == null ? '' : String(p.frameRate), "Timeline's")}</label>` +
      `<label>Render as${sel('renderMode', [['single', 'One file'], ['individual', 'One file per clip']], p.renderMode === 'individual' ? 'individual' : 'single')}</label>` +
      `<label>Encoding profile (H.264, H.265)${sel('encodingProfile', encodings, s.EncodingProfile || '', 'Automatic')}</label>` +
      `<label>Audio codec${sel('audioCodec', AUDIO_CODECS, s.AudioCodec || '', 'Format default')}</label>` +
      `<label>Audio bit depth (Linear PCM)${sel('audioBitDepth', ['16', '24', '32'], s.AudioBitDepth ? String(s.AudioBitDepth) : '', 'Default')}</label>` +
      `<label>Audio sample rate${sel('audioSampleRate', ['44100', '48000', '96000'], s.AudioSampleRate ? String(s.AudioSampleRate) : '', 'Default')}</label>` +
      `<label>Colour space tag<input type="text" name="colorSpace" list="exportx-colorspaces" value="${escapeHtml(s.ColorSpaceTag || '')}" placeholder="Same as Project"></label>` +
      `<label>Gamma tag<input type="text" name="gamma" list="exportx-gammas" value="${escapeHtml(s.GammaTag || '')}" placeholder="Same as Project"></label>` +
      `<label>Pixel aspect${sel('par', [['square', 'Square'], ['cinemascope', 'Cinemascope'], ['16_9', '16:9 (SD)'], ['4_3', '4:3 (SD)']], s.PixelAspectRatio || '', 'Default')}</label>` +
      `<label>Alpha mode${sel('alphaMode', [['0', 'Premultiplied'], ['1', 'Straight']], s.AlphaMode == null ? '' : String(s.AlphaMode), 'Default')}</label>` +
      `<label>Numbering (one file per clip)${sel('uniqueName', [['0', 'Number first'], ['1', 'Number last']], s.UniqueFilenameStyle == null ? '' : String(s.UniqueFilenameStyle), 'Default')}</label>` +
      `<div class="switches">` +
      `<label class="switch"><input type="checkbox" name="multipass"${s.MultiPassEncode ? ' checked' : ''}><i></i><span>Multi-pass encode</span></label>` +
      `<label class="switch"><input type="checkbox" name="alpha"${s.ExportAlpha ? ' checked' : ''}><i></i><span>Export alpha</span></label>` +
      `<label class="switch"><input type="checkbox" name="netopt"${s.NetworkOptimization ? ' checked' : ''}><i></i><span>Fast start (MP4, MOV)</span></label>` +
      `</div></div>` +
      `<p class="hint">These are the parameters Resolve's render API takes; they go to the Deliver page as is. Anything the chosen format and codec do not offer is dropped with a note when the batch is queued. A key with no control here goes in the JSON file (Open JSON).</p>` +
      `</details>`
    );
  }

  function ensureDatalists() {
    if ($('exportx-colorspaces')) return;
    for (const [id, values] of [['exportx-colorspaces', COLOR_SPACES], ['exportx-gammas', GAMMAS]]) {
      const dl = document.createElement('datalist');
      dl.id = id;
      for (const v of values) dl.appendChild(option(v, v, false));
      document.body.appendChild(dl);
    }
  }

  function uniqueId(base) {
    const ids = new Set(state.profiles.map((p) => p.id));
    let id = base;
    let n = 2;
    while (ids.has(id)) id = `${base}-${n++}`;
    return id;
  }

  function renderSettingsProfiles() {
    el.settingsProfiles.innerHTML = '';
    for (const p of sortedProfiles()) {
      const target = profileTarget(p);
      const tag = TARGET_TAG[target] ? `<span class="tag ${TARGET_TAG[target][1]}">${TARGET_TAG[target][0]}</span>` : '';
      const badge = p.isUser ? (p.hasBundled ? 'edited' : 'custom') : '';
      const li = document.createElement('li');
      li.className = `deliv${state.openDelivs.has(p.id) ? ' open' : ''}`;
      li.dataset.id = p.id;
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'deliv-head';
      head.setAttribute('aria-expanded', String(state.openDelivs.has(p.id)));
      head.innerHTML =
        `<span class="deliv-name">${escapeHtml(p.name)}${tag}</span>` +
        `<span class="deliv-sum">${escapeHtml(delivSummary(p))}</span>` +
        `<span class="deliv-badge">${badge}</span>` +
        `<span class="chev">▸</span>`;
      head.addEventListener('click', () => {
        if (state.openDelivs.has(p.id)) state.openDelivs.delete(p.id);
        else state.openDelivs.add(p.id);
        renderSettingsProfiles();
      });
      li.appendChild(head);
      if (state.openDelivs.has(p.id)) li.appendChild(buildDelivForm(p));
      el.settingsProfiles.appendChild(li);
    }
  }

  async function addProfile() {
    const id = uniqueId('custom');
    try {
      const result = await api.saveProfile({
        id,
        name: 'New deliverable',
        label: 'Export',
        target: 'timeline',
        format: 'mp4',
        codec: 'H264',
        renderMode: 'single',
        settings: { ExportVideo: true, ExportAudio: true, VideoQuality: 'High' },
        subfolder: '',
        enabledByDefault: false,
      });
      state.openDelivs.add(id);
      applyProfiles(result);
      const card = el.settingsProfiles.querySelector(`[data-id="${id}"]`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const nameInput = card.querySelector('[name="name"]');
        if (nameInput) nameInput.select();
      }
    } catch (err) {
      showBanner(err.message);
    }
  }

  // ------------------------------------------------------------ step 2: preview video

  const pv = el.pv;

  function previewReady() {
    return Boolean(state.preview.status && state.preview.status.ready && state.preview.loadedFile);
  }

  function markingFromPreview() {
    return previewReady() && state.preview.source === 'preview';
  }

  function videoFps() {
    return (state.preview.status && state.preview.status.fps) || 24;
  }

  function absFrameFromVideo() {
    const st = state.preview.status;
    const t = state.preview.mediaTime != null ? state.preview.mediaTime : pv.currentTime || 0;
    const abs = st.startFrame + Math.round(t * videoFps());
    return Math.min(st.endFrame, Math.max(st.startFrame, abs));
  }

  function applyPreviewStatus(status) {
    if (!status) return;
    state.preview.status = status;
    renderPreview();
  }

  function renderPreview() {
    const st = state.preview.status;
    const rendering = st && st.rendering !== null && st.rendering !== undefined;
    const ready = Boolean(st && st.ready && st.file);
    el.viewer.classList.toggle('empty', !ready && !rendering);
    el.viewer.classList.toggle('busy', Boolean(rendering));
    el.viewer.classList.toggle('stale', Boolean(ready && st.stale));
    el.viewer.classList.toggle('vertical', Boolean(st && (st.vertical || (st.width && st.height && st.height > st.width))));
    el.viewerEmpty.classList.toggle('hidden', ready || Boolean(rendering));
    el.viewerBusy.classList.toggle('hidden', !rendering);
    if (rendering) {
      el.pvProgress.style.width = `${st.rendering}%`;
      el.pvProgressText.textContent = `Rendering preview… ${st.rendering}%`;
    }
    el.scrub.classList.toggle('hidden', !ready);
    el.transport.classList.toggle('hidden', !ready);
    if (ready && state.preview.loadedFile !== st.file) {
      state.preview.loadedFile = st.file;
      state.preview.mediaTime = null;
      pv.src = st.file;
      pv.load();
    }
    if (!ready) {
      state.preview.loadedFile = null;
      pv.removeAttribute('src');
    }
    renderScrubMarks();
    renderTransport();
    renderPlayheadRow();
  }

  function renderTransport() {
    const playing = previewReady() && !pv.paused && !pv.ended;
    el.pvPlay.querySelector('.ic-play').classList.toggle('hidden', playing);
    el.pvPlay.querySelector('.ic-pause').classList.toggle('hidden', !playing);
    el.pvOverlay.classList.toggle('hidden', !previewReady() || playing);
    el.pvMute.classList.toggle('muted', pv.muted);
    el.markSource.textContent = markingFromPreview()
      ? 'Marks come from the preview. Space plays, arrow keys step a frame.'
      : previewReady()
        ? "Marks come from Resolve's playhead."
        : '';
    el.btnMarkSource.textContent = state.preview.source === 'preview' ? 'mark from Resolve instead' : 'mark from the preview instead';
  }

  function updateVideoTime() {
    if (!previewReady()) return;
    const abs = absFrameFromVideo();
    const tc = framesToTc(abs, videoFps());
    el.pvTc.textContent = tc;
    if (pv.duration && !el.pvScrub.matches(':active')) {
      el.pvScrub.value = String(Math.round(((pv.currentTime || 0) / pv.duration) * 1000));
    }
    if (markingFromPreview()) {
      el.playhead.textContent = tc;
      if (state.press) el.keyCutLive.textContent = `IN ${state.press.tc} · ${secondsLabel(abs - state.press.absIn + 1, videoFps())}`;
    }
  }

  function startFrameLoop() {
    if (!('requestVideoFrameCallback' in pv)) return;
    const loop = (_now, meta) => {
      state.preview.mediaTime = meta.mediaTime;
      updateVideoTime();
      if (!pv.paused && !pv.ended) state.preview.rvfc = pv.requestVideoFrameCallback(loop);
    };
    state.preview.rvfc = pv.requestVideoFrameCallback(loop);
  }

  const followResolve = debounce(() => {
    if (!previewReady() || !isConnected()) return;
    api.seek(absFrameFromVideo()).catch(() => {});
  }, 300);

  function renderScrubMarks() {
    const st = state.preview.status;
    el.scrubMarks.innerHTML = '';
    if (!st || !st.ready) return;
    const total = Math.max(1, st.endFrame - st.startFrame + 1);
    for (const m of state.marks) {
      if (m.absOut < st.startFrame || m.absIn > st.endFrame) continue; // outside a ranged preview
      const i = document.createElement('i');
      i.className = m.kind;
      i.style.left = `${((m.absIn - st.startFrame) / total) * 100}%`;
      if (m.kind === 'cut') i.style.width = `${Math.max(0.3, (m.durationFrames / total) * 100)}%`;
      i.title = m.kind === 'cut' ? `Cut ${m.index}: ${m.tcIn} → ${m.tcOut}` : `Still ${m.index}: ${m.tcIn}`;
      el.scrubMarks.appendChild(i);
    }
  }

  function seekVideoTo(absFrame) {
    if (!previewReady()) return;
    const st = state.preview.status;
    pv.currentTime = Math.max(0, (absFrame - st.startFrame) / videoFps());
  }

  function togglePlay() {
    if (!previewReady()) return;
    if (pv.paused || pv.ended) pv.play().catch((err) => showBanner(`The preview could not play: ${err.message}`));
    else pv.pause();
  }

  function stepFrame(delta) {
    if (!previewReady()) return;
    pv.pause();
    pv.currentTime = Math.max(0, (pv.currentTime || 0) + delta / videoFps());
  }

  function wirePreview() {
    pv.addEventListener('loadedmetadata', () => {
      state.preview.mediaTime = 0;
      updateVideoTime();
      renderTransport();
    });
    pv.addEventListener('play', () => {
      renderTransport();
      renderPlayheadRow();
      startFrameLoop();
    });
    pv.addEventListener('pause', () => {
      renderTransport();
      renderPlayheadRow();
      updateVideoTime();
      followResolve();
    });
    pv.addEventListener('ended', () => {
      renderTransport();
      renderPlayheadRow();
    });
    pv.addEventListener('timeupdate', () => {
      if (!('requestVideoFrameCallback' in pv) || pv.paused) {
        state.preview.mediaTime = null;
        updateVideoTime();
      }
    });
    pv.addEventListener('seeked', () => {
      state.preview.mediaTime = null;
      updateVideoTime();
      if (pv.paused) followResolve();
    });
    pv.addEventListener('error', () => {
      showBanner('The preview file could not be played. Use "re-render" under the picture.', 'info');
    });
    pv.addEventListener('click', togglePlay);
    el.pvOverlay.addEventListener('click', togglePlay);
    el.pvPlay.addEventListener('click', togglePlay);
    el.pvMute.addEventListener('click', () => {
      pv.muted = !pv.muted;
      renderTransport();
    });
    el.pvScrub.addEventListener('input', () => {
      if (!pv.duration) return;
      pv.currentTime = (Number(el.pvScrub.value) / 1000) * pv.duration;
    });
    $('btn-preview-render').addEventListener('click', renderPreviewProxy);
    $('btn-preview-rerender').addEventListener('click', renderPreviewProxy);
    el.btnMarkSource.addEventListener('click', () => {
      state.preview.source = state.preview.source === 'preview' ? 'resolve' : 'preview';
      renderTransport();
      renderPlayheadRow();
    });
    api.onPreview((data) => {
      const st = state.preview.status || {};
      if (data.rendering) applyPreviewStatus({ ...st, rendering: data.percent, ready: st.ready && st.file ? true : false });
      else if (data.error) {
        applyPreviewStatus({ ...st, rendering: null });
        showBanner(`Preview: ${data.error}`);
      } else if (data.ready) applyPreviewStatus({ ...st, ...data, rendering: null });
    });
  }

  async function renderPreviewProxy() {
    if (!isConnected()) return;
    try {
      await api.previewRender();
      applyPreviewStatus({ ...(state.preview.status || {}), rendering: 0 });
    } catch (err) {
      showBanner(err.message);
    }
  }

  // ------------------------------------------------------------ step 2: playhead, pad, marks

  function renderPlayheadRow() {
    const r = state.resolvePlayhead;
    if (markingFromPreview()) {
      const st = state.preview.status;
      el.captureFps.textContent = fpsLabel(st.fps);
      const playing = !pv.paused && !pv.ended;
      el.playState.className = `play${playing ? ' on' : ''}`;
      el.playState.lastElementChild.textContent = `${playing ? 'preview playing' : 'preview paused'}${r && r.ok ? ` · Resolve at ${r.tc}` : ''}`;
      updateVideoTime();
      return;
    }
    if (!r || !r.ok) {
      el.playhead.textContent = '--:--:--:--';
      el.playState.className = 'play';
      el.playState.lastElementChild.textContent = 'stopped';
      el.captureFps.textContent = r && r.error ? 'open a timeline in Resolve' : '';
      return;
    }
    el.playhead.textContent = r.tc;
    el.playState.className = `play${r.playing ? ' on' : ''}`;
    el.playState.lastElementChild.textContent = r.playing ? 'playing in Resolve' : 'stopped';
    el.captureFps.textContent = fpsLabel(r.fps);
    if (r.info && r.info.inOut !== undefined && !(state.plan && state.plan.timelines && state.plan.timelines[r.timeline])) renderRangeRow();
    if (state.press) el.keyCutLive.textContent = `IN ${state.press.tc} · ${secondsLabel(r.absFrame - state.press.absIn + 1, r.fps)}`;
  }

  function onResolvePlayhead(data) {
    state.resolvePlayhead = data;
    renderPlayheadRow();
  }

  function applyMarks(result) {
    if (!result) return;
    state.marks = result.marks || [];
    renderMarks();
    renderScrubMarks();
    updateButtons();
    schedulePlan();
  }

  function markRow(m) {
    const li = document.createElement('li');
    li.className = `mark ${m.kind}`;
    li.title = 'Click to go there';
    const range = m.kind === 'cut' ? `${m.tcIn} <span>→</span> ${m.tcOut}<em>${escapeHtml(m.duration)}</em>` : m.tcIn;
    li.innerHTML =
      `<span class="no">${pad2(m.index)}</span>` +
      `<span class="range">${range}</span>` +
      `<button class="del" title="Remove" aria-label="Remove this mark">×</button>`;
    li.addEventListener('click', () => {
      if (previewReady()) {
        pv.pause();
        seekVideoTo(m.absIn);
      }
      api.seek(m.absIn).catch((e) => showBanner(e.message));
    });
    li.querySelector('.del').addEventListener('click', (e) => {
      e.stopPropagation();
      api.markDelete(m.relIn).then(applyMarks).catch((err) => showBanner(err.message));
    });
    return li;
  }

  function renderMarks() {
    const cuts = state.marks.filter((m) => m.kind === 'cut');
    const stills = state.marks.filter((m) => m.kind === 'still');
    el.cutsCount.textContent = String(cuts.length);
    el.stillsCount.textContent = String(stills.length);
    el.cuts.innerHTML = '';
    el.stills.innerHTML = '';
    if (!cuts.length) el.cuts.innerHTML = `<li class="none">None yet. Hold ${escapeHtml(keyName(state.keys.cut))} while it plays.</li>`;
    else for (const m of cuts) el.cuts.appendChild(markRow(m));
    if (!stills.length) el.stills.innerHTML = `<li class="none">None yet. Press ${escapeHtml(keyName(state.keys.still))} on a frame.</li>`;
    else for (const m of stills) el.stills.appendChild(markRow(m));
    const warn = [];
    if (cuts.length && !countIncluded('cuts')) warn.push('Tick a "per cut" deliverable under What to export to export the cuts.');
    if (stills.length && !countIncluded('stills')) warn.push('Tick a "per still" deliverable under What to export to export the stills.');
    el.captureHint.className = `hint${warn.length ? ' warn' : ''}`;
    el.captureHint.textContent = warn.length
      ? warn.join(' ')
      : `Hold ${keyName(state.keys.cut)} while it plays to select a cut, press ${keyName(state.keys.still)} for a still. Keys work while this window is focused. Marks are saved as timeline markers, so you can see and delete them in Resolve too.`;
  }

  // ------------------------------------------------------------ keys: hold cut, press still

  function keyName(key) {
    const k = String(key || '');
    if (k === ' ') return 'Space';
    if (k.length === 1) return k.toUpperCase();
    return k.replace(/^arrow/, '').replace(/^./, (ch) => ch.toUpperCase());
  }

  function renderKeys() {
    el.kbdCut.textContent = keyName(state.keys.cut);
    el.kbdStill.textContent = keyName(state.keys.still);
    el.pickCut.querySelector('kbd').textContent = state.picking === 'cut' ? 'press a key…' : keyName(state.keys.cut);
    el.pickStill.querySelector('kbd').textContent = state.picking === 'still' ? 'press a key…' : keyName(state.keys.still);
    el.pickCut.classList.toggle('picking', state.picking === 'cut');
    el.pickStill.classList.toggle('picking', state.picking === 'still');
    el.keyCut.setAttribute('aria-label', `Hold ${keyName(state.keys.cut)} to mark a cut`);
    el.keyStill.setAttribute('aria-label', `Press ${keyName(state.keys.still)} to mark a still`);
  }

  function normalizeKey(e) {
    return e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  }

  const RESERVED_KEYS = new Set([' ', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'escape', 'enter', 'tab', 'shift', 'control', 'alt', 'meta', 'capslock']);

  function startPicking(which) {
    state.picking = state.picking === which ? null : which;
    renderKeys();
  }

  function finishPicking(e) {
    const key = normalizeKey(e);
    if (key === 'escape') {
      state.picking = null;
      renderKeys();
      return;
    }
    if (RESERVED_KEYS.has(key) || e.metaKey || e.ctrlKey || e.altKey) {
      el.keysHint.textContent = 'That key is reserved. Pick a letter, digit or function key.';
      return;
    }
    const other = state.picking === 'cut' ? state.keys.still : state.keys.cut;
    if (key === other) {
      el.keysHint.textContent = 'The cut and still keys have to differ.';
      return;
    }
    state.keys[state.picking] = key;
    state.picking = null;
    el.keysHint.textContent = 'Click a key to change it, then press the new one. Keys work while the ExportX window is focused.';
    api.saveSettings({ keyCut: state.keys.cut, keyStill: state.keys.still }).catch(() => {});
    renderKeys();
    renderMarks();
  }

  function flashKey(kind) {
    const btn = kind === 'still' ? el.keyStill : el.keyCut;
    btn.classList.add('flash');
    setTimeout(() => btn.classList.remove('flash'), 220);
  }

  function pressAt() {
    return markingFromPreview() ? { absFrame: absFrameFromVideo(), source: 'preview' } : {};
  }

  async function beginPress() {
    if (state.pressing || !isConnected()) return;
    state.pressing = true;
    el.keyCut.classList.add('holding');
    el.keyCutLive.textContent = '…';
    state.pressPromise = api.markBegin(pressAt());
    try {
      state.press = await state.pressPromise;
      el.keyCutLive.textContent = `IN ${state.press.tc}`;
    } catch (err) {
      state.press = null;
      state.pressing = false;
      el.keyCut.classList.remove('holding');
      el.keyCutLive.textContent = CUT_SUB;
      showBanner(err.message);
    }
  }

  async function endPress() {
    if (!state.pressing) return;
    state.pressing = false;
    if (state.pressPromise) await state.pressPromise.catch(() => {});
    const had = state.press;
    const at = { ...pressAt(), kind: 'cut' };
    state.press = null;
    el.keyCut.classList.remove('holding');
    el.keyCutLive.textContent = CUT_SUB;
    if (!had) return;
    try {
      const result = await api.markEnd(at);
      applyMarks(result);
      if (result.added) {
        flashKey('cut');
        showBanner(null);
      }
    } catch (err) {
      showBanner(err.message);
    }
  }

  async function markStill() {
    if (!isConnected()) return;
    try {
      const result = await api.markStill(pressAt());
      applyMarks(result);
      if (result.added) {
        flashKey('still');
        showBanner(null);
      }
    } catch (err) {
      showBanner(err.message);
    }
  }

  function isTyping(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  function wireCapture() {
    // The keycaps mirror the keyboard: they light on key-down and go dark on key-up, and take no clicks.
    el.pickCut.addEventListener('click', () => startPicking('cut'));
    el.pickStill.addEventListener('click', () => startPicking('still'));

    document.addEventListener('keydown', (e) => {
      if (state.picking) {
        e.preventDefault();
        if (!e.repeat) finishPicking(e);
        return;
      }
      if (isTyping(e) || state.view !== 'export' || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = normalizeKey(e);
      if (key === state.keys.cut) {
        e.preventDefault();
        if (!e.repeat) beginPress();
      } else if (key === state.keys.still) {
        e.preventDefault();
        el.keyStill.classList.add('down');
        if (!e.repeat) markStill();
      } else if (key === ' ') {
        e.preventDefault();
        if (!e.repeat && previewReady()) togglePlay();
      } else if (key === 'arrowleft' || key === 'arrowright') {
        if (previewReady()) {
          e.preventDefault();
          stepFrame(key === 'arrowleft' ? -1 : 1);
        }
      }
    });
    document.addEventListener('keyup', (e) => {
      if (normalizeKey(e) === state.keys.still) el.keyStill.classList.remove('down');
      if (isTyping(e) || state.view !== 'export') return;
      if (normalizeKey(e) === state.keys.cut) {
        e.preventDefault();
        endPress();
      }
    });
    window.addEventListener('blur', () => {
      el.keyStill.classList.remove('down');
      if (state.pressing) endPress();
      if (state.picking) {
        state.picking = null;
        renderKeys();
      }
    });
    $('btn-clear-cuts').addEventListener('click', () => confirmClear('cut'));
    $('btn-clear-stills').addEventListener('click', () => confirmClear('still'));
    api.onPlayhead(onResolvePlayhead);
    api.onMarks(applyMarks);
  }

  const clearArmed = { cut: null, still: null };
  function confirmClear(kind) {
    const btn = kind === 'cut' ? $('btn-clear-cuts') : $('btn-clear-stills');
    if (!state.marks.some((m) => m.kind === kind)) return;
    if (clearArmed[kind]) {
      clearTimeout(clearArmed[kind]);
      clearArmed[kind] = null;
      btn.textContent = 'clear';
      api.marksClear(kind).then(applyMarks).catch((e) => showBanner(e.message));
      return;
    }
    btn.textContent = 'click again to remove all';
    clearArmed[kind] = setTimeout(() => {
      clearArmed[kind] = null;
      btn.textContent = 'clear';
    }, 4000);
  }

  // ------------------------------------------------------------ step 3: export

  const schedulePlan = debounce(async () => {
    const req = currentRequest(false);
    if (!isConnected() || !req.profileIds.length) {
      state.plan = { items: [], notes: [] };
      el.exportSummary.textContent = req.profileIds.length ? '' : 'Tick at least one deliverable under What to export.';
      updateButtons();
      return;
    }
    try {
      state.plan = await api.plan(req);
    } catch (err) {
      state.plan = { items: [], notes: [] };
      el.exportSummary.textContent = err.message;
      updateButtons();
      return;
    }
    const { items, notes } = state.plan;
    const finals = items.filter((i) => i.kind === 'final').length;
    const cuts = items.filter((i) => i.kind === 'cut').length;
    const stills = items.filter((i) => i.kind === 'still').length;
    const parts = [];
    if (finals) parts.push(plural(finals, 'final export'));
    if (cuts) parts.push(plural(cuts, 'cut'));
    if (stills) parts.push(plural(stills, 'still'));
    const where = req.targetDir ? ` → ${slash(req.targetDir)}` : ' → choose a folder under Save to';
    const noteText = notes.map((n) => n.message.replace(/ on ".*"( left out)?$/, '$1')).filter((v, i, a) => a.indexOf(v) === i);
    const total = sumEstimates(items);
    const sizeText = EST && total.bytes ? ` · ${total.exact ? '' : '≈ '}${EST.formatBytes(total.bytes)}` : '';
    el.exportSummary.textContent = (parts.length ? parts.join(' · ') + sizeText + where : 'Nothing to export yet.') + (noteText.length ? ` · ${noteText.join(' · ')}` : '');
    renderProfiles();
    renderRangeRow();
    updateButtons();
  }, 150);

  function renderJobs() {
    el.jobs.innerHTML = '';
    for (const job of state.jobs) {
      const st = state.statuses.get(job.jobId) || { status: 'ready', percent: 0 };
      const up = state.upload.files.get(job.jobId);
      const li = document.createElement('li');
      li.className = `file ${st.status}${up ? ` up-${up.state}` : ''}`;
      const where = job.mark ? `<small>${escapeHtml(job.mark.tcIn)}${job.kind === 'cut' ? ` → ${escapeHtml(job.mark.tcOut)}` : ''}</small>` : '';
      let stateText = st.status === 'complete' ? 'done' : st.status === 'rendering' ? `${st.percent}%` : st.status === 'ready' ? 'waiting' : st.status;
      if (up && up.state === 'uploading') stateText = `uploading ${up.percent}%`;
      else if (up && up.state === 'uploaded') stateText = up.box ? `in ${up.box}` : 'on the portal';
      else if (up && up.state === 'failed') stateText = 'upload failed';
      else if (up && up.state === 'queued') stateText = 'to upload';
      const error = st.error || (up && up.error) || '';
      li.innerHTML =
        `<i class="st"></i>` +
        `<span class="fn" title="${escapeHtml(slash(job.targetDir))}/${escapeHtml(job.fileName)}">${escapeHtml(job.fileName)}${where}${estHtml(job.estimate)}</span>` +
        `<span class="state">${escapeHtml(stateText)}</span>` +
        (error ? `<span class="err">${escapeHtml(error)}</span>` : '');
      el.jobs.appendChild(li);
    }
  }

  function renderTotal(summary) {
    if (!summary || !summary.total) {
      el.progressFill.style.width = '0%';
      el.progressLine.className = 'progress-line';
      el.progress.className = `progress${state.jobs.length ? '' : ' hidden'}`;
      el.totalFill.style.width = '0%';
      el.totalText.textContent = state.jobs.length ? `${plural(state.jobs.length, 'file')} queued in Resolve` : '';
      return;
    }
    const cls = summary.done ? (summary.failed ? ' bad' : ' done') : '';
    el.progressFill.style.width = `${summary.percent}%`;
    el.progressLine.className = `progress-line${cls}`;
    el.progress.className = `progress${cls}`;
    el.totalFill.style.width = `${summary.percent}%`;
    const doneN = summary.complete + summary.failed + summary.cancelled;
    el.totalText.textContent = summary.done
      ? summary.failed
        ? `Finished · ${plural(summary.failed, 'file')} failed`
        : `All ${summary.total} done`
      : `${summary.percent}% · ${doneN} of ${summary.total} done`;
  }

  async function queue(startRender, targets) {
    const req = currentRequest(startRender, targets);
    if (!req.profileIds.length) return showBanner('Tick at least one deliverable under What to export.');
    if (!req.targetDir) return showBanner('Choose where to save first (Save to).');
    showBanner(null);
    setBusy(true);
    try {
      const { jobs, errors, notes, warnings, rendering } = await api.queue(req);
      state.jobs = jobs;
      state.statuses = new Map();
      state.rendering = rendering;
      state.lastSummary = null;
      resetUpload();
      renderJobs();
      renderTotal(null);
      renderPortalControls();
      if (errors.length) {
        showBanner(`${errors.length} file(s) could not be queued: ${errors.map((e) => `${e.profileName} (${e.message})`).join('; ')}`);
      } else if (!jobs.length) {
        showBanner(notes.length ? notes.map((n) => n.message).join(' · ') : 'Nothing was queued.', 'info');
      } else if (warnings && warnings.length) {
        showBanner(`${warnings.map((w) => w.message).filter((v, i, a) => a.indexOf(v) === i).join(' · ')}. Everything else is queued as set.`, 'info');
      }
      if (jobs.length) el.progress.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      showBanner(err.message);
    } finally {
      setBusy(false);
    }
    return undefined;
  }

  async function stop() {
    try {
      await api.stop();
    } catch (err) {
      showBanner(err.message);
    }
  }

  // ------------------------------------------------------------ portal: upload finished files

  function portalConfigured() {
    return Boolean(state.portal.url);
  }

  function portalName() {
    return state.portal.name || 'the portal';
  }

  function uploadWanted() {
    return portalConfigured() && el.optUpload.checked;
  }

  function selectedProject() {
    return state.portal.projects.find((p) => p.id === state.portal.projectId) || null;
  }

  function projectOptionText(p) {
    return [p.name, p.jobNumber, p.client].filter(Boolean).join(' · ');
  }

  function normName(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  /**
   * Which portal project this batch goes in, before the editor says: the one
   * chosen last time for this Resolve project, else the one whose name matches
   * it, else none (and the Export button waits).
   */
  function pickDefaultProject() {
    const list = state.portal.projects;
    if (state.portal.projectId && list.some((p) => p.id === state.portal.projectId)) return;
    const resolveProject = (state.status && state.status.project) || '';
    const remembered = resolveProject ? state.portal.byResolve[resolveProject] : null;
    if (remembered && list.some((p) => p.id === remembered)) {
      state.portal.projectId = remembered;
      return;
    }
    const key = normName(resolveProject);
    const match = key ? list.find((p) => normName(p.name) === key) || list.find((p) => normName(p.name).includes(key) || key.includes(normName(p.name))) : null;
    state.portal.projectId = match ? match.id : '';
  }

  function rememberProject() {
    const resolveProject = state.status && state.status.project;
    if (!resolveProject || !state.portal.projectId) return;
    state.portal.byResolve = { ...state.portal.byResolve, [resolveProject]: state.portal.projectId };
    api.saveSettings({ portalProjectByResolve: state.portal.byResolve }).catch(() => {});
  }

  function renderProjectPicker() {
    const sel = el.portalProject;
    sel.innerHTML = '';
    const list = state.portal.projects;
    if (state.portal.loading && !list.length) sel.appendChild(option('', 'Loading projects…', true));
    else if (!list.length) sel.appendChild(option('', state.portal.loadError ? `Could not load: ${state.portal.loadError}` : 'No projects loaded · refresh', true));
    else sel.appendChild(option('', 'Choose a project…', !state.portal.projectId));
    for (const p of list) sel.appendChild(option(p.id, projectOptionText(p), p.id === state.portal.projectId));
    sel.disabled = state.portal.loading && !list.length;
    el.btnPortalRefresh.disabled = state.portal.loading;
    el.btnPortalRefresh.classList.toggle('busy', state.portal.loading);
  }

  async function loadPortalProjects() {
    if (!portalConfigured() || !state.portal.tokenSet || state.portal.loading) return;
    state.portal.loading = true;
    state.portal.loadError = '';
    renderProjectPicker();
    try {
      state.portal.projects = await api.portalProjects();
      pickDefaultProject();
    } catch (err) {
      state.portal.loadError = err.message;
    } finally {
      state.portal.loading = false;
      renderProjectPicker();
      updateButtons();
    }
  }

  function resetUpload() {
    state.upload = { running: false, files: new Map(), result: null, error: null, total: 0, percentTotal: 0 };
  }

  function uploadedCount() {
    let n = 0;
    for (const f of state.upload.files.values()) if (f.state === 'uploaded') n += 1;
    return n;
  }

  function renderPortalControls() {
    const on = portalConfigured();
    el.uploadSwitch.classList.toggle('hidden', !on);
    el.uploadSwitch.querySelector('span').textContent = `Upload to ${portalName()} when done`;
    el.portalProjectRow.classList.toggle('hidden', !uploadWanted());
    renderProjectPicker();
    const up = state.upload;
    const finished = Boolean(state.lastSummary && state.lastSummary.done && state.lastSummary.complete > 0);
    const show = on && (up.running || up.result || up.error || finished);
    el.upload.classList.toggle('hidden', !show);
    if (!show) return;
    const pct = up.running ? up.percentTotal : up.result ? 100 : 0;
    el.uploadFill.style.width = `${pct}%`;
    el.upload.classList.toggle('done', Boolean(up.result && !up.result.failed.length));
    el.upload.classList.toggle('bad', Boolean(up.error || (up.result && up.result.failed.length)));
    el.btnUpload.disabled = up.running || state.rendering;
    const target = selectedProject();
    el.btnUpload.textContent = up.running ? 'Uploading…' : up.result || up.error ? 'Upload again' : target ? `Upload to ${target.name}` : 'Upload';
    el.btnUploadOpen.classList.toggle('hidden', !(up.result && up.result.url));
    const where = up.project ? up.project.name : target ? target.name : portalName();
    let text;
    if (up.running) text = `Uploading to ${where} · ${pct}% · ${uploadedCount()} of ${up.total} sent`;
    else if (up.error) text = `Upload failed: ${up.error}`;
    else if (up.result && up.result.failed.length) text = `${up.result.uploaded.length} of ${up.total} in ${where}, ${plural(up.result.failed.length, 'file')} failed`;
    else if (up.result) text = `All ${plural(up.total, 'file')} in ${where} on ${portalName()}. Check the boxes there, then send the final delivery.`;
    else if (!target) text = 'Pick the portal project above, then upload the finished files.';
    else text = `Finished files are ready to go into ${where} on ${portalName()}.`;
    el.uploadText.textContent = text;
  }

  function onUploadEvent(ev) {
    const up = state.upload;
    if (ev.phase === 'start') {
      resetUpload();
      state.upload.running = true;
      state.upload.total = ev.files.length;
      state.upload.project = ev.project || null;
      state.upload.files = new Map(ev.files.map((f) => [f.jobId, { key: f.key, state: 'queued', percent: 0, error: null }]));
      showBanner(null);
    } else if (ev.phase === 'file') {
      up.files.set(ev.jobId, { key: ev.key, state: ev.state, percent: ev.percent, error: ev.error || null, box: ev.box || null });
      up.percentTotal = ev.percentTotal || 0;
    } else if (ev.phase === 'done') {
      up.running = false;
      if (ev.project) up.project = ev.project;
      up.result = { batchId: ev.batchId, url: ev.url || null, uploaded: ev.uploaded || [], failed: ev.failed || [] };
    } else if (ev.phase === 'error') {
      up.running = false;
      up.error = ev.error;
    }
    renderJobs();
    renderPortalControls();
  }

  async function uploadNow() {
    if (!state.portal.projectId) {
      state.upload.error = 'Pick the portal project the files go in first.';
      renderPortalControls();
      el.portalProject.focus();
      return;
    }
    el.btnUpload.disabled = true;
    try {
      await api.portalUpload({ projectId: state.portal.projectId });
      rememberProject();
    } catch (err) {
      state.upload.error = err.message;
      renderPortalControls();
    }
  }

  function tokenPlaceholder() {
    return state.portal.tokenSet ? 'Saved · paste a new one to replace it' : 'Paste the key from Settings › ExportX on the portal';
  }

  function setPortalResult(text, kind) {
    el.portalResult.textContent = text || '';
    el.portalResult.className = `portal-result${kind ? ` ${kind}` : ''}`;
  }

  async function testPortal() {
    const url = el.portalUrl.value.trim();
    if (!url) return setPortalResult('Enter the portal URL first.', 'bad');
    const typed = el.portalToken.value.trim();
    setPortalResult('Connecting…', '');
    el.btnPortalTest.disabled = true;
    try {
      const res = await api.portalTest({ portalUrl: url, token: typed || undefined });
      state.portal.url = url;
      state.portal.name = res.portal || '';
      state.portal.projects = Array.isArray(res.projects) ? res.projects : state.portal.projects;
      state.portal.loadError = '';
      if (typed) {
        await api.saveSettings({ portalUrl: url, portalToken: typed });
        state.portal.tokenSet = true;
        el.portalToken.value = '';
      } else {
        await api.saveSettings({ portalUrl: url });
      }
      el.portalToken.placeholder = tokenPlaceholder();
      pickDefaultProject();
      const keyLabel = res.key && res.key.label ? ` · key "${res.key.label}"` : '';
      setPortalResult(`Connected to ${res.portal || url} · ${plural(state.portal.projects.length, 'project')}${keyLabel}`, 'ok');
      renderPortalControls();
      updateButtons();
    } catch (err) {
      setPortalResult(err.message, 'bad');
    } finally {
      el.btnPortalTest.disabled = false;
    }
    return undefined;
  }

  function wirePortal() {
    el.optUpload.addEventListener('change', () => {
      el.optPortalAuto.checked = el.optUpload.checked;
      api.saveSettings({ portalAuto: el.optUpload.checked }).catch(() => {});
      renderPortalControls();
      updateButtons();
      if (el.optUpload.checked && !state.portal.projects.length) loadPortalProjects();
    });
    el.optPortalAuto.addEventListener('change', () => {
      el.optUpload.checked = el.optPortalAuto.checked;
      api.saveSettings({ portalAuto: el.optPortalAuto.checked }).catch(() => {});
      renderPortalControls();
      updateButtons();
    });
    el.portalProject.addEventListener('change', () => {
      state.portal.projectId = el.portalProject.value;
      rememberProject();
      renderPortalControls();
      updateButtons();
    });
    el.btnPortalRefresh.addEventListener('click', () => loadPortalProjects());
    el.btnUpload.addEventListener('click', uploadNow);
    el.btnUploadOpen.addEventListener('click', () => {
      if (state.upload.result && state.upload.result.url) api.openUrl(state.upload.result.url).catch((e) => showBanner(e.message));
    });
    el.portalUrl.addEventListener('change', () => {
      state.portal.url = el.portalUrl.value.trim();
      if (!state.portal.url) {
        state.portal.name = '';
        setPortalResult('', '');
      }
      api.saveSettings({ portalUrl: state.portal.url }).catch(() => {});
      renderPortalControls();
    });
    el.portalToken.addEventListener('change', async () => {
      const t = el.portalToken.value.trim();
      if (!t) return;
      try {
        const s = await api.saveSettings({ portalToken: t });
        state.portal.tokenSet = Boolean(s.portalTokenSet);
        el.portalToken.value = '';
        el.portalToken.placeholder = tokenPlaceholder();
        setPortalResult('Token saved. Test the connection when you like.', '');
      } catch (err) {
        setPortalResult(err.message, 'bad');
      }
    });
    el.btnPortalTest.addEventListener('click', testPortal);
    api.onUpload(onUploadEvent);
  }

  // ------------------------------------------------------------ wiring

  function wire() {
    el.tabExport.addEventListener('click', () => switchView('export'));
    el.tabSettings.addEventListener('click', () => switchView('settings'));
    $('btn-refresh').addEventListener('click', () => {
      state.caps = null;
      state.capsPromise = null;
      refreshStatus();
    });
    $('btn-browse').addEventListener('click', async () => {
      const dir = await api.pickFolder(el.targetDir.value.trim()).catch((e) => showBanner(e.message));
      if (dir) {
        el.targetDir.value = dir;
        api.saveSettings({ targetDir: dir }).catch(() => {});
        updateButtons();
        schedulePlan();
      }
    });
    el.targetDir.addEventListener('input', () => {
      updateButtons();
      schedulePlan();
    });
    el.targetDir.addEventListener('change', () => api.saveSettings({ targetDir: el.targetDir.value.trim() }).catch(() => {}));
    $('btn-open-out').addEventListener('click', () => {
      const dir = el.targetDir.value.trim();
      if (dir) api.openFolder(dir).catch((e) => showBanner(e.message));
    });
    el.btnGo.addEventListener('click', () => queue(el.optStart.checked));
    el.btnStop.addEventListener('click', stop);
    el.btnExportCuts.addEventListener('click', () => queue(el.optStart.checked, ['cuts']));
    el.btnExportStills.addEventListener('click', () => queue(el.optStart.checked, ['stills']));
    el.timelinePick.addEventListener('change', () => switchTimeline(el.timelinePick.value));
    el.optInOut.addEventListener('change', () => {
      api.saveSettings({ useInOut: el.optInOut.checked }).catch(() => {});
      renderRangeRow();
      schedulePlan();
      if (isConnected()) api.previewStatus().then(applyPreviewStatus).catch(() => {});
    });
    // settings
    el.nameTemplate.addEventListener('input', () => {
      renderNameExamples();
      schedulePlan();
    });
    el.nameTemplate.addEventListener('change', () => api.saveSettings({ nameTemplate: el.nameTemplate.value.trim() || DEFAULT_TEMPLATE }).catch(() => {}));
    el.optUnderscore.addEventListener('change', () => {
      api.saveSettings({ underscoreSpaces: el.optUnderscore.checked }).then(() => schedulePlan()).catch(() => {});
      renderNameExamples();
    });
    $('btn-add-profile').addEventListener('click', addProfile);
    $('btn-reload-profiles').addEventListener('click', () => loadProfiles({ selectedProfiles: includedIds() }));
    $('btn-profiles-folder').addEventListener('click', () => api.openProfilesFolder().catch((e) => showBanner(e.message)));
    $('btn-caps').addEventListener('click', () => api.capabilities().catch((e) => showBanner(e.message)));
    el.optStart.addEventListener('change', () => {
      api.saveSettings({ startRender: el.optStart.checked }).catch(() => {});
      updateButtons();
    });
    el.optClear.addEventListener('change', () => api.saveSettings({ clearExisting: el.optClear.checked }).catch(() => {}));
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !el.btnGo.disabled && !state.rendering) queue(el.optStart.checked);
    });
    wireCapture();
    wirePreview();
    wirePortal();

    api.onLog(appendLog);
    api.onProgress(({ statuses, summary }) => {
      for (const s of statuses) state.statuses.set(s.jobId, s);
      state.rendering = !summary.done;
      renderJobs();
      renderTotal(summary);
      updateButtons();
    });
    api.onDone((result) => {
      state.rendering = false;
      if (result && result.statuses) for (const s of result.statuses) state.statuses.set(s.jobId, s);
      state.lastSummary = result ? result.summary : null;
      renderJobs();
      renderTotal(result ? result.summary : null);
      renderPortalControls();
      updateButtons();
      if (result && result.error) showBanner(result.error);
      refreshStatus();
    });
  }

  async function init() {
    renderTokens();
    wire();
    const settings = await api.getSettings().catch(() => ({}));
    state.settings = settings;
    if (settings.targetDir) el.targetDir.value = settings.targetDir;
    el.nameTemplate.value = settings.nameTemplate || DEFAULT_TEMPLATE;
    el.optUnderscore.checked = settings.underscoreSpaces !== false;
    el.optClear.checked = Boolean(settings.clearExisting);
    el.optStart.checked = settings.startRender !== false;
    el.optInOut.checked = settings.useInOut !== false;
    ensureDatalists();
    state.keys = { cut: String(settings.keyCut || 'c').toLowerCase(), still: String(settings.keyStill || 's').toLowerCase() };
    renderKeys();
    state.portal = {
      url: String(settings.portalUrl || '').trim(),
      tokenSet: Boolean(settings.portalTokenSet),
      name: settings.portalName || '',
      projects: Array.isArray(settings.portalProjects) ? settings.portalProjects : [],
      projectId: '',
      byResolve: settings.portalProjectByResolve && typeof settings.portalProjectByResolve === 'object' ? settings.portalProjectByResolve : {},
      loading: false,
      loadError: '',
    };
    el.portalUrl.value = state.portal.url;
    el.portalToken.placeholder = tokenPlaceholder();
    el.optPortalAuto.checked = Boolean(settings.portalAuto);
    el.optUpload.checked = Boolean(settings.portalAuto);
    renderPortalControls();
    const history = await api.logHistory().catch(() => []);
    el.log.textContent = history.join('\n');
    renderMarks();
    renderPreview();
    await loadProfiles(settings);
    await refreshStatus();
    // A fresh project list for the picker, in the background; the saved one shows meanwhile.
    if (uploadWanted()) loadPortalProjects();
  }

  init().catch((err) => showBanner(`ExportX failed to start: ${err.message}`));
})();
