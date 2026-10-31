# 02 — Google Drive (GM3, 2026) visual spec: Drive shell, file previewer / PDF viewer, Docs comments, Chrome PDF viewer

Research date: 2026-10-31. Read-only research; nothing was built.

## 0. How this spec was produced and what the labels mean

The most important result is that I could measure the real, current product. A headless Chromium 147 (Playwright,
viewport 1440×900, deviceScaleFactor 2, en-US) loaded **public, signed-out** Google pages (no login was attempted):

* a shared Drive folder in list, grid, hover, selected, focus and context-menu states;
* the in-Drive file-preview overlay for a PDF (the new viewer from December 2025), with its menus;
* the standalone `drive.google.com/file/d/<id>/view` PDF viewer;
* a public Google Doc that allows comments, with the comment sidebar and margin cards;
* Chromium's built-in PDF viewer.

For every element I dumped the `getComputedStyle` values and saved screenshots. I also downloaded Drive's production stylesheet
(`drive_fe.main…css`, 5.1 MB), which contains Google's own `--gm3-sys-color-*` token blocks.

The signed-in-only chrome is the left nav, the **New** button, the search bar and the Home page. I could not render those, so
they are measured from the official Google Workspace Updates images, with the scale stated and a tolerance of about ±2 px. I
cross-checked them against an independent pixel clone.

| Label | Meaning |
|---|---|
| **[live]** | Computed style read from the live Google DOM on 2026-10-31. Exact. |
| **[px]** | Pixel sample from a live 2× screenshot. Exact to ±1 device px. |
| **[css]** | Value taken from Google's or Chromium's production CSS or source. Exact. |
| **[img]** | Measured on an official Google image at the stated scale. ±1–2 CSS px, and colours are approximate when the image is a GIF. |
| **[doc]** | From documentation (Google Fonts metadata, READMEs, Workspace blog). |
| **[inf]** | Inferred. Treat as a best guess, and flag it to critics. |

Raw evidence is in `research/drive-refs/`. The `dumps/*.json` files hold the full computed-style dumps, and `source-css/` holds the
Google and Chromium CSS extracts. Section 9 indexes the reference images.

> **Important caveat for critics:** the live list and grid captures are the *signed-out shared-folder* variant. It has the same
> table, row, card and menu components as signed-in My Drive, but it has no left nav or search, and its header carries "Sign
> in" in place of the account controls. The signed-in shell geometry (§4.1–4.4) comes from [img] or [inf] sources.

---

## 1. Headline findings

1. **The colour system is Google's GM3 palette, not the M3 baseline (purple).** I extracted the exact light and dark
   `--gm3-sys-color-*` blocks from Drive's CSS ([css], §3.1). Key values: primary `#0b57d0`, secondary-container
   `#c2e7ff` (the selected-nav and selected-row blue), surface-container-low `#f8fafd` (app background),
   surface-container `#f0f4f9` (menus, grid cards), surface-container-high `#e9eef6` (search bar), on-surface `#1f1f1f`,
   on-surface-variant `#444746`, outline `#747775`, outline-variant `#c4c7c5` (row dividers).
2. **Fonts used today** [live]:
   * **Google Sans Text** is used for body text, table rows and the header row.
   * **Google Sans** is used for titles. The folder title is 24 px, the viewer file name is 18 px, and the Docs comments use it.
   * **Google Sans Flex** is now the first family in GM3 *menus, menu-bar items and text buttons* (for example
     `"Google Sans Flex","Google Sans Text","Google Sans",Roboto,Arial`).
   * **Product Sans** 22 px is used for the "Drive" wordmark.
   * Google Sans, Google Sans Flex and Google Sans Code are all **OFL on Google Fonts**. Google Sans Text is *not* publicly
     licensed, but it is the `opsz=17` end of the OFL Google Sans variable font (§2).
3. **Icons are Material Symbols Outlined, wght 400, FILL 0, GRAD 0, opsz 24 (or 20).** I verified this by an exact SVG
   path match on Drive's `sort` and `open_in_new` icons against the official 24 px Material Symbols SVGs. The
   `@material-symbols/svg-*` npm packages are drawn at **opsz 48** and do **not** match pixel-for-pixel at 20–24 px. Use the
   variable font (`material-symbols` npm) with `opsz` set, or `@iconify-json/material-symbols`, which uses 24-px geometry
   (§6).
4. **The Drive file viewer was redesigned in December 2025** ([doc]: Workspace Updates, 2025-12). The new design:
   * a dark `#1b1b1b` canvas;
   * a header with file icon, name and a **File / View / (Insert) / Tools / Help** menu bar;
   * a 48 px **pill toolbar** in `#333537` (Page n / N, download, print, zoom − / 100 % ▾ / +);
   * a left rail with thumbnails and outline;
   * prev/next round buttons in the overlay.

   I measured it fully ([live], §4.10). The old Drive viewer, a black translucent top bar with "Open with", is **gone**.
5. **New file-type icon set (2025–26)** [live]. Each icon is an 18×18 rounded square (`rx=3`) with a white glyph:
   * PDF `#FC413D` with the text "PDF";
   * Docs and Text `#3186FF`;
   * Sheets `#00AF57`.

   The Drive logo asset is now `logo_drive_2026_color`.
6. **Drive's list rows are 48 px** with a 1 px `#c4c7c5` divider:
   * hover = 8 % `#1f1f1f` state layer, which gives `#ededed`;
   * selected = `#c2e7ff` with text `#004a77`;
   * selected + hover = `#b2daf4`;
   * keyboard focus = 2 px `#0b57d0` ring plus a 2 px `#d3e3fd` inner ring ([px]).

---

## 2. Fonts — availability, licence, and what Drive uses

Verified 2026-10-31. Each CSS2 URL returned HTTP 200 (`fonts.googleapis.com/css2?family=…`). The licence and catalogue status come from `fonts.google.com/metadata/fonts` and
`github.com/google/fonts/ofl/*/METADATA.pb`.

| Family | Served by Google Fonts API | In public catalogue | Licence | Axes | Drive and Docs usage [live] |
|---|---|---|---|---|---|
| **Google Sans** | yes | yes, added 2025-12-09 | **OFL 1.1, no Reserved Font Names** (`googlefonts/googlesans` v14) | `wght` 400–700, `opsz` 17–18, `GRAD` −50…200, plus italics | 24/32 folder title; 18/20 viewer file name; comment author, body and time; "Download all" text button (14/36, 500, +0.14 px). |
| **Google Sans Text** | yes (`family=Google+Sans+Text`) | **no** (unlisted) | No public licence. The README of the OFL Google Sans says *"the min optical size design (opsz 17) is named 'Google Sans Text'"*. | static 400/500/700 | Body default (`body{font:400 14px/20px "Google Sans Text","Google Sans",Roboto,Arial,sans-serif}`), table rows, header cells, viewer toolbar text, tooltips. |
| **Google Sans Flex** | yes. `https://fonts.googleapis.com/css2?family=Google+Sans+Flex` returns `font-family:'Google Sans Flex'` (latin, latin-ext, vietnamese, math, symbols and other subsets). Axes respond up to `opsz,wght,wdth,GRAD,ROND@6..144,1..1000,25..151,0..100,0..100`. | yes, added 2025-11-12 | **OFL 1.1** (`googlefonts/googlesans-flex`) | `wght` 1–1000, `wdth` 25–151, `opsz` 1–144, `slnt` −10–0, `GRAD`, `ROND` | First family in GM3 menu items ("Download", "Open", "Print"), menu-bar labels ("File View Tools Help"), text-button labels ("Sort", row "Download"), list-item and button token defaults (`--gm3-*-label-text-font`). |
| **Google Sans Code** | yes | yes, added 2025-02-26 | **OFL 1.1** | `wght` 300–800, `MONO` | Not seen in Drive. Docs ruler uses "Google Sans Mono". |
| Google Sans Display | yes | no | none public | — | not used |
| Product Sans | yes (Drive requests `css?family=Product+Sans`) | no | Google brand font, **not licensed** | — | "Drive" wordmark, 22 px / 48 px line height, `#1f1f1f`. **Do not use.** Substitute Google Sans 22 px 400. |
| Roboto | yes | yes | Apache-2.0 / OFL | — | Fallback; Docs UI chrome. |
| Material Symbols Outlined / Rounded | yes | icon catalogue | Apache-2.0 | FILL, wght, GRAD, opsz | All UI icons (§6). |
| Google Symbols | yes | no. Its CSS header says *"See: https://fonts.google.com/license/googlerestricted"* | **restricted** | — | Google-internal superset. **Do not use.** |

