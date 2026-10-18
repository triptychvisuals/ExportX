# ExportX – notes for Claude Code sessions

ExportX is a DaVinci Resolve **Workflow Integration plugin** (Electron, launched by Resolve Studio) plus a **Python script** that both batch-queue render jobs through Resolve's scripting API using shared JSON deliverable profiles. The core loop: tick deliverables → watch the preview (a 720p proxy Resolve renders, played in the panel), **hold C** to select cuts and **press S** for stills (keys changeable in Settings; stored as Resolve timeline markers) → **Export everything** (or **Cuts only** / **Stills only**). A **Settings** tab edits deliverables (format/codec lists come from Resolve) and the file-name pattern, default `{yymmdd}_{project}_{label}`.

## Commands

```bash
node --test                              # unit tests (mock Resolve, no Electron needed)
node scripts/check-syntax.js             # parse-check all JS
python3 python/exportx_batch.py --selftest
EXPORTX_MOCK=1 npx electron .            # run the UI against the mock (needs `npm install` once); the mock playhead "plays"
node scripts/build-preview.js            # docs/preview.html: panel + ui/mock-api.js in one file, open in a browser
node scripts/screenshot.js               # docs/screenshots/*.png via Playwright (preinstalled in cloud sessions)
```

CI (`.github/workflows/ci.yml`) runs exactly those plus a manifest XML parse. Keep them green.

After any UI change run `node scripts/screenshot.js` and look at the PNGs (it caught a grid bug, a class-name collision and an off-screen click), then `node scripts/build-preview.js` so `docs/preview.html` stays current. The panel is deliberately simple: the Export tab is two panes (controls left in reading order with the mark block on top and the Export button pinned; picture right), stacking under 900 px; anything set once goes to the Settings tab (see `docs/DESIGN.md` §0). Keep it that way; add to Settings before adding to the Export tab.

## Layout

- `main.js` Electron main: loads `WorkflowIntegration.node`, owns `ResolveBridge` + `BatchExporter`, IPC handlers (`exportx:*`), polls the playhead every 150 ms and marks every 2 s and pushes `exportx:playhead` / `exportx:marks`, turns `mark-begin`/`mark-end` into markers (optionally at a frame the preview video reports), renders/caches the preview proxy (`exportx:preview-*`, `~/.exportx/previews/`), saves/deletes user deliverable files (`exportx:save-profile` / `delete-profile`), settings in `~/.exportx/settings.json`, render monitor.
- `preload.js` the only renderer↔main bridge (`window.exportx`). Renderer has no Node access; keep it that way.
- `ui/` vanilla HTML/CSS/JS panel with two views (`#view-export`, `#view-settings`). Design notes and tokens: `docs/DESIGN.md`. Escape anything inserted via `innerHTML` (`escapeHtml`). Fonts in `ui/fonts/` are OFL (Wix Madefor). `ui/mock-api.js` is the browser fake used by the preview and screenshots (extend it when the bridge API grows); `ui/mock-preview.webm` is a generated test pattern standing in for the preview video.
- `src/resolve.js` `ResolveBridge`. **Every Resolve call is awaited**; do not assume sync or async. Format/codec ids are matched loosely via `matchEntry`; codec `auto` = first codec of the format. Also timeline info, playhead, seek, and marker-backed marks.
- `src/batch.js` `BatchExporter.plan/queue/render/waitForCompletion` and the pure `expandItems()` (profiles × timelines × marks → items). Per-item errors are collected, not thrown; "nothing marked" is a note.
- `src/marks.js` mark kinds (`exportx:cut` cyan, `exportx:still` pink), `marksFromMarkers`.
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
- Frame spaces: `MarkIn/MarkOut` and `GetStartFrame()` are absolute; marker frameIds are relative to the timeline start. Convert in one place (`src/marks.js`, `ResolveBridge.timelineInfo`).
- Resolve API reference: `docs/RESOLVE_API.md`, and the authoritative `Developer/Scripting/README.txt` in the user's Resolve install. We cannot run Resolve in CI; test logic against the mock.
- In cloud sessions, parallel Bash calls share one working directory: use absolute paths in heredocs and scripts.

## Style

- CommonJS, `'use strict'`, 2-space indent, single quotes, trailing commas. No build step.
- User-facing errors should say what to do next (which folder, which menu, which setting).
