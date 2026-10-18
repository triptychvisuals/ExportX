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
    profiles: $('profiles'),
    targetDir: $('target-dir'),
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
    btnGo: $('btn-go'),
    btnStop: $('btn-stop'),
    btnExportCuts: $('btn-export-cuts'),
    btnExportStills: $('btn-export-stills'),
    exportSummary: $('export-summary'),
    progress: $('progress'),
    totalFill: $('total-fill'),
    totalText: $('total-text'),
    jobs: $('jobs'),
    more: $('more'),
    nameTemplate: $('name-template'),
    tokens: $('tokens'),
    timelines: $('timelines'),
    navHint: $('nav-hint'),
    optStart: $('opt-start'),
    optClear: $('opt-clear'),
    btnQueue: $('btn-queue'),
    userDir: $('user-dir'),
    log: $('log'),
  };

  const TOKENS = ['{project}', '{timeline}', '{profile}', '{date}', '{time}', '{cut}', '{still}', '{tc}'];
  const CHECK = '<svg viewBox="0 0 16 16"><path d="M3 8.5l3 3 7-7"/></svg>';
  const TARGET_TAG = { cuts: ['per cut', 'cut'], stills: ['per still', 'still'] };

  const state = {
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

  function fpsLabel(fps) {
    if (!fps) return '';
    const r = Math.round(fps * 1000) / 1000;
    return `${Number.isInteger(r) ? r : r.toFixed(3).replace(/0+$/, '')} fps`;
  }

  function secondsLabel(frames, fps) {
    const s = Math.max(0, frames) / (fps || 24);
    return s >= 60 ? `${Math.floor(s / 60)}m ${(s % 60).toFixed(1)}s` : `${s.toFixed(1)}s`;
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

  function updateButtons() {
    const ready = isConnected() && el.targetDir.value.trim().length > 0 && !state.busy && !state.rendering;
    const cuts = state.marks.filter((m) => m.kind === 'cut').length;
    const stills = state.marks.filter((m) => m.kind === 'still').length;
    el.btnGo.disabled = !(ready && state.plan.items.length > 0);
    el.btnQueue.disabled = el.btnGo.disabled;
    el.btnExportCuts.disabled = !(ready && cuts > 0 && countIncluded('cuts') > 0);
    el.btnExportStills.disabled = !(ready && stills > 0 && countIncluded('stills') > 0);
    el.btnStop.classList.toggle('hidden', !state.rendering);
    el.btnGo.classList.toggle('hidden', state.rendering);
    el.pad.disabled = !isConnected();
    const n = state.plan.items.length;
    el.btnGo.textContent = n ? `Export everything · ${plural(n, 'file')}` : 'Export everything';
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
    updateButtons();
    schedulePlan();
    if (isConnected()) api.marks().then(applyMarks).catch(() => {});
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
    el.navHint.textContent = !list.length
      ? ''
      : !picked || picked.length === 1
        ? 'Exports the current timeline. Pick more to export them too.'
        : `Exports ${picked.length} timelines.`;
  }

  // ------------------------------------------------------------ step 1: choices

  async function loadProfiles(settings) {
    const { profiles, errors } = await api.profiles();
    state.profiles = profiles;
    const saved = settings && Array.isArray(settings.selectedProfiles) ? new Set(settings.selectedProfiles) : null;
    state.included = new Set(profiles.filter((p) => (saved ? saved.has(p.id) : p.enabledByDefault)).map((p) => p.id));
    if (errors && errors.length) showBanner(`${errors.length} profile file(s) could not be read. See the log under More options.`, 'info');
    renderProfiles();
  }

  function profileMeta(p) {
    const parts = [p.format, /^(auto|\*|first|default)$/i.test(p.codec) ? '' : p.codec];
    if (p.resolution) parts.push(`${p.resolution.width}×${p.resolution.height}`);
    if (p.renderMode === 'individual') parts.push('per clip');
    return parts.filter(Boolean).join(' · ');
  }

  function renderProfiles() {
    el.profiles.innerHTML = '';
    if (!state.profiles.length) {
      el.profiles.innerHTML = '<li class="none">No deliverables found. Add profile JSON files (see More options).</li>';
      return;
    }
    const order = ['timeline', 'cuts', 'stills'];
    const sorted = [...state.profiles].sort((a, b) => order.indexOf(profileTarget(a)) - order.indexOf(profileTarget(b)));
    for (const p of sorted) {
      const on = state.included.has(p.id);
      const target = profileTarget(p);
      const tag = TARGET_TAG[target] ? `<span class="tag ${TARGET_TAG[target][1]}">${TARGET_TAG[target][0]}</span>` : '';
      const li = document.createElement('li');
      li.className = `choice ${on ? 'on' : 'off'}`;
      li.title = p.description || '';
      li.innerHTML =
        `<span class="inc" role="checkbox" aria-checked="${on}">${CHECK}</span>` +
        `<div class="name">${escapeHtml(p.name)}${tag}</div>` +
        `<span class="meta">${escapeHtml(profileMeta(p))}</span>`;
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

  // ------------------------------------------------------------ step 2: capture

  function renderPlayhead(data) {
    if (!data || !data.ok) {
      el.playhead.textContent = '--:--:--:--';
      el.playState.className = 'play';
      el.playState.lastElementChild.textContent = 'stopped';
      el.captureTl.textContent = data && data.error ? 'Open a timeline in Resolve' : 'No timeline';
      return;
    }
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
    renderMarks();
    updateButtons();
    schedulePlan();
  }

  function markRow(m) {
    const li = document.createElement('li');
    li.className = `mark ${m.kind}`;
    li.title = 'Click to move the playhead here';
    const range = m.kind === 'cut' ? `${m.tcIn} <span>→</span> ${m.tcOut}<em>${escapeHtml(m.duration)}</em>` : m.tcIn;
    li.innerHTML =
      `<span class="no">${String(m.index).padStart(2, '0')}</span>` +
      `<span class="range">${range}</span>` +
      `<button class="del" title="Remove" aria-label="Remove this mark">×</button>`;
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
    if (!cuts.length) el.cuts.innerHTML = '<li class="none">None yet. Hold the pad while it plays.</li>';
    else for (const m of cuts) el.cuts.appendChild(markRow(m));
    if (!stills.length) el.stills.innerHTML = '<li class="none">None yet. Tap the pad on a frame.</li>';
    else for (const m of stills) el.stills.appendChild(markRow(m));
    const cutProfiles = countIncluded('cuts');
    const stillProfiles = countIncluded('stills');
    const warn = [];
    if (cuts.length && !cutProfiles) warn.push('Tick a "per cut" deliverable in step 1 to export the cuts.');
    if (stills.length && !stillProfiles) warn.push('Tick a "per still" deliverable in step 1 to export the stills.');
    el.captureHint.className = `hint${warn.length ? ' warn' : ''}`;
    el.captureHint.textContent = warn.length
      ? warn.join(' ')
      : 'Play the timeline in Resolve, then hold or tap the pad. Marks are saved as timeline markers, so you can see and delete them in Resolve too.';
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
    $('btn-clear-cuts').addEventListener('click', () => confirmClear('cut'));
    $('btn-clear-stills').addEventListener('click', () => confirmClear('still'));
    api.onPlayhead(renderPlayhead);
    api.onMarks(applyMarks);
  }

  // A two-step clear: first click arms the link, second click within 4 s clears.
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
      el.exportSummary.textContent = req.profileIds.length ? '' : 'Tick at least one deliverable in step 1.';
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
    const where = req.targetDir ? ` → ${slash(req.targetDir)}` : ' → choose a folder in step 1';
    const noteText = notes.map((n) => n.message.replace(/ on ".*"$/, '')).filter((v, i, a) => a.indexOf(v) === i);
    el.exportSummary.textContent = (parts.length ? parts.join(' · ') + where : 'Nothing to export yet.') + (noteText.length ? ` · ${noteText.join(' · ')}` : '');
    updateButtons();
  }, 150);

  function renderJobs() {
    el.jobs.innerHTML = '';
    for (const job of state.jobs) {
      const st = state.statuses.get(job.jobId) || { status: 'ready', percent: 0 };
      const li = document.createElement('li');
      li.className = `file ${st.status}`;
      const where = job.mark ? `<small>${escapeHtml(job.mark.tcIn)}${job.kind === 'cut' ? ` → ${escapeHtml(job.mark.tcOut)}` : ''}</small>` : '';
      const stateText =
        st.status === 'complete' ? 'done' : st.status === 'rendering' ? `${st.percent}%` : st.status === 'ready' ? 'waiting' : st.status;
      li.innerHTML =
        `<i class="st"></i>` +
        `<span class="fn" title="${escapeHtml(slash(job.targetDir))}/${escapeHtml(job.fileName)}">${escapeHtml(job.fileName)}${where}</span>` +
        `<span class="state">${escapeHtml(stateText)}</span>` +
        (st.error ? `<span class="err">${escapeHtml(st.error)}</span>` : '');
      el.jobs.appendChild(li);
    }
  }

  function renderTotal(summary) {
    if (!summary || !summary.total) {
      el.progressFill.style.width = '0%';
      el.progressLine.className = 'progress-line';
      el.progress.classList.toggle('hidden', !state.jobs.length);
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
    if (!req.profileIds.length) return showBanner('Tick at least one deliverable in step 1.');
    if (!req.targetDir) return showBanner('Choose where to save in step 1.');
    showBanner(null);
    setBusy(true);
    try {
      const { jobs, errors, notes, rendering } = await api.queue(req);
      state.jobs = jobs;
      state.statuses = new Map();
      state.rendering = rendering;
      renderJobs();
      renderTotal(null);
      if (errors.length) {
        showBanner(`${errors.length} file(s) could not be queued: ${errors.map((e) => `${e.profileName} (${e.message})`).join('; ')}`);
      } else if (!jobs.length) {
        showBanner(notes.length ? notes.map((n) => n.message).join(' · ') : 'Nothing was queued.', 'info');
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
        schedulePlan();
      });
    });
  }

  function wire() {
    $('btn-refresh').addEventListener('click', refreshStatus);
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
    el.btnGo.addEventListener('click', () => queue(true));
    el.btnStop.addEventListener('click', stop);
    el.btnExportCuts.addEventListener('click', () => queue(true, ['cuts']));
    el.btnExportStills.addEventListener('click', () => queue(true, ['stills']));
    el.btnQueue.addEventListener('click', () => queue(false));
    $('btn-open-out').addEventListener('click', () => {
      const dir = el.targetDir.value.trim();
      if (dir) api.openFolder(dir).catch((e) => showBanner(e.message));
    });
    $('btn-profiles-folder').addEventListener('click', () => api.openProfilesFolder().catch((e) => showBanner(e.message)));
    $('btn-reload-profiles').addEventListener('click', async () => {
      await loadProfiles({ selectedProfiles: [...state.included] });
      updateButtons();
      schedulePlan();
    });
    $('btn-caps').addEventListener('click', () => api.capabilities().catch((e) => showBanner(e.message)));
    el.nameTemplate.addEventListener('input', schedulePlan);
    el.nameTemplate.addEventListener('change', () => api.saveSettings({ nameTemplate: el.nameTemplate.value.trim() }).catch(() => {}));
    el.optStart.addEventListener('change', () => api.saveSettings({ startRender: el.optStart.checked }).catch(() => {}));
    el.optClear.addEventListener('change', () => api.saveSettings({ clearExisting: el.optClear.checked }).catch(() => {}));
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
    renderMarks();
    await loadProfiles(settings);
    await refreshStatus();
  }

  init().catch((err) => showBanner(`ExportX failed to start: ${err.message}`));
})();