**Recommended font setup** (all OFL):

```html
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Google+Sans:ital,opsz,wght@0,17..18,400..700;1,17..18,400..700&family=Google+Sans+Flex:opsz,wght@6..144,1..1000&display=swap">
```

Or self-host the OFL files from `github.com/google/fonts/tree/main/ofl/googlesans` and `…/googlesansflex`.

Emulate **Google Sans Text** with an alias, so the stacks copied from Drive keep working:

```css
/* Google Sans with opsz pinned to 17 = the "Google Sans Text" design (OFL). */
@font-face { font-family: "Google Sans Text"; src: local("Google Sans"), url(/fonts/GoogleSans[GRAD,opsz,wght].woff2) format("woff2");
  font-weight: 400 700; font-variation-settings: "opsz" 17; }
```

Use a matching `@font-face` with `"opsz" 18` for "Google Sans". If you prefer not to rely on `font-variation-settings` inside
`@font-face`, which Safari supports inconsistently, set `font-variation-settings:"opsz" 17` on the body text roles. With
`font-optical-sizing:auto` and Google Sans served from Google Fonts, text at 14 px automatically resolves to opsz 17 (the
Text design) and 18 px or larger resolves to 18 [inf from axis range].

---

## 3. Tokens (ready to paste)

### 3.1 CSS custom properties

```css
:root {
  /* ===== GM3 system colours — LIGHT. Exact copy of Drive's production block [css] ===== */
  --gm3-sys-color-primary: #0b57d0;
  --gm3-sys-color-on-primary: #ffffff;
  --gm3-sys-color-primary-container: #d3e3fd;
  --gm3-sys-color-on-primary-container: #0842a0;
  --gm3-sys-color-primary-fixed: #d3e3fd;
  --gm3-sys-color-primary-fixed-dim: #a8c7fa;
  --gm3-sys-color-on-primary-fixed: #041e49;
  --gm3-sys-color-on-primary-fixed-variant: #0842a0;
  --gm3-sys-color-inverse-primary: #a8c7fa;
  --gm3-sys-color-secondary: #00639b;
  --gm3-sys-color-on-secondary: #ffffff;
  --gm3-sys-color-secondary-container: #c2e7ff;
  --gm3-sys-color-on-secondary-container: #004a77;
  --gm3-sys-color-secondary-fixed: #c2e7ff;
  --gm3-sys-color-secondary-fixed-dim: #7fcfff;
  --gm3-sys-color-on-secondary-fixed: #001d35;
  --gm3-sys-color-on-secondary-fixed-variant: #004a77;
  --gm3-sys-color-tertiary: #146c2e;
  --gm3-sys-color-on-tertiary: #ffffff;
  --gm3-sys-color-tertiary-container: #c4eed0;
  --gm3-sys-color-on-tertiary-container: #0f5223;
  --gm3-sys-color-tertiary-fixed: #c4eed0;
  --gm3-sys-color-tertiary-fixed-dim: #6dd58c;
  --gm3-sys-color-on-tertiary-fixed: #072711;
  --gm3-sys-color-on-tertiary-fixed-variant: #0f5223;
  --gm3-sys-color-error: #b3261e;
  --gm3-sys-color-on-error: #ffffff;
  --gm3-sys-color-error-container: #f9dedc;
  --gm3-sys-color-on-error-container: #8c1d18;
  --gm3-sys-color-background: #ffffff;
  --gm3-sys-color-on-background: #1f1f1f;
  --gm3-sys-color-surface: #ffffff;
  --gm3-sys-color-surface-bright: #ffffff;
  --gm3-sys-color-surface-dim: #d3dbe5;
  --gm3-sys-color-surface-container-lowest: #ffffff;
  --gm3-sys-color-surface-container-low: #f8fafd;   /* app background behind the white content card */
  --gm3-sys-color-surface-container: #f0f4f9;       /* menus, grid cards, Docs comment sidebar */
  --gm3-sys-color-surface-container-high: #e9eef6;  /* search bar, Docs comment card in the sidebar */
  --gm3-sys-color-surface-container-highest: #dde3ea;
  --gm3-sys-color-surface-variant: #e1e3e1;
  --gm3-sys-color-on-surface: #1f1f1f;              /* primary text */
  --gm3-sys-color-on-surface-variant: #444746;      /* secondary text, icons */
  --gm3-sys-color-outline: #747775;                 /* outlined buttons and chips, segmented button */
  --gm3-sys-color-outline-variant: #c4c7c5;         /* row and table dividers */
  --gm3-sys-color-inverse-surface: #303030;         /* tooltip background [live] */
  --gm3-sys-color-inverse-on-surface: #f2f2f2;      /* tooltip text [live] */
  --gm3-sys-color-scrim: #000000;
  --gm3-sys-color-shadow: #000000;

  /* ===== Drive-specific derived values ([live]/[px]) ===== */
  --drive-app-bg: var(--gm3-sys-color-surface-container-low);       /* #f8fafd */
  --drive-content-bg: #ffffff;                                      /* main content card */
  --drive-row-divider: var(--gm3-sys-color-outline-variant);        /* 1px #c4c7c5 */
  --drive-row-hover: #ededed;            /* = rgba(31,31,31,.08) over white [px] */
  --drive-row-selected-bg: #c2e7ff;      /* [live] */
  --drive-row-selected-fg: #004a77;      /* [live] text in a selected row */
  --drive-row-selected-hover: #b2daf4;   /* = #c2e7ff + 8% #004a77 [px] */
  --drive-focus-ring: #0b57d0;           /* 2px outer [px] */
  --drive-focus-ring-inner: #d3e3fd;     /* 2px inner [px] */
  --drive-sort-chip-bg: #c2e7ff;         /* 24px circle behind the sort arrow in the "Name" header; arrow #004a77 [live] */
  --drive-avatar-placeholder-bg: #f8fafd;/* 24px owner avatar circle [live] */

  /* State-layer opacities (GM3) [css] + [px] */
  --gm3-state-hover: 0.08;
  --gm3-state-focus: 0.10;   /* [inf] GM3 default */
  --gm3-state-pressed: 0.10; /* [inf] GM3 default */
  --gm3-state-disabled-content: 0.38; /* [live] disabled menu item opacity */

  /* File-type icon colours (Drive 2025–26 set) [live] */
  --filetype-pdf: #FC413D;
  --filetype-docs: #3186FF;
  --filetype-text: #3186FF;
  --filetype-sheets: #00AF57;
  --filetype-folder: #444746;

  /* ===== Elevation (GM3, Google variant), as used in Drive CSS [css] ===== */
  --elev-1: 0 1px 2px 0 rgba(60,64,67,.3), 0 1px 3px 1px rgba(60,64,67,.15);
  --elev-2: 0 1px 2px 0 rgba(60,64,67,.3), 0 2px 6px 2px rgba(60,64,67,.15);  /* menus: measured ~10px falloff [px] */
  --elev-3: 0 1px 3px 0 rgba(60,64,67,.3), 0 4px 8px 3px rgba(60,64,67,.15);  /* Docs active comment card uses the rgba(0,0,0,…) form [live] */
  --elev-4: 0 2px 3px 0 rgba(60,64,67,.3), 0 6px 10px 4px rgba(60,64,67,.15); /* [inf] GM3 */
  --elev-5: 0 4px 4px 0 rgba(60,64,67,.3), 0 8px 12px 6px rgba(60,64,67,.15); /* [inf] GM3 */
  --shadow-docs-comment-active: 0 1px 3px 0 rgba(0,0,0,.3), 0 4px 8px 3px rgba(0,0,0,.15); /* [live] */
  --shadow-pdf-page: 0 4px 15px 2px rgba(0,0,0,.35);   /* Drive viewer page [live] */

  /* ===== Shape ===== */
  --shape-full: 9999px;
  --shape-content-card: 16px;      /* [live] main white card */
  --shape-new-button: 16px;        /* [img] + clone */
  --shape-nav-item: 16px;          /* 32px-tall pill [img] */
  --shape-search: 24px;            /* 48px-tall pill [img] */
  --shape-grid-card: 12px;         /* [live] */
  --shape-grid-thumb: 4px;         /* [live] */
  --shape-menu: 4px;               /* [live] light and dark menus */
  --shape-tooltip: 4px;            /* [live] */
  --shape-header-cell-hover: 8px 8px 0 0; /* [live] th radius */
  --shape-chip: 8px;               /* GM3 filter chip [css default] */
  --shape-docs-comment: 12px;      /* [live] */
  --shape-docs-sidebar: 16px;      /* [live] */

  /* ===== Typography roles. Families exactly as Drive declares them [live] ===== */
  --font-text: "Google Sans Text", "Google Sans", Roboto, Arial, sans-serif;
  --font-display: "Google Sans", Roboto, Arial, sans-serif;
  --font-flex: "Google Sans Flex", "Google Sans Text", "Google Sans", Roboto, Arial, sans-serif;
  --font-wordmark: "Product Sans", "Google Sans", Arial, sans-serif; /* substitute Google Sans */

  --type-body: 400 14px/20px var(--font-text);          /* body default */
  --type-row: 400 14px/20px var(--font-text);           /* secondary columns, colour #444746 */
  --type-row-name: 500 14px/20px var(--font-text);      /* file name, #1f1f1f (live signed-out view; see §4.6 note) */
  --type-table-header: 500 14px/20px var(--font-text);  /* #444746; active sort column #1f1f1f */
  --type-page-title: 400 24px/32px var(--font-display); /* "My Drive", folder name */
  --type-wordmark: 400 22px/48px var(--font-wordmark);  /* "Drive" next to the logo */
  --type-menu-item: 400 14px/20px var(--font-flex);
  --type-menu-shortcut: 500 11px/16px var(--font-display); /* letter-spacing .1px [live] */
  --type-text-button: 500 14px/20px var(--font-flex);   /* "Sort", row "Download" */
  --type-button-gs: 500 14px/36px var(--font-display);  /* "Download all"; letter-spacing .14px [live] */
  --type-tooltip: 400 12px/16px var(--font-text);       /* letter-spacing .1px [live] */
  --type-viewer-title: 400 18px/20px var(--font-display);
  --type-viewer-toolbar: 500 14px/20px var(--font-text);
  --type-docs-comment-author: 500 14px/20px var(--font-display);   /* letter-spacing .1px */
  --type-docs-comment-time: 400 12px/16px var(--font-display);     /* letter-spacing .1px */
  --type-docs-comment-body: 400 14px/20px var(--font-display);     /* colour #444746 */
  --type-docs-sidebar-title: 400 22px/28px var(--font-display);    /* "Comments", #444746 */

  /* ===== Layout and dimensions ===== */
  --topbar-h: 64px;            /* [live] content card starts at y=63–64 */
  --nav-w: 256px;              /* [img] 224px pill + 16px inset on each side */
  --nav-item-h: 32px;          /* [img] 31.25px at 1.6× ≈ 32 */
  --nav-item-pill-w: 224px;    /* [img] */
  --nav-item-inset-x: 16px;    /* [img] */
  --nav-icon-x: 32px;          /* icon left edge from window left [img, ±2] */
  --nav-label-x: 68px;         /* label left edge from window left [img] */
  --new-btn-h: 56px;           /* [img] 55.6px */
  --new-btn-min-w: 100px;      /* [img] ~101px with the "+ New" content */
  --search-h: 48px;            /* [img] 49.4px */
  --search-max-w: 720px;       /* [inf] */
  --content-card-right-gap: 16px; /* [img] + [live] (bottom gap 16px) */
  --row-h: 48px;               /* [live] */
  --header-row-h: 48px;        /* [live] */
  --grid-folder-card: 220px 48px; /* [live] at 1440 width; 6 columns, ~17px gaps */
  --grid-file-card: 220px 220px;  /* [live] square; thumbnail 204×164 inset 8px, starts 48px from top */
}
```

