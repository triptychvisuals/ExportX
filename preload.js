'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload).then((res) => {
    if (res && res.ok === false) throw new Error(res.error || 'Unknown error');
    return res && res.ok ? res.data : res;
  });
}

function subscribe(channel, cb) {
  const handler = (_event, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('exportx', {
  status: () => invoke('exportx:status'),
  profiles: () => invoke('exportx:profiles'),
  capabilities: () => invoke('exportx:capabilities'),
  pickFolder: (current) => invoke('exportx:pick-folder', current),
  openFolder: (dir) => invoke('exportx:open-folder', dir),
  openProfilesFolder: () => invoke('exportx:open-profiles-folder'),
  plan: (request) => invoke('exportx:plan', request),
  queue: (request) => invoke('exportx:queue', request),
  render: (jobIds) => invoke('exportx:render', jobIds),
  stop: () => invoke('exportx:stop'),
  jobStatus: (jobIds) => invoke('exportx:job-status', jobIds),
  getSettings: () => invoke('exportx:get-settings'),
  saveSettings: (settings) => invoke('exportx:save-settings', settings),
  logHistory: () => invoke('exportx:log-history'),
  onLog: (cb) => subscribe('exportx:log', cb),
  onProgress: (cb) => subscribe('exportx:progress', cb),
  onDone: (cb) => subscribe('exportx:done', cb),
});
