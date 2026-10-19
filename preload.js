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
  capabilities: (opts) => invoke('exportx:capabilities', opts),
  // deliverable settings (user profile files)
  saveProfile: (profile) => invoke('exportx:save-profile', profile),
  deleteProfile: (id) => invoke('exportx:delete-profile', id),
  // folders and files
  pickFolder: (current) => invoke('exportx:pick-folder', current),
  openFolder: (dir) => invoke('exportx:open-folder', dir),
  openProfilesFolder: () => invoke('exportx:open-profiles-folder'),
  openProfileFile: (profileId) => invoke('exportx:open-profile-file', profileId),
  // preview video (a 720p proxy of the current timeline, rendered by Resolve)
  previewStatus: () => invoke('exportx:preview-status'),
  previewRender: () => invoke('exportx:preview-render'),
  // capture: cuts and stills as timeline markers
  marks: () => invoke('exportx:marks'),
  markBegin: (at) => invoke('exportx:mark-begin', at),
  markEnd: (at) => invoke('exportx:mark-end', at),
  markCancel: () => invoke('exportx:mark-cancel'),
  markStill: (at) => invoke('exportx:mark-still', at),
  markDelete: (relIn) => invoke('exportx:mark-delete', relIn),
  marksClear: (kind) => invoke('exportx:marks-clear', kind),
  seek: (absFrame) => invoke('exportx:seek', absFrame),
  setTimeline: (name) => invoke('exportx:set-timeline', name),
  // the sizes Resolve offers for a format/codec (Settings › Deliverables)
  resolutions: (q) => invoke('exportx:resolutions', q),
  // batch
  plan: (request) => invoke('exportx:plan', request),
  queue: (request) => invoke('exportx:queue', request),
  render: (jobIds) => invoke('exportx:render', jobIds),
  stop: () => invoke('exportx:stop'),
  jobStatus: (jobIds) => invoke('exportx:job-status', jobIds),
  // portal (Triptych Studios or any server implementing portal-kit/)
  portalTest: (opts) => invoke('exportx:portal-test', opts),
  portalProjects: () => invoke('exportx:portal-projects'),
  portalUpload: (opts) => invoke('exportx:portal-upload', opts),
  openUrl: (url) => invoke('exportx:open-url', url),
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
  onPreview: (cb) => subscribe('exportx:preview', cb),
  onUpload: (cb) => subscribe('exportx:upload', cb),
});
