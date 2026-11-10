// R108: a saved reading's page order lives in the settings row `pageOrder.of.<sha>` (@sop/core/page-order), so backups
// and sync carry it with no schema change. A settings row does not hang off `documents`, so nothing cascades: the
// transactions that forget readings (Forget, an Undo of a save, the Trash purge) call this, as they do for the courses'
// `course.of.<sha>` rows, and no fingerprint of a forgotten PDF stays in the settings.
import { pageOrderKey } from '@sop/core';
import type { SqlDb } from './schema-v2';

/** Deletes the page order rows of these readings, and every outbox entry for them. Call it inside the forgetting transaction. */
export function forgetPageOrders(tx: SqlDb, documentIds: readonly string[]): void {
  if (documentIds.length === 0) return;
  const keys = JSON.stringify(documentIds.map(pageOrderKey));
  tx.exec({ sql: 'DELETE FROM settings WHERE key IN (SELECT value FROM json_each(?))', bind: [keys] });
  tx.exec({ sql: `DELETE FROM outbox WHERE table_name = 'settings' AND row_id IN (SELECT value FROM json_each(?))`, bind: [keys] });
}
