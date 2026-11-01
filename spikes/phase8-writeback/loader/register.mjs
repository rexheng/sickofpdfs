// Registers the resolver hook so Node can run the repo's TypeScript (extensionless relative imports) directly.
import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
