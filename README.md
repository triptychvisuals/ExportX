# ExportX

**Batch deliverables for DaVinci Resolve with a few clicks.**

ExportX is a DaVinci Resolve plugin that drives Resolve's own render engine. Watch the cut in the panel, hold **C** to select each social cut, press **S** on each frame you want as a still, then press one button and ExportX queues and renders everything: the final 4K and master exports, one file per cut, one frame per still, each with the right codec, resolution, name (`261018_SpotA_Final.mp4`) and subfolder.

```
┌ X ExportX  [Export] Settings   ● SpotA_Launch › Main Edit                                    ↻ ┐
│ MARK WHILE IT PLAYS        Main Edit · 24 fps │                                                  │
│ ┌───────────────────┐ ┌───────────────────┐   │                                                  │
│ │ [C] Hold for a cut│ │ [S] Still         │   │                                                  │
│ └───────────────────┘ └───────────────────┘   │            preview of the timeline              │
│ CUTS 2                    STILLS 1            │                  (720p proxy)                   │
│ 01 01:00:04:00→01:00:09:11 5.5s  01 01:00:20:20│                                                 │
│ 02 01:00:42:23→01:00:44:03 1.2s               │                                                  │
│                                               │ ━━━━▇▇▇━━━━━━━│━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ WHAT TO EXPORT                                │ ⏸ 🔈 01:00:04:13   Marks come from the preview.  │
│ ☑ Master              mov · ProRes422HQ       │ ● preview playing · Resolve at 01:00:48:03       │
│ ☑ Final 4K            mp4 · H265 · 3840×2160  │                                     01:00:04:13 │
│ ☑ Web 1080p           mp4 · H264 · 1920×1080  │ ● 261018_SpotA_Launch_Master          done      │
│ ☑ Social cuts (per cut)                       │ ● 261018_SpotA_Launch_Final           54%       │
│ ☑ Stills TIFF (per still)                     │ ○ 261018_SpotA_Launch_Web             waiting   │
│ Save to /Volumes/Deliver/SpotA_Launch [Choose]│ ○ 261018_SpotA_Launch_Social_01       waiting   │
├───────────────────────────────────────────────┤ ○ 261018_SpotA_Launch_Still_01        waiting   │
│ [        Export everything · 7 files        ] │                                                  │
│ [ Cuts only ]            [ Stills only ]      │                                                  │
│ 3 final exports · 2 cuts · 2 stills → …       │                                                  │
└───────────────────────────────────────────────┴──────────────────────────────────────────────────┘
```

![ExportX panel](docs/screenshots/panel.png)

**Try it without Resolve:** open [`docs/preview.html`](docs/preview.html) in a browser. It is the real panel bundled with a fake Resolve and a test-pattern video standing in for your timeline, so you can hold C, press S, press Export and edit deliverables in Settings. Rebuild it with `node scripts/build-preview.js`. More screenshots: [holding C](docs/screenshots/holding.png), [exporting](docs/screenshots/exporting.png), [uploading to the portal](docs/screenshots/uploading.png), [all on the portal](docs/screenshots/uploaded.png), [Settings](docs/screenshots/settings.png), [phone width](docs/screenshots/narrow.png).

## The loop

