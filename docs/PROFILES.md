# Deliverable profiles

A profile is one deliverable: what it applies to, container, codec, optional resolution, Resolve render settings, and where/how to name the file. ExportX queues:

| `target` | One render job per… | Typical use |
| --- | --- | --- |
| `timeline` (default) | timeline | final master, final 4K, web version |
| `cuts` | **cut mark** × timeline, rendered as a `MarkIn`/`MarkOut` range | social cuts, teasers |
| `stills` | **still mark** × timeline, rendered as a single frame | frame grabs, thumbnails, posters |

Cuts and stills are marked with the pad in the panel (hold = cut, tap = still) or with the Python CLI, and live as Resolve timeline markers (`customData` `exportx:cut` / `exportx:still`).

Profiles are JSON files read from, in order (later wins by `id`):

1. `profiles/` inside the plugin (bundled defaults, see `profiles/default.json`)
2. `~/.exportx/profiles/` (yours; override the location with `EXPORTX_HOME`)

A file may contain a single profile object, an array of them, or `{ "profiles": [ ... ] }`.

**You rarely need to touch these files.** The panel's **Settings** tab edits deliverables in place: name, the label used in file names, what it applies to, format and codec (lists read live from your Resolve), size, quality, a Deliver preset to start from, folder, audio, and whether it is ticked by default. Saving writes `~/.exportx/profiles/<id>.json`; "Reset to default" removes that file so the bundled version comes back. The JSON is for sharing, versioning, or the few settings the form does not expose.

## Schema

```jsonc
{
  "id": "cuts-social-1080",         // required. letters, digits, - and _ only; used by the CLI
  "name": "Social cuts",            // required. shown in the panel
  "label": "Social",                // optional. the word used in file names (default: first word of the name)
  "description": "…",               // optional
  "target": "cuts",                 // "timeline" (default) | "cuts" | "stills"
  "format": "mp4",                  // required. Resolve format id or description ("mp4", "QuickTime", "tif")
  "codec": "H264",                  // required. Resolve codec id or description, or "auto" for the first codec of the format
  "renderPreset": null,             // optional. a Resolve render preset to load first (its name as shown in Deliver)
  "renderMode": "single",           // "single" (one file) or "individual" (one file per clip)
  "resolution": { "width": 1920, "height": 1080 },   // optional. omit to render at timeline resolution
  "frameRate": null,                // optional. e.g. 23.976 / 25 / 29.97
  "settings": {                     // optional. passed to Project.SetRenderSettings(), one key at a time (see below)
    "VideoQuality": 12000,          // kb/s for H.264/H.265; a "Least".."Best" level only for codecs that have levels
    "AudioCodec": "aac",
    "AudioSampleRate": 48000,
    "NetworkOptimization": true
  },
  "subfolder": "04_Social",         // optional. created under the output folder; relative only, no ".."
  "fileSuffix": "",                 // optional. appended after the filename template
  "enabledByDefault": true,         // optional. included when the panel first opens
  "tags": ["social"]                // optional. for your own organisation
}
```

Format and codec matching ignores case and punctuation, and also matches on description, so `"prores 422 hq"`, `"ProRes422HQ"` and `"Apple ProRes 422 HQ"` all resolve to the same codec. When in doubt, click **List formats & codecs** in the panel or run `python3 python/exportx_batch.py --list` and copy an id from the output. Available codecs differ by OS and Resolve version.

## Order of application

For each job ExportX calls, in order:

1. `LoadRenderPreset(renderPreset)` if set (a preset resets most Deliver settings)
2. `SetCurrentRenderFormatAndCodec(format, codec)`
3. `SetCurrentRenderMode(0|1)` from `renderMode`
4. `SetRenderSettings({ …settings, TargetDir, CustomName, FormatWidth/FormatHeight, FrameRate, SelectAllFrames | MarkIn/MarkOut })`
5. `AddRenderJob()`

Anything in `settings` wins over the preset. `TargetDir`, `CustomName`, `SelectAllFrames`, `MarkIn` and `MarkOut` are always supplied by ExportX, so do not put them in `settings`. Still profiles always get `ExportAudio: false`.

Because every job goes through `SetRenderSettings` and `AddRenderJob`, the files are made by Resolve's own render engine with whatever encoders your machine has. The API does not expose every advanced Deliver option; when you need one, save a Deliver preset in Resolve and point the deliverable at it with `renderPreset` (or "Start from Deliver preset" in Settings).

## Stills

A still is a render job whose in and out point are the same frame, so it goes through the same Deliver engine, colour management and sizing as everything else. Use an image format (`tif`, `png`, `jpg`, `dpx`, `exr`) with `"codec": "auto"` or a specific codec id from the format list. Resolve appends the frame number to image-sequence filenames (for example `SpotA_Main Edit_still01_0086412.tif`); the number is the absolute timeline frame, which is also handy for finding the frame again.

## Useful `settings` keys

These are the keys `Project.SetRenderSettings()` accepts (from Blackmagic's scripting README; verify against your installed version's `Developer/Scripting/README.txt`):