**Dark tokens.** The viewer, the `prefers-color-scheme: dark` theme and Docs dark use the exact Drive dark block in
`drive-refs/source-css/drive-gm3-sys-color-dark.css` [css]. The values the viewer uses are:

* primary `#a8c7fa`;
* surface `#131314`;
* surface-container-lowest `#0e0e0e`;
* surface-container-low **`#1b1b1b`** (viewer canvas);
* surface-container **`#1e1f20`** (zoom dropdown);
* surface-container-high **`#282a2c`** (menus);
* surface-container-highest **`#333537`** (toolbar pill);
* surface-bright `#37393b` (active menu-bar button);
* on-surface `#e3e3e3`;
* on-surface-variant **`#c4c7c5`** (icons and toolbar text);
* outline `#8e918f`;
* outline-variant **`#444746`** (separators);
* secondary-container `#004a77` and on-secondary-container `#c2e7ff` (signed-in "Share" button, from [img]).

---

## 4. Component specs

All values are in CSS px at a 1440×900 viewport unless stated otherwise.

### 4.1 App shell (signed-in, light)

The shell is [img] from the 2023 Workspace refresh image at 1.6×, cross-checked against the live content-card values and the clone.

```
x=0                     256                                                        1424 1440
┌─────────────────────────────────────────────────────────────────────────────────────────┐ y=0
│ [logo 40] Drive      [ 🔍  Search in Drive                     ⚙︎tune ]   ✓  ?  ⚙  ⋮⋮⋮  (A) │  topbar 64px, bg #f8fafd (no divider)
├──────────────────────┬──────────────────────────────────────────────────────────────┬──┤ y=64
│ ╭──────────╮         │╭────────────────────────────────────────────────────────────╮│  │
│ │ +  New   │ 56px    ││ My Drive ▾                                   ▦  ☰  ⓘ        ││16│
│ ╰──────────╯ r16     ││ [File type ▾] [People ▾] [Modified ▾] [Source ▾]  chips 32px  ││px│
│ ▣ Home     ←32px pill││ ─────────────────────────────────────────────────────────── ││  │
│   My Drive  #c2e7ff  ││ Name ↑            Owner        Last modified   File size  ⋮  ││  │
│   …                  ││ ▢ row 48px ──────────────────────────── 1px #c4c7c5          ││  │
│ nav 256 wide          ││  content card: bg #fff, radius 16px all corners             ││  │
│ bg #f8fafd            │╰────────────────────────────────────────────────────────────╯│  │
└──────────────────────┴──────────────────────────────────────────────────────────────┴──┘ y=900-16
```

* The page background is `#f8fafd` [live]. The top bar has the same colour and **no** bottom border.
* The content card is white with a 16 px radius ([live]: top corners `16px 16px 0 0` on the header block, bottom
  `0 0 16px 16px`). It starts at y=64. Its gaps are 16 px to the right and bottom edges [live/img], and its left edge sits at
  x=256 [img ±4].
* In the signed-out variant the card spans x=0–1440 (no nav) and the table area has `padding: 0 12px 0 20px` [live].
* The right "side panel" rail of Calendar, Keep, Tasks and Contacts (56 px wide, at x≈1384) appears only in some accounts. It is
  seen in clones and in 2025 screenshots [img]. It is optional.

### 4.2 Top bar

