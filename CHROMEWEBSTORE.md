# Chrome Web Store Listing — sickofpdfs

> Last Updated: 2026-11-10

This file holds everything the Chrome Developer Dashboard asks for, ready to copy. It is not part of the extension zip.
Keep it in step with the built `manifest.json` (`pnpm -C apps/extension build`, then `apps/extension/.output/chrome-mv3/manifest.json`).
The zip to upload is made with `pnpm release:zip --store` (see "Review Notes" for the first upload).

## Store Listing

**Extension Name** [REQUIRED]
<!-- Must match manifest.json "name". Max 75 characters. -->
sickofpdfs

**Short Description** [REQUIRED]
<!-- Max 132 characters. Shown in search results and tiles. Be specific about function. -->
Open PDFs in Chrome, then highlight, comment and ask Claude. Your study PDFs and notes save to a library on your computer.

(The manifest's own description is shorter: "A PDF reader that replaces Chrome’s, with highlights and comments." Both say the same thing.)

**Detailed Description** [REQUIRED]
<!-- Plain text with line breaks: the store strips Markdown. Copy everything between the lines. -->

----
sickofpdfs opens the PDFs you open in Chrome in a calm, fast reader where you can mark text, write notes and keep your study PDFs in one library.

READING
• Opens every PDF in Chrome: links, files on your computer, and PDFs shown inside pages such as Moodle or Canvas.
• Find, zoom, print, thumbnails and the outline, like Chrome’s own viewer.
• Two-page view and presentation mode.
• Opens each PDF where you stopped last time.
• Drag thumbnails to change the page order. The file itself never changes.
• A PDF shown inside a page opens in the full tab, with "Back to page" to go back.

MARKS AND NOTES
• Highlight, underline, bold and strikethrough: select text, then press one key or right-click.
• Write a note on any passage, figure or area. Notes sit in the margin, with replies.
• The Notes panel lists every note in the PDF.
• Your notes stay with the PDF, even after you move, rename or download it again.
• Download a copy of the PDF with your notes in it, or export all notes as Markdown.

YOUR LIBRARY
• Papers, readings and slides save to your library by themselves. Receipts, bank statements, payslips and other private PDFs are not saved.
• Search titles, full text and notes with Ctrl+K.
• Readings are grouped by course. Add tags, star readings and see related ones.
• Scanned pages are read on your computer, so you can select, mark and search them.
• Automatic backup to a folder you choose, and restore on a new computer.
• Save the web page you are on to your library, from the toolbar button.

ASK CLAUDE (OPTIONAL)
• Type @Claude in a note to ask about a passage or a figure. Answers link to the page they come from.
• Uses your own Anthropic API key, which you add in Settings. Without a key, nothing is sent.

HOW TO USE
1. Install sickofpdfs, then open any PDF in Chrome. It opens in sickofpdfs.
2. Select text and right-click to mark it or write a note.
3. Open your library from the toolbar button to find your readings and notes.
4. For PDFs saved on your computer: open the extension’s details page and switch on "Allow access to file URLs".

PRIVACY
Your PDFs and notes stay on your computer, and in a backup folder if you choose one. We never receive them. There are no ads, trackers or analytics. Nothing is sent anywhere unless you ask for it or turn it on:
• Claude: only the passage or figure you ask about goes to Anthropic, with your own key.
• Online lookups (off at first): only a saved paper’s DOI or arXiv number goes to Crossref or arXiv.
• Search: the words you choose open in Google or Google Scholar in a new tab.
• Cloud sync: only if you connect your own server.
Full policy: https://sickofpdfs-site.rexheng-policy.workers.dev/privacy

PERMISSIONS
• "Read and change all your data on all websites": needed to open PDFs from any website in sickofpdfs instead of Chrome’s viewer, and to show PDFs that sit inside web pages. It does not read the text of web pages. It reads a page only when you click "Save this page to library".
• "Read your browsing history": needed to notice when a tab is opening a PDF, and for "Back to page". Nothing is kept or sent.

SUPPORT
Questions or problems: write to the address on this page, or see https://sickofpdfs-site.rexheng-policy.workers.dev

Version 1.0.0 (Release 1): the first store release.
----

**Category** [REQUIRED]
<!-- Pick one -->
Productivity. In the current dashboard's list, choose "Education" under Productivity (it is a study tool); "Tools" is the second choice.

**Single Purpose** [REQUIRED]
<!-- One sentence. Narrow and easy to understand. -->
Replaces Chrome's PDF viewer with a reader where you can highlight and comment on PDFs and keep your study PDFs and notes in a library on your computer.

**Primary Language** [REQUIRED]
English (UK spelling).


## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `apps/extension/store-assets/store-icon-128.png` (96 px tile with 16 px clear space; `node apps/extension/scripts/make-icons.mjs --store`) |
| Screenshot 1 [REQUIRED] | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 2 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 3 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 4 | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 5 | 1280×800 or 640×400 | ⬜ Not created | |
| Small Promo Tile [RECOMMENDED] | 440×280 | ⬜ Not created | |
| Marquee Promo Tile | 1400×560 | ⬜ Not created | |

<!-- Status options: ⬜ Not created | 🟡 Needs update | ✅ Ready -->

### Screenshot Notes
Take every screenshot from the real built extension, at 1280×800, with an openly licensed paper (for example a CC BY arXiv paper). Never show a real receipt, a real person's file, another company's logo or a phone mock-up. No text over the picture is needed; if a caption is added, keep it to a few plain words.

1. **Reading and marks.** A paper open in the viewer, with a highlight, an underline and one note card in the margin. Shows the toolbar and the Notes panel.
2. **The right-click menu.** Text selected, with the menu open (Highlight, Underline, Bold, Strikethrough, Comment, Ask Claude).
3. **The library.** The library home with several readings, a course group and the search box.
4. **Ask Claude.** A note thread where Claude answers a question about a passage, with a page link. The model name and cost must not show (R107).
5. **Your notes stay yours.** The chip saying "Not saved · invoice or receipt" on a made-up sample invoice, to show that private PDFs are not kept. Or Settings → Backup with a chosen folder.

Small promo tile (440×280): the icon and the words "Mark and comment on PDFs in Chrome" on white. No screenshot is needed there.


## Permissions Justification

The dashboard asks for one reason per permission, and a reason for host permissions. Copy the right-hand column.

| Permission | Type | Justification |
|------------|------|---------------|
| `declarativeNetRequestWithHostAccess` | permissions | When the user opens a PDF on any website, a redirect rule opens it in the sickofpdfs reader instead of Chrome's built-in viewer. The rule spots PDFs by their address and by the content type the website sends, so PDFs without ".pdf" in their address open too. This is the extension's main feature. A second kind of rule lets the reader's own request for that one PDF repeat the referring page Chrome sent, because some websites refuse a PDF without it. No other requests are changed or blocked. |
| `webRequest` | permissions | Observes only (never blocks or changes): it notes, in memory for a few minutes, the referring page Chrome sent with a page or frame load, and sees when the PDF redirect rule sent a tab to the reader. This is how the reader knows which PDF address a tab really opened, so a web page cannot make the reader load some other file with the user's sign-in. Nothing is stored on disk or sent. |
| `webNavigation` | permissions | Tells the extension when a tab or a frame inside a page starts opening a PDF, so the right tab opens in the reader, PDFs on the user's computer reach the reader even before file access is switched on (the reader then explains how to switch it on), and "Back to page" returns to the page that showed the PDF. Navigations that are not PDFs are ignored and nothing is kept. |
| `storage` | permissions | Keeps small reader settings on this computer (for example caret browsing, hidden menus and the reading options in Settings) and the "Updated" note. Until the browser closes, it also keeps which PDF each open tab may load, so a reload, Back or reopening after a crash shows the same PDF at the same page. |
| `unlimitedStorage` | permissions | The user's library keeps copies of saved PDFs (some are several hundred megabytes) and their notes on this computer. Without it Chrome could delete the library when the disk is low, and the user would lose their notes. |
| `offscreen` | permissions | One hidden extension page holds the library's database in a background worker, so every open PDF tab shares one library and notes are never written twice. The same page runs the nightly backup to the user's chosen folder, the automatic course tags and the text recognition of scanned pages, so these keep working after the PDF tab is closed. Chrome has no other place that can run these workers outside a tab. |
| `activeTab` | permissions | Used only when the user clicks "Save this page to library" in the toolbar menu: it lets the extension read the page in the current tab once, to save it as a PDF in the library. It also keeps this working when the user has set the extension's site access to "On click". |
| `scripting` | permissions | Used only after the user clicks "Save this page to library": it runs the page reader in that one tab to copy the article text and pictures into a PDF. Nothing runs on any page without that click. |
| `alarms` | permissions | Only for users who connect their own cloud server: retries a "Forget this PDF" that has not reached their server yet, and starts a sync every few minutes. With no server connected, the alarm finds nothing to do and sends nothing. |
| `identity` | optional_permissions | Asked for only when the user presses "Connect" to sign in to their own cloud server. It opens the sign-in window and gets the sign-in back. Never asked for on install. |
| `http://*/*`, `https://*/*` | host_permissions | PDFs open from every kind of website (university portals, journals, email attachments, course pages), so the reader must be able to take over a PDF on any http or https site, fetch the PDF itself for display, and show PDFs embedded inside pages. The extension does not read or change normal web pages; it only replaces a PDF viewer. |
| `file:///*` | host_permissions | Lets the reader open PDFs saved on the user's own computer, the same way Chrome's viewer does. It works only after the user switches on "Allow access to file URLs" for the extension. |

Other manifest entries a reviewer may ask about:

| Entry | Justification |
|-------|---------------|
| Content script `content-scripts/embed.js` and `embed.css`, on `http://*/*`, `https://*/*`, `file://*/*`, all frames, at `document_start` | A small script (about 5 KB) that notices two things: a PDF shown inside a web page (an `<embed>` or `<object>`, as on Moodle or Canvas), which it then opens in the reader in the full tab with a "Back to page" button; and a PDF that a website sent without saying it is a PDF, which Chrome's viewer would otherwise show. It must start before Chrome's own viewer loads. It holds no data, reads no page text, and does nothing on pages without a PDF. |
| `web_accessible_resources`: `viewer.html` for `<all_urls>` | A PDF link can be on any website, and Chrome only lets a website's link (or the redirect rule acting on it) open an extension page that is listed here. Only the reader page is listed. The reader loads only a PDF the tab really opened (see `webRequest`), so a website cannot use it to read anything. |
| `content_security_policy`: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` | All code is in the package. `'wasm-unsafe-eval'` lets the bundled WebAssembly run: the PDF engine, the library's database and the on-device text recognition for scanned pages. No remote code and no `eval` of text. |
| `cross_origin_embedder_policy: require-corp` and `cross_origin_opener_policy: same-origin` | Makes the extension's own pages "cross-origin isolated", which Chrome requires before WebAssembly can use several threads. The on-device text recognition for scanned pages uses this to read pages several times faster. It changes nothing on websites. |
| `incognito: split` | In Incognito the reader opens PDFs as usual but never saves anything, so it runs as a separate copy there. |
| `minimum_chrome_version: 128` | The rule that spots PDFs by the content type a website sends needs Chrome 128 or later. |

**Remote code:** No. Every script, font and model is in the package. A build check (`check-no-cdn`) and `verify-zip` fail on anything that loads code from the internet.


## Privacy & Data Use

The extension has no server of its own and the developer receives nothing. Data leaves the computer only in the cases below, each started by the user. The answers below match the privacy policy.

| What | Goes to | When |
| --- | --- | --- |
| The PDF request itself | The website the PDF comes from | When the user opens a PDF, exactly as in Chrome |
| Passages and figure pictures the user asks about | Anthropic (the Claude API), with the user's own API key | Only when the user asks Claude. Never for a PDF that looks private. On a PDF the user did not save, only after the user presses Send |
| Claude's web searches | Anthropic's web search | Only while answering a question that needs the web; can be switched off in Settings |
| The API key, when the user checks it | Anthropic | Only when the user presses "Check and save" or "Check again" in Settings → Claude |
| A saved paper's DOI or arXiv number, and nothing else | Crossref or arXiv | Only if the user turns on online lookups (off at first) |
| Words the user chooses to search for | Google or Google Scholar, in a new tab | Only when the user presses Search |
| Saved readings, their PDFs and notes | The user's own cloud server | Only after the user connects one (Settings → Cloud) |
| The address of the page the user saves | That website (to fetch the page's pictures) | Only when the user clicks "Save this page to library" |
| Anything else | Nobody | Never |

### Data Collection

**Does the extension collect user data?** Yes. Nothing reaches the developer, but the store counts data the extension sends on the user's request to a service the user chose, so these are declared.

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Personally identifiable info | No | No | — | No |
| Health info | No | No | — | No |
| Financial info | No. The learning filter looks for card and bank numbers in memory only, so that such PDFs are never saved. | No | — | No |
| Authentication info | Yes: the user's own Anthropic API key, and the sign-in for the user's own cloud server if connected. Kept in a private store on this computer, never in backups, exports or sync. | Yes: the key to Anthropic only, to authorise the user's own Claude requests; the sign-in to the user's own server only | Ask Claude; cloud sync | Only with Anthropic, at the user's request |
| Personal communications | No | No | — | No |
| Location | No | No | — | No |
| Web history | Yes: the address of each saved PDF, and when it was read, kept in the library on this computer. Addresses of PDFs that are not saved are not kept. | Only to the user's own cloud server, if connected | The library's reading history and "Open where you stopped" | No |
| User activity | No | No | — | No |
| Website content | Yes: saved PDFs, their text and the user's notes, on this computer. | Yes: passages and figures the user asks Claude about go to Anthropic; saved readings go to the user's own cloud server, if connected | Ask Claude; cloud sync | Only with Anthropic, at the user's request |

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes


## Privacy Policy

**Privacy Policy URL** [REQUIRED]
https://sickofpdfs-site.rexheng-policy.workers.dev/privacy

The page's words live in `apps/site/src/pages/privacy.ts`. They must say the same as "Privacy & Data Use" above; change both together. The page was live (HTTP 200) on 2026-11-10; the wording updated on that date goes live with the next site deploy.


## Distribution

**Visibility**: Public (start as Unlisted for the owner's own first install, then switch to Public)
**Regions**: All regions

## Developer Info

**Publisher Name** [REQUIRED]
sickofpdfs

**Contact Email** [REQUIRED]
The same address as the privacy page's contact (`CONTACT_EMAIL` in `apps/site/wrangler.jsonc`). It must be checked often: Google sends takedown and policy notices there.

**Support URL / Email** [RECOMMENDED]
https://sickofpdfs-site.rexheng-policy.workers.dev

**Homepage URL** [RECOMMENDED]
https://sickofpdfs-site.rexheng-policy.workers.dev


## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.0.0 ("Release 1") | 2026-11-10 | First store release: the reader, the five marks, comments, the library and its learning filter, backup and restore, @Claude with the user's own key, scanned-page text, page reordering. Earlier test builds (0.1.N) were installed by hand and never went to the store. | Draft |

<!-- Status options: Draft | Submitted | In Review | Published | Rejected -->


## Review Notes

### First upload (keeps the extension's id)
The extension has a fixed id (`donjaoofgenmbfgfcefnmlgmhiffbglk`) from its own key. The cloud sign-in and sync server are tied to that id, so the store copy must keep it.
1. Run `pnpm release:zip --store`. It makes `dist/sickofpdfs-1.0.0-store.zip` without the manifest's `key` (the store refuses a manifest with one) and without HOW-TO-UPDATE.txt.
2. For the very first upload only: copy the private key file into the top level of that zip, named `key.pem`. The store then gives the extension the same id. Only the owner does this; the key never goes in the repo or in chat.
3. Upload. After the first upload, never add `key.pem` again.
4. Check that the dashboard shows the id `donjaoofgenmbfgfcefnmlgmhiffbglk`.

### Moving the owner's own copy to the store version
The hand-installed test build and the store version share the id, so Chrome cannot have both. Removing an extension deletes its library.
1. In the test build, run "Back up now" (or "Export library") and check the backup folder has the readings.
2. Remove the test build, install from the store, then use "Restore from backup". Settings are not restored (R101), so set them again.

### Known Issues / Limitations
- Broad host permissions (`http://*/*`, `https://*/*`) are needed because PDFs come from any website. Expect an in-depth review that takes longer than usual.
- PDFs on the computer need "Allow access to file URLs" switched on; the reader shows a dialog with the button to the right Chrome page when it is off.
- Files over 1 GiB open in Chrome's own viewer.
- Cloud sync is for the owner only for now; other users see a waitlist and a "Connect my own server" link.

### Rejection History
<!--
| Date | Reason | Fix Applied | Resubmitted |
|------|--------|-------------|-------------|
-->
