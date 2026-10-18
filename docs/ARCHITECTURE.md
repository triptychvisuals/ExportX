# Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│ DaVinci Resolve Studio                                                   │
│                                                                          │
│  Workspace › Workflow Integrations › ExportX                             │
│        │ launches main.js in Resolve's bundled Electron                  │
│        ▼                                                                 │
│  ┌──────────────┐  IPC (preload.js, contextBridge)   ┌────────────────┐  │
│  │ ui/          │ ◄────────────────────────────────► │ main.js        │  │
│  │ index.html   │  status · profiles · plan · queue  │  settings      │  │
│  │ renderer.js  │  mark-begin/end · marks · seek     │  playhead poll │  │
│  │ styles.css   │  ← playhead · marks · progress     │  render monitor│  │
│  └──────────────┘                                    └───────┬────────┘  │
│                                                              │           │
│                                 ┌────────────────────────────┼────────┐  │
│                                 │ src/batch.js   BatchExporter        │  │
│                                 │ src/resolve.js ResolveBridge        │  │
│                                 │ src/marks.js   src/timecode.js      │  │
│                                 │ src/profiles.js  src/naming.js      │  │
│                                 └────────────────────────────┬────────┘  │
│                                                              │           │
│                                 WorkflowIntegration.node (Blackmagic)    │
│                                                              │           │
│                                 Resolve scripting API:                   │
│                                   Project  ► SetRenderSettings / AddRenderJob / StartRendering │
│                                   Timeline ► GetCurrentTimecode / GetMarkers / AddMarker       │
└──────────────────────────────────────────────────────────────────────────┘

python/exportx_batch.py  = the same batching and marker logic in one Python file,
                           for the Scripts menu (free edition) or a terminal (Studio).
