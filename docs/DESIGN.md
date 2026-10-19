# Design notes: what ExportX takes from Editor X

Editor X was Wix's web-design platform for designers and agencies: a closed beta in February 2020, public in July 2020, and folded into Wix Studio from 2023 onward. It mattered because it treated a visual tool as a precision instrument: a real CSS grid, a flexbox "Layouter", docking, custom breakpoints that cascade, and an Inspector that showed the exact numbers behind every element. ExportX borrows that posture. A render panel is also a precision instrument, and its users are the same people.

These notes are the brief for the ExportX panel (`ui/`). Section 9 lists what is confirmed by sources and what is recalled from using the product; treat the recalled parts as design intent, not as facts about Wix.

## 0. Simplicity first

The first pass copied Editor X's workspace literally: a tools rail, a canvas, an inspector and a breakpoint strip. It looked like Editor X and it was too much to read for a tool whose whole job is three actions. The second pass keeps the look and drops the structure. The panel is now one column of three numbered steps, because the job really is a sequence:

1. **What to export**: a plain checklist and a folder.
2. **Mark while it plays**: the preview, the playhead, two keys, two short lists.
3. **Export**: one big button, two small ones, progress.

Everything that is set up once and then left alone (file-name pattern, the deliverables themselves, keys, other timelines, the log) lives in a second tab, **Settings**. Nothing was removed from the plugin; it was moved out of the first read.

The third pass turned the column into a **landscape** window, because the panel sits next to Resolve on a wide monitor and the preview video wants width. The left pane holds the controls in reading order: the mark block (the two keys over the two mark lists, a 2 × 2) at the very top, the export checklist under it, and the Export button pinned at the bottom so it never scrolls away. The right pane is the picture: the preview, its scrub bar and transport, the playhead, and the per-file progress once an export runs. Under 900 px the panes stack into one scrolling column with the Export button sticky at the bottom.

Rules that came out of the rewrite:

- A first-time user should be able to say what each step does from its heading alone.
- One primary button. The two secondary buttons exist only because the user asked for them by name ("export the stills").
- Plain names for deliverables ("Final 4K", "Social cuts", "Stills TIFF"); codec details are secondary text on the right, hidden at phone width.
- Tags only where they explain behaviour (`per cut`, `per still`); the default case gets no tag.
- The page scrolls. No fixed grid, no panes, no inner scrollers except the two mark lists and the log.
- The panel must still work at 440 px wide, because it floats next to Resolve's viewer.

## 1. The ten notes

1. **Chrome is black, content is bright.** Editor X put its controls in near-black bars and left the page itself as the brightest thing on screen. ExportX uses a black top bar, a near-black page, and reserves pure white for the things you read: names, numbers, filenames.
2. **One accent, spent carefully.** The accent marks the included thing, the running thing, and the primary action. Nothing else is coloured. Status colours (green, amber, red) appear only on status; cyan and pink are the marker colours and mean cut and still, in the panel and on Resolve's timeline alike.
3. **Steps instead of panes.** Editor X's left rail / canvas / Inspector / Publish became ExportX's three steps and one button. The sequence is the structure.
4. **Precision where it matters.** Click anything and the exact numbers are there: the playhead to the frame, every mark with in and out timecode and duration, every file with its name and state. The inspector is gone; the numbers moved next to the things they describe.
5. **Contexts live in a strip.** Editor X's breakpoint navigator sat across the top of the canvas. ExportX's timeline picker at the top of the mark block does the same for timelines (it only appears when the project has more than one), and the chips under Advanced add more to one batch.
6. **Layers: click selects, a control toggles.** Kept as a single tick box per deliverable; with no inspector there is nothing else to select.
7. **Typography carries hierarchy.** Big, tight, geometric display type for the step titles, the playhead and the keycaps; tiny tracked uppercase labels for list headings; tabular numerals for anything that counts. The typeface is Wix Madefor, the geometric sans Wix commissioned from Dalton Maag (see §7).
8. **Precision cues, not adjectives.** `01:00:04:00 → 01:00:09:11  5.5s`, `3840×2160`, `17% · 1 of 6 done`. Where a value is inherited, say from where (`Timeline`), not "auto".
9. **Hairlines, not shadows.** Flat surfaces separated by 1 px lines. 6 px radii on fields and rows, full pills on buttons and chips, no drop shadows, no gradients.
10. **Motion is fast and informative.** 150 ms state changes, no bounce. Progress is a thin accent line under the top bar plus one bar in step 3; both turn green when done and red if anything failed. The pad flashes cyan or pink for 220 ms when a mark lands.

## 2. Token sheet

All tokens are CSS custom properties on `:root` in `ui/styles.css`. Change the accent in one place to re-skin.

