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
| `main.js` | Electron main. Loads the native binding, owns the `ResolveBridge`/`BatchExporter`, exposes IPC handlers, polls the playhead (150 ms) and marks (2 s) and pushes them to the window, turns a press into a mark, persists settings in `~/.exportx/settings.json`, runs the render monitor. |
| `preload.js` | The only bridge between renderer and main. Exposes `window.exportx` with promise-returning calls and event subscriptions. Renderer has no Node access. |
| `ui/renderer.js` | Vanilla DOM UI: timeline strip, deliverables rail grouped by target, capture sheet (pad, playhead, mark lists), output sheet, "will create" tree, job table, inspector, log drawer. |
| `src/resolve.js` | `ResolveBridge`: awaits every Resolve call, resolves format/codec ids loosely (`auto` = first), applies a profile to Deliver settings, adds/starts/polls jobs, reads timeline info and the playhead, adds/deletes marker-backed marks. No Electron imports, so it is unit-testable. |
| `src/batch.js` | `BatchExporter` and the pure `expandItems()`: profiles × timelines × marks → items with ranges and filenames; per-item error isolation; restores the original timeline; `waitForCompletion` polling with stop detection. |
| `src/marks.js` | Mark kinds (colour, customData), `marksFromMarkers()` (markers → ordered, numbered marks with timecodes), `classifyPress()` (tap vs hold). |
| `src/timecode.js` | fps parsing, timecode ↔ absolute frames including 29.97/59.94 drop-frame. |
| `src/profiles.js` | Loads and validates profile JSON from the bundled and user folders. |
| `src/naming.js` | Filename templating and sanitising. |
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

## Flow of a hold on the pad

1. `pointerdown` (or Space/M) → renderer calls `markBegin`. Main reads the playhead once more for precision and remembers `{ absIn, tc, timeline }`.
2. While held, playhead ticks keep arriving; the pad shows `IN <tc> · <elapsed>`.
3. `pointerup` → `markEnd`. Main reads the playhead again, classifies the press (`classifyPress`: shorter than `minCutSeconds` is a still at the in frame, otherwise a cut from in to out) and calls `Timeline.AddMarker(relIn, colour, "Cut n", note, duration, customData)`.
4. Main rebuilds the mark list from `GetMarkers()`, broadcasts it, and the renderer re-plans so the "Will create" tree and inspector counts update.

## Flow of "Queue & Render"

1. Renderer collects included profile ids, optional target filter (`Export cuts` → `['cuts']`), output folder, template, timeline chips and options, and calls `exportx:queue`.
2. Main resolves the ids against freshly loaded profiles and calls `BatchExporter.queue`.
3. For each timeline: read its marks if any included profile targets cuts/stills; `expandItems` produces one item per final export, per cut × cut profile, per still × still profile, with unique filenames.
4. Switch to the timeline if needed; for each item: make the target folder, `applyProfile` (preset → format/codec → mode → settings incl. `MarkIn/MarkOut`), `AddRenderJob`. Errors are collected per item; "nothing marked" is a note.
5. Switch back to the original timeline, persist the user's choices, return `{ jobs, errors, notes }`.
6. If "start rendering" is on, `StartRendering([ids])` and begin a one-second poll of `GetRenderJobStatus`, pushing `exportx:progress` events until every job is terminal or Resolve stops rendering; then `exportx:done`.

## Roadmap ideas

- Import existing coloured markers as cuts (e.g. "every blue marker with a duration").
- Per-project profile sets stored alongside the project.
- Post-render hooks: checksum, upload, Slack/webhook notification.
- Burn-in and watermark variants via Data Burn-In presets.
- Nudge a mark's in/out by a frame from the panel.
