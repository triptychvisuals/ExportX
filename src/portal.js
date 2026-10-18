'use strict';

/**
 * PortalClient: pushes finished exports into a project on the Triptych
 * Studios portal, through the portal's plugin API (v2). The walk through
 * lives in the portal repository as docs/exportx-api.md; the contract is
 * mirrored in portal-kit/ here, with a reference server for tests.
 *
 * Every call carries `Authorization: Bearer tpx_…` (a key from the portal's
 * Settings › ExportX). The flow for one batch:
 *
 *   GET  /api/plugin/ping                      who is answering, is the key good
 *   GET  /api/plugin/projects                  the projects to pick from
 *   GET  /api/plugin/deliverables?projectId=…  the project's Delivery boxes and files
 *   per file:
 *     POST /api/plugin/deliverables { action: 'upload_url', … }    -> a plan: multipart (presigned parts) | put | tus
 *     PUT  the bytes where the plan says (no auth header; the URLs are signed)
 *     POST /api/plugin/deliverables { action: 'complete_upload', … } (multipart only)
 *     POST /api/plugin/deliverables { action: 'register', … }       -> filed into a Delivery box
 *   POST /api/plugin/deliverables { action: 'batch', … }            -> one note on the project, the tab's URL
 *
 * Files stream from disk in slices; onProgress gets { sent, total, percent }.
 * No third-party dependencies, so it runs inside Resolve's Electron untouched.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const API = {
  ping: '/api/plugin/ping',
  projects: '/api/plugin/projects',
  deliverables: '/api/plugin/deliverables',
};
const PROTOCOL_VERSION = '2';
const PART_PARALLEL = 3;
const PART_RETRIES = 4;

class PortalError extends Error {
  constructor(message, { status, body, code } = {}) {
    super(message);
    this.name = 'PortalError';
    if (status !== undefined) this.status = status;
    if (body !== undefined) this.body = body;
    if (code !== undefined) this.code = code;
  }
}

/** The portal's address: a scheme added, trailing slashes and any pasted /api/… path removed. */
function normalizeBaseUrl(portalUrl) {
  let u = String(portalUrl || '').trim();
  if (!u) throw new PortalError('No portal URL is set (Settings › Portal)');
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  u = u.replace(/\/+$/, '').replace(/\/api(\/.*)?$/i, '');
  return u;
}

const CONTENT_TYPES = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  mxf: 'application/mxf',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  exr: 'image/x-exr',
  dpx: 'image/x-dpx',
  gif: 'image/gif',
  wav: 'audio/wav',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
};

