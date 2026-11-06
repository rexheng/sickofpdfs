# Release 1 hand check on Windows

About 60 minutes. You need a Windows PC, Chrome, the release zip, your Anthropic key (with a monthly spend limit) and Google Drive for desktop. Follow [SETUP.md](../../SETUP.md) for steps that are not repeated here.

Write a word or a tick in "Result / notes". If something is wrong, write what you saw.

| # | Check | Result / notes |
| --- | --- | --- |
| **Install** | | |
| 1 | Install from the release zip into a new folder, following SETUP.md steps 1 to 3. The library opens. | |
| 2 | Open the toolbar menu, click **Open library**. Home shows. | |
| **Double-click chain** | | |
| 3 | After SETUP.md step 4, double-click a PDF in Explorer. It opens in the sickofpdfs viewer. | |
| 4 | Click a PDF link on a web page. It opens in the viewer. | |
| **Keyboard layouts** (repeat for each: UK, US, DE, PL) | | |
| 5 | UK: select a sentence, press **Ctrl+Alt+M**, type a note, save. Typing the letter M in the note does not trigger it. | |
| 6 | US: the same. | |
| 7 | DE: the same. | |
| 8 | PL: the same. Also type a Polish letter in the note (for example ą). | |
| **@Claude** (your own key) | | |
| 9 | Settings, Claude: paste your key, press **Check and save**. It says saved. | |
| 10 | Ask a plain question about the page in a note. An answer arrives. | |
| 11 | Ask about a figure (select a chart). The answer describes it correctly. | |
| 12 | Ask something that needs the web. The answer shows its web sources. | |
| 13 | Press **Think harder** under an answer. A new answer arrives, labelled as thought harder. | |
| 14 | Add up the cost lines shown. Open Console, Usage. The two agree (small rounding is fine). Write both numbers. | |
| **Backup and restore** | | |
| 15 | Settings, Backup, **Choose folder**: a folder in Google Drive for desktop. Wait for the first backup. | |
| 16 | The folder in Explorer holds `sickofpdfs-backup` with your notes. Drive shows it syncing. | |
| 17 | Start a **fresh Chrome profile**, load the extension (SETUP.md steps 2 and 3). Settings, **Restore**, choose the Drive folder. | |
| 18 | Your library, marks and comments are back. A PDF opens with its notes. | |
| **Speed** | | |
| 19 | A 20-page paper opens and shows page 1 quickly, and scrolling feels smooth. | |
| 20 | A big PDF (hundreds of pages) opens and scrolls without freezing. | |
| 21 | Selecting text and marking it feels instant. Compared with Chrome's own viewer: same, better or worse? | |

## Sign-off

- [ ] Every row above is ticked, or its problem is written in the notes.
- [ ] I did not press **Remove** at any point.

Name: ______________  Date: ______________  Ready to publish: yes / no
