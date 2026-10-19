# ExportX – notes for Claude Code sessions

ExportX is a DaVinci Resolve **Workflow Integration plugin** (Electron, launched by Resolve Studio) plus a **Python script** that both batch-queue render jobs through Resolve's scripting API using shared JSON deliverable profiles. The core loop: pick the timeline (a select in the mark block when the project has several) → tick deliverables (each with a size estimate) → watch the preview (a proxy Resolve renders, 1280 on the long side, played in the panel, 9:16 for a vertical timeline), **hold C** to select cuts and **press S** for stills (the on-screen keycaps are live indicators, not buttons; keys changeable in Settings; stored as Resolve timeline markers) → **Export everything** (or **Cuts only** / **Stills only**). An In and Out set in Resolve (19+) keep the batch to that range (the final renders it, marks outside are left out, a cut past Out is clipped, the preview covers it) unless the `only In to Out` switch is off. A **Settings** tab edits deliverables with the full set of render parameters (format, codec and size lists come from Resolve; a live size estimate), the file-name pattern (default `{yymmdd}_{project}_{label}`), the keys, and the **Triptych Studios portal** (URL, encrypted plugin key, auto-upload). With the upload switch on, the Export tab asks which **portal project** the batch goes in; the files land in that project's Delivery tab, filed into its boxes. Rendering and uploading run in the background: taskbar progress and a notification when done.

## Commands

```bash
node --test                              # unit tests (mock Resolve, no Electron needed)
node scripts/check-syntax.js             # parse-check all JS
python3 python/exportx_batch.py --selftest
EXPORTX_MOCK=1 npx electron .            # run the UI against the mock (needs `npm install` once); the mock playhead "plays"
node scripts/build-preview.js            # docs/preview.html: panel + ui/mock-api.js in one file, open in a browser
node scripts/screenshot.js               # docs/screenshots/*.png via Playwright (preinstalled in cloud sessions)
node portal-kit/reference-server/server.js --port 8787 --token devtoken   # a local portal to upload to
bash scripts/package-portal-kit.sh       # dist/exportx-portal-kit.zip for the portal repository
```

CI (`.github/workflows/ci.yml`) runs exactly those plus a manifest XML parse. Keep them green.

After any UI change run `node scripts/screenshot.js` and look at the PNGs, `vertical.png` included (it caught a grid bug, a class-name collision, an off-screen click and a temporal-dead-zone error in the Settings form), then `node scripts/build-preview.js` so `docs/preview.html` stays current. The panel is deliberately simple: the Export tab is two panes (controls left in reading order with the mark block on top and the Export button pinned; picture right), stacking under 900 px; anything set once goes to the Settings tab (see `docs/DESIGN.md` §0). Keep it that way; add to Settings before adding to the Export tab.

## Layout