function contentTypeFor(fileName) {
  const ext = String(fileName || '').toLowerCase().match(/\.([a-z0-9]{1,5})$/);
  return (ext && CONTENT_TYPES[ext[1]]) || 'application/octet-stream';
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Which files did Resolve write for a job? Resolve appends the extension, and for
 * image sequences a frame number, so match "<name>.<ext>" and "<name>[_.-]<digits>.<ext>",
 * ignoring anything older than the moment the job was queued.
 */
function findOutputs(dir, baseName, { since = 0 } = {}) {
  if (!dir || !fs.existsSync(dir)) return [];
  const re = new RegExp(`^${escapeRegExp(baseName)}(?:[._-]?\\d+)?\\.[a-z0-9]{1,5}$`, 'i');
  return fs
    .readdirSync(dir)
    .filter((f) => re.test(f))
    .map((f) => path.join(dir, f))
    .filter((p) => {
      try {
        const st = fs.statSync(p);
        return st.isFile() && st.size > 0 && st.mtimeMs >= since - 1000;
      } catch (_err) {
        return false;
      }
    })
    .sort();
}

/** Metadata for one exported file, as the portal receives it. */
function fileEntry(job, filePath, key) {
  const st = fs.statSync(filePath);
  return {
    key,
    fileName: path.basename(filePath),
    kind: job.kind || 'final',
    label: job.label || null,
    deliverableId: job.profileId || null,
    deliverableName: job.profileName || null,
    timeline: job.timeline || null,
    format: job.format || null,
    codec: job.codec || null,
    width: job.settings && job.settings.FormatWidth ? Number(job.settings.FormatWidth) : null,
    height: job.settings && job.settings.FormatHeight ? Number(job.settings.FormatHeight) : null,
    tcIn: job.mark ? job.mark.tcIn : null,
    tcOut: job.mark ? job.mark.tcOut : null,
    durationFrames: job.mark ? job.mark.durationFrames : null,
    markIndex: job.mark ? job.mark.index : null,
    bytes: st.size,
    modifiedAt: new Date(st.mtimeMs).toISOString(),
  };
}

/**
 * Everything about a finished batch: one entry per output file found on disk
 * (with its local path and job id for the upload), what was expected but not
 * found, and the batch's own facts. `frames` is the timeline length, so a
 * final's duration can be told to the portal.
 */
function buildManifest({ project, timeline, jobs, namePattern, exportxVersion, fps, frames }, { since = 0 } = {}) {
  const files = [];
  const missing = [];
  for (const job of jobs) {
    const outputs = findOutputs(job.targetDir, job.fileName, { since });
    if (!outputs.length) {
      missing.push({ jobId: job.jobId, fileName: job.fileName, targetDir: job.targetDir });
      continue;
    }
    outputs.forEach((p, i) => {
      const key = outputs.length > 1 ? `${job.jobId}-${i + 1}` : job.jobId;
      files.push({ ...fileEntry(job, p, key), path: p, jobId: job.jobId });
    });
  }
  const manifest = {
    source: 'exportx',
    exportxVersion: exportxVersion || null,
    project: project || null,
    timeline: timeline || null,
    fps: fps || null,
    frames: frames || null,
    exportedAt: new Date().toISOString(),
    namePattern: namePattern || null,
    batchId: `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(4).toString('hex')}`,
    files: files.map(({ path: _p, jobId: _j, ...rest }) => rest), // eslint-disable-line no-unused-vars
  };
  return { manifest, files, missing };
}

/** The register call for one file: what the portal needs to file it and show it. */
function registerInput(manifest, file, { contentType } = {}) {
  const fps = manifest.fps || null;
  let duration;
  if (file.kind === 'cut' && file.durationFrames && fps) duration = Math.round((file.durationFrames / fps) * 100) / 100;
  else if (file.kind === 'final' && manifest.frames && fps) duration = Math.round((manifest.frames / fps) * 100) / 100;
  return {
    fileName: file.fileName,
    kind: file.kind,
    size_bytes: file.bytes,
    content_type: contentType || contentTypeFor(file.fileName),
    ...(file.width && file.height ? { width: file.width, height: file.height } : {}),
    ...(duration ? { duration_seconds: duration } : {}),
    ...(file.deliverableName ? { deliverableName: file.deliverableName } : {}),
    meta: {
      kind: file.kind,
      deliverableId: file.deliverableId,
      deliverableName: file.deliverableName,
      label: file.label,
      fileName: file.fileName,
      timeline: file.timeline || manifest.timeline,
      resolveProject: manifest.project,
      format: file.format,
      codec: file.codec,
      fps,
      tcIn: file.tcIn,
      tcOut: file.tcOut,
      durationFrames: file.durationFrames,
      markIndex: file.markIndex,
      batchId: manifest.batchId,
      exportxVersion: manifest.exportxVersion,
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class PortalClient {
  constructor({ portalUrl, token, timeoutMs = 60000, userAgent = 'ExportX', parallelParts = PART_PARALLEL } = {}) {
    this.base = normalizeBaseUrl(portalUrl);
    this.token = String(token || '').trim();
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent;
    this.parallelParts = Math.max(1, parallelParts);
  }

  /** A JSON call to the portal, with the key. */
  _json(method, urlPath, body) {
    const url = new URL(this.base + urlPath);
    const lib = url.protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
      const headers = { Accept: 'application/json', 'User-Agent': this.userAgent };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      let payload = null;
      if (body !== undefined) {
        payload = Buffer.from(JSON.stringify(body));
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(payload.length);
      }
      const req = lib.request(url, { method, headers, timeout: this.timeoutMs }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (_err) {
            json = null;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json || { ok: true });
          } else {
            const msg = (json && (json.message || json.error)) || `${res.statusCode} ${res.statusMessage || ''}`.trim();
            reject(new PortalError(`Portal: ${msg}`, { status: res.statusCode, body: json || text, code: json && json.error ? json.error : undefined }));
          }
        });
      });
      req.on('timeout', () => req.destroy(new PortalError(`Portal ${method} ${urlPath}: timed out`)));
      req.on('error', (err) => reject(err instanceof PortalError ? err : new PortalError(`Portal ${method} ${urlPath}: ${err.message}`)));
      if (payload) req.end(payload);
      else req.end();
    });
  }

  /**
   * PUT a slice of a file to a signed address (no key: the URL carries the
   * signature). Resolves with the ETag the store answered, which a multipart
   * upload needs to close.
   */
  _putSlice(url, filePath, start, end, { contentType = null, extraHeaders = {}, onProgress = null } = {}) {
    const target = new URL(url);
    const lib = target.protocol === 'http:' ? http : https;
    const total = end - start;
    return new Promise((resolve, reject) => {
      const headers = { 'Content-Length': String(total), 'User-Agent': this.userAgent, ...extraHeaders };
      if (contentType) headers['Content-Type'] = contentType;
      const req = lib.request(target, { method: 'PUT', headers, timeout: this.timeoutMs }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ etag: res.headers.etag || res.headers.ETag || null, status: res.statusCode });
          } else {
            const text = Buffer.concat(chunks).toString('utf8').slice(0, 200);
            reject(new PortalError(`The file store answered ${res.statusCode}${text ? `: ${text}` : ''}`, { status: res.statusCode }));
          }
        });
      });
      req.on('timeout', () => req.destroy(new PortalError('The upload stalled (no bytes accepted for a minute)')));
      req.on('error', (err) => reject(err instanceof PortalError ? err : new PortalError(`Upload failed: ${err.message}`)));
      if (total === 0) {
        req.end();
        return;
      }
      const stream = fs.createReadStream(filePath, { start, end: end - 1 });
      let sent = 0;
      stream.on('data', (chunk) => {
        sent += chunk.length;
        if (onProgress) onProgress(sent);
      });
      stream.on('error', (err) => req.destroy(new PortalError(`Could not read the file: ${err.message}`)));
      stream.pipe(req);
    });
  }

  async _putWithRetry(url, filePath, start, end, opts) {
    let last = null;
    for (let attempt = 0; attempt < PART_RETRIES; attempt += 1) {
      try {
        return await this._putSlice(url, filePath, start, end, opts);
      } catch (err) {
        last = err;
        const status = err && err.status;
        const retry = !status || status >= 500 || status === 408 || status === 429;
        if (!retry) throw err;
        await sleep(800 * 2 ** attempt);
      }
    }
    throw last;
  }

  // ---- the portal's calls

  ping() {
    return this._json('GET', API.ping);
  }

  async projects() {
    const res = await this._json('GET', API.projects);
    const list = Array.isArray(res.projects) ? res.projects : [];
    return list.map((p) => ({ id: String(p.id), name: String(p.name || p.id), client: p.client ? String(p.client) : '', jobNumber: p.jobNumber || null, stage: p.stage || null, createdAt: p.createdAt || null }));
  }

  projectFiles(projectId) {
    return this._json('GET', `${API.deliverables}?projectId=${encodeURIComponent(projectId)}`);
  }

  planUpload(projectId, { filename, size, contentType, small, path: existing, kind }) {
    return this._json('POST', API.deliverables, { action: 'upload_url', projectId, filename, size, contentType, ...(small ? { small: true } : {}), ...(existing ? { path: existing } : {}), ...(kind ? { kind } : {}) });
  }

  completeUpload(projectId, uploadPath, uploadId, parts) {
    return this._json('POST', API.deliverables, { action: 'complete_upload', projectId, path: uploadPath, uploadId, parts });
  }

  register(projectId, input) {
    return this._json('POST', API.deliverables, { action: 'register', projectId, ...input });
  }

  batch(projectId, summary) {
    return this._json('POST', API.deliverables, { action: 'batch', projectId, ...summary });
  }

  /**
   * One file into the project's folder, the way the portal's plan says.
   * Resolves with the stored path. onProgress gets { sent, total, percent }.
   */
  async uploadFile(projectId, filePath, { fileName, contentType, onProgress = () => {} } = {}) {
    const name = fileName || path.basename(filePath);
    const type = contentType || contentTypeFor(name);
    const total = fs.statSync(filePath).size;
    const report = (sent) => onProgress({ sent, total, percent: total ? Math.min(100, Math.round((sent / total) * 100)) : 100 });
    let plan = await this.planUpload(projectId, { filename: name, size: total, contentType: type });
    if (plan.mode === 'tus') {
      // Supabase's resumable upload needs a browser session; one signed PUT does not.
      plan = await this.planUpload(projectId, { filename: name, size: total, contentType: type, small: true, path: plan.path });
    }
    if (!plan.path || !plan.mode) throw new PortalError('The portal did not say where to put the file');

    if (plan.mode === 'put') {
      const url = plan.url || plan.signedUrl;
      if (!url) throw new PortalError('The portal gave a PUT plan without an address');
      await this._putWithRetry(url, filePath, 0, total, { contentType: type, extraHeaders: { 'x-upsert': 'true' }, onProgress: report });
      report(total);
      return plan.path;
    }

    if (plan.mode !== 'multipart') throw new PortalError(`The portal asked for an upload mode this plugin does not speak (${plan.mode})`);
    const parts = Array.isArray(plan.parts) ? plan.parts : [];
    const partSize = Number(plan.partSize) || 0;
    if (!parts.length || !partSize || !plan.uploadId) throw new PortalError('The portal gave an incomplete multipart plan');
    const sentByPart = new Map();
    const progress = () => {
      let sum = 0;
      for (const v of sentByPart.values()) sum += v;
      report(Math.min(total, sum));
    };
    const receipts = [];
    let next = 0;
    const worker = async () => {
      while (next < parts.length) {
        const part = parts[next++];
        const start = (part.partNumber - 1) * partSize;
        const end = Math.min(start + partSize, total);
        const { etag } = await this._putWithRetry(part.url, filePath, start, end, {
          onProgress: (sent) => {
            sentByPart.set(part.partNumber, sent);
            progress();
          },
        });
        if (!etag) throw new PortalError("A part uploaded but its receipt (ETag) did not come back; the bucket's CORS rule has to expose ETag");
        sentByPart.set(part.partNumber, end - start);
        progress();
        receipts.push({ partNumber: part.partNumber, etag });
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.parallelParts, parts.length) }, worker));
    receipts.sort((a, b) => a.partNumber - b.partNumber);
    await this.completeUpload(projectId, plan.path, plan.uploadId, receipts);
    report(total);
    return plan.path;
  }

  /**
   * The whole batch into one project: every file uploaded and registered (filed
   * into a Delivery box by the portal), then the batch note.
   * onFile({ key, state: 'uploading'|'uploaded'|'failed', percent, label, box, error })
   */
  async uploadBatch(manifestBundle, { projectId, onFile = () => {} } = {}) {
    const { manifest, files } = manifestBundle;
    if (!projectId) throw new PortalError('Pick the portal project the files go in first');
    if (!files.length) throw new PortalError('Nothing to upload: no finished files were found on disk');
    const uploaded = [];
    const failed = [];
    let bytes = 0;
    for (const f of files) {
      onFile({ key: f.key, state: 'uploading', percent: 0 });
      try {
        const contentType = contentTypeFor(f.fileName);
        const storedPath = await this.uploadFile(projectId, f.path, {
          fileName: f.fileName,
          contentType,
          onProgress: (p) => onFile({ key: f.key, state: 'uploading', percent: p.percent }),
        });
        const reg = await this.register(projectId, { file_path: storedPath, ...registerInput(manifest, f, { contentType }) });
        uploaded.push(reg.label || f.fileName);
        bytes += f.bytes;
        onFile({ key: f.key, state: 'uploaded', percent: 100, label: reg.label || null, box: reg.box ? reg.box.name : null, id: reg.id || null });
      } catch (err) {
        failed.push({ label: f.fileName, error: err.message });
        onFile({ key: f.key, state: 'failed', percent: 0, error: err.message });
      }
    }
    let done = { url: null };
    try {
      done = await this.batch(projectId, { batchId: manifest.batchId, resolveProject: manifest.project || undefined, timeline: manifest.timeline || undefined, uploaded, failed, bytes });
    } catch (err) {
      // The files are on the portal; only the note failed. Say so, but do not fail the batch.
      failed.push({ label: '(batch note)', error: err.message });
    }
    return { batchId: manifest.batchId, projectId, uploaded, failed, bytes, url: done.url || `${this.base}/projects/${encodeURIComponent(projectId)}/delivery` };
  }
}

module.exports = { PortalClient, PortalError, normalizeBaseUrl, findOutputs, fileEntry, buildManifest, registerInput, contentTypeFor, API, PROTOCOL_VERSION };
