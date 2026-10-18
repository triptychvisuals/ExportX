# ExportX portal kit

Everything the **Triptych Studios portal** needs to receive finished exports from ExportX, the DaVinci Resolve plugin.

ExportX renders a batch (final exports, social cuts, stills) with Resolve's engine and, when the *Upload to the portal when done* switch is on, pushes every finished file to the portal together with a **manifest**: project, timeline, deliverable, timecodes, size. The portal stores the batch, lets you **categorise** it (commercial, music video, social, event, stills, or whatever you define) and share it from there.

The whole protocol is **four HTTP calls** with a bearer token. No SDK, no multipart, no websockets.

```
ExportX (Resolve plugin)                         Your portal
───────────────────────                          ───────────
GET  /api/exportx/ping                 ───────►  { ok, portal, version, categories }
POST /api/exportx/batches  (manifest)  ───────►  { ok, batchId }
PUT  /api/exportx/batches/{id}/files/{key}  ──►  { ok, fileId }         × once per file, raw bytes
POST /api/exportx/batches/{id}/complete ──────►  { ok, batchId, url }
```

## What is in this kit

| Path | What it is |
| --- | --- |
| `README.md` | This document: protocol, data model, implementation notes. **Start here.** |
| `CLAUDE_CODE_PROMPT.md` | A prompt to paste into Claude Code inside the portal repository. It tells Claude what to build and how to verify it with the files in this kit. |
| `openapi.yaml` | OpenAPI 3.0 description of the API. Generate server stubs or clients from it, or load it into any API tool. |
| `schema/manifest.schema.json` | JSON Schema (draft-07) for the batch manifest. Validate incoming manifests with it. |
| `examples/` | Real request and response bodies: a manifest, the ping, errors, the complete call. |
| `reference-server/server.js` | A dependency-free Node server that implements the API and writes batches to an inbox folder. It is the executable spec and the fixture ExportX's own tests run against. |
| `client/portal.js` | The client ExportX ships (`src/portal.js` in the plugin). Read it to see exactly what the plugin sends; use it in your own tests. |
| `smoke/check-portal.js` | Runs a complete upload against **any** URL + token using that client, with generated files. Your implementation is done when this passes. |
| `smoke/curl.sh` | The same flow as four `curl` commands. |

## Quick start (five minutes)

```bash
# 1. run the reference server
node reference-server/server.js --port 8787 --token devtoken --inbox ./exportx-inbox

# 2. in a second shell, push a fake batch at it
node smoke/check-portal.js http://localhost:8787 devtoken
ls exportx-inbox/           # one folder per batch: manifest.json, files/, status.json

# 3. point the real plugin at it: ExportX › Settings › Triptych Studios portal
#    URL   http://localhost:8787      Token  devtoken      → Test connection
```

Then build the same four endpoints into the portal, and run `smoke/check-portal.js https://portal.example.com <token>` until it passes.

## The flow, in detail

1. **Test connection** (Settings) calls `GET /ping`. The response names the portal and lists the **categories** the plugin should offer. ExportX caches both.
2. The editor marks cuts and stills, presses **Export everything**. Resolve renders in the background.
3. When every job has finished, ExportX looks at the output folder for each job's file (Resolve adds the extension and, for image sequences, a frame number), and builds the **manifest** (one entry per file found).
4. `POST /batches` with the manifest. The portal validates it, creates the batch (status `uploading`) and returns a `batchId`.
5. For each file, `PUT /batches/{batchId}/files/{key}` with the raw bytes as the body. `key` is the entry's `key` from the manifest. `Content-Length` is always set; `X-ExportX-Filename` carries the URL-encoded file name. Files are sent **one at a time**, in manifest order.
6. `POST /batches/{batchId}/complete` with `{ uploaded: [keys], failed: [{ key, error }] }`. The portal marks the batch `complete` (or `partial` if anything failed) and may return a `url` the plugin shows as *open on the portal*.
7. The editor opens the batch on the portal and categorises it. The plugin may have sent a `category` hint (the default chosen in Settings) but the portal is the source of truth.

