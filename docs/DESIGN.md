# Design notes: what ExportX takes from Editor X

Editor X was Wix's web-design platform for designers and agencies: a closed beta in February 2020, public in July 2020, and folded into Wix Studio from 2023 onward. It mattered because it treated a visual tool as a precision instrument: a real CSS grid, a flexbox "Layouter", docking, custom breakpoints that cascade, and an Inspector that showed the exact numbers behind every element. ExportX borrows that posture. A render panel is also a precision instrument, and its users are the same people.

These notes are the brief for the ExportX panel (`ui/`). Section 9 lists what is confirmed by sources and what is recalled from using the product; treat the recalled parts as design intent, not as facts about Wix.

## 1. The ten notes

1. **Chrome is black, content is bright.** Editor X put its controls in near-black bars and left the page itself as the brightest thing on screen. ExportX uses a black top bar and navigator, dark-grey panes, and reserves pure white for the things you read: names, numbers, filenames.
2. **One accent, spent carefully.** The accent marks the selected thing, the running thing, and the primary action. Nothing else is coloured. Status colours (green, amber, red) appear only on status.
3. **A three-pane workspace.** Tools on the left, the work in the middle, properties of the selected thing on the right, primary action top-right. Editor X's left rail / canvas / Inspector / Publish becomes ExportX's Deliverables rail / Output & queue / Inspector / Queue & Render.
4. **The Inspector is the truth.** Click anything and its exact properties appear as label-left / value-right rows with units visible. In ExportX the selected deliverable shows container, codec, resolution, frame rate, audio, quality flags, naming, and an example filename, plus every raw Resolve setting it will send.
5. **Contexts live in a strip above the canvas.** Editor X's breakpoint navigator sat across the top of the canvas and let you switch what you were designing for. ExportX puts timelines there: the current one marked, any number selectable, and the whole batch repeats per selection.
6. **Layers: click selects, a control toggles.** In the Layers panel clicking a row selected the element; a separate control hid or showed it. ExportX's rail works the same way: click a deliverable to inspect it, tick the box to include it in the batch.
7. **Typography carries hierarchy.** Big, tight, geometric display type for figures and titles; tiny tracked uppercase labels for sections; tabular numerals for anything that counts. The typeface is Wix Madefor, the geometric sans Wix commissioned from Dalton Maag (see §7).
8. **Precision cues, not adjectives.** Show the number and the unit: `1920 × 1080`, `48000 Hz`, `24 bit`, `3 jobs`. Where a value is inherited, say from where (`Timeline`), not "auto".
9. **Hairlines, not shadows.** Flat surfaces separated by 1 px lines. Small radii (4 px) on fields and rows, full pills only on the top-bar actions and chips, no drop shadows, no gradients.
10. **Motion is fast and informative.** 150 ms state changes, no bounce. Progress is a thin accent line under the top bar plus per-job bars; it turns green when done and red if anything failed.

## 2. Token sheet

All tokens are CSS custom properties on `:root` in `ui/styles.css`. Change the accent in one place to re-skin.

| Token | Value | Use |
| --- | --- | --- |
| `--x-chrome` | `#000000` | Top bar, timeline navigator, log drawer |
| `--x-bg` | `#0f0f0f` | Canvas background |
| `--x-surface` | `#161616` | Panes and sheets |
| `--x-surface-2` | `#1d1d1d` | Inputs, hovered rows |
| `--x-surface-3` | `#262626` | Selected rows |
| `--x-line` | `#262626` | Hairlines |
| `--x-line-2` | `#343434` | Control borders |
| `--x-text` | `#ffffff` | Primary text |
| `--x-text-2` | `#a3a3a3` | Secondary text, labels |
| `--x-text-3` | `#6f6f6f` | Tertiary text, placeholders |
| `--x-accent` | `#3b7bff` | Selection, primary action, progress |
| `--x-accent-2` | `#6a9bff` | Accent hover / text on dark |
| `--x-ok` / `--x-warn` / `--x-bad` | `#34c759` / `#e2b93b` / `#ff453a` | Status only |
| `--x-radius` | `4px` | Fields, rows, sheets |
| `--x-pill` | `999px` | Top-bar buttons, chips, status tags |
| `--x-row` | `32px` | Rail and inspector row height |
| `--x-font-display` | Wix Madefor Display | Figures, titles, wordmark |
| `--x-font-ui` | Wix Madefor Text | Everything else |
| `--x-font-mono` | system monospace | Paths, filenames, ids, raw settings |

Type scale: 10.5 px tracked uppercase labels (`.label`), 12 px UI text, 12.5 px row titles, 14 px inspector title, 20 px display figures. Spacing on a 4 px grid; panes are 256 px (rail) and 300 px (inspector).

## 3. Editor X → ExportX mapping

| Editor X | ExportX |
| --- | --- |
| Top bar with site name, Preview, **Publish** | Top bar with project › timeline breadcrumb, **Queue**, **Queue & Render** / **Stop** |
| Breakpoint navigator above the canvas | Timeline navigator: chips per timeline, current marked, multi-select |
| Layers panel (select vs. show/hide) | Deliverables rail (select vs. include) |
| Canvas | Output sheet (folder, filename template, switches), "Will create" tree, Render queue |
| Inspector (Layout / Design tabs, units) | Inspector for the selected deliverable, grouped Output / Frame / Audio / Quality / Naming / Raw settings |
| Site styles & Design Library | Profiles JSON (`profiles/`, `~/.exportx/profiles/`) |
| Dev mode | Python edition and `--list` |
| Thin progress on publish | Accent progress line under the top bar |
| Direct manipulation on the canvas (drag, dock, snap) | The capture pad: hold while the timeline plays to mark a cut, tap to mark a still; marks become Resolve timeline markers |

