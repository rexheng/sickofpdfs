// The bundled list of academic subjects a topic can be named after (spec R92b). About 300 names drawn from common university course
// catalogues: economics, mathematics, statistics, computer science, the sciences, engineering, the social sciences, law, business and the
// humanities. The names are in `subjects.json` (plain JSON, one array of names). Their meaning vectors are made at build time with the
// bundled MiniLM, the way the filter's reference sentences are (apps/extension/scripts/minilm-subjects.mjs, which also checks them), and
// live in apps/extension/src/categorise/subject-vectors.ts.
import list from './subjects.json' with { type: 'json' };

export const SUBJECT_NAMES: readonly string[] = list;