| Key | Type | Notes |
| --- | --- | --- |
| `SelectAllFrames` | bool | Set by ExportX (`true` for timeline targets, `false` for cuts and stills). |
| `MarkIn`, `MarkOut` | int | Absolute timeline frames; set by ExportX from the mark. |
| `TargetDir` | string | Set by ExportX. |
| `CustomName` | string | Set by ExportX. |
| `UniqueFilenameStyle` | int | `0` prefix, `1` suffix. Useful with `"renderMode": "individual"`. |
| `ExportVideo`, `ExportAudio` | bool | |
| `FormatWidth`, `FormatHeight` | int | Set from `resolution`. |
| `FrameRate` | number | Set from `frameRate`. |
| `PixelAspectRatio` | string | `"square"` or `"cinemascope"`. |
| `VideoQuality` | int or string | `0` automatic; `1…` bit rate in kb/s (what H.264 and H.265 take: the bundled profiles use 45000 for the 4K final, 16000 for 1080p, 12000 for social cuts, 6000 for the proxy); or `"Least"`, `"Low"`, `"Medium"`, `"High"`, `"Best"` for the few codecs with quality levels (Photo JPEG and the like). A level on H.264/H.265 is refused by Resolve and dropped with a note. |
| `AudioCodec` | string | e.g. `"aac"`, `"lpcm"`. |
| `AudioBitDepth` | int | 16 / 24 / 32, for Linear PCM (`lpcm`). AAC has no bit depth; Resolve refuses the key and ExportX drops it. |
| `AudioSampleRate` | int | 48000 |
| `ColorSpaceTag`, `GammaTag` | string | e.g. `"Same as Project"`, `"Rec.709"`, `"Rec.2100 ST2084"`. |
| `ExportAlpha` | bool | Codec permitting. |
| `EncodingProfile` | string | e.g. `"Main10"` for H.265. |
| `MultiPassEncode` | bool | H.264 / H.265. |
| `AlphaMode` | int | `0` premultiplied, `1` straight. |
| `NetworkOptimization` | bool | Fast-start MP4/MOV. |

### When Resolve refuses a setting

`SetRenderSettings` takes the whole dictionary or none of it, and refuses any key the current format and codec do not offer. ExportX therefore sets the essentials first (folder, name, frame range), then the size as a pair, then every other key on its own. A refused extra is dropped: the job renders with Resolve's default for it, the log says `Resolve does not offer VideoQuality = "High" for mp4/H264; "Web 1080p" renders without`, and the same line shows as a banner when the batch is queued. A refused folder, name, range or size stops that job with a message that names the key and what to change.

## File names

The default convention is **`{yymmdd}_{project}_{label}`**, so on 18 October 2026 the project "SpotA" exports as

```
261018_SpotA_Master.mov       (Master)
261018_SpotA_Final.mp4        (Final 4K)
261018_SpotA_Web.mp4          (Web 1080p)
261018_SpotA_Social_01.mp4    (Social cuts, one per cut)
261018_SpotA_Social_02.mp4
261018_SpotA_Still_01_0086412.tif   (Stills TIFF, one per still; Resolve adds the frame number)
```

Change the pattern under Settings › File names; the panel shows a live example. Spaces become underscores by default (`underscoreSpaces` in `~/.exportx/settings.json`). Tokens:

| Token | Value |
| --- | --- |
| `{yymmdd}` `{date}` `{time}` | `261018`, `20261018`, `140509` |
| `{project}` `{timeline}` | Resolve names |
| `{label}` | the deliverable's label (Final, Master, Social, Still…) |
| `{profile}` `{profileName}` | deliverable id / display name |
| `{format}` `{codec}` `{width}` `{height}` | from the deliverable |
| `{n}` `{cut}` `{still}` | two-digit mark number (cuts and stills only) |
| `{tc}` `{tcout}` | in / out timecode of the mark with dots, e.g. `01.00.12.05` |
| `{in}` `{out}` | absolute in / out frame of the mark |

Characters that are illegal in filenames become `_`, and Resolve adds the extension. For cuts and stills, if the pattern contains none of `{n}` `{cut}` `{still}` `{tc}` `{in}`, ExportX appends `_{n}` so every mark gets its own file.

## Bundled profiles

| id | Name | Label | target | Output | Default |
| --- | --- | --- | --- | --- | --- |
| `final-prores-master` | Master | Master | timeline | QuickTime ProRes 422 HQ, 24-bit PCM | on |
| `final-4k-h265` | Final 4K | Final | timeline | MP4 H.265 3840×2160 | on |
| `final-1080-h264` | Web 1080p | Web | timeline | MP4 H.264 1920×1080 | on |
| `cuts-social-1080` | Social cuts | Social | cuts | MP4 H.264 1920×1080 per cut | on |
| `cuts-social-vertical` | Social cuts 9:16 | Social9x16 | cuts | MP4 H.264 1080×1920 per cut | off |
| `stills-tiff` | Stills TIFF | Still | stills | TIFF per still | on |
| `stills-jpeg` | Stills JPEG | Still | stills | JPEG per still | off |
| `review-proxy` | Review proxy 720p | Review | timeline | MP4 H.264 1280×720 | off |
| `clips-prores` | Individual clips | Clip | timeline | ProRes 422, one file per clip | off |

## Examples

A client-specific HEVC 10-bit master:

```json
{
  "id": "client-hevc-main10",
  "name": "Client HEVC Main10",
  "label": "Client",
  "format": "mp4",
  "codec": "H265",
  "settings": { "EncodingProfile": "Main10", "VideoQuality": 60000, "MultiPassEncode": true, "AudioCodec": "aac" },
  "subfolder": "Client"
}
```

Square cuts for a feed, reusing a Deliver preset you already maintain:

```json
{
  "id": "cuts-square",
  "name": "Square cuts",
  "label": "Square",
  "target": "cuts",
  "renderPreset": "Instagram Square",
  "format": "mp4",
  "codec": "H264",
  "resolution": { "width": 1080, "height": 1080 },
  "subfolder": "04_Social/1x1"
}
```

16-bit PNG stills for a poster designer:

```json
{
  "id": "stills-png16",
  "name": "Stills PNG 16-bit",
  "label": "Still",
  "target": "stills",
  "format": "png",
  "codec": "RGB 16 bits",
  "subfolder": "06_Stills/PNG"
}
```
