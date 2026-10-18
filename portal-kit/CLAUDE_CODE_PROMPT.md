# Prompt for Claude Code in the portal repository

Copy everything below the line into Claude Code inside the **Triptych Studios portal** repo, after unzipping `exportx-portal-kit.zip` somewhere in that repo (for example `docs/exportx-portal-kit/`). Adjust the two bracketed lines first.

---

I need this portal to receive finished exports from **ExportX**, a DaVinci Resolve plugin we use in the studio. The plugin renders a batch of deliverables (final exports, social cuts, stills) and uploads them here with a manifest describing each file. On the portal I want to see each batch, **categorise** it (commercial, music video, social, event, stills; make the list editable by admins), browse and share the files.

The complete spec is in `[docs/exportx-portal-kit/]` (unzipped from the kit ExportX ships). Read, in this order:

1. `README.md`: the four-call protocol, the manifest fields, and the implementation notes (streaming, sizes, auth, statuses).
2. `openapi.yaml` and `schema/manifest.schema.json`: the exact shapes.
3. `reference-server/server.js`: a 200-line Node implementation that is the executable spec. Match its behaviour (status codes, validation, byte-count check, `X-ExportX-Filename`, responses), not its storage.
4. `examples/`: real bodies.

Build, in this stack `[Next.js + Postgres + S3, or whatever this repo uses]`:

**API** under `/api/exportx` (bearer token auth, JSON errors `{ ok:false, error }` written for an editor, not a developer):
- `GET /ping` → `{ ok, portal: "Triptych Studios", version: "1", categories: [{ id, name }] }` from the categories table, in display order.
- `POST /batches` → validate the manifest against the schema, create a batch row (status `uploading`, store the manifest as JSON, owner = token's user), return `{ ok, batchId }` with 201.
- `PUT /batches/{id}/files/{key}` → the body is the raw file. **Stream it** to object storage (or disk) without buffering; the files are up to tens of GB. Require `Content-Length`, reject a byte-count mismatch with 400, replace on repeat, 400 for a key that is not in the manifest, 404 for an unknown batch. Return `{ ok, fileId, bytes }` with 201.
- `POST /batches/{id}/complete` → body `{ uploaded: [keys], failed: [{ key, error }] }`; set status `complete` or `partial`, record `completedAt`, return `{ ok, batchId, status, url }` where `url` is the batch page on this portal.
- Raise upload body-size and timeout limits for the files route at every layer (framework, reverse proxy, CDN). Document what you changed.

**Tokens**: an "ExportX tokens" section on the account page: create (show once), name, last used, revoke. Tokens are upload-scoped; they cannot read other users' batches.

**Data model**: `batches` (id, owner, project, timeline, fps, category_id nullable, status `uploading|partial|complete|abandoned`, manifest JSONB, received_at, completed_at), `batch_files` (id, batch_id, key, file_name, kind `final|cut|still`, label, deliverable_id, deliverable_name, format, codec, width, height, tc_in, tc_out, duration_frames, mark_index, bytes, storage_key, received_at), `categories` (id, name, position). Mark batches `abandoned` by a job if still `uploading` after 6 hours.

**UI**:
- `/batches`: list, newest first, with project, timeline, category (inline-editable dropdown), status, file counts by kind, total size, date. Filters by category, project, kind, status.
- `/batches/{id}`: the files grouped as **Final exports**, **Cuts** (with their timecodes and durations), **Stills** (thumbnail grid), download links (signed URLs), a category picker, a share button that creates an expiring public link. Show the manifest's `category` hint as the preselected category when the batch arrives without one.
- Admin: edit the categories list and order.

**Verify** before you report back:
1. Unit tests for manifest validation and the byte-count check.
2. Start the app locally and run `node <kit>/smoke/check-portal.js http://localhost:<port> <a real token>`; it must print `OK: the portal speaks ExportX v1.`. Then run it with `--big 2048` to prove a 2 GB upload streams through without memory growth.
3. `bash <kit>/smoke/curl.sh http://localhost:<port> <token>` must also pass.
4. Open the batch page the complete call returned and categorise it.

Keep the protocol exactly as specified (ExportX is already shipped against it). If something in the kit is ambiguous, follow `reference-server/server.js` and tell me what you chose.
