/**
 * What the viewer publishes about itself for tests to read. Production code writes here with `publishRuntime`;
 * nothing in this file is global, and nothing in production reads it. Later tasks add fields.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- the fields arrive with the features that publish them
export interface ViewerRuntime {}

let registry: Partial<ViewerRuntime> = {};

/** Merges `p` into the registry. */
export function publishRuntime(p: Partial<ViewerRuntime>): void {
  registry = { ...registry, ...p };
}

/** A copy of everything published so far. */
export function readRuntime(): Partial<ViewerRuntime> {
  return { ...registry };
}
