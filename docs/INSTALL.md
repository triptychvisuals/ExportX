# Installing ExportX

ExportX ships in two forms that share the same deliverable profiles:

| Edition | Needs | Where it shows up |
| --- | --- | --- |
| **Workflow Integration plugin** (the panel with buttons) | DaVinci Resolve **Studio** 18 or newer | Workspace › Workflow Integrations › ExportX |
| **Python script / CLI** | Resolve free or Studio (in-app); Studio for external/terminal use | Workspace › Scripts, or your terminal |

Blackmagic only exposes the Workflow Integration plugin host and external scripting in Studio. The free edition can still run the Python script from the Scripts menu.

## 1. Workflow Integration plugin

### The short way: download and double-click

1. Download the plugin: **<https://github.com/triptychvisuals/ExportX/archive/refs/heads/main.zip>** (the latest), or a numbered version from <https://github.com/triptychvisuals/ExportX/tags>.
2. Unzip it. You get a folder called `ExportX-main` (or `ExportX-0.2.0`).
3. **Mac:** double-click `Install ExportX.command` inside it. If macOS says it "cannot be opened because it is from an unidentified developer", right-click the file, choose **Open**, then **Open** again. It asks for your Mac password once (Resolve's plugin folder belongs to the system).
   **Windows:** double-click `Install ExportX.cmd` and allow the administrator prompt.
4. Restart DaVinci Resolve Studio and open **Workspace › Workflow Integrations › ExportX**.

The installer copies `WorkflowIntegration.node` out of your own Resolve install, so the download works for any Resolve Studio 18 or newer on Mac, Windows or Linux. If you would rather type it: `bash ~/Downloads/ExportX-main/scripts/install.sh`.

### Paths you will need

| OS | Plugins folder | Developer folder |
| --- | --- | --- |
| macOS | `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/` | `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/` |
| Windows | `%ProgramData%\Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins\` | `%ProgramData%\Blackmagic Design\DaVinci Resolve\Support\Developer\` |
| Linux | `/opt/resolve/Workflow Integration Plugins/` | `/opt/resolve/Developer/` |

The native bridge `WorkflowIntegration.node` lives in `<Developer>/Workflow Integrations/Examples/SamplePlugin/`. It is Blackmagic's binary, is specific to your OS and Resolve version, and is deliberately **not** committed to this repository. The install scripts copy it for you.

### macOS / Linux

```bash
git clone https://github.com/triptychvisuals/ExportX.git
cd ExportX
bash scripts/install.sh          # copies the plugin; asks for sudo
# or, while developing:
bash scripts/install.sh --link   # symlinks the repo so edits show up on the next launch
```

### Windows (elevated PowerShell)

```powershell
git clone https://github.com/triptychvisuals/ExportX.git
cd ExportX
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
# development junction:
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Link
```

### Manual install

1. Create `<Plugins folder>/ExportX/`.
2. Copy `manifest.xml`, `package.json`, `main.js`, `preload.js`, `src/`, `ui/` and `profiles/` into it.
3. Copy `WorkflowIntegration.node` from the SamplePlugin folder into it as well.
4. Restart Resolve Studio. ExportX appears under **Workspace › Workflow Integrations**.

No `npm install` is required at runtime: Resolve launches the plugin inside its own bundled Electron and the plugin has no third-party dependencies.

## 2. Python script

### Inside Resolve (Workspace › Scripts)

Copy `python/exportx_batch.py` and the `profiles/` folder next to each other in your Fusion scripts folder:

| OS | Scripts folder |
| --- | --- |
| macOS | `~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility/` |
| Windows | `%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\` |
| Linux | `~/.local/share/DaVinciResolve/Fusion/Scripts/Utility/` |

Set `EXPORTX_OUT` (and optionally `EXPORTX_PROFILES`) in your environment, or edit the `CONFIG` block at the top of the script, then run it from the Scripts menu. Resolve needs Python 3 installed and selected in Preferences › System › General.

### From a terminal (Studio)

Enable Preferences › System › General › **External scripting using: Local**, export the variables from Resolve's `Developer/Scripting/README.txt`, then:

```bash
python3 python/exportx_batch.py --list
python3 python/exportx_batch.py --all --out "/Volumes/Deliver/Job123" --wait
```

## Troubleshooting

- **ExportX is not in the Workflow Integrations menu**: check the folder name and that `manifest.xml` is directly inside it; make sure you are on Studio 18+; look at Resolve's log (`Help › Create Diagnostics Log`) for manifest parse errors.
- **"WorkflowIntegration.node is missing"** banner: copy the file from the SamplePlugin folder into the plugin folder. If you installed with `--link`, copy it into the repo root (it is git-ignored).
- **"Initialize() failed"**: the plugin was launched outside Resolve, or by a Resolve that does not support Workflow Integrations.
- **"Resolve refused the render setting X"**: Resolve's Deliver page would not take that value for the deliverable's format and codec. The message says which key and what to change (the folder, the name pattern, the marks, or the size). Settings that are only extras (a quality level, an audio bit depth, an encoding profile) never stop a job: Resolve's own default is used instead and the log under Settings › Advanced says so.
- **Unknown codec / format**: click **List formats & codecs** in the panel (or run the Python script with `--list`) and use one of the printed ids in your profile. Ids differ between Resolve versions and OSes (for example, ProRes encoding on Windows/Linux needs Resolve 19.1 or later).
- **Jobs queue but nothing renders**: Resolve refuses `StartRendering` while another render is in progress. Stop it in the Deliver page and try again.
- **Running the UI outside Resolve** (for development): `npm install` once, then `EXPORTX_MOCK=1 npx electron .` uses the mock Resolve from `test/helpers/mock-resolve.js`.
