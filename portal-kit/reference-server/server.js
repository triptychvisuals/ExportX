#!/usr/bin/env node
'use strict';

/**
 * A stand-in for the Triptych Studios portal's plugin API (v2), to test
 * ExportX without the real portal. It answers the same routes with the
 * same shapes (see ../README.md and, in the portal repository,
 * docs/exportx-api.md), plays the file store itself, and writes every
 * project's files to an inbox folder.
 *
 *   node server.js --port 8787 --token devtoken --inbox ./exportx-inbox [--storage put|multipart] [--part-size-mb 5]
 *
 * Routes (all under the portal's address; the plugin ones need "Authorization: Bearer <token>"):
 *   GET  /api/plugin/ping                         -> { ok, portal, version: '2', key, storage, url }
 *   GET  /api/plugin/projects                     -> { projects: [{ id, name, client, jobNumber, stage, createdAt }] }
 *   GET  /api/plugin/deliverables?projectId=…     -> { project, boxes, files, readyAt, storage }
 *   POST /api/plugin/deliverables                 -> actions upload_url | complete_upload | register | batch
 *   PUT  /_store/<path>?sig=…[&uploadId=…&partNumber=n]   the "presigned" address the plans point at (no bearer)
 *   GET  /projects/<id>/delivery                  a page listing what landed (what the plugin opens)
 *
 * Inbox layout: <inbox>/<projectId>/files/<fileName>, <inbox>/<projectId>/deliverables.json,
 *               <inbox>/<projectId>/batches/<batchId>.json
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API_VERSION = '2';

const DEFAULT_PROJECTS = [
  { id: 'proj-spota', name: 'SpotA Launch', client: 'Acme Beverages', jobNumber: 'TRP-2026-4821', stage: 'post', createdAt: '2026-10-10T12:00:00.000Z', boxes: [{ name: 'Hero cut 16:9', spec: 'ProRes 422 HQ, 4K' }, { name: 'Social cutdowns', spec: '9:16, 30s' }, { name: 'Stills', spec: '10 graded frames' }] },
  { id: 'proj-gls', name: 'Ghetto Love Story', client: 'Kiraly Payne', jobNumber: 'TRP-2026-3310', stage: 'post', createdAt: '2026-10-08T16:00:04.986Z', boxes: [{ name: 'Music video', spec: 'ProRes 4K' }, { name: 'Vertical cut', spec: '9:16' }] },
  { id: 'proj-night', name: 'Night Drive', client: 'Halcyon Records', jobNumber: 'TRP-2026-2207', stage: 'production', createdAt: '2026-09-30T10:00:00.000Z', boxes: [] },
];

/** Words that make a box the home for each kind; the portal's lib/client-flow/exportx.ts has the same table. */
const BOX_WORDS = {
  still: [/\b(stills?|photos?|frames?|thumbnails?|artwork|poster|cover|key ?art|grabs?)\b/i],
  cut: [/\b(social|cut ?downs?|cutdowns?|vertical|9:16|1:1|4:5|teasers?|snippets?|clips?|reels?|shorts?|tiktok|instagram|ig\b|stories)\b/i],
  final: [/\b(final|master|hero|main|full|feature|film|video|16:9|4k|uhd|prores|deliver(y|able))\b/i],
};

function boxForKind(kind, boxes) {
  const says = (text, k) => BOX_WORDS[k].some((re) => re.test(text));
  const claimedByAnother = (text) => (kind !== 'cut' && says(text, 'cut')) || (kind !== 'still' && says(text, 'still'));
  for (const field of ['name', 'spec']) {
    for (const b of boxes) {
      const text = String(b[field] || '').trim();
      if (text && says(text, kind) && !claimedByAnother(text)) return b;
    }
  }
  return null;
}

function fileLabel(boxName, fileName, deliverableName) {
  const box = (boxName || '').trim() || (deliverableName || '').trim() || 'ExportX';
  const label = fileName && fileName !== box ? `${box} · ${fileName}` : box;
  return label.length > 120 ? `${label.slice(0, 117)}...` : label;
}

