// The bundled academic subjects and broad fields with their meaning vectors, for naming topics (R92b, R92d). If the stored vectors do not match
// the lists (they always do in a build, which checks them), there are none and topics are named by their most telling phrases instead.
import { FIELD_NAMES, SUBJECT_FIELD, SUBJECT_NAMES, type Field, type Subject } from '@sop/core';
import { decodeSubjectVector, FIELD_VECTORS, SUBJECT_VECTORS } from './subject-vectors';

export function loadSubjects(): Subject[] {
  if (SUBJECT_VECTORS.length !== SUBJECT_NAMES.length) return [];
  return SUBJECT_NAMES.map((name, i) => ({ name, vector: decodeSubjectVector(SUBJECT_VECTORS[i]), ...(SUBJECT_FIELD[name] === undefined ? {} : { field: SUBJECT_FIELD[name] }) }));
}

export function loadFields(): Field[] {
  if (FIELD_VECTORS.length !== FIELD_NAMES.length) return [];
  return FIELD_NAMES.map((name, i) => ({ name, vector: decodeSubjectVector(FIELD_VECTORS[i]) }));
}
