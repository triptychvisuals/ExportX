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
  // connection and catalogue
  status: () => invoke('exportx:status'),
  profiles: () => invoke('exportx:profiles'),
  capabilities: () => invoke('exportx:capabilities'),
  // folders and files
  pickFolder: (current) => invoke('exportx:pick-folder', current),
  openFolder: (dir) => invoke('exportx:open-folder', dir),
  openProfilesFolder: () => invoke('exportx:open-profiles-folder'),
  openProfileFile: (profileId) => invoke('exportx:open-profile-file', profileId),
  // capture: cuts and stills as timeline markers
  marks: () => invoke('exportx:marks'),
  markBegin: () => invoke('exportx:mark-begin'),
  markEnd: () => invoke('exportx:mark-end'),
  markCancel: () => invoke('exportx:mark-cancel'),
  markStill: () => invoke('exportx:mark-still'),
  markDelete: (relIn) => invoke('exportx:mark-delete', relIn),
  marksClear: (kind) => invoke('exportx:marks-clear', kind),
  seek: (absFrame) => invoke('exportx:seek', absFrame),
  // batch
  plan: (request) => invoke('exportx:plan', request),
  queue: (request) => invoke('exportx:queue', request),
  render: (jobIds) => invoke('exportx:render', jobIds),
  stop: () => invoke('exportx:stop'),
  jobStatus: (jobIds) => invoke('exportx:job-status', jobIds),
  // settings and log
  getSettings: () => invoke('exportx:get-settings'),
  saveSettings: (settings) => invoke('exportx:save-settings', settings),
  logHistory: () => invoke('exportx:log-history'),
  // events
  onLog: (cb) => subscribe('exportx:log', cb),
  onProgress: (cb) => subscribe('exportx:progress', cb),
  onDone: (cb) => subscribe('exportx:done', cb),
  onPlayhead: (cb) => subscribe('exportx:playhead', cb),
  onMarks: (cb) => subscribe('exportx:marks', cb),
});