function parseArgs(argv) {
  const out = {
    port: Number(process.env.PORT) || 8787,
    token: process.env.EXPORTX_TOKEN || 'devtoken',
    inbox: process.env.EXPORTX_INBOX || path.join(process.cwd(), 'exportx-inbox'),
    storage: process.env.EXPORTX_STORAGE || 'put',
    partSizeMb: Number(process.env.EXPORTX_PART_MB) || 5,
    name: 'Triptych Studios (reference)',
    projects: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--token') out.token = argv[++i];
    else if (a === '--inbox') out.inbox = path.resolve(argv[++i]);
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--storage') out.storage = argv[++i];
    else if (a === '--part-size-mb') out.partSizeMb = Number(argv[++i]);
    else if (a === '--projects') out.projects = JSON.parse(fs.readFileSync(argv[++i], 'utf8'));
  }
  return out;
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function fail(res, status, code, message) {
  return send(res, status, { error: code, message });
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
  return String(name || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'file';
}

/** The checks the portal makes on a register call (zod there); the same rules here, as a list of problems. */
function validateRegister(b) {
  const errors = [];
  if (!b || typeof b !== 'object') return ['body must be a JSON object'];
  if (!b.projectId) errors.push('projectId is required');
  if (!b.file_path) errors.push('file_path is required');
  if (!b.fileName) errors.push('fileName is required');
  if (!['final', 'cut', 'still'].includes(b.kind)) errors.push('kind must be final, cut or still');
  if (typeof b.size_bytes !== 'number' || b.size_bytes < 0) errors.push('size_bytes must be a number');
  if (b.meta !== undefined && (typeof b.meta !== 'object' || b.meta === null)) errors.push('meta must be an object');
  return errors;
}

function createServer(options = {}) {
  const opts = { ...parseArgs([]), ...options };
  fs.mkdirSync(opts.inbox, { recursive: true });
  const projects = (opts.projects || DEFAULT_PROJECTS).map((p) => ({ ...p, boxes: Array.isArray(p.boxes) ? p.boxes : [] }));
  const storeSecret = crypto.randomBytes(16).toString('hex');
  const uploads = new Map(); // uploadId -> { path, parts: Map(partNumber -> { file, etag }) }
  const partSize = Math.max(1, opts.partSizeMb) * 1024 * 1024;
  let publicUrl = opts.publicUrl || '';

  const projectDir = (id) => path.join(opts.inbox, safeName(id));
  const filesJson = (id) => path.join(projectDir(id), 'deliverables.json');
  const readFiles = (id) => {
    try {
      return JSON.parse(fs.readFileSync(filesJson(id), 'utf8'));
    } catch (_err) {
      return [];
    }
  };
  const writeFiles = (id, list) => {
    fs.mkdirSync(projectDir(id), { recursive: true });
    fs.writeFileSync(filesJson(id), JSON.stringify(list, null, 2));
  };
  const sig = (p) => crypto.createHmac('sha256', storeSecret).update(p).digest('hex').slice(0, 24);
  const storeUrl = (p, extra = '') => `${publicUrl}/_store/${p.split('/').map(encodeURIComponent).join('/')}?sig=${sig(p)}${extra}`;
  const boxesOf = (project) => {
    const files = readFiles(project.id);
    return project.boxes.map((b, i) => ({ id: `offer:${i}:${b.name.toLowerCase()}`, name: b.name, spec: b.spec || '', files: files.filter((f) => f.label === b.name || f.label.startsWith(`${b.name} · `)).length }));
  };
  const projectView = (p) => ({ id: p.id, name: p.name, client: p.client || '', jobNumber: p.jobNumber || null, stage: p.stage || null, createdAt: p.createdAt || null });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (!publicUrl) publicUrl = `http://${req.headers.host || `localhost:${opts.port}`}`;
    const parts = url.pathname.split('/').filter(Boolean);

    try {
      // ---- the "presigned" store: PUT bytes to a path, whole or as a part
      if (parts[0] === '_store') {
        const rel = decodeURIComponent(parts.slice(1).join('/'));
        if (req.method !== 'PUT') return fail(res, 405, 'method', 'PUT only');
        if (url.searchParams.get('sig') !== sig(rel)) return fail(res, 403, 'bad_signature', 'That upload address is not signed for this path');
        const projectId = rel.split('/')[1];
        const uploadId = url.searchParams.get('uploadId');
        const partNumber = Number(url.searchParams.get('partNumber'));
        const hash = crypto.createHash('md5');
        let bytes = 0;
        fs.mkdirSync(path.join(projectDir(projectId), 'files'), { recursive: true });
        const target = uploadId ? path.join(projectDir(projectId), 'files', `.${path.basename(rel)}.part${partNumber}`) : path.join(projectDir(projectId), 'files', path.basename(rel));
        await new Promise((resolve, reject) => {
          const out = fs.createWriteStream(target);
          req.on('data', (c) => {
            bytes += c.length;
            hash.update(c);
          });
          req.on('error', reject);
          out.on('error', reject);
          out.on('finish', resolve);
          req.pipe(out);
        });
        const expected = Number(req.headers['content-length']);
        if (Number.isFinite(expected) && expected !== bytes) {
          fs.unlinkSync(target);
          return fail(res, 400, 'short_body', `Received ${bytes} bytes, expected ${expected}`);
        }
        const etag = `"${hash.digest('hex')}"`;
        if (uploadId) {
          const up = uploads.get(uploadId);
          if (!up || up.path !== rel) {
            fs.unlinkSync(target);
            return fail(res, 404, 'unknown_upload', 'No such multipart upload');
          }
          up.parts.set(partNumber, { file: target, etag, bytes });
        }
        res.writeHead(200, { ETag: etag, 'Content-Length': '0' });
        return res.end();
      }

      // ---- a page the plugin opens
      if (req.method === 'GET' && parts[0] === 'projects' && parts[1] && parts[2] === 'delivery') {
        const project = projects.find((p) => p.id === decodeURIComponent(parts[1]));
        if (!project) return fail(res, 404, 'not_found', 'No such project');
        const files = readFiles(project.id);
        const html = `<!doctype html><meta charset="utf-8"><title>${project.name} · Delivery</title><body style="font:14px system-ui;padding:24px"><h1>${project.name} <small>${project.jobNumber || ''}</small></h1><p>Reference portal. ${files.length} file(s) from ExportX:</p><ul>${files.map((f) => `<li><b>${f.label}</b> · ${f.kind} · ${f.size_bytes} bytes</li>`).join('')}</ul></body>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }

      if (parts[0] !== 'api' || parts[1] !== 'plugin') return fail(res, 404, 'not_found', 'Not found');
      const auth = req.headers.authorization || '';
      const m = /^Bearer\s+(.+)$/i.exec(auth);
      if (!m) return fail(res, 401, 'missing_plugin_key', 'Send the plugin key as Authorization: Bearer tpx_…');
      if (m[1].trim() !== opts.token) return fail(res, 401, 'bad_plugin_key', 'That plugin key is not known. Make a new one under Settings > ExportX and paste it into the plugin.');
      const route = parts[2];

      if (req.method === 'GET' && route === 'ping') {
        return send(res, 200, { ok: true, portal: opts.name, version: API_VERSION, key: { label: 'reference key', prefix: `${opts.token.slice(0, 10)}` }, storage: opts.storage === 'multipart' ? 'r2' : 'supabase', url: publicUrl });
      }
      if (req.method === 'GET' && route === 'projects') {
        return send(res, 200, { projects: projects.map((p) => ({ ...projectView(p), footage: { clips: 0, sentAt: null, picksSentAt: null } })) });
      }
      if (route !== 'deliverables') return fail(res, 404, 'not_found', `No route for ${req.method} ${url.pathname}`);

      if (req.method === 'GET') {
        const id = url.searchParams.get('projectId') || '';
        const project = projects.find((p) => p.id === id);
        if (!project) return fail(res, 404, 'not_found', 'No such project. Refresh the project list in ExportX.');
        return send(res, 200, { project: projectView(project), boxes: boxesOf(project), files: readFiles(project.id).map((f) => ({ id: f.id, label: f.label, fileName: f.fileName, bytes: f.size_bytes, kind: f.kind, source: 'exportx', createdAt: f.createdAt })), readyAt: null, storage: opts.storage === 'multipart' ? 'r2' : 'supabase' });
      }
      if (req.method !== 'POST') return fail(res, 405, 'method', 'GET or POST');
      const body = await readJson(req);
      const project = projects.find((p) => p.id === body.projectId);
      if (!project) return fail(res, 404, 'not_found', 'No such project. Refresh the project list in ExportX.');

      switch (body.action) {
        case 'upload_url': {
          if (!body.filename || typeof body.size !== 'number') return fail(res, 400, 'invalid_body', 'filename and size are required');
          const rel = body.path || `deliverables/${project.id}/${Date.now().toString(36)}-${safeName(body.filename)}`;
          if (!rel.startsWith(`deliverables/${project.id}/`) || rel.includes('..')) return fail(res, 400, 'bad_path', 'That path is not in this project.');
          const small = body.kind === 'preview' || body.small === true;
          if (opts.storage === 'multipart' && !small) {
            const uploadId = crypto.randomBytes(8).toString('hex');
            uploads.set(uploadId, { path: rel, parts: new Map() });
            const count = Math.max(1, Math.ceil(body.size / partSize));
            const urls = [];
            for (let n = 1; n <= count; n += 1) urls.push({ partNumber: n, url: storeUrl(rel, `&uploadId=${uploadId}&partNumber=${n}`) });
            return send(res, 200, { mode: 'multipart', path: rel, uploadId, partSize, parts: urls });
          }
          if (opts.storage === 'tus' && !small) return send(res, 200, { mode: 'tus', bucket: 'client-files', path: rel });
          return send(res, 200, { mode: 'put', path: rel, url: storeUrl(rel) });
        }
        case 'complete_upload': {
          const up = uploads.get(body.uploadId);
          if (!up || up.path !== body.path) return fail(res, 404, 'unknown_upload', 'No such multipart upload');
          const wanted = Array.isArray(body.parts) ? [...body.parts].sort((a, b) => a.partNumber - b.partNumber) : [];
          if (!wanted.length) return fail(res, 400, 'invalid_body', 'parts are required');
          const target = path.join(projectDir(project.id), 'files', path.basename(up.path));
          const out = fs.createWriteStream(target);
          for (const w of wanted) {
            const have = up.parts.get(w.partNumber);
            if (!have || have.etag !== w.etag) {
              out.destroy();
              return fail(res, 400, 'bad_part', `Part ${w.partNumber} is missing or its ETag does not match`);
            }
            await new Promise((resolve, reject) => {
              const rs = fs.createReadStream(have.file);
              rs.on('error', reject);
              rs.on('end', resolve);
              rs.pipe(out, { end: false });
            });
            fs.unlinkSync(have.file);
          }
          await new Promise((resolve) => out.end(resolve));
          uploads.delete(body.uploadId);
          return send(res, 200, { ok: true, path: up.path });
        }
        case 'register': {
          const errors = validateRegister(body);
          if (errors.length) return fail(res, 400, 'invalid_body', errors.join('; '));
          if (!body.file_path.startsWith(`deliverables/${project.id}/`)) return fail(res, 400, 'bad_path', 'That path is not in this project.');
          const stored = path.join(projectDir(project.id), 'files', path.basename(body.file_path));
          if (!fs.existsSync(stored)) return fail(res, 400, 'no_bytes', 'Nothing was uploaded to that path yet');
          const boxes = boxesOf(project);
          const wanted = body.box ? boxes.find((b) => b.name.toLowerCase() === String(body.box).trim().toLowerCase()) : null;
          const box = wanted || boxForKind(body.kind, boxes);
          const label = fileLabel(box ? box.name : null, body.fileName, body.deliverableName);
          const row = { id: crypto.randomUUID(), label, fileName: body.fileName, file_path: body.file_path, kind: body.kind, size_bytes: body.size_bytes, content_type: body.content_type || null, width: body.width || null, height: body.height || null, duration_seconds: body.duration_seconds || null, source: 'exportx', meta: { ...(body.meta || {}), kind: body.kind, fileName: body.fileName, deliverableName: body.deliverableName || null, box: box ? box.name : null }, createdAt: new Date().toISOString() };
          writeFiles(project.id, [...readFiles(project.id), row]);
          console.log(`[exportx] ${project.name}: ${label} (${body.size_bytes} bytes)`);
          return send(res, 200, { ok: true, id: row.id, label, box: box ? { id: box.id, name: box.name } : null });
        }
        case 'batch': {
          const dir = path.join(projectDir(project.id), 'batches');
          fs.mkdirSync(dir, { recursive: true });
          const id = safeName(body.batchId || Date.now().toString(36));
          fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ ...body, receivedAt: new Date().toISOString() }, null, 2));
          console.log(`[exportx] ${project.name}: batch ${id}, ${(body.uploaded || []).length} uploaded, ${(body.failed || []).length} failed`);
          return send(res, 200, { ok: true, url: `${publicUrl}/projects/${encodeURIComponent(project.id)}/delivery` });
        }
        default:
          return fail(res, 400, 'invalid_body', `Unknown action ${body.action}`);
      }
    } catch (err) {
      return fail(res, 500, 'internal', err.message);
    }
  });

  server.inbox = opts.inbox;
  server.projects = projects;
  server.readFiles = readFiles;
  return server;
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  const server = createServer(opts);
  server.listen(opts.port, () => {
    console.log(`ExportX reference portal listening on http://localhost:${opts.port} (plugin API v${API_VERSION}, ${opts.storage} uploads)`);
    console.log(`token: ${opts.token}   inbox: ${opts.inbox}`);
    console.log(`In ExportX › Settings › Portal, set the URL to http://localhost:${opts.port} and paste the token as the key.`);
  });
}

module.exports = { createServer, validateRegister, boxForKind, fileLabel, DEFAULT_PROJECTS, API_VERSION };
