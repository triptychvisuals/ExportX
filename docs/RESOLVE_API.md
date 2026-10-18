# DaVinci Resolve API cheat sheet

This is the slice of Blackmagic's scripting API that ExportX uses. The authoritative reference is the `README.txt` that ships with your Resolve install under `Developer/Scripting/`, and `Developer/Workflow Integrations/README.txt` for the plugin host. Both change between versions; when they disagree with this page, they win.

## Getting the Resolve object

| Context | How |
| --- | --- |
| Workflow Integration plugin (Electron, Studio 18+) | `const WI = require('./WorkflowIntegration.node'); WI.Initialize('<plugin id>'); const resolve = WI.GetResolve(); … WI.CleanUp();` |
| Script run from Workspace › Scripts | `resolve` is already a global (also `bmd.scriptapp("Resolve")`) |
| External Python (Studio) | `import DaVinciResolveScript as dvr; resolve = dvr.scriptapp("Resolve")` with `RESOLVE_SCRIPT_API`, `RESOLVE_SCRIPT_LIB`, `PYTHONPATH` set per the README |

`src/resolve.js` awaits every call so it does not matter whether the binding returns plain values or Promises.

## Objects

```
Resolve
  GetProductName() GetVersionString() GetProjectManager() GetCurrentPage() OpenPage(name)
ProjectManager
  GetCurrentProject() LoadProject(name) SaveProject() GetProjectListInCurrentFolder()
Project
  GetName() GetTimelineCount() GetTimelineByIndex(i) GetCurrentTimeline() SetCurrentTimeline(tl)
  --- render presets / formats ---
  GetRenderPresetList() -> [name]
  LoadRenderPreset(name) -> bool
  SaveAsNewRenderPreset(name) -> bool
  GetRenderFormats() -> {description: formatId}        e.g. {"QuickTime": "mov", "MP4": "mp4", "TIFF": "tif"}
  GetRenderCodecs(formatId) -> {description: codecId}  e.g. {"Apple ProRes 422 HQ": "ProRes422HQ"}
  GetCurrentRenderFormatAndCodec() -> {format, codec}
  SetCurrentRenderFormatAndCodec(formatId, codecId) -> bool
  GetRenderResolutions(formatId, codecId) -> [{Width, Height}]
  GetCurrentRenderMode() / SetCurrentRenderMode(0 individual clips | 1 single clip)
  SetRenderSettings({...}) -> bool                     keys listed in docs/PROFILES.md
  --- queue ---
  AddRenderJob() -> jobId
  GetRenderJobList() -> [{JobId, TimelineName, TargetDir, OutputFilename, RenderMode, Format, Codec, MarkIn, MarkOut, ...}]
  DeleteRenderJob(jobId) / DeleteAllRenderJobs()
  StartRendering(isInteractiveMode=False)
  StartRendering([jobId, ...], isInteractiveMode=False)
  StartRendering(jobId1, jobId2, ...)
  StopRendering()
  IsRenderingInProgress() -> bool
  GetRenderJobStatus(jobId) -> {JobStatus, CompletionPercentage, EstimatedTimeRemainingInMs, TimeTakenToRenderInMs, Error}
      JobStatus is one of "Ready" | "Rendering" | "Complete" | "Failed" | "Cancelled"
  ExportCurrentFrameAsStill(filePath) -> bool          (newer versions; ExportX uses one-frame render jobs instead)
Timeline
  GetName() GetStartFrame() GetEndFrame() GetStartTimecode()
  GetSetting(name) SetSetting(name, value)             "timelineFrameRate", "timelineDropFrameTimecode", ...
  GetCurrentTimecode() -> "HH:MM:SS:FF" (";" before FF when drop-frame)
  SetCurrentTimecode(tc) -> bool
  --- markers ---
  GetMarkers() -> {frameId: {color, duration, note, name, customData}}   frameId is relative to the timeline start
  AddMarker(frameId, color, name, note, duration, customData) -> bool   fails if a marker already sits on frameId
  GetMarkerByCustomData(customData) -> {frameId: {...}}
  UpdateMarkerCustomData(frameId, customData) -> bool
  DeleteMarkerAtFrame(frameNum) -> bool
  DeleteMarkerByCustomData(customData) -> bool          deletes the FIRST match only
  DeleteMarkersByColor(color) -> bool                   or "All"
  GrabStill() / GrabAllStills(stillFrameSource)         Color-page gallery stills (not used)
```

Marker colours: Blue, Cyan, Green, Yellow, Red, Pink, Purple, Fuchsia, Rose, Lavender, Sky, Mint, Lemon, Sand, Cocoa, Cream. ExportX uses Cyan for cuts and Pink for stills.

## Behaviour worth knowing

- Render settings are **global Deliver-page state**. `SetRenderSettings` changes what the Deliver page shows; `AddRenderJob` snapshots it into a job. ExportX therefore applies a profile and adds a job immediately, one item at a time.
- `AddRenderJob` uses the **current timeline**. To batch several timelines, `SetCurrentTimeline` before each group of jobs and switch back afterwards (ExportX does this).
- `LoadRenderPreset` resets most settings, so load the preset first and override afterwards.
- `MarkIn`/`MarkOut` are **absolute frames** in the same space as `GetStartFrame()`. Marker `frameId`s are **relative** to the timeline start. `abs = GetStartFrame() + frameId`.
- A render job with `MarkIn == MarkOut` renders exactly one frame. With an image format this is a still; Resolve appends the frame number to the filename.
- `StartRendering` returns `false` if a render is already running.
- `isInteractiveMode=true` shows Resolve's render progress UI and prompts; ExportX uses `false` and polls `GetRenderJobStatus` itself.
- `FormatWidth`/`FormatHeight` change the output size; how a mismatched aspect ratio is handled follows the project's image scaling settings.
- There is no play/pause call in the scripting API, and no way to read viewer frames. ExportX polls `GetCurrentTimecode()` to show Resolve's playhead, and for an in-panel picture it renders a small proxy of the timeline through the same render queue and plays that file.
- `timelineResolutionWidth` / `timelineResolutionHeight` (via `Timeline.GetSetting`) give the aspect ratio for the preview proxy.
- Codec and format ids differ by OS and Resolve version. Match loosely and offer the user the list (`capabilities()` in `src/resolve.js`).

## Workflow Integration plugin host

- Plugins live in the `Workflow Integration Plugins` folder (paths in docs/INSTALL.md), one folder per plugin, with `manifest.xml` at its root:

  ```xml
  <?xml version="1.0" encoding="UTF-8"?>
  <BlackmagicDesign>
    <Plugin>
      <Id>com.triptychvisuals.exportx</Id>
      <Name>ExportX</Name>
      <Version>0.1.0</Version>
      <Description>…</Description>
      <FilePath>main.js</FilePath>
    </Plugin>
  </BlackmagicDesign>
  ```

- Resolve runs `FilePath` inside its bundled Electron; `require('electron')` works without installing anything.
- `WorkflowIntegration.node` must sit next to `main.js`. Copy it from `Developer/Workflow Integrations/Examples/SamplePlugin/`.
- `Initialize(pluginId)` must be passed the same id as the manifest. Call `CleanUp()` before quitting.
- The example plugin from Blackmagic in that same folder is the best reference for anything not covered here.
