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

A file may contain a single profile object, an array of them, or `{ "profiles": [ ... ] }`. Click the folder icon in the Deliverables rail to open the user folder, and the reload icon after editing.

## Schema

```jsonc
{
  "id": "cuts-social-1080",         // required. letters, digits, - and _ only; used in filenames and the CLI
  "name": "Cuts · Social 1080p",    // required. shown in the panel
  "description": "…",               // optional
  "target": "cuts",                 // "timeline" (default) | "cuts" | "stills"
  "format": "mp4",                  // required. Resolve format id or description ("mp4", "QuickTime", "tif")
  "codec": "H264",                  // required. Resolve codec id or description, or "auto" for the first codec of the format
  "renderPreset": null,             // optional. a Resolve render preset to load first (its name as shown in Deliver)
  "renderMode": "single",           // "single" (one file) or "individual" (one file per clip)
  "resolution": { "width": 1920, "height": 1080 },   // optional. omit to render at timeline resolution
  "frameRate": null,                // optional. e.g. 23.976 / 25 / 29.97
  "settings": {                     // optional. passed straight to Project.SetRenderSettings()
    "VideoQuality": "High",
    "AudioCodec": "aac",
    "AudioBitDepth": 16,
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
| `VideoQuality` | int or string | `0` automatic; `1…` bitrate in kb/s; or `"Least"`, `"Low"`, `"Medium"`, `"High"`, `"Best"` where the codec supports quality levels. |
| `AudioCodec` | string | e.g. `"aac"`, `"lpcm"`. |
| `AudioBitDepth` | int | 16 / 24 / 32 |
| `AudioSampleRate` | int | 48000 |
| `ColorSpaceTag`, `GammaTag` | string | e.g. `"Same as Project"`, `"Rec.709"`, `"Rec.2100 ST2084"`. |
| `ExportAlpha` | bool | Codec permitting. |
| `EncodingProfile` | string | e.g. `"Main10"` for H.265. |
| `MultiPassEncode` | bool | H.264 / H.265. |
| `AlphaMode` | int | `0` premultiplied, `1` straight. |
| `NetworkOptimization` | bool | Fast-start MP4/MOV. |

## Filename template

Set once in the panel (saved for next time). Tokens:

| Token | Value |
| --- | --- |
| `{project}` `{timeline}` | Resolve names |
| `{profile}` `{profileName}` | profile id / display name |
| `{format}` `{codec}` `{width}` `{height}` | from the profile |
| `{date}` `{time}` | `YYYYMMDD`, `HHMMSS` |
| `{cut}` `{still}` `{n}` | two-digit mark number (cuts and stills only) |
| `{tc}` `{tcout}` | in / out timecode of the mark with dots, e.g. `01.00.12.05` |
| `{in}` `{out}` | absolute in / out frame of the mark |

Characters that are illegal in filenames become `_`. The profile's `fileSuffix` is appended after the template, and Resolve adds the extension. For cuts and stills, if the template contains none of `{cut}` `{still}` `{n}` `{tc}` `{in}`, ExportX appends `_cut{cut}` or `_still{still}` so every mark gets its own file.

Example: template `{project}_{timeline}_{date}` on timeline "Main Edit" in project "SpotA" with the bundled profiles gives

```
02_Final/SpotA_Main Edit_20261018_4K.mp4
04_Social/SpotA_Main Edit_20261018_cut01.mp4
04_Social/SpotA_Main Edit_20261018_cut02.mp4
06_Stills/SpotA_Main Edit_20261018_still01_0086412.tif
```

## Bundled profiles

| id | target | Output | Default |
| --- | --- | --- | --- |
| `final-prores-master` | timeline | QuickTime ProRes 422 HQ, 24-bit PCM | on |
| `final-4k-h265` | timeline | MP4 H.265 3840×2160 | on |
| `final-1080-h264` | timeline | MP4 H.264 1920×1080 | on |
| `cuts-social-1080` | cuts | MP4 H.264 1920×1080 per cut | on |
| `cuts-social-vertical` | cuts | MP4 H.264 1080×1920 per cut | off |
| `stills-tiff` | stills | TIFF per still | on |
| `stills-jpeg` | stills | JPEG per still | off |
| `review-proxy` | timeline | MP4 H.264 1280×720 | off |
| `clips-prores` | timeline | ProRes 422, one file per clip | off |

## Examples

A client-specific HEVC 10-bit master:

```json
{
  "id": "client-hevc-main10",
  "name": "Client HEVC Main10",
  "format": "mp4",
  "codec": "H265",
  "settings": { "EncodingProfile": "Main10", "VideoQuality": 60000, "MultiPassEncode": true, "AudioCodec": "aac" },
  "subfolder": "Client",
  "fileSuffix": "_HEVC"
}
```

Square cuts for a feed, reusing a Deliver preset you already maintain:

```json
{
  "id": "cuts-square",
  "name": "Cuts · Square",
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
  "name": "Stills · PNG 16-bit",
  "target": "stills",
  "format": "png",
  "codec": "RGB 16 bits",
  "subfolder": "06_Stills/PNG"
}
```
