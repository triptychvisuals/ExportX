# ExportX

**Batch deliverables for DaVinci Resolve with a few clicks.**

ExportX is a DaVinci Resolve plugin that drives Resolve's own render engine. Play your final cut, hold a button to mark the social cuts, tap it to mark stills, then press one button and ExportX queues and renders everything: the final 4K and master exports, one file per cut, one frame per still, each with the right codec, resolution, naming and subfolder.

```
┌ X ExportX   SpotA_Launch › Main Edit                ● Resolve Studio 20.1   [Queue] [Queue & Render] ┐
│ TIMELINES  (● Main Edit) ( Trailer 30s ) ( Social Cut )                                  1 timeline  │
├──────────────────┬──────────────────────────────────────────────────────┬────────────────────────────┤
│ DELIVERABLES 5/9 │ CAPTURE   Main Edit · 24 fps        ● playing   01:00:41:07 │ INSPECTOR                 │
│ Final exports    │ ┌──────────────────────┐  CUTS 2                            │ Cuts · Social 1080p       │
│ ☑ ProRes Master  │ │  Hold to mark a cut  │  01 01:00:04:00 → 01:00:09:11 5.5s │ Applies to   Each cut     │
│ ☑ 4K H.265       │ │  tap to mark a still │  02 01:00:14:04 → 01:00:16:15 2.5s │ Container    mp4          │
│ ☑ 1080p H.264    │ └──────────────────────┘  STILLS 1                          │ Codec        H264         │
│ Per cut          │ [Export cuts] [Export stills]  01 01:00:20:20              │ Resolution   1920 × 1080  │
│ ☑ Social 1080p   ├──────────────────────────────────────────────────────┤ Range        Each cut     │
│ ☐ Social 9:16    │ OUTPUT  /Volumes/Deliver/SpotA_Launch  {project}_{timeline}_{date} │ Subfolder    04_Social    │
│ Per still        │ WILL CREATE                                     6 jobs │ Example      …_cut01.mp4  │
│ ☑ TIFF           │   02_Final/  SpotA_Main Edit_20261018_4K  …            │                           │
│ ☐ JPEG           │   04_Social/ SpotA_Main Edit_20261018_cut01  01:00:04:00 → … │ [Exclude] [Open JSON]  │
└──────────────────┴──────────────────────────────────────────────────────┴────────────────────────────┘
```

![ExportX panel](docs/screenshots/panel.png)

*Rendered from `ui/` against the mock Resolve (`node scripts/screenshot.js`); the real panel looks the same inside Resolve Studio. More: [holding the pad](docs/screenshots/holding.png), [rendering](docs/screenshots/rendering.png).*

## The loop

1. **Pick deliverables.** Tick the final exports you owe (ProRes master, 4K H.265, 1080p), the per-cut profile for social, and the per-still format. Choose the output folder and filename pattern once; they are remembered.
2. **Play and mark.** Play the timeline in Resolve. In the ExportX panel, **hold** the pad (or Space / M) across a section to mark a cut; **tap** it to mark a still. Each mark becomes a Resolve timeline marker (cyan for cuts, pink for stills), so you see them on the timeline, can trim or delete them there, and they travel with the project.
3. **Export.** Press **Queue & Render** for everything, or **Export cuts** / **Export stills** for just those. ExportX adds one job per deliverable to Resolve's own render queue (cuts as in/out ranges, stills as single-frame image renders), starts the render and shows progress per job.

## What you get

