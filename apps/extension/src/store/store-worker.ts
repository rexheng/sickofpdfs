// The store worker: the one owner of the library database. The offscreen document starts it and hands it ports; it
// serves every port, one request at a time, and announces each committed change on the changes channel.
// What it does is shared with the phone app's store worker (store-host.ts); here the database is always SQLite in OPFS
// (the SAH pool).
//
// It never imports the secrets store (ruling R14): the database, backups and sync must never be able to read a secret.
import { openPool, serveStore } from './store-host';
import { DB_FILE } from './transport';

serveStore(async (sqlite3) => {
  const pool = await openPool(sqlite3);
  return { db: new pool.OpfsSAHPoolDb(DB_FILE) };
});