If the plugin crashes or loses the network mid-way, the batch stays `uploading`. Treat batches that have not completed within a few hours as abandoned (show them, allow deletion). ExportX's *Upload again* button creates a **new** batch; it does not resume. Deduplicate on the portal side if you want (same `project` + `timeline` + file names + `bytes` within a short window).

## API reference

Base path: `{portalUrl}/api/exportx`. ExportX appends `/api/exportx` to the URL the user types unless it already ends with it, so `https://portal.example.com` and `https://portal.example.com/api/exportx` both work.

**Authentication.** Every request carries `Authorization: Bearer <token>`. Tokens are per user (or per workstation); issue them from the portal's account page and let the user paste one into ExportX. Respond `401` when the token is missing or wrong. ExportX stores the token encrypted on the workstation and never displays it again.

**Content types.** JSON bodies are `application/json`; file bodies are `application/octet-stream`. All responses are JSON. Every response has a boolean `ok`; errors are `{ "ok": false, "error": "human-readable message" }` with a 4xx/5xx status. ExportX shows `error` to the user verbatim, so write it for an editor, not a developer ("This token has expired. Create a new one under Account › ExportX.").

### `GET /ping`

Health and discovery. Also what *Test connection* calls.

```json
{ "ok": true, "portal": "Triptych Studios", "version": "1",
  "categories": [ { "id": "commercial", "name": "Commercial" }, { "id": "music-video", "name": "Music video" } ] }
```

- `portal` is shown in the plugin ("Upload to Triptych Studios when done").
- `version` is the protocol version, currently `"1"`.
- `categories` is optional. Each has a stable `id` (what comes back in the manifest) and a display `name`. Plain strings are accepted too. Return them in the order you want them listed.

### `POST /batches`

Body: the manifest (see below and `schema/manifest.schema.json`). Create the batch and return its id.

```json
{ "ok": true, "batchId": "20261018-5f3a9c1e" }
```

Return `400` with a clear `error` if the manifest is invalid (`validateManifest()` in the reference server shows the minimum checks: `source === "exportx"`, a `project`, a non-empty `files` array with unique `key`s, `fileName`, a valid `kind`, numeric `bytes`). `batchId` can be any URL-safe string.

### `PUT /batches/{batchId}/files/{key}`

Body: the file's raw bytes. Headers: `Content-Length` (always present), `Content-Type: application/octet-stream`, `X-ExportX-Filename` (URL-encoded original file name, same as the manifest entry's `fileName`).

```json
{ "ok": true, "fileId": "f_8c1b2e", "bytes": 2457600000 }
```

- `key` must be one of the manifest's keys; otherwise `400`.
- Compare the bytes you received with `Content-Length` and reject mismatches with `400` (the reference server does). ExportX then marks that file *upload failed* and carries on with the next one.
- A second PUT for the same key replaces the first (idempotent).
- Optional `url` in the response is shown nowhere yet; reserved.

### `POST /batches/{batchId}/complete`

Body: `{ "uploaded": ["job-1", "job-2"], "failed": [ { "key": "job-3", "error": "Portal PUT …: 400 …" } ] }`

```json
{ "ok": true, "batchId": "20261018-5f3a9c1e", "status": "complete",
  "url": "https://portal.example.com/batches/20261018-5f3a9c1e" }
```

Set the batch status to `complete`, or `partial` when `failed` is non-empty. `url` is optional; when present the plugin shows an *open on the portal* link and puts it in the system notification. This is the moment to notify people, generate thumbnails, and so on.

### Optional, not used by the plugin

The reference server also answers `GET /batches` and `GET /batches/{id}` for convenience. Build whatever read API your UI needs; ExportX only calls the four endpoints above.

## The manifest

`examples/manifest.json` is a complete one. Top level:

| Field | Type | Meaning |
| --- | --- | --- |
| `source` | `"exportx"` | Always. Lets the endpoint reject other clients. |
| `exportxVersion` | string | Plugin version, e.g. `"0.2.0"`. |
| `project` | string | Resolve project name. |
| `timeline` | string | Timeline name (comma-joined if the batch spans several). |
| `fps` | number | Timeline frame rate, e.g. `23.976`. |
| `exportedAt` | ISO 8601 | When the manifest was built (render finished). |
| `namePattern` | string | The file-name pattern in force, e.g. `{yymmdd}_{project}_{label}`. |
| `category` | string or null | The category id the user picked as default in ExportX, if any. A hint only. |
| `files[]` | array | One entry per file, below. |

