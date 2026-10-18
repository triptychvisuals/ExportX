# ExportX portal kit

How **ExportX**, the DaVinci Resolve plugin, lands a batch of finished deliverables inside a project on the **Triptych Studios portal**, and the tools to test that without the real portal.

The portal side is **implemented** in the `triptych-portal` repository (plugin keys under Settings › ExportX, the routes under `app/api/plugin/`, the Delivery tab's boxes). Its own walk through is `docs/exportx-api.md` there; this folder mirrors the contract so the two repositories can be checked against each other, and ships a reference server that behaves like the portal.

```
ExportX (Resolve plugin)                                        The portal
───────────────────────                                         ──────────
GET  /api/plugin/ping                                  ───────► { ok, portal, version: "2", key, storage, url }
GET  /api/plugin/projects                              ───────► { projects: [{ id, name, client, jobNumber, stage }] }
GET  /api/plugin/deliverables?projectId=…              ───────► { project, boxes, files, readyAt, storage }
per file:
  POST /api/plugin/deliverables { action: "upload_url" }    ──► a plan: multipart (presigned parts) | put | tus
  PUT  the bytes where the plan says (signed URLs, no key)   ──► the file store (Cloudflare R2 or Supabase)
  POST /api/plugin/deliverables { action: "complete_upload" } (multipart only)
  POST /api/plugin/deliverables { action: "register" }      ──► filed into a Delivery box: { ok, id, label, box }
POST /api/plugin/deliverables { action: "batch" }      ───────► one note on the project: { ok, url }
```

## What is in this kit

| Path | What it is |
| --- | --- |
| `README.md` | This document: the flow, the calls, the filing rules, the notes. |
| `openapi.yaml` | OpenAPI 3.0 description of the plugin API (v2). |
| `schema/register.schema.json` | JSON Schema (draft-07) for the register call, the one with the most fields. |
| `examples/` | Real request and response bodies for every call. |
| `reference-server/server.js` | A dependency-free Node server that answers like the portal, plays the file store itself (single PUT, multipart parts, or a tus plan to exercise the fallback) and writes everything to an inbox folder. ExportX's tests run against it. |
| `client/portal.js` | The client ExportX ships (`src/portal.js` in the plugin). What the plugin sends, exactly. |
| `smoke/check-portal.js` | Runs the whole flow against **any** URL + key with generated files. Proves a portal (or a change to one) still speaks ExportX. |
| `smoke/curl.sh` | The same flow as `curl` commands, for a terminal. |

## Quick start (five minutes)

```bash
# 1. a portal on your machine
node reference-server/server.js --port 8787 --token devtoken --inbox ./exportx-inbox
#    add --storage multipart to hand out presigned-part plans like R2 does

# 2. in a second shell, push a fake batch at it
node smoke/check-portal.js http://localhost:8787 devtoken
ls exportx-inbox/proj-spota/                 # files/, deliverables.json, batches/

# 3. point the plugin at it: ExportX › Settings › Triptych Studios portal
#    URL http://localhost:8787, key devtoken, Test connection; then pick a project next to Export
```

Against the real portal: make a key under **Settings › ExportX** there, then `node smoke/check-portal.js https://portal.triptychstudios.co tpx_… --project <id>` (it lands three small files on that project's Delivery tab; remove them there afterwards).

## The flow, in detail

1. **Test connection** (Settings) calls `GET /ping` and `GET /projects`. The plugin remembers the portal's name, the key's label, and the project list.
2. Next to **Export everything** the plugin shows the switch *Upload to Triptych Studios when done* and, under it, **Into project**: the portal's projects (name · job number · client). The plugin pre-selects the project picked last time for this Resolve project, else one whose name matches, and will not export until one is chosen. The choice is remembered per Resolve project.
3. Resolve renders in the background. When every job has finished, the plugin looks at the output folder for each job's file (Resolve adds the extension and, for image sequences, a frame number).
4. For each file: `upload_url` → bytes → (`complete_upload`) → `register`. Files go one at a time, in order; parts of one file go three at a time. Per-file failures do not stop the batch.
5. `batch` writes one activity row on the project ("ExportX delivered 7 files (3.1 GB) from SpotA / Main Edit. Check the boxes, then send the final delivery.") and returns the Delivery tab's URL, which the plugin shows as *open on the portal*.
6. On the portal, each file sits in the box its kind matched (or under **Not in a box yet**); every file has a **Move to** picker. Nothing reaches the client until **Send the final delivery**.

## The calls

Base address: the portal's own (`https://portal.triptychstudios.co`). The plugin strips any `/api/…` path pasted into the URL field. Every plugin call carries `Authorization: Bearer tpx_…`; the PUTs to the file store carry no key (their URLs are signed). Every answer is JSON; errors are `{ "error": "code", "message": "what to do" }` with a 4xx/5xx status. The message is shown to the editor as is.

### `GET /api/plugin/ping`

```json
{ "ok": true, "portal": "Triptych Studios", "version": "2", "key": { "label": "ExportX on the edit bay", "prefix": "tpx_a1b2c3" }, "storage": "r2", "url": "https://portal.triptychstudios.co" }
```

`storage` is `r2` (presigned parts, any size) or `supabase` (one PUT a file; 50 MB each on the free plan).

### `GET /api/plugin/projects`

```json
{ "projects": [ { "id": "proj-muzq2ywy-ahaa", "name": "Ghetto Love Story", "client": "Kiraly Payne", "jobNumber": "TRP-2026-4821", "stage": "post", "createdAt": "2026-10-08T16:00:04.986Z" } ] }
```

Every live project not in the trash, newest first. `id` is what every other call takes as `projectId`.

### `GET /api/plugin/deliverables?projectId=…`

```json
{ "project": { "id": "proj-…", "name": "Ghetto Love Story", "jobNumber": "TRP-2026-4821", "stage": "post", "client": "Kiraly Payne" },
  "boxes": [ { "id": "offer:0:hero cut 16:9", "name": "Hero cut 16:9", "spec": "ProRes 422 HQ, 4K", "files": 0 } ],
  "files": [ { "id": "…", "label": "Hero cut 16:9 · hero.mov", "fileName": "hero.mov", "bytes": 2457600000, "kind": "video", "source": "portal", "createdAt": "…" } ],
  "readyAt": null, "storage": "r2" }
```

The boxes are the deliverables the offer promised. The plugin may name one per file (`box` in the register call) but does not have to.

### `POST /api/plugin/deliverables` `{ "action": "upload_url", … }`

Request: `{ "action": "upload_url", "projectId", "filename", "size", "contentType", "kind"?: "file" | "preview", "small"?: true, "path"?: "…" }`

One of three plans comes back:

| `mode` | What to do |
| --- | --- |
| `multipart` | `{ path, uploadId, partSize, parts: [{ partNumber, url }] }`. PUT each `partSize` slice to its URL (the last part is the remainder), `Content-Length` set, no key, no `Content-Type`. Keep each response's `ETag`. Then `complete_upload` with `{ path, uploadId, parts: [{ partNumber, etag }] }`. |
| `put` | `{ path, url }`. One PUT of the whole file with `Content-Type` set. |
| `tus` | Supabase's resumable upload, which needs a browser session. Ask again with `"small": true` and the same `"path"`; a `put` plan comes back. |

### `POST /api/plugin/deliverables` `{ "action": "register", … }`

See `examples/register.json` and `schema/register.schema.json`.

```json
{ "ok": true, "id": "…", "label": "Hero cut 16:9 · 261018_GLS_Final.mp4", "box": { "id": "offer:0:hero cut 16:9", "name": "Hero cut 16:9" } }
```

**Filing rules** (the portal's `lib/client-flow/exportx.ts`, mirrored in the reference server):

- `kind` is `final`, `cut` or `still`. When `box` is not given (or names no box), the portal picks the box whose name (then spec) fits the kind: finals go to a box saying final, master, hero, main, 4K, ProRes and the like; cuts to social, cutdowns, vertical, 9:16, teaser, reel; stills to stills, photos, frames, thumbnails, poster. A box that names cuts or stills is never taken by a final.
- The label is `"<Box> · <fileName>"`; the box a file is in is the part of its label before " · ". No box: the deliverable's own name stands in (`"Final 4K · 261018_GLS_Final.mp4"`), the file waits under **Not in a box yet**, and the studio moves it with one pick.
- `meta` is kept on the row as is (the portal adds `kind`, `fileName`, `deliverableName`, `box`, and the key's label). For cuts, `tcIn`, `tcOut` and `durationFrames` make the tab show the range.

### `POST /api/plugin/deliverables` `{ "action": "batch", … }`

Request: `{ "action": "batch", "projectId", "batchId"?, "resolveProject"?, "timeline"?, "uploaded": [labels], "failed": [{ label, error }], "bytes"? }`. Answer: `{ "ok": true, "url": "https://portal…/projects/<id>/delivery" }`.

## Errors

`401 missing_plugin_key` / `bad_plugin_key`: make a new key under Settings › ExportX. `404 not_found`: the project id is wrong or the project is in the trash (refresh the list). `400 bad_path`: the `file_path` is not in that project's folder (use the `path` the plan gave back). `502 storage_unreachable`: the file store refused; the message says which R2 setting to check. `503 not_configured`: the deployment has no service role key.

## Notes for anyone changing either side

- The plugin's client (`client/portal.js`) retries a part or a PUT four times on 5xx, 408, 429 and network errors, and gives up at once on other 4xx. A missing `ETag` on a part is an error that names the bucket's CORS rule.
- Progress is per file (`{ sent, total, percent }`) and overall; the plugin shows both, and the dock/taskbar icon mirrors the overall number.
- Registering the same path twice makes two rows: register once per upload. *Upload again* in the plugin makes a new batch (new files) rather than resuming.
- Protocol version is `2` (`ping.version`). Additive changes keep it; a breaking one becomes `3` and the plugin will say so in its log.
- Changing the contract means changing, together: the portal's routes and `docs/exportx-api.md`, this README, `openapi.yaml`, the schema, the reference server, `client/portal.js` (really `src/portal.js`), `python/exportx_batch.py`, and `test/portal.test.js`.
