# ExportX – notes for Claude Code sessions

ExportX is a DaVinci Resolve **Workflow Integration plugin** (Electron, launched by Resolve Studio) plus a **Python script** that both batch-queue render jobs through Resolve's scripting API using shared JSON deliverable profiles.

## Commands

```bash
node --test                              # unit tests (mock Resolve, no Electron needed)
node scripts/check-syntax.js             # parse-check all JS
python3 python/exportx_batch.py --selftest
EXPORTX_MOCK=1 npx electron .            # run the UI against the mock (needs `npm install` once)
```

CI (`.github/workflows/ci.yml`) runs exactly those plus a manifest XML parse. Keep them green.

## Layout

- `main.js` Electron main: loads `WorkflowIntegration.node`, owns `ResolveBridge` + `BatchExporter`, IPC handlers (`exportx:*`), settings in `~/.exportx/settings.json`, render monitor.
- `preload.js` the only renderer↔main bridge (`window.exportx`). Renderer has no Node access; keep it that way.
- `ui/` vanilla HTML/CSS/JS panel. Escape anything inserted via `innerHTML` (`escapeHtml`).
- `src/resolve.js` `ResolveBridge`. **Every Resolve call is awaited**; do not assume sync or async. Format/codec ids are matched loosely via `matchEntry`.
- `src/batch.js` `BatchExporter.queue/plan/render/waitForCompletion`. Per-profile errors are collected, not thrown.
- `src/profiles.js`, `src/naming.js` pure helpers with tests.
- `profiles/default.json` bundled deliverables; user overrides live in `~/.exportx/profiles/` (see `docs/PROFILES.md`).
- `python/exportx_batch.py` stdlib-only mirror of the batching logic; keep its behaviour in step with `src/`.
- `test/helpers/mock-resolve.js` mirrors the Resolve API surface we use. Extend it when you use a new API call.

## Constraints

- **No runtime npm dependencies.** Resolve runs the plugin in its bundled Electron; nothing is `npm install`ed on the user's machine. `electron` is a devDependency for mock mode only.
- `WorkflowIntegration.node` is Blackmagic's binary, git-ignored, copied by `scripts/install.*` from `<Resolve>/Developer/Workflow Integrations/Examples/SamplePlugin/`. Never commit it.
- The plugin id `com.triptychvisuals.exportx` must match in `manifest.xml` and `main.js`.
- Resolve render settings are global Deliver-page state: apply a profile then immediately `AddRenderJob`, one at a time. Multi-timeline batching switches timelines and must switch back (`finally`).
- Resolve API reference: `docs/RESOLVE_API.md`, and the authoritative `Developer/Scripting/README.txt` in the user's Resolve install. We cannot run Resolve in CI; test logic against the mock.

## Style

- CommonJS, `'use strict'`, 2-space indent, single quotes, trailing commas. No build step.
- User-facing errors should say what to do next (which folder, which menu, which setting).