* **Logo.** The live `img` is `logo_drive_2026_color_1x_web_48dp.png`, drawn at **44×40** at x=24, y=11 (signed-out
  [live]). The "Drive" wordmark is 22 px, 400, line height 48 px, `#1f1f1f`, `padding-left 4px`, with its box at x=68
  [live]. In the signed-in 2023 image the logo sits at x≈16–20 [img].
  * Asset note: the Drive logo is a Google trademark. Use your own product mark in its slot.
* **Search bar** [img]:
  * size and shape: 48 px tall, radius 24 px, bg `#e9eef6`;
  * placement: starts at x≈256 (aligned with the content card), max width ≈720 px [inf];
  * content: a 24 px search icon at left padding ≈16 px, then the placeholder "Search in Drive" (Google Sans Text 16/24, `#444746`
    [inf]), then a "tune" (filter) 24 px icon button at the right;
  * focused: bg `#fff` with elevation 1 [inf from GM3 Google search bars].
  * In a 2026 clone the placeholder reads "Get answers from Drive" with a sparkle-search icon. This is **unverified**; use
    "Search in Drive".
* **Right side:** 40×40 icon buttons (radius 50 %, padding 8 px, 24 px icons `#444746`):
  * offline/ready `offline_pin` [inf];
  * Help `help` (outlined circle "?");
  * Settings `settings`;
  * Google apps (3×3 dots, a Google SVG, 24 px);
  * account avatar 32 px, inside a 40 px target.

  The signed-out variant shows a "Sign in" filled button instead: 85×40, radius 100 px, bg `#0b57d0`, text 14/18 500 white,
  Google Sans Text, padding 10 px 12 px [live].

### 4.3 "+ New" button

Values are [img] from the official 2023 frame at 1.6×, plus the clone; see `crop-31`.

```
 x=16            ~116
 ┌──────────────────┐ y≈72
 │  +    New        │ 56px tall, radius 16px, bg #ffffff, box-shadow --elev-1 (hover → --elev-2 [inf])
 └──────────────────┘ y≈128
   ^icon 24px "add"    label: Google Sans 14px 500 (or Flex 500), colour measured bluish-dark ≈ #001d35 [img, GIF-quantised]
   padding ≈ 0 20px 0 16px, gap 12px [inf]
```

* Some Workspace accounts show "New ▾" with a dropdown arrow (official 2023 Home GIF).
* Clicking it opens a light menu (§4.9) with these items:
  * New folder (`create_new_folder`);
  * File upload (`upload_file`);
  * Folder upload (`drive_folder_upload`);
  * Google Docs, Sheets, Slides, Forms, More ▸ [inf].

### 4.4 Left navigation

Values are [img], cross-checked against the clone `clone-28`.

* Items are 32 px tall pills, 224 px wide, inset 16 px from the left. The pitch is 32 px, with **16 px gaps between groups**.
* Groups (current personal-account order, 2024–2026, [img] from `official-24a` and `press-27`):
  1. **Home**, **My Drive**, **Computers**
  2. **Shared with me**, **Recent**, **Starred**
  3. **Spam**, **Trash** (UK locale: "Bin"), **Storage**
* Below the groups:
  * a storage meter: a 4 px track `#e9eef6` [inf], with the fill in primary `#0b57d0`;
  * text "x GB of 15 GB used", 14/20 `#444746` (Google Sans Text);
  * an outlined button "Get more storage" (40 px, radius 20, 1 px `#747775`, label `#0b57d0` 14 px 500).
* Workspace accounts add "Shared drives"; older images show "Activity" and "Workspaces". A 2026 clone also shows "Projects"
  (unverified).
* **Expandable items** (My Drive, Computers, Shared drives) carry an 18–20 px `arrow_right` (solid triangle) to the left of
  the icon, at x≈24 [img].
* **Icon** 20 px [inf; it looks 20 at 1.6×], colour `#444746`, left edge x≈32. **Label** Google Sans Text 14/20 400 `#1f1f1f`,
  at x=68.
* **Selected:** pill bg `#c2e7ff`, label and icon `#001d35` (quantised (15,31,57) [img]; the GM3 filter-chip-selected label
  token is `#001d35` [css]). The icon switches to **FILL 1**. Label weight stays 400 (it looks identical to unselected
  items [img]).
* **Hover:** 8 % `#1f1f1f` state layer on the pill.
* **Icon names** (Material Symbols Outlined; filled variant when selected):

  | Item | Icon | Confidence |
  |---|---|---|
  | Home | `home` | [img] |
  | My Drive | the Drive-logo-in-a-box glyph. Google-internal; the closest Apache-2.0 glyph is `drive_export`, else `add_to_drive` or `hard_drive`. | **verify visually** |
  | Computers | `computer` | [img] |
  | Shared drives | `folder_shared` / `group_work` | [inf] |
  | Shared with me | `group` (`people` is not a Symbols name) | [img] |
  | Recent | `schedule` | [img] |
  | Starred | `star` | [img] |
  | Spam | `report` (octagon "!") — the image shows a circle "!", so possibly `error` | [img] |
  | Trash | `delete` | [img] |
  | Storage | `cloud` | [img] |
  | Activity | `notifications` | [inf] |
  | Workspaces | `workspaces` | [inf] |
  | Priority (2023) | `task_alt` / `check_box` | [img] |

### 4.5 Content header (My Drive / folder)

* **Title.**
  * Signed-in: "My Drive ▾" in Google Sans 24/32 400 `#1f1f1f`, with a 24 px `arrow_drop_down` [img].
  * Live signed-out folder title: Google Sans 24/32 400 `#444746`, rendered as a breadcrumb chip with radius 100 px and
    padding 4 px 16 px. Its box is at x=4, y=81, height 40 [live].
  * The title row is 64 px tall (y 63–127) [live].
* **Filter chips** (signed-in) [img + css defaults]:
  * outlined chips 32 px tall, radius 8 px, 1 px `#747775`, label Google Sans 14/20 500 `#444746`;
  * 18 px trailing `arrow_drop_down`; padding 16 px (8 px on the icon side); 8 px apart; selected → bg `#c2e7ff`, label `#001d35`;
  * chip names: Type, People, Modified, Source (older: File type, Last modified, Location).
  * In Home (2024) the chips are rendered **tonal** (bg ≈ `#e9eef6`, no outline) with leading icons [img].
* **View toggle** (segmented button) [live]:
  * group 110×32 at the right (x=1307 at a 1440 viewport, y=83);
  * two 55 px halves with radius `16px 0 0 16px` and `0 16px 16px 0`, padding `0 17px 0 20px`;
  * the outline and centre divider are 1 px `#747775` (divider [live]);
  * selected half bg `#c2e7ff` with an 18 px check (`check`) plus an 18 px `menu` (list) or `grid_view` icon, `#001d35`
    [px≈];
  * tooltip "List layout (Alt+V then L)".
* **"Download all"** (signed-out only): text button, Google Sans 14/36 500 `#0b57d0`, radius 100 px, padding 1 px 9 px [live].
* **Details:** 40×40 icon button `info` (signed-in).

### 4.6 List view (table)

Values are [live] unless marked.

```
table x=20 … 1428 (signed-out, 1440 viewport). Column boxes (th/td):
 Name 21→709 (688w, td padding-right 24) │ Owner 709→924 (215w) │ Date modified 924→1139 (215w) │ File size 1139→1227 (88w) │ actions/Sort 1227→1428 (~192w)
 header th padding: 0 8px 0 6px; th hover radius 8px 8px 0 0
┌──────────────────────────────────────────────────────────────────────────────┐ header row 48px
│ Name (●↑)              Owner             Date modified      File size   ≡ Sort │ 14px/48px 500 #444746 ("Name" = #1f1f1f when sorted)
├──────────────────────────────────────────────────────────────────────────────┤ 1px #c4c7c5 (tr border-bottom)
│ [ico] file name  👥    (◯) Owner hidden      Jun 25, 2022       1 KB    ⤓ Download │ row 48px, line-height 48px
├──────────────────────────────────────────────────────────────────────────────┤ 1px #c4c7c5
```