| Token | Value | Use |
| --- | --- | --- |
| `--x-chrome` | `#000000` | Top bar, log |
| `--x-bg` | `#0f0f0f` | Page background |
| `--x-surface` / `--x-surface-2` / `--x-surface-3` | `#161616` / `#1d1d1d` / `#262626` | Pad, inputs, hovered rows |
| `--x-line` / `--x-line-2` | `#262626` / `#343434` | Hairlines, control borders |
| `--x-text` / `--x-text-2` / `--x-text-3` | `#ffffff` / `#a3a3a3` / `#6f6f6f` | Primary, secondary, tertiary text |
| `--x-accent` / `--x-accent-2` | `#3b7bff` / `#6a9bff` | Ticks, primary button, progress, holding pad |
| `--x-cut` / `--x-still` | `#38c6d6` / `#e06fb8` | Cut and still marks (Resolve's cyan and pink) |
| `--x-ok` / `--x-warn` / `--x-bad` | `#34c759` / `#e2b93b` / `#ff453a` | Status only |
| `--x-radius` / `--x-pill` | `6px` / `999px` | Fields and rows / buttons and chips |
| `--x-col` | `620px` | Column width |
| `--x-font-display` | Wix Madefor Display | Step titles, playhead, pad, wordmark |
| `--x-font-ui` | Wix Madefor Text | Everything else |
| `--x-font-mono` | system monospace | Timecodes, filenames, codec ids |

Type scale: 10.5 px tracked uppercase labels, 12–13 px UI text, 14 px deliverable names, 17 px step titles, 20 px pad title, 24 px playhead. Spacing on a 4 px grid.

## 3. Editor X → ExportX mapping

| Editor X | ExportX |
| --- | --- |
| Top bar with site name and **Publish** | Top bar with project › timeline; the primary button lives in step 3 |
| Layers panel (select vs. show/hide) | Step 1 checklist |
| Direct manipulation on the canvas (drag, dock, snap) | Step 2 pad: hold while the timeline plays to mark a cut, tap for a still; marks become Resolve timeline markers |
| Inspector | Numbers placed next to their things: codec summary per deliverable, timecodes per mark, state per file |
| Breakpoint navigator | Timeline chips under More options |
| Site styles & Design Library | Profiles JSON (`profiles/`, `~/.exportx/profiles/`) |
| Dev mode | Python edition and `--list` |
| Thin progress on publish | Accent progress line under the top bar + the step 3 bar |

## 4. Components

- **Top bar** 44 px, black, sticky. White square "X" mark and `ExportX` wordmark; connection dot and `Project › Timeline`; refresh icon.
- **Progress line** 2 px under the top bar, sticky with it. Width is the batch percentage; green when complete, red when any job failed.
- **Step title** a 24 px white disc with the step number, then the title in display type.
- **Choice row** 40 px: 18 px tick (accent when on), name (14 px / 500) with an optional `per cut` / `per still` tag in the mark colour, and a monospace codec summary at the right ending in the estimated size (`≈ 1.1 GB`, a plain `6.2 MB` when it is exact; hidden at phone width).
- **Viewer** a 16:9 black box filling the right pane's width (height capped so the transport and playhead stay visible), or a centred 9:16 box when the timeline is taller than wide (a 1080×1920 social timeline), so a vertical cut is watched vertically. Empty state: one sentence, a `Render preview` button, one line of explanation. Rendering: a thin bar. Ready: the video, a big centred play glyph when paused, a **scrub bar** whose track shows cuts as cyan blocks and stills as pink ticks, and a transport row (play, mute, the preview's timecode, where marks come from, `re-render`, `mark from Resolve instead`). A stale preview gets an amber note in the corner.
- **Mark block** at the top of the left pane: the heading with a timeline picker (a select, shown when the project has more than one timeline) and the frame rate, then the two keycap rows over the two mark lists, a 2 × 2, then the range row. The keycap rows are indicators, not buttons: a 56 px keycap showing the key (`C`, `S` by default) beside `Hold for a cut` / `Still` and one line of help. Holding the cut key lights its row cyan, the keycap brightest, and the help line becomes `IN <tc> · <elapsed>`; releasing flashes it. Pressing the still key lights the still keycap pink for as long as it is down. The colours are the marker colours, so the panel and Resolve's timeline agree. Dimmed at 40 % when not connected. The **range row** reads `In to Out 01:00:02:00 → 01:00:50:23 · 49.0s` with an accent bar on its left and a mini switch `only In to Out`, or `Whole timeline · 60.0s · set In and Out in Resolve (I, O) to export a part` when none is set.
- **Settings › Keys** a short list of rows, each with a keycap; the cut and still keycaps are buttons that read `press a key…` while rebinding. Space, the arrows and ⌘↩ are shown but fixed.
- **Mark row** 28 px monospace: coloured dot and number, `in → out` and duration (cuts) or the frame's timecode (stills), `×` to remove. Click moves the playhead. `clear` asks for a second click within four seconds instead of a dialog.
- **Export bar** pinned to the bottom of the left pane: one 46 px accent pill (`Export everything · 6 files`), `Cuts only` / `Stills only` pills, a switch `Upload to Triptych Studios when done` (only when a portal URL is set) and, while it is on, an `Into project` row: a select of the portal's projects (`SpotA Launch · TRP-2026-4821 · Acme Beverages`) with a refresh icon; the export buttons wait, and the select's border turns amber, until a project is picked. Then a summary line (`3 final exports · 2 cuts · 1 still · ≈ 1.5 GB → folder`), a 4 px bar with `17% · 1 of 6 done`, and while rendering one quiet line: `Runs in the background: keep marking, switch to Resolve or minimise this window. A notification pops when it's done.` The per-file list with status dots lives under the playhead on the right, where the picture leaves room.
- **Upload card** above the file list on the right, only when a portal is set and a batch has finished: one sentence (`Uploading to SpotA Launch · 31% · 2 of 7 sent`, `All 7 files in SpotA Launch on Triptych Studios. Check the boxes there, then send the final delivery.`), an `open on the portal` link (the project's Delivery tab), an `Upload to SpotA Launch` / `Upload again` pill, and a 4 px bar (accent, then green or red). File rows take a second state while it runs: `uploading 43%`, `in Social cutdowns` (the box the portal filed it in), `on the portal`, `upload failed`.
- **Tabs** a two-segment pill in the top bar, `Export` and `Settings`; the active segment is white on black like the timeline chips.
- **Settings › File names** the pattern field, token chips, the spaces switch, and a live example line that uses the real project name.
- **Settings › Deliverables** one collapsed card per deliverable (name, tag, monospace summary, `edited`/`custom` badge). Open, it is a two-column form: Name, Label, Applies to, Deliver preset, Format, Codec (both filled from Resolve's lists), Size (the sizes Resolve offers for that codec, `Timeline's`, or `Custom…`), Quality (a level, or a bit rate in kb/s), Folder, two switches, then a `More settings` disclosure with the rest of what Resolve's render API takes (frame rate, render as one file or per clip, encoding profile, audio codec, bit depth and sample rate, colour space and gamma tags, pixel aspect, alpha mode, numbering, multi-pass, export alpha, fast start), a live size line (`≈ 1.1 GB for Main Edit (49.0s, In to Out, ProRes 422 HQ data rate)`), then `Save`, `Duplicate`, `Reset to default` or `Delete`, `Open JSON`. Destructive actions ask for a second click instead of a dialog.
- **Settings › Triptych Studios portal** two fields (URL, the plugin key as a password field that empties itself once saved and then reads `Saved · paste a new one to replace it`), `Test connection` with the result in green or red beside it (`Connected to Triptych Studios · 12 projects · key "ExportX on the edit bay"`), the auto-upload switch, one paragraph on where the key comes from and how files are filed. The project itself is chosen next to Export, where the decision is made per batch.
- **Settings › Advanced** chips for extra timelines in one batch, two switches, the formats button, the log.

## 5. States

- **Disconnected / no project**: red dot, banner explaining the fix, pad and buttons disabled, the checklist still visible.
- **Ready**: green dot; `Export everything` shows the file count once a folder is set.
- **Marking**: the cut key is held; the playhead keeps updating and the cut keycap row is lit with the in point and elapsed time. On release the cut appears in its list, the summary re-plans, and the row flashes. The still key marks on the key-down and lights the still keycap pink while it is down.
- **Nothing to export a mark with**: the hint under the keys turns amber and names the box to tick in step 1.
- **Queued**: file rows appear with grey dots; the bar reads `6 files queued in Resolve`.
- **Rendering**: `Stop rendering` replaces the primary button; the current file's dot is accent with a halo; the bar and line move once a second.
- **Done**: dots green (or red), bar green or red, `All 6 done` or `Finished · 1 file failed` with the error under the file. A system notification says the same if the panel is not in front; the dock icon's progress clears.
- **Uploading**: the upload card appears with the accent bar; the current file's row reads `uploading 43%` with the accent halo; the dock icon shows the upload's percentage.
- **On the portal**: card and rows turn green, `open on the portal` appears, `Upload again` stays for a retry. Failures turn the card red with the portal's message, which is written for an editor.

## 6. What we deliberately did not copy

- **The workspace.** Rail, canvas and inspector are right for a page builder and wrong for a three-action tool (see §0).
- **White panels.** Inside Editor X the Add, Layers and Inspector panels were light. ExportX lives inside Resolve's dark UI, so everything is dark and the Editor X contrast comes from white type and black chrome.
- **Wix's exact blue.** The accent is a neighbouring electric blue, not Wix's brand colour. To match Resolve's warm accent, change `--x-accent` and `--x-accent-2` only.
- **Pure black everywhere.** A tool used for hours needs a ladder (`#000 → #0f → #16 → #1d → #26`) so surfaces read as separate without borders doing all the work.

## 7. Typeface and licensing

Wix Madefor Text and Display are released under the SIL Open Font License 1.1 and are on Google Fonts. The Latin woff2 files for the weights we use are bundled in `ui/fonts/` (from the `@fontsource/wix-madefor-*` packages) with the licence text, so the panel renders identically offline inside Resolve. The HTML preview (`docs/preview.html`, built by `scripts/build-preview.js`) loads the same faces from Google Fonts instead. Fallback stack: system UI sans.

## 8. Open items

- Optional light theme for users who run Resolve's light UI.
- Keyboard: arrow keys in the checklist; nudge a mark's in/out by a frame. (`⌘/Ctrl+Enter` exports, C holds a cut, S marks a still, Space plays.)
- Global hotkeys so C and S work while Resolve has focus. Electron's `globalShortcut` fires on key-down only and steals the key from Resolve, so this needs a native key hook; for now keys work while the panel is focused, which is the normal case with the preview playing in the panel.
- A mini timeline strip under the playhead showing marks as cyan/pink blocks, like Editor X's breakpoint ruler.

## 9. Sources and confidence

Confirmed from published material found while writing these notes:

- Editor X launched as a new brand and platform for designers and agencies (July 2020 public launch; closed beta from February 2020): [Wix press room](https://www.wix.com/press-room/home/post/introducing-editor-x-advanced-website-creation-platform-raising-the-standard-of-web-design), [Design Week](https://www.designweek.co.uk/issues/3-9-february-2020/wix-reveals-editor-x-platform-to-answer-complex-design-needs/), [PRINT](https://www.printmag.com/design-news/wix-announces-official-launch-of-editor-x/).
- Transition into Wix Studio: Wix support pages note Editor X "is transitioning to Wix Studio" ([Site Styles](https://support.wix.com/en/article/editor-x-managing-your-site-styles)).
- Workspace layout: panel toggles top-left, canvas in the centre, Inspector opens on the right when an element is selected; it "follows well-established patterns" ([Smashing Magazine](https://www.smashingmagazine.com/2021/05/build-launch-responsive-websites-editorx/)).
- Inspector: controls size, position and behaviour; properties change with the selected element; alignment at the top of the panel ([Wix Studio Academy](https://www.wix.com/studio-tech-design/academyx3/lessons/inspector-panel), [Using the Inspector Panel](https://support.wix.com/en/article/editor-x-using-the-inspector-panel)).
- Layers panel: lists all elements, selection and reordering, parent/child hierarchy, master elements highlighted green ([Working With Layers](https://support.wix.com/en/article/editor-x-working-with-layers-on-your-page)).
- Breakpoint navigator at the top of the canvas; changes cascade down to smaller breakpoints ([About Responsive Design](https://support.wix.com/en/article/editor-x-about-responsive-design)).
- Grid, Layouter, docking, Stack and unit choices (px, %, fr, vw): [Using Grids](https://support.wix.com/en/article/editor-x-using-grids), [Flexbox vs Grid tools](https://support.wix.com/en/article/editor-x-choosing-between-flexbox-and-grid-based-tools), [TechRadar review](https://www.techradar.com/reviews/editor-x-review).
- Site styles: six typography styles and colour categories ([Managing Your Site Styles](https://support.wix.com/en/article/editor-x-managing-your-site-styles)).
- Wix Madefor: commissioned from Dalton Maag, launched September 2020, geometric and minimal, OFL and on Google Fonts ([Wix press room](https://www.wix.com/press-room/home/post/wix-debuts-digital-first-typeface-madefor), [It's Nice That](https://www.itsnicethat.com/news/wix-dalton-maag-madefor-typeface-graphic-design-300920), [Fonts In Use](https://fontsinuse.com/typefaces/229718/wix-madefor)).
- Wordmark: bold black type with emphasis on the X ([logotyp.us](https://logotyp.us/logo/editor-x/)).

Recalled from using the product, not independently verified here: the black top bar and left rail with light panels, blue selection outlines and docking indicators, the inverted active breakpoint, the pill-shaped Publish button, and Madefor being the typeface of the Editor X marketing site. The notes use these as direction; none of ExportX depends on them being exact.
