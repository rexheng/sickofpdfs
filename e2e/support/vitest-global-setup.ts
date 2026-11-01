// The Vitest browser project's global setup: starts the e2e fixture server (Task 12's startFixtureServer, with the
// loader's /mock route) and gives tests its origin as `inject('fixtureOrigin')`.
import type { TestProject } from 'vitest/node';
import { startFixtureServer } from './server';

declare module 'vitest' {
  export interface ProvidedContext {
    /** `http://127.0.0.1:<port>` of the fixture server. */
    fixtureOrigin: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const server = await startFixtureServer();
  project.provide('fixtureOrigin', server.origin);
  return () => server.close();
}