## 4. Components

- **Top bar** 44 px, black. Left: white square "X" mark and `ExportX` wordmark (Madefor Display 700/800). Middle: breadcrumb `Project › Timeline` in secondary text with the names in white. Right: connection dot and product/version, refresh icon, `Queue` (ghost pill), `Queue & Render` (accent pill), `Stop` (red pill) while rendering.
- **Progress line** 2 px below the top bar. Width is the batch percentage; hidden at 0, green when complete, red when any job failed.
- **Timeline navigator** 36 px, black. `TIMELINES` label, a row of pill chips; the selected chips invert to white-on-black with a blue dot on the current timeline. Hint text at the right states what will be rendered.
- **Rail row** 32 px minimum: 16 px include box (accent when on), name (12.5 px / 500), monospace meta line `mov · ProRes422HQ · 1920×1080`. Selected row has a 2 px white left edge and `--x-surface-3` fill.
- **Capture sheet** the first sheet on the canvas. Header: `CAPTURE`, timeline name and frame rate, a play dot that turns green while the playhead moves, and the playhead timecode in 22 px display type at the right. Below: the **pad** (left, 136 px tall, `Hold to mark a cut` / `Tap to mark a still`) and the **mark lists** (right, `CUTS n` and `STILLS n`, each row `01  01:00:04:00 → 01:00:09:11  5.5s  ×` in monospace with a cyan or pink dot; click a row to move the playhead there). Footer: `Export cuts`, `Export stills`, and a summary such as `3 cuts × 1 profile · 1 still × 1 profile`.
- **Pad states**: idle (surface-2, hairline), hover (brighter hairline), **holding** (accent fill, `IN <tc> · <elapsed>` in monospace along the bottom edge, 1 % scale-down), **flash** (220 ms cyan for a cut, pink for a still, matching the marker colours in Resolve), disabled (40 % opacity when not connected). Space or M does the same as the pointer while the panel is focused.
- **Sheet** a flat panel on the canvas with a label header and an optional display figure right-aligned (`3` jobs, `45 %`).
- **Field row** 88 px label column, 30 px inputs with 4 px radius, accent border on focus. Template tokens are small bordered monospace chips that insert at the caret.
- **Switch** 28 × 16 px, accent when on, label in secondary text.
- **Tree** monospace list grouped by output folder, files indented, timeline · deliverable in secondary text at the right.
- **Job row** timeline, deliverable, filename (mono), status tag (outlined pill, coloured by state), 2 px progress bar with tabular percentage.
- **Inspector row** 26 px, label left in secondary text, value right in white; numbers tabular with a dimmed unit suffix; raw settings in monospace.
- **Log drawer** a 28 px black bar showing the latest line; click to expand to 150 px of history.

## 5. States

- **Disconnected / no project**: red dot, banner explaining the fix (which folder, which menu), actions disabled, everything else still visible so profiles can be reviewed.
- **Ready**: green dot, actions enabled once at least one deliverable and a folder are set.
- **Marking**: the pad is held; the playhead keeps updating, the pad shows the in point and elapsed time, nothing else changes. On release the new mark appears in its list, the "Will create" tree and inspector counts re-plan, and the pad flashes the mark's colour.
- **Queued**: job rows appear with `READY` tags; figure shows `0 %`; the render queue sheet scrolls into view.
- **Rendering**: `Stop` replaces `Queue & Render`; progress line and per-job bars move once a second; the rail and inspector stay usable.
- **Done**: tags turn `COMPLETE` / `FAILED`; progress line green or red; banner only if something failed.

## 6. What we deliberately did not copy

- **White panels.** Inside Editor X the Add, Layers and Inspector panels were light. ExportX lives inside Resolve's dark UI, so every pane is dark and the Editor X contrast comes from white type and the black chrome instead.
- **Wix's exact blue.** The accent is a neighbouring electric blue, not Wix's brand colour. If you would rather match Resolve's warm accent, change `--x-accent` and `--x-accent-2` only.
- **Pure black everywhere.** The marketing site was black on black; a tool used for hours needs a ladder (`#000 → #0f → #16 → #1d → #26`) so panes read as separate surfaces without borders doing all the work.
- **Tabs in the inspector.** Our inspector is short enough to scroll; sections replace tabs.

## 7. Typeface and licensing

Wix Madefor Text and Display are released under the SIL Open Font License 1.1 and are on Google Fonts. The Latin woff2 files for the weights we use are bundled in `ui/fonts/` (from the `@fontsource/wix-madefor-*` packages) with the licence text, so the panel renders identically offline inside Resolve. Fallback stack: system UI sans.

## 8. Open items

- Icon set: currently a handful of inline 1.5 px line icons; a consistent 16 px set would finish the look.
- In-panel profile editing (the inspector is read-only; `Open JSON` opens the source file).
- Optional light theme for users who run Resolve's light UI.
- Keyboard: arrow keys in the rail; nudge a mark's in/out by a frame. (`⌘/Ctrl+Enter` queues & renders, Space/M marks.)
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
