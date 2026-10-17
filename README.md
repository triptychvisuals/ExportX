# ExportX

**Batch deliverables for DaVinci Resolve with a few clicks.**

ExportX is a DaVinci Resolve plugin that drives Resolve's own render engine. Pick the deliverables you owe (master, web, review proxy, social cut…), pick an output folder, press one button, and ExportX queues every render job with the right codec, resolution, naming and subfolder, then starts the render and shows progress.

```
┌ ExportX ──────────────────────────────────────────────────────────┐
│ ☑ ProRes 422 HQ Master      mov · ProRes422HQ                     │
│ ☑ H.264 Web (1080p)         mp4 · H264 · 1920×1080                │
│ ☑ Review Proxy (720p)       mp4 · H264 · 1280×720                 │
│ ☐ Social Vertical           mp4 · H264 · 1080×1920                │
│                                                                   │
│ Output  /Volumes/Deliver/Job_123            [Browse…]             │
│ Name    {project}_{timeline}_{date}                               │
│ Timelines  ◉ Current (Main Edit)  ○ Choose…                       │
│                                                                   │
│ Will create: 3 jobs                                               │
│   01_Masters/SpotA_Main Edit_20261017_MASTER.mov                  │
│   02_Web/SpotA_Main Edit_20261017_WEB.mp4                         │
│   03_Review/SpotA_Main Edit_20261017_REVIEW.mp4                   │
│                                                                   │
│                    [ Queue & Render ]   [ Queue only ]            │
└───────────────────────────────────────────────────────────────────┘
```

## What you get

- **Workflow Integration plugin** for Resolve Studio 18+: a panel under *Workspace › Workflow Integrations › ExportX*.
- **Deliverable profiles as JSON**: six sensible defaults, add your own in `~/.exportx/profiles/`, override the bundled ones by id. See [docs/PROFILES.md](docs/PROFILES.md).
- **Multi-timeline batches**: one click renders the selected deliverables for the current timeline or any set of timelines, then switches back.
- **Filename templates** with `{project}`, `{timeline}`, `{profile}`, `{date}` and friends, plus per-profile subfolders and suffixes.
- **Live progress** per job, pulled from Resolve's queue; stop from the panel.
- **Python edition** (`python/exportx_batch.py`) using the same profiles, for the Scripts menu in the free edition or headless use from a terminal in Studio.
- **No runtime dependencies**, unit-tested against an in-memory Resolve mock, CI on every push.

## Quick start

```bash
git clone https://github.com/triptychvisuals/ExportX.git
cd ExportX
bash scripts/install.sh                 # macOS / Linux (sudo prompt)
# Windows, elevated PowerShell:
# powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

Restart Resolve Studio and open **Workspace › Workflow Integrations › ExportX**. Full instructions, paths and troubleshooting: [docs/INSTALL.md](docs/INSTALL.md).

Python / CLI:

```bash
python3 python/exportx_batch.py --list                          # profiles, presets, formats, codecs
python3 python/exportx_batch.py --all --out ~/Deliver/Job123 --wait
python3 python/exportx_batch.py -p prores-master -p h264-web --out ~/Deliver --timeline "Main Edit" --render
```

## Bundled profiles

| id | Output | Folder |
| --- | --- | --- |
| `prores-master` | QuickTime ProRes 422 HQ, 24-bit PCM, timeline resolution | `01_Masters/*_MASTER.mov` |
| `h264-web` | MP4 H.264 1920×1080, AAC, fast start | `02_Web/*_WEB.mp4` |
| `h265-uhd` *(off by default)* | MP4 H.265 3840×2160 | `02_Web/*_UHD.mp4` |
| `review-proxy` | MP4 H.264 1280×720, medium quality | `03_Review/*_REVIEW.mp4` |
| `social-vertical` *(off by default)* | MP4 H.264 1080×1920 | `04_Social/*_9x16.mp4` |
| `stems-individual-clips` *(off by default)* | ProRes 422, one file per clip | `05_Clips/` |

Codec ids vary by OS and Resolve version; click **List formats & codecs** in the panel to see what your install offers.

## Repository layout

```
manifest.xml        Resolve plugin manifest (id com.triptychvisuals.exportx)
main.js             Electron main process: Resolve connection, IPC, render monitor
preload.js          contextBridge API exposed to the UI
ui/                 Panel UI (HTML/CSS/vanilla JS)
src/resolve.js      ResolveBridge: wraps the scripting API (format/codec matching, jobs, status)
src/batch.js        BatchExporter: profiles × timelines → jobs, render, poll
src/profiles.js     Profile loading and validation
src/naming.js       Filename templating
profiles/           Bundled deliverable profiles
python/             Python edition (Scripts menu / CLI)
scripts/            install.sh, install.ps1, package.sh, check-syntax.js
test/               node:test suites + mock Resolve
docs/               INSTALL, PROFILES, RESOLVE_API, ARCHITECTURE
```

## Development

```bash
node --test                      # unit tests against the mock Resolve
node scripts/check-syntax.js     # parse every JS file
python3 python/exportx_batch.py --selftest

npm install                      # only for mock-mode UI runs (installs Electron)
EXPORTX_MOCK=1 npx electron .    # run the panel outside Resolve against the mock
bash scripts/install.sh --link   # symlink the repo into Resolve's plugin folder while developing
bash scripts/package.sh          # dist/ExportX-<version>.zip
```

`WorkflowIntegration.node` is Blackmagic's binary and is git-ignored; the install scripts copy it from your Resolve install. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit and [docs/RESOLVE_API.md](docs/RESOLVE_API.md) for the slice of the Resolve API in use.

## Requirements

- The plugin panel needs **DaVinci Resolve Studio 18 or newer** (Blackmagic only enables Workflow Integration plugins in Studio).
- The Python edition runs from the Scripts menu in the free edition, and from a terminal in Studio with external scripting enabled.

## License

MIT, see [LICENSE](LICENSE).
