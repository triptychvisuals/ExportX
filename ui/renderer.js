/* global window, document */
'use strict';

(function main() {
  const api = window.exportx;
  const $ = (id) => document.getElementById(id);

  const el = {
    connDot: $('conn-dot'),
    connText: $('conn-text'),
    banner: $('banner'),
    profiles: $('profiles'),
    userDir: $('user-dir'),
    targetDir: $('target-dir'),
    nameTemplate: $('name-template'),
    tokens: $('tokens'),
    currentTl: $('current-tl-name'),
    timelines: $('timelines'),
    optClear: $('opt-clear'),
    optStart: $('opt-start'),
    preview: $('preview'),
    previewCount: $('preview-count'),
    btnGo: $('btn-go'),
    btnQueue: $('btn-queue'),
    btnStop: $('btn-stop'),
    jobs: $('jobs'),
    jobsEmpty: $('jobs-empty'),
    totalFill: $('total-fill'),
    totalText: $('total-text'),
    log: $('log'),
  };

  const TOKENS = [
    '{project}', '{timeline}', '{profile}', '{profileName}', '{format}', '{codec}',
    '{width}', '{height}', '{date}', '{time}',
  ];

  const state = {
    status: null,
    profiles: [],
    selected: new Set(),
    timelinesPicked: new Set(),
    jobs: [],
    statuses: new Map(),
    rendering: false,
    busy: false,
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
    el.banner.className = `banner ${kind === 'info' ? 'info' : ''}`;
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function currentRequest(startRender) {
    const mode = document.querySelector('input[name="tl-mode"]:checked').value;
    return {
      profileIds: state.profiles.filter((p) => state.selected.has(p.id)).map((p) => p.id),
      targetDir: el.targetDir.value.trim(),
      nameTemplate: el.nameTemplate.value.trim() || '{timeline}_{profile}',
      timelines: mode === 'pick' ? [...state.timelinesPicked] : null,
      clearExisting: el.optClear.checked,
      startRender: Boolean(startRender),
    };
  }

  function setBusy(busy) {
    state.busy = busy;
    updateButtons();
  }

  function updateButtons() {
    const connected = Boolean(state.status && state.status.connected && !state.status.error);
    const hasSelection = state.selected.size > 0 && el.targetDir.value.trim().length > 0;
    const can = connected && hasSelection && !state.busy && !state.rendering;
    el.btnGo.disabled = !can;
    el.btnQueue.disabled = !can;
    el.btnStop.classList.toggle('hidden', !state.rendering);
    el.btnGo.classList.toggle('hidden', state.rendering);
  }

  // ------------------------------------------------------------ status

  async function refreshStatus() {
    try {
      state.status = await api.status();
    } catch (err) {
      state.status = { connected: false, error: err.message };
    }
    const s = state.status;
    if (s.userDir) el.userDir.textContent = `${s.userDir.replace(/\\/g, '/')}/profiles/`;
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
      el.connText.textContent = `${s.product}${s.version ? ` ${s.version}` : ''} · ${s.project}${s.mock ? ' · MOCK' : ''}`;
      showBanner(null);
    }
    el.currentTl.textContent = s.timeline ? `(${s.timeline})` : '(none open)';
    renderTimelines(s.timelines || []);
    if (s.rendering && !state.rendering) {
      showBanner('Resolve is already rendering. Wait for it to finish before queuing more.', 'info');
    }
    updateButtons();
    schedulePreview();
  }

  function renderTimelines(list) {
    el.timelines.innerHTML = '';
    for (const tl of list) {
      const li = document.createElement('li');
      const label = document.createElement('label');
      label.className = 'check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = state.timelinesPicked.has(tl.name) || (state.timelinesPicked.size === 0 && tl.current);
      if (input.checked) state.timelinesPicked.add(tl.name);
      input.addEventListener('change', () => {
        if (input.checked) state.timelinesPicked.add(tl.name);
        else state.timelinesPicked.delete(tl.name);
        schedulePreview();
      });
      label.appendChild(input);
      label.appendChild(document.createTextNode(` ${tl.name}${tl.current ? ' (current)' : ''}`));
      li.appendChild(label);
      el.timelines.appendChild(li);
    }
  }

  // ------------------------------------------------------------ profiles

  async function loadProfiles(settings) {
    const { profiles, errors } = await api.profiles();
    state.profiles = profiles;
    const saved = settings && Array.isArray(settings.selectedProfiles) ? new Set(settings.selectedProfiles) : null;
    state.selected = new Set(
      profiles.filter((p) => (saved ? saved.has(p.id) : p.enabledByDefault)).map((p) => p.id),
    );
    if (errors && errors.length) {
      showBanner(`${errors.length} profile file(s) could not be read. See the log.`, 'info');
    }
    renderProfiles();
  }

  function renderProfiles() {
    el.profiles.innerHTML = '';
    if (!state.profiles.length) {
      el.profiles.innerHTML = '<li class="muted">No profiles found.</li>';
      return;
    }
    for (const p of state.profiles) {
      const li = document.createElement('li');
      li.className = state.selected.has(p.id) ? 'on' : '';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = state.selected.has(p.id);
      const body = document.createElement('div');
      const res = p.resolution ? `<span class="badge res">${p.resolution.width}×${p.resolution.height}</span>` : '';
      const mode = p.renderMode === 'individual' ? '<span class="badge">clips</span>' : '';
      body.innerHTML =
        `<div class="name">${escapeHtml(p.name)}<span class="badges">` +
        `<span class="badge">${escapeHtml(p.format)}</span><span class="badge">${escapeHtml(p.codec)}</span>${res}${mode}` +
        `</span></div>` +
        (p.description ? `<div class="desc">${escapeHtml(p.description)}</div>` : '');
      const toggle = (on) => {
        if (on) state.selected.add(p.id);
        else state.selected.delete(p.id);
        input.checked = on;
        li.className = on ? 'on' : '';
        updateButtons();
        schedulePreview();
      };
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('change', () => toggle(input.checked));
      li.addEventListener('click', () => toggle(!state.selected.has(p.id)));
      li.appendChild(input);
      li.appendChild(body);
      el.profiles.appendChild(li);
    }
  }

  // ------------------------------------------------------------ preview

  const schedulePreview = debounce(async () => {
    const req = currentRequest(false);
    if (!state.status || !state.status.connected || state.status.error || !req.profileIds.length) {
      el.preview.innerHTML = '';
      el.previewCount.textContent = '';
      return;
    }
    try {
      const items = await api.plan(req);
      el.preview.innerHTML = items
        .map(
          (i) =>
            `<li><span>${escapeHtml(i.timeline)} · ${escapeHtml(i.profileName)} → </span>${escapeHtml(
              i.targetDir ? `${i.targetDir.replace(/\\/g, '/')}/` : '',
            )}<strong>${escapeHtml(i.fileName)}</strong></li>`,
        )
        .join('');
      el.previewCount.textContent = `${items.length} job${items.length === 1 ? '' : 's'}`;
    } catch (err) {
      el.preview.innerHTML = `<li class="err">${escapeHtml(err.message)}</li>`;
      el.previewCount.textContent = '';
    }
  }, 150);

  // ------------------------------------------------------------ jobs

  function renderJobs() {
    el.jobs.innerHTML = '';
    el.jobsEmpty.classList.toggle('hidden', state.jobs.length > 0);
    for (const job of state.jobs) {
      const st = state.statuses.get(job.jobId) || { status: 'ready', percent: 0 };
      const tr = document.createElement('tr');
      const pct = st.status === 'complete' ? 100 : st.percent || 0;
      tr.innerHTML =
        `<td>${escapeHtml(job.timeline)}</td>` +
        `<td>${escapeHtml(job.profileName)}</td>` +
        `<td class="file" title="${escapeHtml(job.targetDir)}">${escapeHtml(job.fileName)}</td>` +
        `<td><span class="status ${escapeHtml(st.status)}">${escapeHtml(st.status)}</span>` +
        (st.error ? `<div class="err">${escapeHtml(st.error)}</div>` : '') +
        `</td>` +
        `<td><div class="jobbar"><div class="bar"><div class="fill ${
          st.status === 'complete' ? 'ok' : st.status === 'failed' || st.status === 'cancelled' ? 'bad' : ''
        }" style="width:${pct}%"></div></div><span>${pct}%</span></div></td>`;
      el.jobs.appendChild(tr);
    }
  }

  function renderTotal(summary) {
    if (!summary || !summary.total) {
      el.totalFill.style.width = '0%';
      el.totalFill.className = 'fill';
      el.totalText.textContent = state.jobs.length ? 'Queued' : 'Idle';
      return;
    }
    el.totalFill.style.width = `${summary.percent}%`;
    el.totalFill.className = `fill ${summary.done ? (summary.failed ? 'bad' : 'ok') : ''}`;
    const parts = [];
    if (summary.rendering) parts.push(`${summary.rendering} rendering`);
    if (summary.complete) parts.push(`${summary.complete} done`);
    if (summary.failed) parts.push(`${summary.failed} failed`);
    if (summary.cancelled) parts.push(`${summary.cancelled} cancelled`);
    if (summary.ready) parts.push(`${summary.ready} waiting`);
    el.totalText.textContent = `${summary.percent}% · ${parts.join(', ')}`;
  }

  async function queue(startRender) {
    const req = currentRequest(startRender);
    if (!req.profileIds.length) return showBanner('Pick at least one deliverable.');
    if (!req.targetDir) return showBanner('Pick an output folder.');
    if (req.timelines && !req.timelines.length) return showBanner('Pick at least one timeline.');
    showBanner(null);
    setBusy(true);
    try {
      const { jobs, errors, rendering } = await api.queue(req);
      state.jobs = jobs;
      state.statuses = new Map();
      state.rendering = rendering;
      renderJobs();
      renderTotal(null);
      if (errors.length) {
        showBanner(`${errors.length} deliverable(s) could not be queued: ${errors.map((e) => `${e.profileName} (${e.message})`).join('; ')}`);
      }
      if (!jobs.length && !errors.length) showBanner('Nothing was queued.', 'info');
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
        schedulePreview();
      });
    });
  }

  function wire() {
    $('btn-refresh').addEventListener('click', refreshStatus);
    $('btn-all').addEventListener('click', () => {
      state.selected = new Set(state.profiles.map((p) => p.id));
      renderProfiles();
      updateButtons();
      schedulePreview();
    });
    $('btn-none').addEventListener('click', () => {
      state.selected = new Set();
      renderProfiles();
      updateButtons();
      schedulePreview();
    });
    $('btn-reload-profiles').addEventListener('click', async () => {
      const saved = { selectedProfiles: [...state.selected] };
      await loadProfiles(saved);
      updateButtons();
      schedulePreview();
    });
    $('btn-profiles-folder').addEventListener('click', () => api.openProfilesFolder().catch((e) => showBanner(e.message)));
    $('btn-caps').addEventListener('click', () => api.capabilities().catch((e) => showBanner(e.message)));
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
    el.nameTemplate.addEventListener('input', schedulePreview);
    document.querySelectorAll('input[name="tl-mode"]').forEach((r) =>
      r.addEventListener('change', () => {
        el.timelines.classList.toggle('hidden', r.value !== 'pick' || !r.checked);
        schedulePreview();
      }),
    );
    el.btnGo.addEventListener('click', () => queue(true));
    el.btnQueue.addEventListener('click', () => queue(false));
    el.btnStop.addEventListener('click', stop);
    $('btn-clear-log').addEventListener('click', () => {
      el.log.textContent = '';
    });

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
    await loadProfiles(settings);
    await refreshStatus();
  }

  init().catch((err) => showBanner(`ExportX failed to start: ${err.message}`));
})();
