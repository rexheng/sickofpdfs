// The broad field of each bundled subject (spec R92d): "Econometrics" is in Economics, "Computer Vision" in Artificial Intelligence. About 25
// fields. A reading that shares no exact subject with another joins its field's topic when two or more readings share that field.
// `subject-fields.json` maps every name of `subjects.json` to a field; the field vectors are made at build time like the subjects' are
// (apps/extension/scripts/minilm-subjects.mjs).
import map from './subject-fields.json' with { type: 'json' };

export const SUBJECT_FIELD: Readonly<Record<string, string>> = map;
/** The distinct fields, sorted: the order of their stored vectors. */
export const FIELD_NAMES: readonly string[] = [...new Set(Object.values(map))].sort();