* **Sort indicator:** a 24×24 circle bg `#c2e7ff` holding an `arrow_upward` / `arrow_downward` icon (`#004a77`), placed right
  after the "Name" label (x=69). The header "Sort" control is a text button 82×40, radius 20, padding `0 16px 0 12px`, with an
  18 px `sort` icon and the label "Sort" (Google Sans Flex 14 500 `#444746`).
* **Row:** 48 px tall, `tr` with `border-bottom: 1px solid #c4c7c5` and `padding-right: 2px`.
  * Leading icon: folders use a 24 px icon at x=37 (`folder` / `folder_shared`, `#444746`); file types use a **16×16** icon at
    x=41 (the SVGs in §6.3).
  * Name text starts at **x=77**, i.e. 56 px from the table edge.
  * Name text: Google Sans Text 14/20 **500** `#1f1f1f`.
    > Note: the 2023 official signed-in image looks closer to 400. If critics compare against the live captures, use 500.
  * After the name: a 16 px `group` "Shared" icon (`#444746`) 8 px after the text, then a `star` for starred items.
* **Owner cell:** a 24 px avatar circle (bg `#f8fafd` for the placeholder, radius 12; the signed-in view shows the photo), then
  "me" or the name at x+32 (14/20 400 `#444746`).
* **Date modified:** "Jun 25, 2022" (this year: "Jan 6", without the year). Signed-in "Last modified" shows
  "May 17, 2021 Ruichi Zhou" (the date plus the modifier) [img].
* **File size:** "1 KB", "6.9 MB", or "—" for folders.
* **Signed-in trailing:** a `more_vert` 40 px icon button at the far right [img]. On hover, inline actions appear: Share
  (`person_add`), Download (`download`), Rename (`drive_file_rename`; the Material Icons name `drive_file_rename_outline` is not in Symbols), Add to Starred (`star`) [doc: the 2023 blog
  says "Key actions such as sharing, downloading, and editing are now displayed inline when hovering"; exact icons
  [inf]]. Signed-out hover shows a text button "⤓ Download": 40 px, radius 20, padding `0 16px 0 12px`, icon 18 px, label
  Google Sans Flex 14 500 `#444746` [live].
* **States** [px/live]:

  | State | Row appearance |
  |---|---|
  | hover | bg `#ededed` (8 % on-surface) |
  | selected | bg `#c2e7ff`; text colour `#004a77` for the name and every column; the owner avatar circle turns white |
  | selected + hover | `#b2daf4` |
  | keyboard-focused + selected | a 2 px `#0b57d0` ring inset ~1 px into the row, plus a 2 px `#d3e3fd` inner ring (see `live-04`) |

  Multi-select bar (signed-in): the header is replaced by "n selected" with action icons [inf, not captured].

### 4.7 Grid view

Values are [live] at a 1440 viewport, 6 columns.

* **Sections:** folders first, then files. A 16 px gap separates rows; columns sit about 17 px apart. The header shows only
  "Name ↑".
* **Folder card:** 220×48, bg `#f0f4f9`, radius 12 px.
  * Icon: 24 px `folder` / `folder_shared` at x+16.
  * Name at x+48: 14/20 500 `#1f1f1f`.
  * Trailing: a 40×40 icon button (radius 20, padding 8) at right inset 4 px. It shows `download` signed out and `more_vert`
    signed in.
* **File card:** 220×220, bg `#f0f4f9`, radius 12.
  * Header strip 48 px: 16 px type icon at x+16, name at x+48, `more_vert` / `download` at right.
  * Thumbnail box: x+8, y+48, 204×164, bg `#fff`, radius 4 px. It shows a page render (PDF first page, doc preview).
* **Selected:** card bg `#c2e7ff`, text `#004a77`.

### 4.8 Home page

Values are [img] from `official-24a` (2024, 800 px wide, ~1×) and `press-27`.

* Order of content:
  1. Large centred greeting "Welcome to Drive" or "Welcome, <name>", Google Sans ~24–28 px 400 `#1f1f1f`.
  2. A centred 48 px search pill.
  3. Tonal filter chips with leading icons: Type, People, Modified, Location.
  4. **"Suggested folders"** section header: Google Sans 16/24 500 `#1f1f1f`, a collapse chevron (`keyboard_arrow_down`) to the
     left, and a "View more / View less" text button.
  5. Folder cards: about 4 per row, about 48–56 px tall. Each has bg `#f0f4f9`, radius 12, a folder icon (coloured per folder
     colour), the name in 14/20 500, a second line "In My Drive" in 12/16 400 `#444746`, and `more_vert`.
  6. **"Suggested files"**, with the list/grid segmented toggle at the right. Its list columns are Name, Reason suggested
     ("You opened • 3:45 PM"), Owner, Location (an icon plus the folder name), and `more_vert`.
* Live 2025–26 Home shows "Welcome to Drive" at the top left of the card (24/32), with collapsible sections and the search in
  the top bar ([img] `press-27`, clone). Both layouts exist; use the top-left variant.

### 4.9 Menus (light: context menu, New menu, filter dropdowns)

Values are [live] from the signed-out context menu, which has 1 item. Signed-in menus use the same component with more items.

```
┌───────────────────────────────────────┐  width 320px (min), bg #f0f4f9, radius 4px, padding 8px 0, shadow --elev-2 [px ≈10px falloff]
│  ⤓   Download                          │  item 32px tall, padding 6px 12px; icon 20px #444746 at x+12; label at x+48
└───────────────────────────────────────┘  label: Google Sans Flex 14/20 400 #1f1f1f
```

* Item hover: 8 % `#1f1f1f` state layer [inf].
* Separator: 1 px `#c4c7c5` with 8 px vertical margin [inf from the dark menu].
* Submenu arrow: `arrow_right` 24 px at the right [live, dark menu].
* Shortcut hint: right-aligned, Google Sans 11/16 500, +0.1 px tracking, `#444746` [live, dark menu].
* Signed-in right-click menu (2024–26), [inf] from product knowledge and the 2023 GIF:
  * Open with ▸ (`open_with`);
  * Download (`download`);
  * Rename (`drive_file_rename`);
  * Make a copy (`file_copy`);
  * ── Share ▸ (`person_add`);
  * Organise ▸ (`drive_file_move`);
  * File information ▸ (`info`);
  * ── Move to trash (`delete`).
* Filter dropdowns (Type) list items with **coloured file-type icons**: PDFs, Videos, Shortcuts, Folders, Sites, Audio,
  Drawings, Archives (zip) [img].
* **Tooltip** [live]: bg `#303030`, text `#f2f2f2` in Google Sans Text 12/16 400 with 0.1 px tracking, padding 4 px 8 px,
  radius 4 px, 26 px tall, about 4 px below the anchor.

### 4.10 File preview / PDF viewer (new Drive viewer, December 2025)

Values are [live]. The overlay is opened by double-clicking a PDF in the list. The standalone version is
`/file/d/<id>/view`.

```
OVERLAY (scrim over the Drive page: rgba(0,0,0,.92) → #141414 over white) │ STANDALONE: bg #1b1b1b
y=0 ┌──────────────────────────────────────────────────────────────────────────────────────┐
    │ ✕(32px@16,16)  [PDF 24]  slides_systems_biology_pde.pdf          (signed-in: Open▾ Share▾ ✦ (A)) [⧉ 40px] │ header 64px
    │                            File  View  Tools  Help   ← menubar y=34, 24px tall            │
y=64├─╭────────────────────────────────────────────────────────────────────────────────────╮──┤
    │ │ Page [ 1 ] / 51  │  ⤓   🖶  │  −  (100% ▾)  +      (signed-in: │ 💬 Comment  ✍ Request eSignature) │ │ pill: x16, h48, bg #333537, radius 100, padding 8
y=112 ╰────────────────────────────────────────────────────────────────────────────────────╯  │ (standalone: pill 1356w + separate 48×48 ⌃ "Hide file header", bg #333537 r16)
y=128 ┌─────┐┌───┐             ┌──────────────── page 800w ───────────────┐
    │ (▣)  ││ 1 ▢│             │  white page, shadow 0 4px 15px 2px rgba(0,0,0,.35)        │      (›) next 40px
    │  ☰   ││ 2 ▢│  ‹ prev     │  pages stacked with 16px gap                              │      bg rgba(30,31,32,.9)
    │      ││ … │  40px@x28   └───────────────────────────────────────────┘
    │ ◫ (bottom-left 56×40 pill, bg rgba(30,31,32,.92), radius 0 100px 100px 0)   │
```

