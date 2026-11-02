# Phase 3 hand check: the backup folder on Windows (W-B1 to W-B3)

This takes about 30 minutes. You need a Windows PC with Chrome, the built extension loaded, and (for checks B and C) **Google Drive for desktop** and **OneDrive**.

Why you are doing this: the test box has no real Chrome window, so it cannot press Chrome's "choose a folder" button. The tests use a stand-in folder instead. Only you can check the real thing: a real folder, a real restart, and a real Drive folder.

What the backup should do:

- You choose a folder once. The backup goes in a folder named `sickofpdfs-backup` inside it.
- It runs every night, and after you take notes.
- If Chrome stops letting the extension write to the folder, the toolbar icon shows a red **!** and the library shows **Backup is waiting. Click to allow.** One click brings it back.

Fill in the answers as you go. A word or a tick is enough. At the end, send the table back.

## Before you start

1. Open `chrome://extensions`, switch on Developer mode, **Load unpacked**, and choose the extension folder. Pin the extension.
2. Open one PDF from the web (a paper is fine). Select a sentence, press **Ctrl+Alt+M** and type a short note. Check that the PDF is in your library.
3. Make three empty folders to test with:
   - `Documents\sickofpdfs-test`
   - a sub-folder in Google Drive for desktop, for example `G:\My Drive\sickofpdfs-test`
   - a sub-folder in OneDrive, for example `C:\Users\<you>\OneDrive\sickofpdfs-test`

## Check A (W-B1): pick a folder, restart Chrome, see what Chrome remembers

1. Open the library, then **Settings → Backup → Choose folder**. Pick `Documents\sickofpdfs-test`.
2. Chrome asks whether the extension may edit files in that folder. **Write down the exact words and the buttons.** Is there a button that says **Allow on every visit**? Choose it if it is there, and say so. Otherwise choose the button that allows editing.
3. Wait for the first backup. Settings shows a line such as "Today at 2:05 pm · 3 MB" and "1 reading, 1 note, 1 PDF".
4. Open the folder in Explorer. You should see `sickofpdfs-backup` with `manifest.json`, `library.json`, a `snapshots` folder with one file, a `pdf` folder and a `notes` folder. Open the `.md` file in `notes`. It should show your sentence and your note.
5. **Close Chrome completely.** Close every window, then check in Task Manager that no `chrome.exe` is left.
6. Open Chrome again and open the library. **Write down:**
   - Does the library show a red pill **Backup is waiting. Click to allow.**? (yes / no)
   - Does the toolbar icon show a red **!**? (yes / no)
   - If yes: click the pill. What does Chrome ask, in its own words? Does the backup run after you answer? (yes / no)
   - If no: Settings → Backup says "Today at ..." and **Back up now** works with no question. (yes / no)
7. Click **Back up now** once more. The line changes to the new time.

What we learn: whether Chrome keeps the folder allowed after a restart. The design works either way. This tells us how often you will see the pill.

## Check B (W-B2): a Google Drive for desktop folder

1. **Settings → Backup → Change folder**. Pick `G:\My Drive\sickofpdfs-test`. Chrome may refuse the very top folder of My Drive. If it refuses, pick a sub-folder. Write down what happened.
2. Wait for the backup. In a browser, open drive.google.com and look in the same folder.
3. Within 2 minutes you should see `sickofpdfs-backup` with the same files as before. **Write down how long it took.**
4. Chrome writes a file in two steps, so Drive may briefly show a temporary file ending in `.crswap` (and a PDF copy may show as `.pdf.part` until it is whole). That is harmless. **Write down if one stays after 5 minutes.** Each backup removes `.crswap` files that are more than a day old, and any `.part` file left by a backup that stopped.
5. In Drive, open `library.json` (Drive shows it as text). Check it has no sign of your API key (the key starts with `sk-ant`). If you have not entered a key yet, skip this step.

## Check C (W-B3): a OneDrive folder

1. Do the same as Check B with `C:\Users\<you>\OneDrive\sickofpdfs-test`.
2. Open onedrive.live.com and look for the files. **Write down how long it took, and anything odd** (a sync error, a locked file, a file that did not upload).

## Check D: forgetting a PDF removes it from the backup too

