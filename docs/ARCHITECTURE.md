# Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ DaVinci Resolve Studio                                               │
│                                                                      │
│  Workspace › Workflow Integrations › ExportX                         │
│        │ launches main.js in Resolve's bundled Electron              │
│        ▼                                                             │
│  ┌──────────────┐  IPC (preload.js, contextBridge)  ┌─────────────┐  │
│  │ ui/          │ ◄───────────────────────────────► │ main.js     │  │
│  │ index.html   │   status / profiles / plan /      │             │  │
│  │ renderer.js  │   queue / render / stop /         │ settings    │  │
│  │ styles.css   │   progress events                 │ monitor     │  │
│  └──────────────┘                                   └──────┬──────┘  │
│                                                            │         │
│                                   ┌────────────────────────┼──────┐  │
│                                   │ src/batch.js  BatchExporter   │  │
│                                   │ src/resolve.js ResolveBridge  │  │
│                                   │ src/profiles.js  src/naming.js│  │
│                                   └────────────────────────┬──────┘  │
│                                                            │         │
│                               WorkflowIntegration.node (Blackmagic)  │
│                                                            │         │
│                                   Resolve scripting API: Project ►   │
│                                   SetRenderSettings / AddRenderJob / │
│                                   StartRendering / GetRenderJobStatus│
└──────────────────────────────────────────────────────────────────────┘

python/exportx_batch.py  = the same batching logic in one Python file, for the
                           Scripts menu (free edition) or a terminal (Studio).
profiles/*.json          = deliverable definitions shared by both editions.
```

## Modules

| File | Responsibility |
| --- | --- |
| `main.js` | Electron main. Loads the native binding, owns the `ResolveBridge`/`BatchExporter`, exposes IPC handlers, persists settings in `~/.exportx/settings.json`, runs the render monitor and pushes progress to the window. |
| `preload.js` | The only bridge between renderer and main. Exposes `window.exportx` with promise-returning calls and event subscriptions. Renderer has no Node access. |
| `ui/renderer.js` | Vanilla DOM UI: profile picker, timeline picker, output folder, filename template with live preview, queue/render buttons, job table, log. |
| `src/resolve.js` | `ResolveBridge`: awaits every Resolve call, resolves format/codec ids loosely, applies a profile to Deliver settings, adds/starts/polls jobs, normalises job status. No Electron imports, so it is unit-testable. |
| `src/batch.js` | `BatchExporter`: profiles × timelines → jobs; per-job error isolation; restores the original timeline; `waitForCompletion` polling with stop detection. |
| `src/profiles.js` | Loads and validates profile JSON from the bundled and user folders. |
| `src/naming.js` | Filename templating and sanitising. |
| `test/helpers/mock-resolve.js` | In-memory Resolve with the same method names, used by the tests and by `EXPORTX_MOCK=1`. |

## Design decisions

- **No runtime dependencies.** Resolve runs the plugin in its own Electron, and copying `node_modules` into a system folder is fragile. Everything is plain Node/DOM. `electron` is a devDependency only for mock-mode runs.
- **Await everything.** The native binding's sync/async behaviour is not something to depend on; `await` on a plain value is free.
- **Profiles as data.** Deliverables are JSON so a studio can version them, share them, and override bundled ones without touching code. The Python edition reads the same files.
- **Per-job isolation.** A bad codec id in one profile reports an error for that profile and the batch continues.
- **Resolve stays the renderer.** ExportX only drives Resolve's own queue; jobs appear in the Deliver page and can be inspected, re-run, or cancelled there as usual.
- **Renderer sandboxing.** `contextIsolation: true`, `nodeIntegration: false`, a CSP, and `innerHTML` only with escaped strings.

## Flow of one click on "Queue & Render"

1. Renderer collects selected profile ids, output folder, template, timeline choice and options and calls `exportx:queue`.
2. Main resolves the ids against freshly loaded profiles and calls `BatchExporter.queue`.
3. For each timeline: switch to it; for each profile: make the target folder, `applyProfile` (preset → format/codec → mode → settings), `AddRenderJob`, record the job. Errors are collected per profile.
4. Switch back to the original timeline, persist the user's choices, return `{ jobs, errors }`.
5. If "start rendering" is on, `StartRendering([ids])` and begin a one-second poll of `GetRenderJobStatus`, pushing `exportx:progress` events until every job is terminal or Resolve stops rendering; then `exportx:done`.

## Roadmap ideas

- Marker-based ranges (render between coloured markers, one job per marker pair) using `Timeline.GetMarkers()` and `MarkIn`/`MarkOut`.
- Per-project profile sets stored alongside the project (e.g. a `profiles/` folder picked per job).
- Post-render hooks: checksum, upload, Slack/webhook notification.
- Burn-in and watermark variants via Data Burn-In presets.