* **Header** (64 px, bg transparent over the scrim in the overlay, `#1b1b1b` standalone):
  * Close (overlay only): 32×32 button, radius 16, padding 4, icon 24 px `close` `#c4c7c5`, at x=16 y=16.
  * File-type icon: 24 px at x=58 in the overlay, x=16 standalone.
  * File name: Google Sans 18/20 400 `#e3e3e3`, top y=12, left x=98 in the overlay (x=56 standalone).
  * **Menu bar** ("File View Tools Help"; the signed-in view adds "Insert"):
    * buttons 24 px tall with padding 0 9 px, labels Google Sans Flex 14 400 `#e3e3e3`;
    * the open menu's button gets bg `#37393b` and radius `4px 4px 0 0`.
  * Right side:
    * overlay: "Open in new tab", a 40×40 button with radius 20, padding 10, icon 20 px `open_in_new`;
    * signed-in [img `official-25`]: an outlined split button "Open ▾" (icon `open_in_new`, 1 px `#8e918f`), a **tonal split
      button "Share ▾" (bg `#004a77`, label `#c2e7ff`)**, a Gemini spark, and the avatar.
* **Toolbar pill** (y=64, h=48, bg `#333537`, radius 100 px, padding 8 px):
  * Text: Google Sans Text 14/20 500 `#c4c7c5`. "Page" at x=40.
  * Page input: about 22–33×24, radius 4 px, **1 px `#8e918f` border** [px], text `#e3e3e3`. Then "/" and the total.
  * Separators: 1×12 `#444746` with about 8 px margin.
  * Icon buttons: 32×32, radius 16, padding 6, **20 px icons** `#c4c7c5` — `download`, `print`, `zoom_out` (a "−" glyph),
    `add` (zoom in).
  * Zoom combobox: 73×32, radius 100, input text Google Sans 14/24 `#e3e3e3` "100%", plus a 20 px `arrow_drop_down`. When
    focused it gets a `2px solid #a8c7fa` outline.
  * Signed-in extra group [img]: separated by a gap, holds text buttons "Comment" (`add_comment`) and "Request eSignature"
    (`signature`).
  * Hover on any icon button: a round state layer of **8 % `#c4c7c5`** over `#333537`, giving `#3e4041` [px].
  * Dark-theme tooltip: bg `#e3e3e3`, text `#303030`, radius 4, Google Sans Text 12/16 [px]. It appears about 8 px below the
    pill (`live-14`).
* **Zoom dropdown:**
  * bg `#1e1f20`, radius 4 px, width about 76;
  * items 40 px tall: "Fit", then a separator (1 px `#444746`), then 50 %, 75 %, 100 %, 125 %, 150 %, 200 %;
  * label Google Sans 16/24 400 `#e3e3e3`, padding about 8 px 16 px.
* **Dark menus** (File and Tools):
  * bg **`#282a2c`**, radius 4 px, padding 8 px 0, width 288 px; shadow elevation-2 [inf];
  * items **36 px** (8 px + 20 + 8); rows with a submenu arrow are 40 px;
  * icon 20 px `#c4c7c5` at x+12; label at x+48, Google Sans Flex 14/20 400 `#e3e3e3`;
  * shortcut right-aligned: Google Sans 11/16 500, +0.1 px, `#c4c7c5` ("Ctrl+D", "Ctrl+P", "D");
  * separator: `li` 17 px tall = 8 px + 1 px `#444746` + 8 px;
  * disabled items: opacity .38.
  * Signed-out items:
    * File: Open ▸ (icon `open_with`), ─, Download Ctrl+D, ─, Details D (disabled), Print Ctrl+P;
    * Tools: Find Ctrl+F (`find_in_page`).
* **Left rail:**
  * toolbar at x=16 with 40×40 round toggles (radius 20, padding 8, 24 px icons `#c4c7c5`):
    * "Hide thumbnails" (`image` / `photo_library`, **selected = bg `#333537`**);
    * "Show outline" (`list` / `toc`);
  * thumbnail list at x=62–179: a page number in a 28 px column (Google Sans Text 14/20 500 `#c4c7c5`), then the thumbnail
    (≈71 px wide for landscape, ≈73×97 for portrait);
  * the current page thumbnail gets a **2 px `#a8c7fa` rounded outline with a 2 px offset**, separated from the page by the
    background [px];
  * bottom-left "Hide navigation pane": a 56×40 pill (bg `rgba(30,31,32,.92)`, radius `0 100px 100px 0`) holding a 40 px
    button with icon `left_panel_close`.
* **Page area:**
  * starts at y=128, centred, white pages with `0 4px 15px 2px rgba(0,0,0,.35)`, 16 px vertical gap;
  * placeholder bg `rgba(68,71,70,.2)`;
  * a floating 42 px round "scroll-to-top" or annotation button can appear (bg `rgba(227,227,227,.95)`, 1 px `#e3e3e3` border,
    `0 3px 3px rgba(0,0,0,.05)`).
* **Prev/next** (overlay, other files in the folder): 40×40, radius 20, bg `rgba(30,31,32,.9)`, icons 24 px
  `chevron_left` / `chevron_right` `#c4c7c5`, at x=28 and right 28, vertically centred.
* **Error toast:** "There was a problem with the preview…" on a `#3c3c3c`-ish rounded rectangle, 16 px text
  (`drive-refs/live-22-drive-preview-error-toast.png`).

### 4.11 Google Docs comments

Values are [live] from a public doc that allows anonymous comment viewing. The doc was not modified.

* **Open-sidebar button:** the top-bar "Show all comments" 42×42 icon button (`comment` / `chat_bubble` style, radius 9999).
* **Sidebar** (all comments):
  * x = viewport−336, y=65, **320 px wide**, extends to 16 px from the bottom, bg **`#f0f4f9`**, radius 16 px.
  * Header (56 px tall): "Comments" in Google Sans 22/28 400 `#444746` at padding 16, plus a `close` 24 px icon button at the
    right.
  * **Tabs row:** 48 px tall, padding 0 12 px, border-bottom 1 px `#c4c7c5`.
    * Tabs "All comments" and "For you", padding 0 16 px, labels Google Sans 14/20 400.
    * Selected tab: label `#0b57d0`, bg `rgba(11,87,208,.08)`, and a **3 px `#0b57d0` bottom indicator** spanning the label
      width + 3 px, with rounded top.
    * Unselected label: `#444746`.
    * A 24 px `search` icon button at the right.
  * **Filter buttons:** "All types ▾" and "All tabs ▾", 32 px tall, radius 8 px, 1 px `#747775`, Google Sans 14/28 500 `#444746`,
    padding `0 8px 0 16px`, 8 px apart, at y=186.
* **Thread card in the sidebar:**
  * x+16, width 288, bg **`#e9eef6`**, radius **12 px**, 16 px gap between cards. Padding 16 px horizontally, 17 px from the top.
  * Line 1: "Tab 1 · <quoted anchor text…>", Google Sans 12/20 500 `#444746`, ellipsised, with a `keyboard_arrow_down` 24 px button
    at the right.
  * Author row: 32 px circular avatar; name at x+40 from the avatar, Google Sans 14/20 500 +0.1 px `#1f1f1f`; timestamp
    below, Google Sans 12/16 400 +0.1 px `#444746` ("9:24 PM Sep 28").
  * Body: Google Sans 14/20 400 `#444746`, 11 px below the author block.
  * Replies are stacked with 20 px top padding and the same author or body styles. "Show more" is a link in 11 px `#0b57d0`.
