import type { FormInfo } from './types';

/**
 * Phase 1 treats a PDF as a form when it is XFA, or has a widget a person can fill in. A bare /AcroForm does not count:
 * LaTeX's hyperref adds one to most papers (P0-7).
 *
 * What counts as fillable (getFormInfo's walk): check boxes, radio buttons, combo boxes, list boxes and text fields.
 * These do not count: push buttons and signature fields; a field marked read-only (field flag ReadOnly, or the
 * widget's annotation flag ReadOnly), because nobody can type in it; and a widget marked Hidden or NoView, because
 * nobody can see it. So a document whose only fields are read-only or hidden is not a form.
 */
export function hasFillableFields(info: Pick<FormInfo, 'formType' | 'firstFillablePage'>): boolean {
  return info.formType.startsWith('xfa') || info.firstFillablePage !== null;
}
