// CL8 · For the workflows: `node scripts/env-info.mjs --env staging url` prints that Worker's address; `… ready` fails with a
// plain message when the environment has not been bootstrapped yet (placeholder ids left in wrangler.jsonc).
import { arg, envConfig } from './cloud-env.mjs';

const envName = arg('env');
const what = process.argv[process.argv.length - 1];
const cfg = envConfig(envName);
if (what === 'url') console.log(cfg.vars.PUBLIC_URL);
else if (what === 'ready') {
  if (JSON.stringify(cfg).includes('REPLACE_AT_BOOTSTRAP')) {
    console.error(`${envName} is not set up yet: run the "Bootstrap cloud" workflow first.`);
    process.exit(1);
  }
  console.log(`${envName} is set up: ${cfg.vars.PUBLIC_URL}`);
} else {
  console.error('usage: node scripts/env-info.mjs --env <staging|production> url|ready');
  process.exit(2);
}
