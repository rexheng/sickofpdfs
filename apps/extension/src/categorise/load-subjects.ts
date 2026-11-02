// The bundled academic subjects with their meaning vectors, for naming topics (R92b). If the stored vectors do not match the list (they
// always do in a build, which checks them), there are no subjects and topics are named by their most telling phrases instead.
import { SUBJECT_NAMES, type Subject } from '@sop/core';
import { decodeSubjectVector, SUBJECT_VECTORS } from './subject-vectors';

export function loadSubjects(): Subject[] {
  if (SUBJECT_VECTORS.length !== SUBJECT_NAMES.length) return [];
  return SUBJECT_NAMES.map((name, i) => ({ name, vector: decodeSubjectVector(SUBJECT_VECTORS[i]) }));
}
