'use strict';

/**
 * PortalClient: pushes finished exports to the Triptych Studios portal (or any
 * server that implements the small ExportX ingest API in portal-kit/).
 *
 * Protocol (v1), all requests carry `Authorization: Bearer <token>`:
 *   GET  {base}/ping                            -> { ok, portal, version, categories? }
 *   POST {base}/batches            (JSON)       -> { ok, batchId }
 *   PUT  {base}/batches/{id}/files/{key}        -> { ok, fileId }   raw bytes, Content-Length set
 *   POST {base}/batches/{id}/complete (JSON)    -> { ok, batchId, url? }
 *
 * {base} is the portal URL plus /api/exportx unless the URL already ends with it.
 * Files stream from disk; onProgress gets { sent, total, percent }.
 * No third-party dependencies, so it runs inside Resolve's Electron untouched.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const API_SUFFIX = '/api/exportx';

class PortalError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'PortalError';
    if (status !== undefined) this.status = status;
    if (body !== undefined) this.body = body;
  }
}

function normalizeBaseUrl(portalUrl) {
  let u = String(portalUrl || '').trim();
  if (!u) throw new PortalError('No portal URL is set (Settings › Portal)');
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  u = u.replace(/\/+$/, '');
  if (!u.toLowerCase().endsWith(API_SUFFIX)) u += API_SUFFIX;
  return u;
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

/** Build the manifest for a finished batch: one entry per output file found on disk. */
function buildManifest({ project, timeline, jobs, namePattern, exportxVersion, category, fps }, { since = 0 } = {}) {
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
    exportedAt: new Date().toISOString(),
    namePattern: namePattern || null,
    category: category || null,
    files: files.map(({ path: _p, jobId: _j, ...rest }) => rest), // eslint-disable-line no-unused-vars
  };
  return { manifest, files, missing };
}

class PortalClient {
  constructor({ portalUrl, token, timeoutMs = 30000, userAgent = 'ExportX' } = {}) {
    this.base = normalizeBaseUrl(portalUrl);
    this.token = String(token || '');
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent;
  }

  _headers(extra = {}) {
    const h = { Accept: 'application/json', 'User-Agent': this.userAgent, ...extra };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  _request(method, urlPath, { body = null, headers = {}, stream = null, contentLength = null, onProgress = null } = {}) {
    const url = new URL(this.base + urlPath);
    const lib = url.protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
      const h = this._headers(headers);
      let payload = null;
      if (body !== null) {
        payload = Buffer.from(JSON.stringify(body));
        h['Content-Type'] = 'application/json';
        h['Content-Length'] = String(payload.length);
      } else if (stream) {
        h['Content-Type'] = h['Content-Type'] || 'application/octet-stream';
        if (contentLength !== null) h['Content-Length'] = String(contentLength);
      }
      const req = lib.request(url, { method, headers: h, timeout: this.timeoutMs }, (res) => {
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
            const msg = (json && (json.error || json.message)) || `${res.statusCode} ${res.statusMessage || ''}`.trim();
            reject(new PortalError(`Portal ${method} ${urlPath}: ${msg}`, { status: res.statusCode, body: json || text }));
          }
        });
      });
      req.on('timeout', () => req.destroy(new PortalError(`Portal ${method} ${urlPath}: timed out`)));
      req.on('error', (err) => reject(err instanceof PortalError ? err : new PortalError(`Portal ${method} ${urlPath}: ${err.message}`)));
      if (payload) {
        req.end(payload);
      } else if (stream) {
        let sent = 0;
        stream.on('data', (chunk) => {
          sent += chunk.length;
          if (onProgress) onProgress({ sent, total: contentLength, percent: contentLength ? Math.min(100, Math.round((sent / contentLength) * 100)) : 0 });
        });
        stream.on('error', (err) => req.destroy(new PortalError(`Could not read file: ${err.message}`)));
        stream.pipe(req);
      } else {
        req.end();
      }
    });
  }

  ping() {
    return this._request('GET', '/ping');
  }

  createBatch(manifest) {
    return this._request('POST', '/batches', { body: manifest });
  }

  uploadFile(batchId, key, filePath, { onProgress } = {}) {
    const size = fs.statSync(filePath).size;
    return this._request('PUT', `/batches/${encodeURIComponent(batchId)}/files/${encodeURIComponent(key)}`, {
      stream: fs.createReadStream(filePath),
      contentLength: size,
      headers: { 'X-ExportX-Filename': encodeURIComponent(path.basename(filePath)) },
      onProgress,
    });
  }

  completeBatch(batchId, summary) {
    return this._request('POST', `/batches/${encodeURIComponent(batchId)}/complete`, { body: summary || {} });
  }

  /**
   * The whole flow: create the batch, upload every file, complete it.
   * onFile({ key, state: 'uploading'|'uploaded'|'failed', percent, error, fileId, url })
   */
  async uploadBatch(manifestBundle, { onFile = () => {} } = {}) {
    const { manifest, files } = manifestBundle;
    if (!files.length) throw new PortalError('Nothing to upload: no finished files were found on disk');
    const created = await this.createBatch(manifest);
    const batchId = created.batchId || created.id;
    if (!batchId) throw new PortalError('The portal did not return a batchId');
    const uploaded = [];
    const failed = [];
    for (const f of files) {
      onFile({ key: f.key, state: 'uploading', percent: 0 });
      try {
        const res = await this.uploadFile(batchId, f.key, f.path, {
          onProgress: (p) => onFile({ key: f.key, state: 'uploading', percent: p.percent }),
        });
        uploaded.push(f.key);
        onFile({ key: f.key, state: 'uploaded', percent: 100, fileId: res.fileId || null, url: res.url || null });
      } catch (err) {
        failed.push({ key: f.key, error: err.message });
        onFile({ key: f.key, state: 'failed', percent: 0, error: err.message });
      }
    }
    const done = await this.completeBatch(batchId, { uploaded, failed });
    return { batchId, uploaded, failed, url: done.url || null, portal: done };
  }
}

module.exports = { PortalClient, PortalError, normalizeBaseUrl, findOutputs, fileEntry, buildManifest, API_SUFFIX };