profiles/*.json          = deliverable definitions shared by both editions.
Resolve timeline markers = where cuts and stills live (customData exportx:cut / exportx:still).
```

## Modules

| File | Responsibility |
| --- | --- |
| `main.js` | Electron main. Loads the native binding, owns the `ResolveBridge`/`BatchExporter`, exposes IPC handlers, polls the playhead (150 ms) and marks (2 s) and pushes them to the window, turns a press into a mark (from Resolve's playhead or from a frame the preview video reports), renders and caches the **preview proxy** (`~/.exportx/previews/`), saves and deletes user deliverable files for the Settings tab, persists settings in `~/.exportx/settings.json` (the portal token encrypted with `safeStorage`), runs the render monitor and the **portal upload**, and gives background feedback: `setProgressBar` on the dock/taskbar icon and a `Notification` when a render or upload finishes (only when the window is not in front; clicking it brings the panel back). |
| `preload.js` | The only bridge between renderer and main. Exposes `window.exportx` with promise-returning calls and event subscriptions. Renderer has no Node access. |
| `ui/renderer.js` | Vanilla DOM UI. **Export** tab, two panes: left = mark block (cut/still keys over the mark lists), export checklist + folder, pinned export bar (buttons, summary, progress); right = preview video with scrub bar and mark overlay, transport, playhead, per-file progress. **Settings** tab: file-name pattern with live example, editable deliverable cards (format/codec lists from Resolve), keys, advanced (timelines, switches, log). Stacks under 900 px. |
| `ui/mock-api.js` | Browser-side fake of `window.exportx` (playing timeline, markers, self-progressing render queue) for `docs/preview.html` and screenshots. |
| `scripts/build-preview.js` | Bundles the panel + mock into one HTML file (`docs/preview.html`) anyone can open. |
| `src/resolve.js` | `ResolveBridge`: awaits every Resolve call, resolves format/codec ids loosely (`auto` = first), applies a profile to Deliver settings, adds/starts/polls jobs, reads timeline info and the playhead, adds/deletes marker-backed marks. No Electron imports, so it is unit-testable. |
| `src/batch.js` | `BatchExporter` and the pure `expandItems()`: profiles × timelines × marks → items with ranges and filenames; per-item error isolation; restores the original timeline; `waitForCompletion` polling with stop detection. |
| `src/marks.js` | Mark kinds (colour, customData) and `marksFromMarkers()` (markers → ordered, numbered marks with timecodes). |
| `src/timecode.js` | fps parsing, timecode ↔ absolute frames including 29.97/59.94 drop-frame. |
| `src/profiles.js` | Loads and validates profile JSON from the bundled and user folders; `loadProfilesWithOrigin` (isUser/hasBundled), `saveUserProfile`, `deleteUserProfile` for the Settings tab. |
| `src/naming.js` | File-name convention (`{yymmdd}_{project}_{label}` by default), tokens, sanitising, `defaultLabel`. |
| `src/portal.js` | `PortalClient` for the portal's plugin API (v2): `ping`, `projects`, `projectFiles`, `uploadFile` (asks for a plan, then streams the bytes as presigned multipart parts three at a time with retries, or one signed PUT; a `tus` plan is asked again as a PUT), `register`, `batch`, and `uploadBatch` tying them together per file. Also `findOutputs()` (which files on disk a Resolve job produced, with or without frame numbers, newer than the queue time), `buildManifest()` (jobs → files with local paths, the batch id) and `registerInput()` (what the portal is told about a file: kind, size, type, size in pixels, duration, timecodes, deliverable). Plain `http`/`https`, no dependencies. |
| `portal-kit/` | The contract with the portal, mirrored from the `triptych-portal` repository: README, `openapi.yaml`, `schema/register.schema.json`, examples, a dependency-free reference server that behaves like the portal (put, multipart or tus plans; also the test fixture), and a smoke script that proves either side. |
| `test/helpers/mock-resolve.js` | In-memory Resolve with the same method names (including timeline markers and a playhead), used by the tests and by `EXPORTX_MOCK=1`. |

## Frame bookkeeping

Three frame spaces meet here, and the conversion lives in one place (`src/marks.js` + `ResolveBridge.timelineInfo`):

- **Timecode** from `Timeline.GetCurrentTimecode()`, drop-frame when the timeline says so.
- **Absolute frames**, what `GetStartFrame()`, `MarkIn` and `MarkOut` use. A 24 fps timeline starting at 01:00:00:00 starts at 86400.
- **Relative frames**, what marker `frameId`s use (0 = first frame of the timeline). `abs = startFrame + rel`.

## Design decisions

- **No runtime dependencies.** Resolve runs the plugin in its own Electron, and copying `node_modules` into a system folder is fragile. Everything is plain Node/DOM. `electron` is a devDependency only for mock-mode runs.
- **Await everything.** The native binding's sync/async behaviour is not something to depend on; `await` on a plain value is free.
- **Marks are markers.** Instead of a private database the cuts and stills are Resolve timeline markers tagged by `customData`. They are visible on the timeline, editable in Resolve, saved with the project, and the Python edition sees the same ones.
- **Stills go through Deliver.** A still is a one-frame render job, so it gets the same colour management, sizing and output path handling as a video export, works in every Resolve version with the scripting API, and shows up in the render queue like everything else.
- **Profiles as data.** Deliverables are JSON so a studio can version them, share them, and override bundled ones without touching code. The Python edition reads the same files.
- **Per-item isolation.** A bad codec id in one profile, or a cut profile with nothing marked, reports a problem for that item and the batch continues.
- **Resolve stays the renderer.** ExportX only drives Resolve's own queue; jobs appear in the Deliver page and can be inspected, re-run, or cancelled there as usual.
- **Renderer sandboxing.** `contextIsolation: true`, `nodeIntegration: false`, a CSP, and `innerHTML` only with escaped strings.

## The preview video

Resolve's scripting API cannot stream its viewer, so the panel asks Resolve to render a 1280-wide H.264 proxy of the current timeline into `~/.exportx/previews/<project>__<timeline>.mp4` (a normal render job, deleted from the queue when done, with a JSON sidecar holding start/end frame and fps). The `<video>` element plays it. While it is the marking source, `absFrame = startFrame + round(video time × fps)` (using `requestVideoFrameCallback`'s `mediaTime` when available), and that frame is sent with `mark-begin` / `mark-end` instead of reading Resolve's playhead. When the preview pauses or is scrubbed, Resolve's playhead is moved to the same frame so both stay in step. If the timeline's length or frame rate no longer matches the sidecar, the viewer shows a "re-render" notice. The user can switch the pad back to Resolve's playhead at any time.

## Flow of a held cut key

1. Key-down of the cut key (C by default; or pointer-down on the cut button) → renderer calls `markBegin`, passing the preview's current frame when the preview is the marking source. Main otherwise reads Resolve's playhead once more for precision, and remembers `{ absIn, tc, timeline }`.
2. While held, playhead ticks keep arriving; the cut button shows `IN <tc> · <elapsed>`.
3. Key-up → `markEnd`. Main reads the playhead again and calls `Timeline.AddMarker(relIn, "Cyan", "Cut n", note, duration, "exportx:cut")` for the range. The still key (S) goes straight to `markStill`, which adds a one-frame pink marker at the current frame.
4. Main rebuilds the mark list from `GetMarkers()`, broadcasts it, and the renderer re-plans so the "Will create" tree and inspector counts update.

## Flow of "Queue & Render"

1. Renderer collects included profile ids, optional target filter (`Export cuts` → `['cuts']`), output folder, template, timeline chips and options, and calls `exportx:queue`.
2. Main resolves the ids against freshly loaded profiles and calls `BatchExporter.queue`.
3. For each timeline: read its marks if any included profile targets cuts/stills; `expandItems` produces one item per final export, per cut × cut profile, per still × still profile, with unique filenames.
4. Switch to the timeline if needed; for each item: make the target folder, `applyProfile` (preset → format/codec → mode → settings incl. `MarkIn/MarkOut`), `AddRenderJob`. Errors are collected per item; "nothing marked" is a note.
5. Switch back to the original timeline, persist the user's choices, return `{ jobs, errors, notes }`.
6. If "start rendering" is on, `StartRendering([ids])` and begin a one-second poll of `GetRenderJobStatus`, pushing `exportx:progress` events until every job is terminal or Resolve stops rendering; then `exportx:done`. The poll runs in the main process, so the window stays free: marking keeps working, and the dock/taskbar icon mirrors the percentage.
7. On `exportx:done`: taskbar progress clears (or flashes red on failures), a notification goes out if the panel is not in front, and, if the batch was queued with the upload switch on, the upload starts.

## Flow of an upload

1. The picker next to Export lists the portal's projects (`GET /api/plugin/projects`, cached in settings); the renderer pre-selects the project chosen last time for this Resolve project, else a name match, and the queue request carries `portalProjectId`. Main refuses to queue a batch with the switch on and no project.
2. Main remembers, per batch, the queue time, project, timeline, fps, length, name pattern and the portal project. After the render, it keeps only the jobs Resolve reports `complete`.
3. `buildManifest()` looks in each job's folder for `fileName.ext` or `fileName[_.-]NNNN.ext` newer than the queue time (Resolve adds the extension; image sequences get frame numbers) and produces one entry per file, plus a `missing` list that is logged.
4. `PortalClient.uploadBatch()`: for each file, `upload_url` (a plan), the bytes to the plan's signed addresses (parts three at a time for R2, one PUT otherwise), `complete_upload` when it was multipart, then `register` with `registerInput()`; the portal files it into a Delivery box and answers with the label and the box. Then `batch`, one note on the project, which returns the Delivery tab's URL. Per-file failures do not stop the batch.
5. Every step goes to the renderer as `exportx:upload` events (`start` with the project, `file` with percent, overall percent and the box, `done` with the URL, `error`), to the taskbar as progress, and to the log. A notification announces the result.
6. *Upload* in the panel runs the same path by hand for the last batch into the picked project; it registers the files again (no resume).

## Roadmap ideas

- Import existing coloured markers as cuts (e.g. "every blue marker with a duration").
- Per-project profile sets stored alongside the project.
- Post-render hooks beyond the portal: checksum, Slack/webhook notification.
- Resumable uploads (tus or multipart) for very large masters over flaky links; protocol v2.
- Burn-in and watermark variants via Data Burn-In presets.
- Nudge a mark's in/out by a frame from the panel.
- Render the preview automatically when a timeline opens, behind a setting.
