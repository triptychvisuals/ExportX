# ExportX

**Batch deliverables for DaVinci Resolve with a few clicks.**

ExportX is a DaVinci Resolve plugin that drives Resolve's own render engine. Play your final cut, hold a button to mark the social cuts, tap it to mark stills, then press one button and ExportX queues and renders everything: the final 4K and master exports, one file per cut, one frame per still, each with the right codec, resolution, naming and subfolder.

```
┌ X ExportX   ● SpotA_Launch › Main Edit                      ↻ ┐
│                                                               │
│ ① What to export                                              │
│   ☑ Master                               mov · ProRes422HQ    │
│   ☑ Final 4K                             mp4 · H265 · 3840×2160│
│   ☑ Web 1080p                            mp4 · H264 · 1920×1080│
│   ☑ Social cuts  (per cut)               mp4 · H264 · 1920×1080│
│   ☑ Stills TIFF  (per still)             tif                  │
│   Save to  /Volumes/Deliver/SpotA_Launch            [Choose…] │
│                                                               │
│ ② Mark while it plays        Main Edit · 24 fps   01:00:42:11 │
│   ┌───────────────────────────────────────────────────────┐   │
│   │                    Hold for a cut                     │   │
│   │                    Tap for a still                    │   │
│   └───────────────────────────────────────────────────────┘   │
│   CUTS 2   01 01:00:04:00 → 01:00:09:11 5.5s   STILLS 1       │
│            02 01:00:42:23 → 01:00:44:03 1.2s   01 01:00:20:20 │
│                                                               │
│ ③ Export                                                      │
│   [              Export everything · 6 files              ]   │
│   [ Cuts only ]                            [ Stills only ]    │
│   3 final exports · 2 cuts · 1 still → /Volumes/Deliver/…     │
│                                                               │
│ ▸ More options                                                │
└───────────────────────────────────────────────────────────────┘
```

![ExportX panel](docs/screenshots/panel.png)

**Try it without Resolve:** open [`docs/preview.html`](docs/preview.html) in a browser. It is the real panel bundled with a fake Resolve whose timeline is playing, so you can hold the pad, tap it and press Export. Rebuild it with `node scripts/build-preview.js`. More screenshots: [holding the pad](docs/screenshots/holding.png), [exporting](docs/screenshots/exporting.png), [More options](docs/screenshots/more.png), [phone width](docs/screenshots/narrow.png).

## The loop

1. **What to export.** Tick the final exports you owe (Master, Final 4K, Web 1080p), the per-cut profile for social, and the per-still format. Choose the folder once; it is remembered.
2. **Mark while it plays.** Play the timeline in Resolve. In the ExportX panel, **hold** the pad (or Space / M) across a section to mark a cut; **tap** it to mark a still. Each mark becomes a Resolve timeline marker (cyan for cuts, pink for stills), so you see them on the timeline, can trim or delete them there, and they travel with the project.
3. **Export.** Press **Export everything**, or **Cuts only** / **Stills only**. ExportX adds one job per deliverable to Resolve's own render queue (cuts as in/out ranges, stills as single-frame image renders), starts the render and shows progress per job.

## What you get

- **Workflow Integration plugin** for Resolve Studio 18+: a panel under *Workspace › Workflow Integrations › ExportX*. One column, three numbered steps, everything else under "More options". Design notes in [docs/DESIGN.md](docs/DESIGN.md).
- **Hold-to-mark capture** with a live playhead readout, mark lists you can click to jump to, and marks stored as timeline markers.
- **Deliverable profiles as JSON** with a `target` of `timeline`, `cuts` or `stills`: nine sensible defaults, add your own in `~/.exportx/profiles/`, override the bundled ones by id. See [docs/PROFILES.md](docs/PROFILES.md).
- **Multi-timeline batches**: pick extra timelines under More options and one click renders the selected deliverables for each.
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
ui/                 Panel UI (HTML/CSS/vanilla JS), browser mock for previews, bundled Wix Madefor fonts (OFL)
src/resolve.js      ResolveBridge: render API, timeline info, playhead, markers
src/batch.js        BatchExporter: profiles × timelines × marks → jobs, render, poll
src/marks.js        Cuts and stills as timeline markers; hold/tap classification
src/timecode.js     Timecode ↔ frames (drop-frame aware)
src/profiles.js     Profile loading and validation
src/naming.js       Filename templating
profiles/           Bundled deliverable profiles
python/             Python edition (Scripts menu / CLI)
scripts/            install.sh, install.ps1, package.sh, check-syntax.js, build-preview.js, screenshot.js
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
node scripts/build-preview.js    # docs/preview.html: the panel + a fake Resolve in one file, open in any browser
node scripts/screenshot.js       # docs/screenshots/*.png from the same mock (needs playwright + chromium)
bash scripts/install.sh --link   # symlink the repo into Resolve's plugin folder while developing
bash scripts/package.sh          # dist/ExportX-<version>.zip
```

`WorkflowIntegration.node` is Blackmagic's binary and is git-ignored; the install scripts copy it from your Resolve install. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit and [docs/RESOLVE_API.md](docs/RESOLVE_API.md) for the slice of the Resolve API in use.

## Requirements

- The plugin panel needs **DaVinci Resolve Studio 18 or newer** (Blackmagic only enables Workflow Integration plugins in Studio).
- The Python edition runs from the Scripts menu in the free edition, and from a terminal in Studio with external scripting enabled.

## License

MIT, see [LICENSE](LICENSE). Bundled fonts are under the SIL Open Font License, see `ui/fonts/LICENSE-OFL.txt`.
