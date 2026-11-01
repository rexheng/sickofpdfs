// The fixture server's `/mock` route (interface file: e2e/support/server.ts gains `mockPath(o)`; "the route answers exactly as
// described: a contentLength with no body sends headers, then holds the socket"). Reached through a namespace import so that
// this file still loads, and fails with a clear message, on a tree where Task 20 has not added it yet.
import * as serverModule from '../../support/server';

export interface MockOptions {
  status?: number;
  contentType?: string;
  contentLength?: number;
  body?: string;
  chunked?: boolean;
  bytes?: number;
}

/** The address of a `/mock` answer described by `o`, on the fixture server `server`. */
export function mockUrl(server: { url(path: string): string }, o: MockOptions): string {
  const mockPath = (serverModule as unknown as { mockPath?: (o: MockOptions) => string }).mockPath;
  if (typeof mockPath !== 'function') throw new Error("e2e/support/server.ts does not export mockPath() (the interface file says Task 20 adds it, with the /mock route)");
  return server.url(mockPath(o));
}