1. **What to export.** Tick the final exports you owe (Master, Final 4K, Web 1080p), the per-cut deliverable for social, and the per-still format. Choose the folder once; it is remembered.
2. **Mark while it plays.** Press **Render preview** once and a small 720p copy of the timeline plays in the panel (made by Resolve's render engine, cached per timeline). **Hold C** across a section to select a cut (in on press, out on release); **press S** on a frame to mark a still. Both keys can be changed in Settings, and the two on-screen buttons do the same with the mouse. Space plays and pauses, the arrow keys step a frame, and Resolve's playhead follows when you pause. Each mark becomes a Resolve timeline marker (cyan for cuts, pink for stills), so you see them on the timeline, can trim or delete them there, and they travel with the project. Without a preview, the pad marks from Resolve's own playhead while you play there.
3. **Export.** Press **Export everything**, or **Cuts only** / **Stills only**. ExportX adds one job per deliverable to Resolve's own render queue (cuts as in/out ranges, stills as single-frame image renders), starts the render and shows progress per file. Everything from here on happens **in the background**: keep marking, switch to Resolve or minimise the panel. The dock or taskbar icon shows the progress, and a system notification pops when the batch is done (click it to bring the panel back).
4. **Upload to the Triptych Studios portal** (optional). With the switch next to Export on, you pick **which portal project** the batch goes in (the picker lists the portal's projects by name, job number and client, remembers your choice per Resolve project, and pre-selects a name match). When the render finishes, every file goes into that project's **Delivery tab**, filed into the box its kind fits: finals in the hero or master box, cuts in the social box, stills in the stills box. The upload runs in the background with its own progress and notification; the card above the file list reads `All 7 files in SpotA Launch on Triptych Studios` with an *open on the portal* link, and each file row says which box it landed in. On the portal, any file can be moved to another box, and nothing reaches the client until you press *Send the final delivery*.

## Settings

The **Settings** tab edits deliverables in place: name, the label used in file names, whether it applies to the whole timeline, each cut or each still, format and codec (the lists come straight from your Resolve), size, quality or bit rate, a Deliver preset to start from, folder, audio, and whether it is ticked by default. Add, duplicate, reset or delete deliverables there. The same tab holds the file-name pattern with a live example, the capture keys, the **portal** (URL, the plugin key, *Test connection*, auto-upload), extra timelines, and the log. The key is stored encrypted with the OS keychain where Electron offers one.

## The portal

ExportX talks to the Triptych Studios portal's plugin API: a key made under **Settings › ExportX** on the portal, `GET /api/plugin/projects` for the picker, and `POST /api/plugin/deliverables` to get an upload plan per file (presigned parts into Cloudflare R2, or one signed PUT), put the bytes there, and register the file into a Delivery box. The portal side lives in the `triptych-portal` repository (its walk through is `docs/exportx-api.md` there). [`portal-kit/`](portal-kit/README.md) mirrors the contract: README, OpenAPI, a JSON Schema for the register call, examples, a dependency-free **reference server** that behaves like the portal (and is the test fixture), and a smoke test for either side. `bash scripts/package-portal-kit.sh` zips it as `dist/exportx-portal-kit.zip`.

```bash
node portal-kit/reference-server/server.js --port 8787 --token devtoken   # a portal on your machine
# ExportX › Settings › Triptych Studios portal: URL http://localhost:8787, key devtoken, Test connection
```

## Is it Resolve's real export engine?

Yes. ExportX encodes nothing itself. It sets the Deliver page's render settings through Resolve's scripting API and adds jobs to Resolve's render queue, so every file comes out of the same renderer as a manual export, with the same formats, codecs and hardware encoders your machine offers. The jobs are visible in the Deliver page while they run. The API does not expose every advanced Deliver option; for those, save a Deliver preset in Resolve and start the deliverable from it in Settings. ExportX then only overrides format, codec, size, name and range.

## What you get

- **Workflow Integration plugin** for Resolve Studio 18+: a panel under *Workspace › Workflow Integrations › ExportX*. Landscape layout: the C and S keys over the cuts and stills lists at the top left, the export checklist under them, the Export button pinned at the bottom, and the picture on the right. Narrow windows stack. Design notes in [docs/DESIGN.md](docs/DESIGN.md).
- **A preview of the timeline in the panel** (a 720p proxy rendered by Resolve, cached per timeline) with a scrub bar that shows your marks, plus **two capture keys**: hold C for a cut, press S for a still, both changeable. Marks map to exact timeline frames and are stored as timeline markers.
- **Settings tab** to change formats, codecs, sizes, quality, presets, folders and labels without touching JSON.
- **Naming convention** `YYMMDD_Project_Label` by default, e.g. `261018_SpotA_Final.mp4`, with a live example and tokens for anything else.
- **Deliverable profiles as JSON** with a `target` of `timeline`, `cuts` or `stills`: nine sensible defaults, add your own in `~/.exportx/profiles/`, override the bundled ones by id. See [docs/PROFILES.md](docs/PROFILES.md).
- **Multi-timeline batches**: pick extra timelines under More options and one click renders the selected deliverables for each.
- **Live progress** per job, pulled from Resolve's queue; stop from the panel. Renders and uploads run in the background with dock/taskbar progress and a notification when done.
- **Upload to the Triptych Studios portal** when a batch finishes (or by hand): pick the portal project next to Export, and the files land in its Delivery tab, filed into the offer's boxes. The contract and a reference server live in [`portal-kit/`](portal-kit/README.md).
- **Python edition** (`python/exportx_batch.py`) using the same profiles and markers, for the Scripts menu in the free edition or headless use from a terminal in Studio.
- **No runtime dependencies**, unit-tested against an in-memory Resolve mock, CI on every push.

## Install

**Download:** <https://github.com/triptychvisuals/ExportX/archive/refs/heads/main.zip> (or a numbered version under [tags](https://github.com/triptychvisuals/ExportX/tags)). Unzip it, then double-click **`Install ExportX.command`** (Mac; right-click › Open the first time) or **`Install ExportX.cmd`** (Windows). It copies the plugin into Resolve's plugin folder and takes `WorkflowIntegration.node` from your own Resolve install, so one download fits every machine. Restart Resolve Studio and open **Workspace › Workflow Integrations › ExportX**.

From a terminal instead:

```bash
git clone https://github.com/triptychvisuals/ExportX.git
cd ExportX
bash scripts/install.sh                 # macOS / Linux (sudo prompt)
# Windows, elevated PowerShell:
# powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

Full instructions, paths and troubleshooting: [docs/INSTALL.md](docs/INSTALL.md). To send batches to the portal, make a key under **Settings › ExportX** on the portal and paste it into ExportX's Settings tab.

Python / CLI:

```bash
python3 python/exportx_batch.py --list                                   # timelines, marks, profiles, formats, codecs
python3 python/exportx_batch.py --all --out ~/Deliver/Job123 --wait      # everything that is marked, named 261018_Project_Label
python3 python/exportx_batch.py --targets stills --out ~/Deliver --render
python3 python/exportx_batch.py --mark-cut 01:00:04:00 01:00:09:12 --mark-still 01:00:12:05
EXPORTX_PORTAL_URL=https://portal.triptychstudios.co EXPORTX_PORTAL_TOKEN=tpx_… \
python3 python/exportx_batch.py --list-projects                                                   # the portal's projects (id, job number, name)
python3 python/exportx_batch.py --all --out ~/Deliver/Job123 --wait --upload --portal-project proj-…   # render, then land the files in that project
```

## Bundled profiles

| Name | Applies to | Output | Example file | Default |
| --- | --- | --- | --- | --- |
| Master | timeline | QuickTime ProRes 422 HQ, 24-bit PCM | `01_Masters/261018_SpotA_Master.mov` | on |
| Final 4K | timeline | MP4 H.265 3840×2160 | `02_Final/261018_SpotA_Final.mp4` | on |
| Web 1080p | timeline | MP4 H.264 1920×1080 | `02_Final/261018_SpotA_Web.mp4` | on |
| Social cuts | each cut | MP4 H.264 1920×1080 | `04_Social/261018_SpotA_Social_01.mp4` | on |
| Social cuts 9:16 | each cut | MP4 H.264 1080×1920 | `04_Social/9x16/261018_SpotA_Social9x16_01.mp4` | off |
| Stills TIFF | each still | TIFF | `06_Stills/261018_SpotA_Still_01_<frame>.tif` | on |
| Stills JPEG | each still | JPEG | `06_Stills/JPEG/261018_SpotA_Still_01_<frame>.jpg` | off |
| Review proxy 720p | timeline | MP4 H.264 1280×720 | `03_Review/261018_SpotA_Review.mp4` | off |
| Individual clips | timeline | ProRes 422, one file per clip | `05_Clips/` | off |

Change any of these under Settings. Codec lists come from your Resolve, so they match what your machine can encode.

## Repository layout

```
manifest.xml        Resolve plugin manifest (id com.triptychvisuals.exportx)
main.js             Electron main: Resolve connection, playhead polling, marks, preview proxy, settings + render IPC
preload.js          contextBridge API exposed to the UI
ui/                 Panel UI (HTML/CSS/vanilla JS), browser mock + sample video for previews, bundled Wix Madefor fonts (OFL)
src/resolve.js      ResolveBridge: render API, timeline info, playhead, markers
src/batch.js        BatchExporter: profiles × timelines × marks → jobs, render, poll
src/marks.js        Cuts and stills as timeline markers; hold/tap classification
src/timecode.js     Timecode ↔ frames (drop-frame aware)
src/profiles.js     Profile loading and validation
src/naming.js       File-name convention and tokens
src/portal.js       PortalClient: the portal's plugin API (projects, upload plans, register, batch note)
portal-kit/         The contract with the portal: README, OpenAPI, schema, examples, reference server, smoke test
profiles/           Bundled deliverable profiles
python/             Python edition (Scripts menu / CLI)
scripts/            install.sh, install.ps1, package.sh, package-portal-kit.sh, check-syntax.js, build-preview.js, screenshot.js
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
bash scripts/package-portal-kit.sh   # dist/exportx-portal-kit.zip for the portal repository
```

`WorkflowIntegration.node` is Blackmagic's binary and is git-ignored; the install scripts copy it from your Resolve install. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit and [docs/RESOLVE_API.md](docs/RESOLVE_API.md) for the slice of the Resolve API in use.

## Requirements

- The plugin panel needs **DaVinci Resolve Studio 18 or newer** (Blackmagic only enables Workflow Integration plugins in Studio).
- The Python edition runs from the Scripts menu in the free edition, and from a terminal in Studio with external scripting enabled.

## License

MIT, see [LICENSE](LICENSE). Bundled fonts are under the SIL Open Font License, see `ui/fonts/LICENSE-OFL.txt`.
