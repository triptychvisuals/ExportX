#!/usr/bin/env node
'use strict';

/**
 * ExportX ingest: reference server.
 *
 * A dependency-free Node server that implements the ExportX portal API (v1)
 * and writes every batch into an inbox folder. Use it to test ExportX before
 * the real portal endpoints exist, and as the executable spec for them.
 *
 *   node server.js --port 8787 --token devtoken --inbox ./exportx-inbox
 *
 * Endpoints (all under /api/exportx, all require "Authorization: Bearer <token>"):
 *   GET  /ping                          -> { ok, portal, version, categories }
 *   POST /batches                       -> { ok, batchId }            body: manifest JSON
 *   PUT  /batches/:id/files/:key        -> { ok, fileId, bytes }      body: raw file bytes
 *   POST /batches/:id/complete          -> { ok, batchId, url }       body: { uploaded, failed }
 *   GET  /batches                       -> { ok, batches: [...] }     (convenience for the UI)
 *   GET  /batches/:id                   -> { ok, batch }
 *
 * Inbox layout: <inbox>/<batchId>/manifest.json, <inbox>/<batchId>/files/<fileName>, status.json
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = '/api/exportx';

function parseArgs(argv) {
  const out = { port: Number(process.env.PORT) || 8787, token: process.env.EXPORTX_TOKEN || 'devtoken', inbox: process.env.EXPORTX_INBOX || path.join(process.cwd(), 'exportx-inbox'), name: 'Triptych Studios (reference)' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--token') out.token = argv[++i];
    else if (a === '--inbox') out.inbox = path.resolve(argv[++i]);
    else if (a === '--name') out.name = argv[++i];
  }
  return out;
}

const DEFAULT_CATEGORIES = [
  { id: 'commercial', name: 'Commercial' },
  { id: 'music-video', name: 'Music video' },
  { id: 'social', name: 'Social' },
  { id: 'event', name: 'Event' },
  { id: 'stills', name: 'Stills' },
];

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (err) {
        reject(new Error(`Invalid JSON: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function safeName(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '') || 'file';
}

function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object') return ['manifest must be a JSON object'];
  if (m.source !== 'exportx') errors.push('source must be "exportx"');
  if (!m.project) errors.push('project is required');
  if (!Array.isArray(m.files) || !m.files.length) errors.push('files must be a non-empty array');
  else {
    const keys = new Set();
    m.files.forEach((f, i) => {
      if (!f || typeof f !== 'object') return errors.push(`files[${i}] must be an object`);
      if (!f.key) errors.push(`files[${i}].key is required`);
      else if (keys.has(f.key)) errors.push(`files[${i}].key "${f.key}" is duplicated`);
      keys.add(f.key);
      if (!f.fileName) errors.push(`files[${i}].fileName is required`);
      if (!['final', 'cut', 'still'].includes(f.kind)) errors.push(`files[${i}].kind must be final, cut or still`);
      if (typeof f.bytes !== 'number' || f.bytes < 0) errors.push(`files[${i}].bytes must be a number`);
      return undefined;
    });
  }
  return errors;
}

function createServer(options = {}) {
  const opts = { ...parseArgs([]), ...options };
  fs.mkdirSync(opts.inbox, { recursive: true });
  const batches = new Map(); // batchId -> { manifest, receivedAt, files: Map(key -> {fileId, path, bytes}), status }

  function batchDir(id) {
    return path.join(opts.inbox, id);
  }

  function persist(id) {
    const b = batches.get(id);
    if (!b) return;
    fs.writeFileSync(path.join(batchDir(id), 'status.json'), JSON.stringify({ status: b.status, receivedAt: b.receivedAt, completedAt: b.completedAt || null, files: [...b.files.values()].map(({ path: p, ...rest }) => rest) }, null, 2)); // eslint-disable-line no-unused-vars
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (!url.pathname.startsWith(API)) return send(res, 404, { ok: false, error: 'Not found' });
    const auth = req.headers.authorization || '';
    if (opts.token && auth !== `Bearer ${opts.token}`) return send(res, 401, { ok: false, error: 'Invalid or missing bearer token' });
    const rel = url.pathname.slice(API.length).replace(/\/+$/, '') || '/';
    const parts = rel.split('/').filter(Boolean);

    try {
      if (req.method === 'GET' && rel === '/ping') {
        return send(res, 200, { ok: true, portal: opts.name, version: '1', categories: opts.categories || DEFAULT_CATEGORIES });
      }

      if (req.method === 'GET' && rel === '/batches') {
        return send(res, 200, { ok: true, batches: [...batches.entries()].map(([id, b]) => ({ batchId: id, project: b.manifest.project, timeline: b.manifest.timeline, status: b.status, files: b.manifest.files.length, receivedAt: b.receivedAt })) });
      }

      if (req.method === 'POST' && rel === '/batches') {
        const manifest = await readJson(req);
        const errors = validateManifest(manifest);
        if (errors.length) return send(res, 400, { ok: false, error: errors.join('; ') });
        const batchId = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(4).toString('hex')}`;
        fs.mkdirSync(path.join(batchDir(batchId), 'files'), { recursive: true });
        fs.writeFileSync(path.join(batchDir(batchId), 'manifest.json'), JSON.stringify(manifest, null, 2));
        batches.set(batchId, { manifest, receivedAt: new Date().toISOString(), files: new Map(), status: 'uploading' });
        persist(batchId);
        console.log(`[exportx] batch ${batchId}: ${manifest.project} / ${manifest.timeline} · ${manifest.files.length} file(s)`);
        return send(res, 201, { ok: true, batchId });
      }

      if (parts[0] === 'batches' && parts[1]) {
        const id = decodeURIComponent(parts[1]);
        const b = batches.get(id);
        if (!b) return send(res, 404, { ok: false, error: `Unknown batch ${id}` });

        if (req.method === 'GET' && parts.length === 2) {
          return send(res, 200, { ok: true, batch: { batchId: id, status: b.status, manifest: b.manifest, files: [...b.files.values()].map(({ path: p, ...rest }) => rest) } }); // eslint-disable-line no-unused-vars
        }

        if (req.method === 'PUT' && parts[2] === 'files' && parts[3]) {
          const key = decodeURIComponent(parts[3]);
          const entry = b.manifest.files.find((f) => f.key === key);
          if (!entry) return send(res, 400, { ok: false, error: `Key "${key}" is not in the batch manifest` });
          const headerName = req.headers['x-exportx-filename'] ? decodeURIComponent(String(req.headers['x-exportx-filename'])) : entry.fileName;
          const target = path.join(batchDir(id), 'files', safeName(headerName));
          const expected = Number(req.headers['content-length']) || null;
          let bytes = 0;
          await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(target);
            req.on('data', (c) => {
              bytes += c.length;
            });
            req.on('error', reject);
            out.on('error', reject);
            out.on('finish', resolve);
            req.pipe(out);
          });
          if (expected !== null && bytes !== expected) {
            fs.unlinkSync(target);
            return send(res, 400, { ok: false, error: `Received ${bytes} bytes, expected ${expected}` });
          }
          const fileId = crypto.createHash('sha1').update(`${id}:${key}`).digest('hex').slice(0, 16);
          b.files.set(key, { key, fileId, fileName: path.basename(target), bytes, path: target, receivedAt: new Date().toISOString() });
          persist(id);
          console.log(`[exportx]   ${key} → ${path.basename(target)} (${bytes} bytes)`);
          return send(res, 201, { ok: true, fileId, bytes });
        }

        if (req.method === 'POST' && parts[2] === 'complete') {
          const body = await readJson(req);
          b.status = (body.failed && body.failed.length) ? 'partial' : 'complete';
          b.completedAt = new Date().toISOString();
          b.summary = body;
          persist(id);
          console.log(`[exportx] batch ${id} ${b.status}: ${(body.uploaded || []).length} uploaded, ${(body.failed || []).length} failed`);
          return send(res, 200, { ok: true, batchId: id, status: b.status, url: `${opts.publicUrl || `http://localhost:${opts.port}`}/batches/${id}` });
        }
      }
      return send(res, 404, { ok: false, error: `No route for ${req.method} ${rel}` });
    } catch (err) {
      return send(res, 500, { ok: false, error: err.message });
    }
  });

  server.inbox = opts.inbox;
  server.batches = batches;
  return server;
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  const server = createServer(opts);
  server.listen(opts.port, () => {
    console.log(`ExportX reference portal listening on http://localhost:${opts.port}${API}`);
    console.log(`token: ${opts.token}   inbox: ${opts.inbox}`);
    console.log('In ExportX › Settings › Portal, set the URL to http://localhost:' + opts.port + ' and the token above.');
  });
}

module.exports = { createServer, validateManifest, DEFAULT_CATEGORIES, API };
