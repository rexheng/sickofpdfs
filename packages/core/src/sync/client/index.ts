// @sop/core/sync-client: what every sync client shares (contracts CA11). The sync API over `fetch`, the sign-in steps, and one
// push-then-pull round over a local store. Platform specifics (opening the sign-in page, keeping tokens, scheduling) stay in
// each app's thin adapter: the extension's token broker and offscreen engine, the Android app's shell.
export * from './http';
export * from './oauth';
export * from './round';
export * from './transfer';
export * from './engine';
