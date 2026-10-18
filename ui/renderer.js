/* global window, document */
'use strict';

(function main() {
  const api = window.exportx;
  const $ = (id) => document.getElementById(id);

  const el = {
    crumbProject: $('crumb-project'),
    crumbTimeline: $('crumb-timeline'),
    connDot: $('conn-dot'),
    connText: $('conn-text'),
    banner: $('banner'),
    progressLine: $('progress-line'),
    progressFill: $('progress-fill'),
    timelines: $('timelines'),
    navHint: $('nav-hint'),
    profiles: $('profiles'),
    profilesCount: $('profiles-count'),
    userDir: $('user-dir'),
    captureTl: $('capture-tl'),
    playState: $('play-state'),
    playhead: $('playhead'),
    pad: $('pad'),
    padLive: $('pad-live'),
    cuts: $('cuts'),
    stills: $('stills'),
    cutsCount: $('cuts-count'),
    stillsCount: $('stills-count'),
    captureHint: $('capture-hint'),
    btnExportCuts: $('btn-export-cuts'),
    btnExportStills: $('btn-export-stills'),
    targetDir: $('target-dir'),
    nameTemplate: $('name-template'),
    tokens: $('tokens'),
    optClear: $('opt-clear'),
    optStart: $('opt-start'),
    preview: $('preview'),
    previewCount: $('preview-count'),
    previewSummary: $('preview-summary'),
    btnGo: $('btn-go'),
    btnQueue: $('btn-queue'),
    btnStop: $('btn-stop'),
    jobs: $('jobs'),
    jobsEmpty: $('jobs-empty'),
    totalPct: $('total-pct'),
    totalText: $('total-text'),
    inspectorBody: $('inspector-body'),
    inspectorKind: $('inspector-kind'),
    drawer: $('drawer'),
    log: $('log'),
    logLast: $('log-last'),
  };

  const TOKENS = ['{project}', '{timeline}', '{profile}', '{date}', '{time}', '{width}', '{height}', '{cut}', '{still}', '{tc}'];
  const CHECK = '<svg viewBox="0 0 16 16"><path d="M3 8.5l3 3 7-7"/></svg>';
  const FOLDER = '<svg viewBox="0 0 16 16"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/></svg>';
  const TARGET_LABEL = { timeline: 'Whole timeline', cuts: 'Each cut', stills: 'Each still' };
  const GROUP_LABEL = { timeline: 'Final exports', cuts: 'Per cut', stills: 'Per still' };
  const HANDLED_SETTINGS = new Set([
    'TargetDir', 'CustomName', 'FormatWidth', 'FormatHeight', 'FrameRate', 'SelectAllFrames', 'MarkIn', 'MarkOut',
    'ExportVideo', 'ExportAudio', 'AudioCodec', 'AudioBitDepth', 'AudioSampleRate', 'VideoQuality', 'EncodingProfile',
    'MultiPassEncode', 'NetworkOptimization', 'ExportAlpha', 'ColorSpaceTag', 'GammaTag',
  ]);

  const state = {
    status: null,
    profiles: [],
    included: new Set(),
    selectedId: null,
    timelinesPicked: new Set(),
    planItems: [],
    jobs: [],
    statuses: new Map(),
    rendering: false,
    busy: false,
    playhead: null,
    marks: [],
    marksInfo: null,
    pressing: false,
    press: null,
    pressPromise: null,
  };

  // ------------------------------------------------------------ utilities

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function appendLog(line) {
    el.log.textContent += (el.log.textContent ? '\n' : '') + line;
    el.log.scrollTop = el.log.scrollHeight;
    el.logLast.textContent = line.replace(/^\[[^\]]*\]\s*/, '');
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

  function fpsLabel(fps) {
    if (!fps) return '';
    const r = Math.round(fps * 1000) / 1000;
    return `${Number.isInteger(r) ? r : r.toFixed(3).replace(/0+$/, '')} fps`;
  }

  function secondsLabel(frames, fps) {
    const s = Math.max(0, frames) / (fps || 24);
    return s >= 60 ? `${Math.floor(s / 60)}m ${(s % 60).toFixed(1)}s` : `${s.toFixed(1)}s`;
  }

  function isConnected() {
    return Boolean(state.status && state.status.connected && !state.status.error);
  }

  function includedIds() {
    return state.profiles.filter((p) => state.included.has(p.id)).map((p) => p.id);
  }

  function profileTarget(p) {
    return TARGET_LABEL[p.target] ? p.target : 'timeline';
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
      nameTemplate: el.nameTemplate.value.trim() || '{timeline}_{profile}',
      timelines: pickedTimelines(),
      clearExisting: el.optClear.checked,
      startRender: Boolean(startRender),
    };
  }

  function setBusy(busy) {
    state.busy = busy;
    updateButtons();
  }

  function countIncluded(target) {
    return state.profiles.filter((p) => state.included.has(p.id) && profileTarget(p) === target).length;
  }

  function updateButtons() {
    const ready = isConnected() && el.targetDir.value.trim().length > 0 && !state.busy && !state.rendering;
    const can = ready && state.included.size > 0;
    el.btnGo.disabled = !can;
    el.btnQueue.disabled = !can;
    el.btnStop.classList.toggle('hidden', !state.rendering);
    el.btnGo.classList.toggle('hidden', state.rendering);
    el.btnQueue.classList.toggle('hidden', state.rendering);
    const cuts = state.marks.filter((m) => m.kind === 'cut').length;
    const stills = state.marks.filter((m) => m.kind === 'still').length;
    el.btnExportCuts.disabled = !(ready && cuts > 0 && countIncluded('cuts') > 0);
    el.btnExportStills.disabled = !(ready && stills > 0 && countIncluded('stills') > 0);
    el.pad.disabled = !isConnected();
  }

  // ------------------------------------------------------------ status, crumbs, navigator

  async function refreshStatus() {
    try {
      state.status = await api.status();
    } catch (err) {
      state.status = { connected: false, error: err.message };
    }
    const s = state.status;
    if (s.userDir) {
      el.userDir.textContent = `${slash(s.userDir)}/profiles/`;
      el.userDir.title = el.userDir.textContent;
    }
    if (!s.connected) {
      el.connDot.className = 'dot bad';
      el.connText.textContent = 'Not connected';
      showBanner(s.error || 'Not connected to DaVinci Resolve.');
    } else if (s.error) {
      el.connDot.className = 'dot';
      el.connText.textContent = `${s.product || 'Resolve'} ${s.version || ''}`.trim();
      showBanner(s.error, 'info');
    } else {
      el.connDot.className = 'dot ok';
      el.connText.textContent = `${s.product}${s.version ? ` ${s.version}` : ''}${s.mock ? ' · mock' : ''}`;
      showBanner(null);
      if (s.rendering && !state.rendering) showBanner('Resolve is already rendering. Wait for it to finish before queuing more.', 'info');
    }
    renderCrumbs();
    renderTimelines();
    updateButtons();
    renderInspector();
    schedulePreview();
    if (isConnected()) api.marks().then(applyMarks).catch(() => {});
  }

  function renderCrumbs() {
    const s = state.status || {};
    el.crumbProject.textContent = s.project || 'No project';
    el.crumbProject.className = `crumb${s.project ? ' live' : ''}`;
    el.crumbTimeline.textContent = s.timeline || 'No timeline';
    el.crumbTimeline.className = `crumb${s.timeline ? ' live' : ''}`;
  }

  function renderTimelines() {
    const list = timelineList();
    const known = new Set(list.map((t) => t.name));
    for (const name of [...state.timelinesPicked]) if (!known.has(name)) state.timelinesPicked.delete(name);
    const current = list.find((t) => t.current);
    if (!state.timelinesPicked.size && current) state.timelinesPicked.add(current.name);

    el.timelines.innerHTML = '';
    if (!list.length) {
      el.navHint.textContent = isConnected() ? 'No timelines in this project' : '';
      return;
    }
    for (const tl of list) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `chip${state.timelinesPicked.has(tl.name) ? ' on' : ''}`;
      chip.title = tl.current ? `${tl.name} (current timeline)` : tl.name;
      chip.innerHTML = `${tl.current ? '<i class="cur"></i>' : ''}${escapeHtml(tl.name)}`;
      chip.addEventListener('click', () => {
        if (state.timelinesPicked.has(tl.name)) state.timelinesPicked.delete(tl.name);
        else state.timelinesPicked.add(tl.name);
        renderTimelines();
        schedulePreview();
      });
      el.timelines.appendChild(chip);
    }
    const picked = pickedTimelines();
    const n = picked ? picked.length : 0;
    el.navHint.textContent = n === 0 ? 'Renders the current timeline' : n === 1 ? '1 timeline' : `${n} timelines`;
  }

  // ------------------------------------------------------------ deliverables rail

  async function loadProfiles(settings) {
    const { profiles, errors } = await api.profiles();
    state.profiles = profiles;
    const saved = settings && Array.isArray(settings.selectedProfiles) ? new Set(settings.selectedProfiles) : null;
    state.included = new Set(profiles.filter((p) => (saved ? saved.has(p.id) : p.enabledByDefault)).map((p) => p.id));
    if (!profiles.some((p) => p.id === state.selectedId)) {
      const first = profiles.find((p) => state.included.has(p.id)) || profiles[0];
      state.selectedId = first ? first.id : null;
    }
    if (errors && errors.length) showBanner(`${errors.length} profile file(s) could not be read. See the log.`, 'info');
    renderProfiles();
    renderInspector();
  }

  function profileMeta(p) {
    const parts = [p.format, p.codec];
    if (p.resolution) parts.push(`${p.resolution.width}×${p.resolution.height}`);
    if (p.renderMode === 'individual') parts.push('clips');
    return parts.join(' · ');
  }

  function renderProfiles() {
    el.profiles.innerHTML = '';
    el.profilesCount.textContent = state.profiles.length ? `${state.included.size}/${state.profiles.length}` : '';
    if (!state.profiles.length) {
      el.profiles.innerHTML = '<li class="none">No profiles found.</li>';
      return;
    }
    for (const target of ['timeline', 'cuts', 'stills']) {
      const group = state.profiles.filter((p) => profileTarget(p) === target);
      if (!group.length) continue;
      const head = document.createElement('li');
      head.className = 'layer-group';
      head.innerHTML = `<span class="label">${GROUP_LABEL[target]}</span>`;
      el.profiles.appendChild(head);
      for (const p of group) {
        const on = state.included.has(p.id);
        const li = document.createElement('li');
        li.className = `layer ${on ? 'on' : 'off'}${p.id === state.selectedId ? ' selected' : ''}`;
        li.innerHTML =
          `<span class="inc" role="checkbox" aria-checked="${on}" title="${on ? 'Exclude from batch' : 'Include in batch'}">${CHECK}</span>` +
          `<div><div class="name">${escapeHtml(p.name)}</div><div class="meta">${escapeHtml(profileMeta(p))}</div></div>`;
        li.querySelector('.inc').addEventListener('click', (e) => {
          e.stopPropagation();
          toggleInclude(p.id);
        });
        li.addEventListener('click', () => {
          state.selectedId = p.id;
          renderProfiles();
          renderInspector();
        });
        el.profiles.appendChild(li);
      }
    }
  }

  function toggleInclude(id, force) {
    const on = force === undefined ? !state.included.has(id) : force;
    if (on) state.included.add(id);
    else state.included.delete(id);
    renderProfiles();
    renderInspector();
    updateButtons();
    schedulePreview();
  }

  // ------------------------------------------------------------ capture: playhead, pad, marks

  function renderPlayhead(data) {
    if (!data || !data.ok) {
      el.playhead.textContent = '--:--:--:--';
      el.playState.className = 'play';
      el.playState.lastElementChild.textContent = data && data.error ? 'no timeline' : 'stopped';
      el.captureTl.textContent = '';
      state.playhead = null;
      return;
    }
    state.playhead = data;
    el.playhead.textContent = data.tc;
    el.playState.className = `play${data.playing ? ' on' : ''}`;
    el.playState.lastElementChild.textContent = data.playing ? 'playing' : 'stopped';
    el.captureTl.textContent = `${data.timeline} · ${fpsLabel(data.fps)}`;
    if (state.press) {
      const frames = data.absFrame - state.press.absIn + 1;
      el.padLive.textContent = `IN ${state.press.tc} · ${secondsLabel(frames, data.fps)}`;
    }
  }

  function applyMarks(result) {
    if (!result) return;
    state.marks = result.marks || [];
    state.marksInfo = result.info || null;
    renderMarks();
    updateButtons();
    schedulePreview();
  }

  function markRow(m) {
    const li = document.createElement('li');
    li.className = `mark ${m.kind}`;
    li.title = 'Click to move the playhead here';
    const range = m.kind === 'cut' ? `${m.tcIn} <span>→</span> ${m.tcOut}` : m.tcIn;
    li.innerHTML =
      `<span class="no">${String(m.index).padStart(2, '0')}</span>` +
      `<span class="range">${range}</span>` +
      `<span class="dur">${m.kind === 'cut' ? escapeHtml(m.duration) : ''}</span>` +
      `<button class="del" title="Remove this mark" aria-label="Remove">×</button>`;
    li.addEventListener('click', () => api.seek(m.absIn).catch((e) => showBanner(e.message)));
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
    if (!cuts.length) el.cuts.innerHTML = '<li class="none">Hold the pad while the timeline plays.</li>';
    else for (const m of cuts) el.cuts.appendChild(markRow(m));
    if (!stills.length) el.stills.innerHTML = '<li class="none">Tap the pad on a frame you want.</li>';
    else for (const m of stills) el.stills.appendChild(markRow(m));

    const cutProfiles = countIncluded('cuts');
    const stillProfiles = countIncluded('stills');
    const parts = [];
    if (cuts.length) parts.push(`${cuts.length} cut${cuts.length === 1 ? '' : 's'} × ${cutProfiles} profile${cutProfiles === 1 ? '' : 's'}`);
    if (stills.length) parts.push(`${stills.length} still${stills.length === 1 ? '' : 's'} × ${stillProfiles} profile${stillProfiles === 1 ? '' : 's'}`);
    el.captureHint.textContent = parts.length ? parts.join(' · ') : 'Play the timeline in Resolve, then hold or tap. Marks are saved as timeline markers.';
  }

  function flashPad(kind) {
    const cls = kind === 'still' ? 'flash-still' : 'flash-cut';
    el.pad.classList.add(cls);
    setTimeout(() => el.pad.classList.remove(cls), 220);
  }

  async function beginPress() {
    if (state.pressing || !isConnected()) return;
    state.pressing = true;
    el.pad.classList.add('holding');
    el.padLive.textContent = '…';
    state.pressPromise = api.markBegin();
    try {
      state.press = await state.pressPromise;
      el.padLive.textContent = `IN ${state.press.tc}`;
    } catch (err) {
      state.press = null;
      state.pressing = false;
      el.pad.classList.remove('holding');
      el.padLive.textContent = '';
      showBanner(err.message);
    }
  }

  async function endPress() {
    if (!state.pressing) return;
    state.pressing = false;
    if (state.pressPromise) await state.pressPromise.catch(() => {});
    const had = state.press;
    state.press = null;
    el.pad.classList.remove('holding');
    el.padLive.textContent = '';
    if (!had) return;
    try {
      const result = await api.markEnd();
      applyMarks(result);
      if (result.added) {
        flashPad(result.added.kind);
        showBanner(null);
      }
    } catch (err) {
      showBanner(err.message);
    }
  }

  function wireCapture() {
    el.pad.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try {
        el.pad.setPointerCapture(e.pointerId);
      } catch (_err) {
        /* not supported */
      }
      beginPress();
    });
    el.pad.addEventListener('pointerup', endPress);
    el.pad.addEventListener('pointercancel', endPress);
    el.pad.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') e.preventDefault();
    });
    document.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === ' ' || e.key.toLowerCase() === 'm') {
        e.preventDefault();
        beginPress();
      }
    });
    document.addEventListener('keyup', (e) => {
      if (e.key === ' ' || e.key.toLowerCase() === 'm') {
        e.preventDefault();
        endPress();
      }
    });
    window.addEventListener('blur', () => {
      if (state.pressing) endPress();
    });
    $('btn-clear-cuts').addEventListener('click', () => {
      if (!state.marks.some((m) => m.kind === 'cut')) return;
      if (!window.confirm('Remove all cut markers from this timeline?')) return;
      api.marksClear('cut').then(applyMarks).catch((e) => showBanner(e.message));
    });
    $('btn-clear-stills').addEventListener('click', () => {
      if (!state.marks.some((m) => m.kind === 'still')) return;
      if (!window.confirm('Remove all still markers from this timeline?')) return;
      api.marksClear('still').then(applyMarks).catch((e) => showBanner(e.message));
    });
    el.btnExportCuts.addEventListener('click', () => queue(true, ['cuts']));
    el.btnExportStills.addEventListener('click', () => queue(true, ['stills']));
    api.onPlayhead(renderPlayhead);
    api.onMarks(applyMarks);
  }

  // ------------------------------------------------------------ inspector

  function fmtUnit(value, unit) {
    if (value === undefined || value === null || value === '') return null;
    return `${escapeHtml(value)}<small>${unit}</small>`;
  }

  function fmtBool(value) {
    if (value === undefined || value === null) return null;
    return value ? 'On' : 'Off';
  }

  function fmtQuality(q) {
    if (q === undefined || q === null) return null;
    if (q === 0 || q === '0') return 'Automatic';
    if (typeof q === 'number') return `${q}<small>kb/s</small>`;
    return escapeHtml(q);
  }

  function section(title, rows) {
    const body = rows
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v, cls]) => `<div class="insp-row"><span class="k">${escapeHtml(k)}</span><span class="v${cls ? ` ${cls}` : ''}">${v}</span></div>`)
      .join('');
    if (!body) return '';
    return `<div class="insp-section"><span class="label">${escapeHtml(title)}</span>${body}</div>`;
  }

  function extensionFor(format) {
    const m = String(format || '').toLowerCase().match(/^[a-z0-9]{2,4}/);
    return m ? m[0] : '';
  }

  function renderInspector() {
    const p = state.profiles.find((x) => x.id === state.selectedId);
    if (!p) {
      el.inspectorKind.textContent = '';
      el.inspectorBody.innerHTML = '<div class="insp-empty">Select a deliverable to inspect it.</div>';
      return;
    }
    el.inspectorKind.textContent = 'Deliverable';
    const s = p.settings || {};
    const target = profileTarget(p);
    const userDir = state.status && state.status.userDir ? slash(state.status.userDir) : null;
    const isUser = userDir && p.source && slash(p.source).startsWith(userDir);
    const example = state.planItems.find((i) => i.profileId === p.id);
    const ext = extensionFor(p.format);
    const range = s.SelectAllFrames === false && s.MarkIn != null && s.MarkOut != null ? `${s.MarkIn}–${s.MarkOut}` : null;
    const marksOfKind = target === 'cuts' ? state.marks.filter((m) => m.kind === 'cut').length : target === 'stills' ? state.marks.filter((m) => m.kind === 'still').length : null;

    const other = Object.entries(s)
      .filter(([k]) => !HANDLED_SETTINGS.has(k))
      .map(([k, v]) => [k, escapeHtml(typeof v === 'object' ? JSON.stringify(v) : String(v)), 'mono']);

    el.inspectorBody.innerHTML =
      `<div class="insp-title">` +
      `<h3>${escapeHtml(p.name)}</h3>` +
      `<div class="id"><span>${escapeHtml(p.id)}</span><span class="tag${isUser ? ' user' : ''}">${isUser ? 'User' : 'Bundled'}</span></div>` +
      (p.description ? `<p class="desc">${escapeHtml(p.description)}</p>` : '') +
      `</div>` +
      section('Output', [
        ['Applies to', TARGET_LABEL[target] + (marksOfKind !== null ? ` <small>${marksOfKind} marked</small>` : '')],
        ['Container', escapeHtml(p.format), 'mono'],
        ['Codec', /^(auto|\*|first|default)$/i.test(p.codec) ? 'First available' : escapeHtml(p.codec), /^(auto|\*|first|default)$/i.test(p.codec) ? 'dim' : 'mono'],
        ['Mode', p.renderMode === 'individual' ? 'Individual clips' : 'Single clip'],
        ['Preset', p.renderPreset ? escapeHtml(p.renderPreset) : 'None', p.renderPreset ? '' : 'dim'],
      ]) +
      section('Frame', [
        ['Resolution', p.resolution ? `${p.resolution.width} × ${p.resolution.height}` : 'Timeline', p.resolution ? '' : 'dim'],
        ['Frame rate', p.frameRate != null ? fmtUnit(p.frameRate, 'fps') : 'Timeline', p.frameRate != null ? '' : 'dim'],
        ['Range', target === 'cuts' ? 'Each cut, in → out' : target === 'stills' ? 'One frame per still' : range || 'Entire timeline', target === 'timeline' && !range ? 'dim' : ''],
        ['Video', fmtBool(s.ExportVideo === undefined ? true : s.ExportVideo)],
      ]) +
      (target === 'stills'
        ? ''
        : section('Audio', [
            ['Export', fmtBool(s.ExportAudio === undefined ? true : s.ExportAudio)],
            ['Codec', s.AudioCodec ? escapeHtml(s.AudioCodec) : null, 'mono'],
            ['Bit depth', fmtUnit(s.AudioBitDepth, 'bit')],
            ['Sample rate', fmtUnit(s.AudioSampleRate, 'Hz')],
          ])) +
      section('Quality', [
        ['Quality', fmtQuality(s.VideoQuality)],
        ['Profile', s.EncodingProfile ? escapeHtml(s.EncodingProfile) : null],
        ['Multi-pass', fmtBool(s.MultiPassEncode)],
        ['Fast start', fmtBool(s.NetworkOptimization)],
        ['Alpha', fmtBool(s.ExportAlpha)],
        ['Color space', s.ColorSpaceTag ? escapeHtml(s.ColorSpaceTag) : null],
        ['Gamma', s.GammaTag ? escapeHtml(s.GammaTag) : null],
      ]) +
      section('Naming', [
        ['Subfolder', p.subfolder ? escapeHtml(p.subfolder) : 'Output folder', p.subfolder ? 'mono' : 'dim'],
        ['Suffix', p.fileSuffix ? escapeHtml(p.fileSuffix) : 'None', p.fileSuffix ? 'mono' : 'dim'],
        ['Example', example ? `${escapeHtml(example.fileName)}${ext ? `.${ext}` : ''}` : '—', example ? 'mono' : 'dim'],
      ]) +
      section('Other settings', other) +
      `<div class="insp-actions">` +
      `<button class="btn small block${state.included.has(p.id) ? '' : ' primary'}" id="insp-toggle">${state.included.has(p.id) ? 'Exclude from batch' : 'Include in batch'}</button>` +
      `<button class="btn small" id="insp-open" title="${escapeHtml(p.source || '')}">Open JSON</button>` +
      `</div>`;

    $('insp-toggle').addEventListener('click', () => toggleInclude(p.id));
    $('insp-open').addEventListener('click', () => api.openProfileFile(p.id).catch((e) => showBanner(e.message)));
  }

  // ------------------------------------------------------------ preview tree

  const schedulePreview = debounce(async () => {
    const req = currentRequest(false);
    const timelinesN = req.timelines ? req.timelines.length : 1;
    el.previewSummary.textContent = req.profileIds.length
      ? `${req.profileIds.length} deliverable${req.profileIds.length === 1 ? '' : 's'} × ${timelinesN} timeline${timelinesN === 1 ? '' : 's'}`
      : '';
    if (!isConnected() || !req.profileIds.length) {
      state.planItems = [];
      el.preview.innerHTML = `<div class="none">${req.profileIds.length ? 'Waiting for Resolve.' : 'Include at least one deliverable.'}</div>`;
      el.previewCount.textContent = '0';
      renderInspector();
      return;
    }
    try {
      const { items, notes } = await api.plan(req);
      state.planItems = items;
      renderTree(items, notes);
      el.previewCount.textContent = String(items.length);
    } catch (err) {
      state.planItems = [];
      el.preview.innerHTML = `<div class="err">${escapeHtml(err.message)}</div>`;
      el.previewCount.textContent = '0';
    }
    renderInspector();
  }, 150);

  function renderTree(items, notes = []) {
    if (!items.length && !notes.length) {
      el.preview.innerHTML = '<div class="none">Nothing to create.</div>';
      return;
    }
    const groups = new Map();
    for (const it of items) {
      const key = slash(it.targetDir) || '.';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    let html = '';
    for (const [dir, list] of groups) {
      html += `<div class="folder">${FOLDER}<span>${escapeHtml(dir)}/</span></div>`;
      for (const it of list) {
        const where = it.mark ? `<i>${escapeHtml(it.mark.tcIn)}${it.kind === 'cut' ? ` → ${escapeHtml(it.mark.tcOut)}` : ''}</i>` : '';
        html += `<div class="file"><b>${escapeHtml(it.fileName)}</b>${where}<span>${escapeHtml(it.timeline)} · ${escapeHtml(it.profileName)}</span></div>`;
      }
    }
    for (const n of notes) html += `<div class="none">${escapeHtml(n.profileName)}: ${escapeHtml(n.message)}</div>`;
    el.preview.innerHTML = html;
  }

  // ------------------------------------------------------------ jobs

  function renderJobs() {
    el.jobs.innerHTML = '';
    el.jobsEmpty.classList.toggle('hidden', state.jobs.length > 0);
    for (const job of state.jobs) {
      const st = state.statuses.get(job.jobId) || { status: 'ready', percent: 0 };
      const pct = st.status === 'complete' ? 100 : st.percent || 0;
      const fillClass = st.status === 'complete' ? ' ok' : st.status === 'failed' || st.status === 'cancelled' ? ' bad' : '';
      const where = job.mark ? ` <i>${escapeHtml(job.mark.tcIn)}${job.kind === 'cut' ? ` → ${escapeHtml(job.mark.tcOut)}` : ''}</i>` : '';
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td>${escapeHtml(job.timeline)}${where}</td>` +
        `<td>${escapeHtml(job.profileName)}</td>` +
        `<td class="file" title="${escapeHtml(slash(job.targetDir))}/${escapeHtml(job.fileName)}">${escapeHtml(job.fileName)}</td>` +
        `<td><span class="status ${escapeHtml(st.status)}">${escapeHtml(st.status)}</span>${st.error ? `<div class="err-text">${escapeHtml(st.error)}</div>` : ''}</td>` +
        `<td><div class="jobbar"><div class="bar"><div class="fill${fillClass}" style="width:${pct}%"></div></div><span>${pct}%</span></div></td>`;
      el.jobs.appendChild(tr);
    }
  }

  function renderTotal(summary) {
    if (!summary || !summary.total) {
      el.progressFill.style.width = '0%';
      el.progressLine.className = 'progress-line';
      el.totalPct.textContent = state.jobs.length ? '0%' : '—';
      el.totalText.textContent = state.jobs.length ? `${state.jobs.length} queued` : 'Idle';
      return;
    }
    el.progressFill.style.width = `${summary.percent}%`;
    el.progressLine.className = `progress-line${summary.done ? (summary.failed ? ' bad' : ' done') : ''}`;
    el.totalPct.textContent = `${summary.percent}%`;
    const parts = [];
    if (summary.rendering) parts.push(`${summary.rendering} rendering`);
    if (summary.complete) parts.push(`${summary.complete} complete`);
    if (summary.failed) parts.push(`${summary.failed} failed`);
    if (summary.cancelled) parts.push(`${summary.cancelled} cancelled`);
    if (summary.ready) parts.push(`${summary.ready} waiting`);
    el.totalText.textContent = parts.join(' · ');
  }

  async function queue(startRender, targets) {
    const req = currentRequest(startRender, targets);
    if (!req.profileIds.length) return showBanner('Include at least one deliverable.');
    if (!req.targetDir) return showBanner('Choose an output folder.');
    showBanner(null);
    setBusy(true);
    try {
      const { jobs, errors, notes, rendering } = await api.queue(req);
      state.jobs = jobs;
      state.statuses = new Map();
      state.rendering = rendering;
      renderJobs();
      renderTotal(null);
      if (jobs.length) el.jobs.closest('.sheet').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      if (errors.length) {
        showBanner(`${errors.length} job(s) could not be queued: ${errors.map((e) => `${e.profileName} (${e.message})`).join('; ')}`);
      } else if (!jobs.length) {
        showBanner(notes.length ? notes.map((n) => `${n.profileName}: ${n.message}`).join(' · ') : 'Nothing was queued.', 'info');
      }
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

  // ------------------------------------------------------------ wiring

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
        schedulePreview();
      });
    });
  }

  function wire() {
    $('btn-refresh').addEventListener('click', refreshStatus);
    $('btn-all').addEventListener('click', () => {
      state.included = new Set(state.profiles.map((p) => p.id));
      renderProfiles();
      renderInspector();
      updateButtons();
      schedulePreview();
    });
    $('btn-none').addEventListener('click', () => {
      state.included = new Set();
      renderProfiles();
      renderInspector();
      updateButtons();
      schedulePreview();
    });
    $('btn-reload-profiles').addEventListener('click', async () => {
      await loadProfiles({ selectedProfiles: [...state.included] });
      updateButtons();
      schedulePreview();
    });
    $('btn-profiles-folder').addEventListener('click', () => api.openProfilesFolder().catch((e) => showBanner(e.message)));
    $('btn-caps').addEventListener('click', () => {
      el.drawer.classList.add('open');
      api.capabilities().catch((e) => showBanner(e.message));
    });
    $('btn-browse').addEventListener('click', async () => {
      const dir = await api.pickFolder(el.targetDir.value.trim()).catch((e) => showBanner(e.message));
      if (dir) {
        el.targetDir.value = dir;
        api.saveSettings({ targetDir: dir }).catch(() => {});
        updateButtons();
        schedulePreview();
      }
    });
    $('btn-open-out').addEventListener('click', () => {
      const dir = el.targetDir.value.trim();
      if (dir) api.openFolder(dir).catch((e) => showBanner(e.message));
    });
    el.targetDir.addEventListener('input', () => {
      updateButtons();
      schedulePreview();
    });
    el.targetDir.addEventListener('change', () => api.saveSettings({ targetDir: el.targetDir.value.trim() }).catch(() => {}));
    el.nameTemplate.addEventListener('input', schedulePreview);
    el.nameTemplate.addEventListener('change', () => api.saveSettings({ nameTemplate: el.nameTemplate.value.trim() }).catch(() => {}));
    el.optStart.addEventListener('change', () => api.saveSettings({ startRender: el.optStart.checked }).catch(() => {}));
    el.optClear.addEventListener('change', () => api.saveSettings({ clearExisting: el.optClear.checked }).catch(() => {}));
    el.btnGo.addEventListener('click', () => queue(true));
    el.btnQueue.addEventListener('click', () => queue(el.optStart.checked));
    el.btnStop.addEventListener('click', stop);
    $('drawer-toggle').addEventListener('click', () => el.drawer.classList.toggle('open'));
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !el.btnGo.disabled && !state.rendering) queue(true);
    });
    wireCapture();

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
      renderJobs();
      renderTotal(result ? result.summary : null);
      updateButtons();
      if (result && result.error) showBanner(result.error);
      refreshStatus();
    });
  }

  async function init() {
    renderTokens();
    wire();
    const settings = await api.getSettings().catch(() => ({}));
    if (settings.targetDir) el.targetDir.value = settings.targetDir;
    if (settings.nameTemplate) el.nameTemplate.value = settings.nameTemplate;
    el.optClear.checked = Boolean(settings.clearExisting);
    el.optStart.checked = settings.startRender !== false;
    const history = await api.logHistory().catch(() => []);
    el.log.textContent = history.join('\n');
    if (history.length) el.logLast.textContent = history[history.length - 1].replace(/^\[[^\]]*\]\s*/, '');
    renderMarks();
    await loadProfiles(settings);
    await refreshStatus();
  }

  init().catch((err) => showBanner(`ExportX failed to start: ${err.message}`));
})();
