// Settings → Library rules: how many files the owner chose "Never save this file" for. Only the count is read: the list
// holds salted fingerprints, which name nothing. The settings folder may reach the local-only store (eslint.config.mjs,
// ruling R14); this file reads one number from it and nothing else.
import { LOCAL_ONLY_DB, type LocalOnlyStore, openLocalOnlyStore } from '../../local-only/secrets-store';

let opened: Promise<LocalOnlyStore> | null = null;

/** Whether the local-only database exists: reading a count must not create it (nothing was ever chosen then). */
async function exists(): Promise<boolean> {
  try {
    return (await indexedDB.databases()).some((db) => db.name === LOCAL_ONLY_DB);
  } catch {
    return true; // cannot tell: open it (an empty one holds nothing)
  }
}

/** The number of files kept as "Never save this file"; 0 when there are none, or in Incognito (nothing is kept there). */
export async function neverSaveCount(): Promise<number> {
  if (chrome.extension.inIncognitoContext || !(await exists())) return 0;
  opened ??= openLocalOnlyStore();
  try {
    return await (await opened).countNeverSave();
  } catch (e) {
    opened = null;
    throw e;
  }
}