* **Active thread** (clicked):
  * card bg turns **`#ffffff`**;
  * the author row gets a `check` (Resolve, `#0b57d0`, 24 px) and a `more_vert` (`rgba(31,31,31,.7)`);
  * a reply field appears at the bottom: "Reply or add others with @", 38 px tall, radius 16 px, 1 px `#747775`, padding
    `8px 7px 8px 16px`, Google Sans 14/20.
* **Margin (anchored) cards** in the doc's right margin, shown when the sidebar is closed:
  * 282 px wide, bg **`#f8fafd`**, radius 12 px, padding `16px 16px 12px`, **10 px gap**;
  * avatar 32 px; name 14/20 500 at x+44; time 12/16 400.
  * Suggestion cards use bold 13/20 labels ("Add:", "Format:") in `#444746` with italic quoted text.
  * **Active margin card:** bg `#fff`, radius 12, shadow `0 1px 3px 0 rgba(0,0,0,.3), 0 4px 8px 3px rgba(0,0,0,.15)`. It is
    shifted 12 px left of the inactive cards (x=1143 vs 1155).
* **Anchor highlight:** the active comment's text range is highlighted **`#fcbc03`** [px], i.e. Google Yellow `#fbbc04`.
  The inactive highlight is a lighter yellow [inf, ≈`#fde293` / `rgba(251,188,4,.4)`].

### 4.12 Chrome's built-in PDF viewer (for "open in browser" comparisons)

Values are [css] from `chromium/src/chrome/browser/resources/pdf` at main, as of 2026-10, and [px] from Chromium 147.

* **Toolbar:**
  * height **56 px**, bg **`rgb(60,60,60)` `#3c3c3c`**, text `rgb(241,241,241)`, padding 0 16 px;
  * title: 0.87 rem 500, starting 16 px after the menu (`menu`) button;
  * centre: page selector (input bg `rgba(0,0,0,.5)`, width `max(2, digits)ch`, 0.81 rem), then "/ N", a 1×20
    `rgba(255,255,255,.3)` separator, zoom − [100%] +, a separator, fit (`fit_page` / `fit_width`) and rotate
    (`rotate_left`), then annotate (ink `draw`) and undo/redo;
  * end: download, print, `more_vert`;
  * icon buttons are cr-icon-button 36 px with 20 px icons;
  * active button bg `rgba(255,255,255,.24)`;
  * progress bar 3 px `google-blue-300`.
* **Sidenav:** **300 px** wide, bg `rgb(40,41,42)` `#28292a`, with a 1 px `rgb(94,94,94)` border on the right.
  * Icon column 64 px with 36 px buttons and a 12 px margin. The selected tab is `google-blue-300` (`#8ab4f8`), with a vertical
    indicator.
  * Thumbnails: 108×140 boxes, white, 12 px bottom margin. The current page has a 6 px `#8ab4f8` box-shadow ring (8 px when
    focus-visible). Inactive thumbnails sit at opacity .5, and .7 on hover.
* **Content bg:** `#282828` (40,40,40) [px].

---

## 5. Spacing summary (Drive light UI)

| Thing | Value | Source |
|---|---|---|
| Base grid | 4 px (all measured values are multiples of 4, except the 17 px card gap = 16 + rounding) | [live] |
| Top bar height | 64 | [live] |
| Content card top / right / bottom gap | 64 / 16 / 16 | [live]/[img] |
| Content side padding (table) | 20 left, 12 right | [live] |
| Title row height | 64 | [live] |
| Header row / data row | 48 / 48 | [live] |
| Icon → name gap in a row | 24 px icon at x=37 → name at 77 (16 px gap) | [live] |
| Nav item height / gap between groups | 32 / 16 | [img] |
| Menu item / dark menu item | 32 / 36 | [live] |
| Menu padding | 8 px top and bottom | [live] |
| Grid card gap | 16–17 px | [live] |
| Docs comment cards gap (margin / sidebar) | 10 / 16 | [live] |

---

## 6. Icons and assets

### 6.1 Material Symbols: which set and which settings

* **Set:** *Material Symbols Outlined*, `FILL 0` (nav selected → `FILL 1`), `wght 400`, `GRAD 0`. Use `opsz 24` for 24 px icons
  and `opsz 20` for 20 px ones.
  * Proof: Drive's "Sort" SVG path `M120-240v-80h240v80H120Zm0-200v-80h480v80H120Zm0-200v-80h720v80H120Z` and "Open in new tab"
    path are byte-identical to `fonts.gstatic.com/s/i/short-term/release/materialsymbolsoutlined/{sort,open_in_new}/default/24px.svg`.
  * Some legacy Material Icons paths remain (close, chevrons, zoom in), along with Google-internal glyphs (Drive logo, Apps
    grid).
* **npm options, verified 2026-10-31:**
  * **`material-symbols@0.48.2`** (Apache-2.0). It ships *variable* woff2 files for outlined, rounded and sharp (4 MB outlined,
    wght 100–700). Use
    `font-variation-settings:'FILL' 0,'wght' 400,'GRAD' 0,'opsz' 24`. This is the best fidelity at any size.
  * **`@iconify-json/material-symbols@1.2.97`** (Apache-2.0, 16 475 icons, 24×24 viewBox with **opsz-24 geometry**, so it
    matches Drive). Use it with `@iconify/react` or `unplugin-icons`. Naming: `home` is the filled glyph and `home-outline`
    is FILL 0.
  * `@material-symbols/svg-400@0.48.2` (Apache-2.0) has outlined, rounded and sharp variants with `-fill` versions, **but the
    paths are drawn at opsz 48**. Stroke weights look heavier at 20–24 px, so it is **not pixel-faithful**. Avoid it for diffs.
  * Fallback: the Google Fonts CSS `family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200`.

### 6.2 Icon names per surface

Names marked [live/verified] or [inf] as above.

| Surface | Action → icon |
|---|---|
| Top bar | search `search`; advanced search `tune`; offline `offline_pin`; help `help`; settings `settings`; apps (Google SVG, or `apps`) |
| New menu | `create_new_folder`, `upload_file`, `drive_folder_upload` [inf] |
| Content header | `arrow_drop_down`; view `menu` (list) and `grid_view`; selected-segment `check`; details `info`; chips `arrow_drop_down` |
| Table | sort arrow `arrow_upward` / `arrow_downward` (24 px circle, 18–20 px glyph); header "Sort" `sort` [verified]; shared badge `group` (16 px); owner placeholder `account_circle` (16 px); row `more_vert`; hover actions `person_add`, `download`, `drive_file_rename`, `star` |
| Folders | `folder`, `folder_shared` (24 px `#444746`) |
| Viewer | close `close`; open in new tab `open_in_new` [verified]; download `download`; print `print`; zoom `remove` / `add`; zoom menu `arrow_drop_down`; thumbnails `image`; outline `toc` / `list`; hide pane `left_panel_close`; prev/next `chevron_left` / `chevron_right`; menus `open_with`, `info`, `find_in_page`; signed-in `add_comment`, `signature`, `share`; the Gemini spark is a Google-only glyph, so substitute `auto_awesome` |
| Docs comments | `close`, `search`, `keyboard_arrow_down` (the font ligature `expand_more` also works), `check` (resolve), `more_vert`, `arrow_drop_down` |

### 6.3 File-type icons: legitimate sources

Drive's own icons are Google trademarks. The live SVG of the PDF icon is an 18×18 `rect rx=3 fill=#FC413D` with white "PDF"
glyph paths. Docs uses `#3186FF` with white bars, and Sheets uses `#00AF57`. These assets belong to Google, so they must
not be copied or redrawn. Options:

