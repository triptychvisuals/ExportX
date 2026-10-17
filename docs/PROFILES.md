# Deliverable profiles

A profile is one deliverable: container, codec, optional resolution, Resolve render settings, and where/how to name the file. ExportX queues one Resolve render job per **profile × timeline**.

Profiles are JSON files read from, in order (later wins by `id`):

1. `profiles/` inside the plugin (bundled defaults, see `profiles/default.json`)
2. `~/.exportx/profiles/` (yours; override the location with `EXPORTX_HOME`)

A file may contain a single profile object, an array of them, or `{ "profiles": [ ... ] }`. Click **Folder** in the panel to open the user folder, and **Reload** after editing.

## Schema

```jsonc
{
  "id": "h264-web",                 // required. letters, digits, - and _ only; used in filenames and the CLI
  "name": "H.264 Web (1080p)",      // required. shown in the panel
  "description": "…",               // optional
  "format": "mp4",                  // required. Resolve format id or description ("mp4", "QuickTime", "mov")
  "codec": "H264",                  // required. Resolve codec id or description ("ProRes422HQ", "Apple ProRes 422 HQ")
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
  "subfolder": "02_Web",            // optional. created under the output folder; relative only, no ".."
  "fileSuffix": "_WEB",             // optional. appended after the filename template
  "enabledByDefault": true,         // optional. ticked when the panel first opens
  "tags": ["web"]                   // optional. for your own organisation
}
```

Format and codec matching ignores case and punctuation, and also matches on description, so `"prores 422 hq"`, `"ProRes422HQ"` and `"Apple ProRes 422 HQ"` all resolve to the same codec. When in doubt, click **List formats & codecs** in the panel or run `python3 python/exportx_batch.py --list` and copy an id from the output. Available codecs differ by OS and Resolve version.

## Order of application

For each job ExportX calls, in order:

1. `LoadRenderPreset(renderPreset)` if set (a preset resets most Deliver settings)
2. `SetCurrentRenderFormatAndCodec(format, codec)`
3. `SetCurrentRenderMode(0|1)` from `renderMode`
4. `SetRenderSettings({ …settings, TargetDir, CustomName, FormatWidth/FormatHeight, FrameRate, SelectAllFrames })`
5. `AddRenderJob()`

Anything in `settings` wins over the preset. `TargetDir` and `CustomName` are always supplied by ExportX from the output folder, subfolder and filename template, so do not put them in `settings`.

## Useful `settings` keys

These are the keys `Project.SetRenderSettings()` accepts (from Blackmagic's scripting README; verify against your installed version's `Developer/Scripting/README.txt`):

| Key | Type | Notes |
| --- | --- | --- |
| `SelectAllFrames` | bool | `true` renders the whole timeline. ExportX sets this unless you set `MarkIn`/`MarkOut`. |
| `MarkIn`, `MarkOut` | int | Frame numbers, used when `SelectAllFrames` is false. |
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

Set once in the panel (saved for next time). Tokens: `{project}`, `{timeline}`, `{profile}`, `{profileName}`, `{format}`, `{codec}`, `{width}`, `{height}`, `{date}` (YYYYMMDD), `{time}` (HHMMSS). Characters that are illegal in filenames are replaced with `_`. The profile's `fileSuffix` is appended after the template, and Resolve adds the extension.

Example: template `{project}_{timeline}_{date}` with the bundled `h264-web` profile on timeline "Main Edit" in project "SpotA" gives `SpotA_Main Edit_20261017_WEB.mp4` under `<output>/02_Web/`.

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

Reuse a Deliver-page preset you already maintain, just changing where it goes:

```json
{
  "id": "house-youtube",
  "name": "House YouTube preset",
  "renderPreset": "YouTube 2160p",
  "format": "mp4",
  "codec": "H264",
  "subfolder": "YouTube"
}
```