- **Workflow Integration plugin** for Resolve Studio 18+: a panel under *Workspace › Workflow Integrations › ExportX*, designed after Editor X ([docs/DESIGN.md](docs/DESIGN.md)).
- **Hold-to-mark capture** with a live playhead readout, mark lists you can click to jump to, and marks stored as timeline markers.
- **Deliverable profiles as JSON** with a `target` of `timeline`, `cuts` or `stills`: nine sensible defaults, add your own in `~/.exportx/profiles/`, override the bundled ones by id. See [docs/PROFILES.md](docs/PROFILES.md).
- **Multi-timeline batches**: the timeline strip lets one click render the selected deliverables for any set of timelines.
- **Filename templates** with `{project}`, `{timeline}`, `{date}`, `{cut}`, `{still}`, `{tc}` and friends, plus per-profile subfolders and suffixes.
- **Live progress** per job, pulled from Resolve's queue; stop from the panel.
- **Python edition** (`python/exportx_batch.py`) using the same profiles and markers, for the Scripts menu in the free edition or headless use from a terminal in Studio.
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
python3 python/exportx_batch.py --list                                   # timelines, marks, profiles, formats, codecs
python3 python/exportx_batch.py --all --out ~/Deliver/Job123 --wait      # everything that is marked
python3 python/exportx_batch.py --targets stills --out ~/Deliver --render
python3 python/exportx_batch.py --mark-cut 01:00:04:00 01:00:09:12 --mark-still 01:00:12:05
```

## Bundled profiles

| id | target | Output | Folder | Default |
| --- | --- | --- | --- | --- |
| `final-prores-master` | timeline | QuickTime ProRes 422 HQ, 24-bit PCM | `01_Masters/*_MASTER.mov` | on |
| `final-4k-h265` | timeline | MP4 H.265 3840×2160 | `02_Final/*_4K.mp4` | on |
| `final-1080-h264` | timeline | MP4 H.264 1920×1080 | `02_Final/*_1080.mp4` | on |
| `cuts-social-1080` | cuts | MP4 H.264 1920×1080 per cut | `04_Social/*_cut01.mp4` | on |
| `cuts-social-vertical` | cuts | MP4 H.264 1080×1920 per cut | `04_Social/9x16/` | off |
| `stills-tiff` | stills | TIFF per still | `06_Stills/*_still01_<frame>.tif` | on |
| `stills-jpeg` | stills | JPEG per still | `06_Stills/JPEG/` | off |
| `review-proxy` | timeline | MP4 H.264 1280×720 | `03_Review/` | off |
| `clips-prores` | timeline | ProRes 422, one file per clip | `05_Clips/` | off |

Codec ids vary by OS and Resolve version; click **List formats & codecs** in the panel to see what your install offers.

## Repository layout

```
manifest.xml        Resolve plugin manifest (id com.triptychvisuals.exportx)
main.js             Electron main: Resolve connection, playhead polling, mark + render IPC
preload.js          contextBridge API exposed to the UI
ui/                 Panel UI (HTML/CSS/vanilla JS) + bundled Wix Madefor fonts (OFL)
src/resolve.js      ResolveBridge: render API, timeline info, playhead, markers
src/batch.js        BatchExporter: profiles × timelines × marks → jobs, render, poll
src/marks.js        Cuts and stills as timeline markers; hold/tap classification
src/timecode.js     Timecode ↔ frames (drop-frame aware)
src/profiles.js     Profile loading and validation
src/naming.js       Filename templating
profiles/           Bundled deliverable profiles
python/             Python edition (Scripts menu / CLI)
scripts/            install.sh, install.ps1, package.sh, check-syntax.js
test/               node:test suites + mock Resolve
docs/               INSTALL, PROFILES, DESIGN, RESOLVE_API, ARCHITECTURE
```

## Development

```bash
node --test                      # unit tests against the mock Resolve
node scripts/check-syntax.js     # parse every JS file
python3 python/exportx_batch.py --selftest

npm install                      # only for mock-mode UI runs (installs Electron)
EXPORTX_MOCK=1 npx electron .    # run the panel outside Resolve against the mock (the mock playhead "plays")
bash scripts/install.sh --link   # symlink the repo into Resolve's plugin folder while developing
bash scripts/package.sh          # dist/ExportX-<version>.zip
```

`WorkflowIntegration.node` is Blackmagic's binary and is git-ignored; the install scripts copy it from your Resolve install. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit and [docs/RESOLVE_API.md](docs/RESOLVE_API.md) for the slice of the Resolve API in use.

## Requirements

- The plugin panel needs **DaVinci Resolve Studio 18 or newer** (Blackmagic only enables Workflow Integration plugins in Studio).
- The Python edition runs from the Scripts menu in the free edition, and from a terminal in Studio with external scripting enabled.

## License

MIT, see [LICENSE](LICENSE). Bundled fonts are under the SIL Open Font License, see `ui/fonts/LICENSE-OFL.txt`.
