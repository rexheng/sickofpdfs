# Drive / Docs / PDF viewer reference images

The companion spec is `../02-drive-visual-spec.md`.

## How the live captures were taken

All `live-*` images were captured on **2026-10-31**:

* Browser: Playwright 1.63 with Chromium 147 (headless; the `channel:"chromium"` new-headless mode for the viewer and Docs).
* Viewport and scale: 1440×900 CSS px at **deviceScaleFactor 2**, so each PNG is **2880×1800**. Divide pixel coordinates by 2
  to get CSS px.
* Locale: en-US.
* Account state: no Google login. Every page is public or shared with "anyone with the link".

The `dumps/` folder holds the `getComputedStyle` JSON behind each capture (bounding boxes in CSS px). Query it with
`scratchpad/scripts/q.py`.

The `source-css/` folder holds:

* the Drive production GM3 token blocks (light and dark), extracted from
  `https://drive.google.com/_/drive_fe/_/ss/k=drive_fe.main.*` on 2026-10-31;
* the GM3 component-token defaults found in the same CSS;
* the Chromium PDF viewer CSS (`chromium.googlesource.com/chromium/src/+/main/chrome/browser/resources/pdf/`).

## Live captures

| File | Source URL | What it shows |
|---|---|---|
| live-01-drive-folder-list.png | https://drive.google.com/drive/folders/15uNXeRBIhVvZJIhL4yTw4IsStMhUaaxl (public gdown test folder) | Drive list view: header, sort chip, 48 px rows, folder, Docs, PPTX, Sheets and TXT icons, segmented list/grid toggle, "Download all" |
| live-02-drive-folder-list-row-hover.png | same | Row hover state (`#ededed`) on "files_2" |
| live-03-drive-folder-list-row-selected.png | same | Selected row (`#c2e7ff`, text `#004a77`) |
| live-04-drive-folder-row-selected-focused.png | same (after double-click) | Selected and keyboard-focused row: 2 px `#0b57d0` ring plus 2 px `#d3e3fd` inner ring, row hover-download action |
| live-05-drive-context-menu-signed-out.png | same (right-click on gdown.pptx) | Light GM3 context menu (`#f0f4f9`, radius 4, 32 px item), selected row and inline "Download" action |
| live-06-drive-folder-grid.png | same (grid toggle) | Grid view: folder chips 220×48, file cards 220×220 with thumbnails, selected card, tooltip "Grid layout (Alt+V then L)" |
| live-07-drive-folder-list-pdf-icons.png | https://drive.google.com/drive/folders/0B4JvezIAd01OZkcwU1RCemg5bzQ ("Lecture Notes") | List of PDFs with the 2025–26 red "PDF" tiles (`#FC413D`) |
| live-08-drive-folder-grid-pdf-thumbs.png | same | Grid of PDF cards with page thumbnails |
| live-09-drive-pdf-preview-overlay.png | https://drive.google.com/drive/folders/1lIRqaCPeXMVZGoY-44bBsvtnsHtlRfIO (double-click "slides_systems_biology_pde.pdf") | **New (Dec 2025) Drive file-preview overlay**: scrim, header with ✕, PDF icon, name and File/View/Tools/Help menu bar, pill toolbar, thumbnail rail, prev/next buttons, page |
| live-10-drive-pdf-preview-file-menu.png | same | Dark File menu (`#282a2c`): Open ▸, Download Ctrl+D, Details (disabled), Print Ctrl+P |
| live-11-drive-pdf-preview-tools-menu.png | same | Tools menu: Find Ctrl+F |
| live-12-drive-pdf-preview-view-menu.png | same | View menu |
| live-13-drive-pdf-preview-zoom-dropdown.png | same | Zoom combobox focused (2 px `#a8c7fa`) and dropdown (Fit / 50–200 %) |
| live-14-drive-pdf-preview-hover-download.png | same | Toolbar icon-button hover state with tooltip |
| live-15-drive-pdf-preview-hover-close.png | same | Close-button hover |
| live-16-drive-pdf-standalone-viewer.png | https://drive.google.com/file/d/0B-rtraLdHkAYX29tTldGZVRNSlE/view | Standalone viewer: `#1b1b1b` canvas, "Sign in" tonal button, separate "Hide file header" 48×48 button, bottom-left pane toggle |
| live-17-docs-comments-sidebar.png | https://docs.google.com/document/d/1ho0FKy9ge0tUSRzebq1AFi28KR1H_utecQjHx4CNCEs/edit (public Apache Arrow proposal; nothing was edited) | Docs "Comments" sidebar: tabs (All comments / For you), filter buttons, thread cards (`#e9eef6`, radius 12) |
| live-18-docs-comments-sidebar-active-thread.png | same | Active thread: white card, Resolve ✓, ⋮, "Reply or add others with @" field, yellow anchor highlight in the doc |
| live-19-docs-margin-comment-active.png | same (sidebar closed) | Active margin comment card (white, elevation 3) beside the highlighted anchor |
| live-20-docs-margin-cards-default.png | https://docs.google.com/document/d/1-pRFFAMcii8Hb1YmW0r0zTEd9xooP9nIC26ncct7Ub8/edit (public Mooncake RFC) | Default margin cards (`#f8fafd`, radius 12, 10 px gap), suggestion cards, Docs GM3 toolbar |
| live-21-chrome-pdf-viewer.png | file:// copy of https://arxiv.org/pdf/1706.03762v7 in Chromium 147 | Chrome built-in PDF viewer: 56 px `#3c3c3c` toolbar, 300 px `#28292a` sidenav, thumbnails |
| live-22-drive-preview-error-toast.png | https://drive.google.com/drive/folders/0B4JvezIAd01OZkcwU1RCemg5bzQ (headless-shell; viewer JS blocked) | Overlay scrim over the list, plus the "There was a problem with the preview" toast |