1. Open a second PDF, make a note on it, and click **Back up now**. Look in the backup folder: there are now two `.pdf` files under `pdf` and two files under `notes`.
2. In that PDF's viewer, choose **File → Forget this PDF** and confirm. The dialog should say **Removed from your library and your backups. Google Drive or OneDrive may keep their own copy in their trash for a while.**
3. Look in the folder again. The PDF's `.pdf` file and its notes file are gone. The other PDF's files, `library.json` and every file in `snapshots` are still there.
4. Open **every** file in `snapshots` with Notepad and search for the PDF's title. It must not be in any of them. Do the same in `library.json`. The other PDF's note must still be there.
5. On drive.google.com (or onedrive.live.com), look in the Trash. **Write down** whether the forgotten PDF's old files are there, and whether Drive keeps older versions of `library.json` (right-click → Manage versions). That is the cloud's own copy, which the dialog warns about.
6. Now the offline case. In Explorer, rename the backup folder `sickofpdfs-test` to `sickofpdfs-test-away`. Open a third PDF, make a note, click **Back up now**, then **Forget this PDF**. The dialog should say that your backup folder can't be reached yet and that it will be cleaned at the next backup.
7. Rename the folder back. Open the library and click **Back up now**. The third PDF's files are gone from the folder, and Settings no longer says anything is waiting to be removed.
8. The change-folder case. Forget a fourth PDF while the folder is renamed away (as in step 6), then **Settings → Backup → Change folder** and pick a new folder. Settings should say **1 removal is waiting for sickofpdfs-test**. Rename the old folder back and click **Try now**. The line goes, and the fourth PDF's files are gone from the old folder.

## Check E: catching up when a night was missed

1. Close Chrome in the evening. Open it the next morning and wait 5 minutes without opening any tab but the library.
2. Settings → Backup says **Last backup** with this morning's time. (The backup runs after 2:00 am, or as soon as Chrome opens if it was closed then.)

## Check F: export the whole library as a zip

1. **Settings → Backup → Export library.** Save the file on your desktop.
2. Right-click the zip and choose **Extract all**. Windows should open it without an error.
3. Open one PDF from the `pdf` folder inside. It is the same PDF you saved. Open the `.md` file in `notes`.

## Check G: restore on a fresh Chrome profile

1. In Chrome, click your profile picture and **Add** a new profile. In the new profile, load the extension (Check A, step 1 of "Before you start").
2. Open the library. It is empty.
3. **Settings → Restore from backup.** Pick the backup folder from Check A (or the Drive folder from Check B).
4. The dialog shows what the backup holds, for example "2 readings, 2 notes, 2 PDFs". Restore it.
5. The readings are back in the library. Open one. Your note is on the page. Ctrl+K finds words from the page once the library says it has finished indexing.
6. Restore the same folder a second time. Nothing changes.

## Check H: a folder that already holds another library's backup

This is a safety check. It must not overwrite anything.

1. In the new (empty) profile from Check G, **before** restoring, go to **Settings → Backup → Choose folder** and pick the folder that holds the backup from Check A.
2. The backup does **not** run. A pill **Backup needs a look** shows at the top, and the extension icon shows a red **!**. Hover the icon: it says the backup is on hold and why. Click the pill: a small card explains that the folder holds a backup that isn't from this library, with **Not now** and **Back up anyway**. Click **Not now**.
3. Look in the folder in Explorer. Every file is as it was. Nothing was removed.
4. Do not click **Back up anyway** unless you want to replace that backup. Choose **Turn off** instead.

## What to send back

| Check | Result (a word or a tick) | Anything odd |
| --- | --- | --- |
| A. Chrome's question when you picked the folder (exact words) | | |
| A. "Allow on every visit" offered? | | |
| A. After a restart: pill and badge shown? | | |
| A. After a restart: the question Chrome asked | | |
| B. Drive: top folder refused? | | |
| B. Drive: seconds until the files showed | | |
| B. Drive: a `.crswap` file stayed? | | |
| C. OneDrive: minutes until the files showed | | |
| C. OneDrive: anything odd | | |
| D. Forget removed the PDF and notes file | | |
| D. Forget left nothing in snapshots or `library.json` | | |
| D. Offline forget cleaned at the next backup | | |
| D. Drive or OneDrive trash keeps the forgotten files? | | |
| D. Change folder kept the waiting removal, and Try now finished it | | |
| E. Caught up in the morning | | |
| F. Zip opens in Windows and the PDF opens | | |
| G. Restore brought back readings, notes and PDFs | | |
| G. Second restore changed nothing | | |
| H. Another library's backup was left alone | | |