1. **Pictogrammers MDI via `@iconify-json/mdi`** (icons under Apache-2.0). Use **`mdi:file-pdf-box`**, a rounded square with
   "PDF" cut out, the closest geometric match to Drive's new PDF tile, filled `#FC413D`. Also `mdi:file-document`,
   `mdi:google-spreadsheet`, `mdi:folder`, `mdi:file-image-box`, `mdi:file-video`, `mdi:folder-zip`, `mdi:file-word-box`,
   `mdi:file-excel-box`, `mdi:file-powerpoint-box`. All were verified present in `@iconify-json/mdi`, whose licence field reads
   Apache-2.0 (author Pictogrammers). **Recommended.**
2. **Material Symbols** `picture_as_pdf`, `description` (doc), `table_chart` / `grid_on` (sheet), `folder`, `image`,
   `movie`, `audio_file`, `folder_zip`, tinted with the colours in §3. Apache-2.0. This option is weaker for PDF (the glyph is
   an outline document, not a solid tile).
3. `vscode-icons` (MIT; `@iconify-json/vscode-icons` `file-type-pdf2`) and `react-file-icon` (MIT). These work but are stylistically
   further from Drive.
4. The Drive API `files.iconLink` URLs (`drive-thirdparty.googleusercontent.com/16/type/application/pdf`) are a documented
   way for *apps that integrate with Drive* to show Google's icons. They are **not** open-licensed. Use them only if the
   product is a real Drive integration.

The Drive logo and "Drive" wordmark are trademarks. Use your own mark in the same 40 px slot.

---

## 7. What to reuse

### 7.1 Open-source Drive clones

None is pixel-faithful enough to fork. GitHub search was run 2026-10-31.

| Repo | Stack | Licence | Fidelity to the 2025–26 Drive |
|---|---|---|---|
| `jatinsoni08/GoogleDriveClone` | static HTML + Tailwind | **MIT** | Best open-licensed layout match: Home, nav order, header icons, Gemini spark, side panel. However it uses Font Awesome-style icons, nav pills look ~40 px tall, and it is not token-accurate. Usable only as a layout sketch. |
| `nisabmohd/google-drive` | React + MUI v5 + Node | **none** (all rights reserved) | 2022-era look with MUI styling; not current. Do not reuse. |
| `subnub/myDrive` (4.2 k★) | React + Node + Mongo | GPL-3.0 | Own design; not a Drive look-alike. |
| `WebDevSimplified/firebase-google-drive-clone`, `samarbadriddin0v/…`, `EzeibekweEmma/…` (MIT), Next.js/Appwrite "StoreIt" tutorials | React / Next | mostly none | Functional tutorials with generic Tailwind UIs; low fidelity. |
| "Drive · Mya" (`google-drive-clone-three-lac.vercel.app`, no public repo or licence found) | unknown | unknown | **Highest fidelity seen** (nav 224×32 pills, New 101×56 r16, 2026 items such as "Projects" and the "Get answers from Drive" search). Use it only as a *visual cross-check*. Do not copy. |

### 7.2 Component libraries

* **`@material/web` 2.5.0** (Apache-2.0, Lit web components):
  * gives true M3 components (buttons, icon buttons, menus, chips, lists, tabs, dialogs, progress) themable via
    `--md-sys-color-*`, so you can drop in the GM3 values above;
  * **but** the README states *"MWC is in maintenance mode pending new maintainers"*;
  * it has no data table and no tooltip; nav drawer, segmented button and card exist only in `labs` (verified in the
    2.5.0 tarball);
  * React needs `@lit/react` wrappers;
  * Drive overrides most M3 defaults: menu items are 32 px, not 48 px, and M3 buttons default to 40 px with 24 px padding.

  Verdict: optional, only for ripple and focus-ring behaviour.
* **MUI (`@mui/material` 9.5, MIT)** still implements **Material 2**. `@mui/material-next` (M3) is deprecated. Getting GM3 out of it
  means fighting the theme. **Not recommended.**
* `mdui` 2.1.5 (MIT) and `beercss` 5.0.3 (MIT) are M3 implementations, but they use baseline M3 metrics. They have the same
  override problem as `@material/web`.

### 7.3 Recommendation

Hand-build the Drive surfaces. They are geometrically simple: a nav pill, a 48 px table row, cards, a pill toolbar and menus.
Build them in React with Tailwind (or CSS modules) driven by the token block in §3.1.

Take behaviour and accessibility from **Radix UI primitives** (MIT): DropdownMenu, ContextMenu, Tooltip, Dialog, ToggleGroup
(for the segmented button), and Tabs (for the comment sidebar). Style them with the measured values.

Use these assets:

* icons: `material-symbols` (variable font, opsz 20/24) or `@iconify-json/material-symbols`;
* fonts: OFL **Google Sans** (with opsz 17 standing in for Google Sans Text) and **Google Sans Flex**;
* file-type tiles: `@iconify-json/mdi` (`file-pdf-box` and friends).

Do not ship Product Sans, Google Sans Text, Google Symbols or Drive's logo and file icons.

---

## 8. Known gaps (flag to critics)

* Signed-in-only surfaces were **not** rendered live, so they rely on [img] and [inf] values:
  * left nav, New button, search bar, Home, the multi-select toolbar;
  * the signed-in right-click menu, the "Share" dialog and the details panel.
* The exact search-bar width and placeholder colour, the New label colour (`#001d35` vs `#1f1f1f`) and the "My Drive" icon glyph
  are [inf].
* Row file-name weight is 500 in the live 2026 signed-out view, but looks like 400 in the 2023 signed-in image.
* The new viewer's signed-in toolbar ("Comment", "Request eSignature", the "Share" tonal split button) is measured only from
  the official 2025 image at about 1.5× (colours exact for the tonal Share: `#004a77` / `#c2e7ff`).
* To re-measure, the scripts are in `scratchpad/scripts/`:
  * `probe.js` — steps: shot, dump, dumpframes, hover, click, rightclick, wheel;
  * `q.py` — query the dumps;
  * `svgs.js` and `matchicons.py` — icon path matching.

  Use Chromium `channel:"chromium"` (new headless) for the Drive viewer. The headless shell gets HTTP 403 on the viewer
  module.

---

## 9. Reference image index

The images are in `research/drive-refs/`; its `README.md` repeats this list with source URLs.
Live captures are 2880×1800 (2× of a 1440×900 viewport), taken 2026-10-31.

| File | What it shows |
|---|---|
| live-01 … 04 | Drive list view: default, row hover, selected, selected + keyboard focus |
| live-05 / crop-33 | context menu (signed-out) |
| live-06, live-08 | grid view (folders + files; PDF thumbnails) |
| live-07 | list with red PDF tiles |
| live-09 … 15, crop-34/35 | Drive PDF preview overlay: base, File / Tools / View menus, zoom dropdown, hover states |
| live-16 | standalone `/file/d/…/view` viewer |
| live-17 … 20, crop-36 | Docs comment sidebar, active thread, active margin card, default margin cards |
| live-21, crop-37 | Chromium built-in PDF viewer |
| live-22 | Drive preview overlay showing the error toast (scrim and toast styling) |
| official-22/22a, crop-31/32 | 2023 GM3 refresh, signed-in My Drive (nav, New, search, chips, suggested cards, rows); 2082×1289 = 1.6× |
| official-23/23a | 2023 Home view (nav incl. Activity / Workspaces, Home table) |
| official-24/24a | 2024 unified Home (Welcome, search, chips, suggested folders cards, files list) |
| official-25 | 2025-12 new file viewer, signed-in (Open / Share split buttons, Comment, eSignature, comment card, Gemini summary) |
| official-26 | 2023 Docs refresh |
| press-27 | Macworld 2024, Drive Home dark theme on a laptop (nav order) |
| clone-28 … 30 | clones (cross-check only) |
| dumps/*.json | full computed-style dumps behind every [live] number |
| source-css/ | Drive GM3 light and dark token blocks, GM3 component token defaults, Chromium PDF viewer CSS |