## Official Google images (Google Workspace Updates blog)

| File | Source | Date | What it shows |
|---|---|---|---|
| official-22-wu2023-mydrive-refresh.gif (+ `22a` frame 0 PNG) | https://workspaceupdates.googleblog.com/2023/03/refreshed-ui-google-drive-docs-sheets-slides.html. Image: `blogger.googleusercontent.com/img/b/R29vZ2xl/AVvXsEjo6Lav…/s0/filters (2).gif` | 2023-03 | Signed-in My Drive in GM3: left nav (Priority, My Drive selected, Shared drives, …), **+ New** button, search bar, filter chips, Suggested cards, list rows, Type filter menu with coloured type icons. **2082×1289 ≈ 1.6×** of a ~1301×806 viewport. GIF palette, so colours are approximate. |
| official-23-wu2023-drive-home.gif (+ `23a` frame) | https://workspaceupdates.googleblog.com/2023/11/introducing-new-homepage-view-in-google-drive.html | 2023-11 | Home view (Workspace account): nav Home / Activity / Workspaces / My drive / Shared drives / Computers / Shared with me / Recent / Starred / Spam / Trash / Storage; "New ▾"; Home table with "Reason suggested" and "Location". 800×489 (~0.62×). |
| official-24-wu2024-drive-home-unified.gif (+ `24a` frame) | https://workspaceupdates.googleblog.com/2024/08/unified-view-file-folder-suggestions-google-drive.html | 2024-08 | Unified Home: "Welcome, Liliana", centred search, tonal chips, **Suggested folders** cards, Suggested files list, list/grid toggle, nav for a personal account, storage meter, "Get more storage". 800×489. |
| official-25-wu2025-drive-file-viewer-signed-in.png | https://workspaceupdates.googleblog.com/2025/12/google-drive-web-modern-file-viewer-interface.html | 2025-12 | **Signed-in new file viewer**: File / View / Insert / Tools / Help, "Open ▾" outlined split button, "Share ▾" tonal split button (`#004a77` / `#c2e7ff`), Gemini spark, toolbar with "Comment" and "Request eSignature", thumbnail rail, Gemini summary card, comment card. 2048×1199 (~1.5×). |
| official-26-wu2023-docs-refresh.jpg | same post as official-22 | 2023-03 | Docs GM3 UI (meeting-notes template) |

## Press

| File | Source | Date | What it shows |
|---|---|---|---|
| press-27-macworld2024-drive-home-dark.jpg | https://www.macworld.com/article/2495727/google-drive-review-2.html (image `wp-content/uploads/2024/10/Google-Drive-Review-6.jpg`) | 2024-10 | Drive Home in dark theme on a laptop: nav order Home / My Drive / Computers · Shared with me / Recent / Starred · Spam / Bin / Storage; suggested folder cards. Perspective photo; not measurable. |

## Clones (cross-check only; do not copy)

| File | Source | Licence | Notes |
|---|---|---|---|
| clone-28-mya-vercel-drive-home.png | https://google-drive-clone-three-lac.vercel.app/drive/home (captured 2026-10-31) | unknown, no repo found | Highest-fidelity clone; shows 2026-style nav including "Projects" and the "Get answers from Drive" search (unverified against real Drive) |
| clone-29-jatinsoni08-drive-home.png | https://github.com/jatinsoni08/GoogleDriveClone (`googledrive.png` in the README) | MIT | Static HTML + Tailwind replica of the 2025 Home |
| clone-30-nisabmohd-drive.png | https://github.com/nisabmohd/google-drive (`images/1.png`) | none | React + MUI, dated look |

## Crops (helpers)

| File | Crop of | Scale |
|---|---|---|
| crop-31-wu2023-left-nav-new-button.png | official-22a, x 0–420 | 1.6× |
| crop-32-wu2023-top-bar-search.png | official-22a, top 140 px | 1.6× |
| crop-33-context-menu-2x.png | live-05 | 2× |
| crop-34-viewer-header-file-menu-2x.png | live-10 | 2× |
| crop-35-viewer-toolbar-pill-2x.png | live-09, y 50–130 CSS | 2× |
| crop-36-docs-comment-thread-2x.png | live-18 | 2× |
| crop-37-chrome-pdf-toolbar-2x.png | live-21 | 2× |
| crop-38-drive-header-and-table-head-2x.png | live-01 | 2× |

> **Repo note:** third-party images (press articles, Google blog images, other people's Drive clones) are kept out of this public repo. They live in `third-party/`, which git ignores, on the build machine only. The source URLs above still identify them.