- `main.js` Electron main: loads `WorkflowIntegration.node`, owns `ResolveBridge` + `BatchExporter`, IPC handlers (`exportx:*`), polls the playhead every 150 ms and marks every 2 s and pushes `exportx:playhead` / `exportx:marks`, turns `mark-begin`/`mark-end` into markers (optionally at a frame the preview video reports), renders/caches the preview proxy (`exportx:preview-*`, `~/.exportx/previews/`), saves/deletes user deliverable files (`exportx:save-profile` / `delete-profile`), settings in `~/.exportx/settings.json` (`portalToken` sealed with `safeStorage`, never sent to the renderer: `publicSettings()`; `portalProjects` cached for the picker; `portalProjectByResolve` remembers the choice per Resolve project; `useInOut`), `exportx:set-timeline` (switches Resolve's current timeline and resets the playhead and marks caches) and `exportx:resolutions`, the preview range (In/Out when kept), render monitor, portal upload (`uploadBatch({ projectId })`, `exportx:portal-test` / `portal-projects` / `portal-upload`, `exportx:upload` events), `taskbarProgress()` + `notify()` for background feedback.
- `preload.js` the only renderer↔main bridge (`window.exportx`). Renderer has no Node access; keep it that way.
- `ui/` vanilla HTML/CSS/JS panel with two views (`#view-export`, `#view-settings`). Design notes and tokens: `docs/DESIGN.md`. Escape anything inserted via `innerHTML` (`escapeHtml`). Fonts in `ui/fonts/` are OFL (Wix Madefor). `ui/mock-api.js` is the browser fake used by the preview and screenshots (extend it when the bridge API grows; it has three timelines, `Social Cut` being 1080×1920, and an In/Out on `Main Edit`); `ui/mock-preview.webm` is a generated test pattern standing in for the preview video.
- `src/resolve.js` `ResolveBridge`. **Every Resolve call is awaited**; do not assume sync or async. Format/codec ids are matched loosely via `matchEntry`; codec `auto` = first codec of the format. Also timeline info (size, fps, length, In/Out via `GetMarkInOut` → `timelineInOut`), `renderResolutions`, playhead, seek, and marker-backed marks.
- `src/batch.js` `BatchExporter.plan/queue/render/waitForCompletion` and the pure `expandItems()` (profiles × timelines × marks → items, kept to the In/Out range via `marksWithin`, each with an `estimate`). Per-item errors are collected, not thrown; "nothing marked" and "outside In/Out" are notes.
- `src/estimate.js` `estimateBytes`/`sizeLabel`, UMD (CommonJS in main and the batcher, `window.ExportXEstimate` in the panel; `build-preview.js` and `screenshot.js` inline it). Mirrored by `estimate_bytes` in Python.
- `src/marks.js` mark kinds (`exportx:cut` cyan, `exportx:still` pink), `marksFromMarkers`.
- `src/portal.js` `PortalClient` for the portal's plugin API v2 (`/api/plugin/ping|projects|deliverables`: plans → bytes to signed URLs → register → batch), `findOutputs`, `buildManifest`, `registerInput`. The portal side is real and lives in the `triptych-portal` repository (`lib/plugin-auth.ts`, `app/api/plugin/*`, `lib/client-flow/exportx.ts`, `docs/exportx-api.md`); `portal-kit/` mirrors the contract and `portal-kit/reference-server/server.js` behaves like the portal (also the test fixture, with `--storage put|multipart|tus`). Changing the contract means changing both repositories, the kit's README, `openapi.yaml`, the schema, the reference server, the Python mirror and the tests together, then `bash scripts/package-portal-kit.sh`.
- `src/timecode.js` fps parsing, timecode ↔ absolute frames, drop-frame aware.
- `src/profiles.js` (load/validate, plus `saveUserProfile`/`deleteUserProfile`/`loadProfilesWithOrigin` for Settings) and `src/naming.js` (convention `{yymmdd}_{project}_{label}`, `defaultLabel`) are pure helpers with tests.
- `profiles/default.json` bundled deliverables with `target: timeline | cuts | stills`; user overrides live in `~/.exportx/profiles/` (see `docs/PROFILES.md`).
- `python/exportx_batch.py` stdlib-only mirror of the batching and marker logic; keep its behaviour in step with `src/`.
- `test/helpers/mock-resolve.js` mirrors the Resolve API surface we use, including timelines with markers and a playhead. Extend it when you use a new API call.

## Constraints

- **No runtime npm dependencies.** Resolve runs the plugin in its bundled Electron; nothing is `npm install`ed on the user's machine. `electron` is a devDependency for mock mode only.
- `WorkflowIntegration.node` is Blackmagic's binary, git-ignored, copied by `scripts/install.*` from `<Resolve>/Developer/Workflow Integrations/Examples/SamplePlugin/`. Never commit it.
- The plugin id `com.triptychvisuals.exportx` must match in `manifest.xml` and `main.js`.
- Resolve render settings are global Deliver-page state: apply a profile then immediately `AddRenderJob`, one item at a time. Multi-timeline batching switches timelines and must switch back (`finally`).
- `SetRenderSettings` takes all keys or none, and refuses keys the current format/codec does not offer (`VideoQuality: 'Medium'` for H.264, `AudioBitDepth` for AAC). `applyRenderSettings` in `src/resolve.js` (mirrored in Python) therefore sets the essentials together, the size as a pair, and every extra alone, dropping refused extras into `rejected` (shown as a banner and in the log). Keep new profile settings in the "extras" class unless a wrong job is worse than no job.
- Frame spaces: `MarkIn/MarkOut` and `GetStartFrame()` are absolute; marker frameIds and `GetMarkInOut()` are relative to the timeline start. Convert in one place (`src/marks.js`, `ResolveBridge.timelineInfo`/`timelineInOut`). `GetMarkInOut` exists from Resolve 19: guard every use, and a range covering the whole timeline counts as none.
- Resolve API reference: `docs/RESOLVE_API.md`, and the authoritative `Developer/Scripting/README.txt` in the user's Resolve install. We cannot run Resolve in CI; test logic against the mock.
- In cloud sessions, parallel Bash calls share one working directory: use absolute paths in heredocs and scripts.
- `node --test` treats any `*-test.js` / `test-*.js` / `test/**` file as a test: name helper scripts elsewhere accordingly (`portal-kit/smoke/check-portal.js`). A test that spawns a child against an in-process server must use the async `execFile`, or it deadlocks.
- Class names: `.top` is the header. Modifier classes on hints are `lead`, not `top`.

## Style

- CommonJS, `'use strict'`, 2-space indent, single quotes, trailing commas. No build step.
- User-facing errors should say what to do next (which folder, which menu, which setting).