Each file entry:

| Field | Type | Meaning |
| --- | --- | --- |
| `key` | string | Unique within the batch. Used in the PUT URL. Usually Resolve's job id; image sequences get `-1`, `-2`, … |
| `fileName` | string | File name with extension, e.g. `261018_SpotA_Launch_Social_01.mp4`. |
| `kind` | `final` / `cut` / `still` | Whole-timeline export, a marked cut, or a marked still frame. Drives the portal's default grouping. |
| `label` | string | The deliverable's label used in the file name (`Final`, `Social`, `Still`). |
| `deliverableId`, `deliverableName` | string | The ExportX deliverable (profile) that produced it, e.g. `cuts-social-1080` / `Social cuts`. |
| `timeline` | string | Timeline this file came from. |
| `format`, `codec` | string | Resolve's ids, e.g. `mp4` / `H265`, `tif` / `RGB16`. |
| `width`, `height` | number or null | Output size when the deliverable sets one; `null` means the timeline's size. |
| `tcIn`, `tcOut` | timecode or null | Mark range for cuts (`01:00:04:00` → `01:00:09:11`); the frame for stills (`tcIn === tcOut`); `null` for finals. |
| `durationFrames` | number or null | Length of a cut in frames; `1` for stills. |
| `markIndex` | number or null | 1-based number of the cut or still in the timeline. |
| `bytes` | number | File size. Matches the PUT's `Content-Length`. |
| `modifiedAt` | ISO 8601 | File modification time on the workstation. |

Store the manifest as received (JSONB works well) and index what you query: `project`, `timeline`, `category`, `files[].kind`.

## Implementation notes

- **Files are big.** A ProRes master is tens of gigabytes. Stream the PUT body straight to object storage or disk; never buffer it in memory. Raise request-size and timeout limits on the reverse proxy for `/api/exportx/batches/*/files/*` (nginx `client_max_body_size 0;`, `proxy_request_buffering off;`). The plugin's socket timeout is 60 s of *inactivity*, not total time.
- **One request per file, sequential.** You will not see parallel uploads from one workstation.
- **Content-Length is always set**, so a 411 is never needed and you can pre-allocate or check quota before reading the body.
- **Statuses:** `uploading` → `complete` | `partial`. Add `abandoned` for batches that never completed if you like.
- **Categories** belong to the portal. ExportX only shows the list `ping` returns and sends the chosen `id` as a hint. Changing a batch's category later is a portal feature, not a plugin one.
- **Security:** HTTPS only in production. Scope tokens to upload only (they live on edit workstations). Rate-limit `/ping`. Sanitise `fileName` before touching a file system (the reference server's `safeName`). Do not trust `bytes` from the manifest for quota; count what arrives.
- **Keys are opaque.** Do not parse Resolve job ids; they are just unique strings.
- **Versioning:** the protocol is `1`. Additive changes (new optional fields) keep the version. Anything breaking becomes `2` and the plugin will negotiate from `ping.version`.

## Testing your implementation

```bash
node smoke/check-portal.js https://portal.example.com <token>              # full flow with generated files
node smoke/check-portal.js https://portal.example.com <token> --big 2048   # one 2 GB file, for proxy limits
bash smoke/curl.sh https://portal.example.com <token>                      # the same with curl
```

The script prints each step and exits non-zero on the first problem, with the server's `error` text. Then set the URL and token in ExportX › Settings and press *Test connection*; the plugin logs what it sees under Settings › Advanced › Log.

## Where this lives in the plugin

- `src/portal.js` (copied here as `client/portal.js`): `PortalClient` (ping, createBatch, uploadFile, completeBatch, uploadBatch), `findOutputs()` (which files a Resolve job produced), `buildManifest()`.
- `main.js`: settings (`portalUrl`, encrypted `portalToken`, `portalAuto`, `portalCategory`), the `exportx:portal-test` / `exportx:portal-upload` handlers, automatic upload after a render, taskbar progress and notifications.
- `ui/`: the switch next to Export, the upload card above the file list, and Settings › Triptych Studios portal.
