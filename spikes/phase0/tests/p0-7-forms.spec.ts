import { expect } from '@playwright/test';
import { hasFillableFields } from '../src/engine/spike-native';
import { test, type FormsPageResult } from './fixtures';
import { record } from './record';

// The brief's P0-7 tests, with their assertions unchanged. Each test writes its measurements with record() before
// asserting, so a failing run keeps them. Fixtures: `fixtures` (the six classifier PDFs, SHA-256 checked).
const brief = (i: FormsPageResult) =>
  `formType ${i.formType}, firstFillablePage ${i.firstFillablePage}, ${i.pagesWalked}/${i.pageCount} pages walked, ` +
  `widgets ${JSON.stringify(i.widgetTypes)}, ${i.elapsedMs} ms`;

// The four learning fixtures whose /AcroForm holds no fields (hyperref-style; see docs/research/04 §B.2)
const NOT_FORMS = ['nber-w29000', 'lse-cep-dp1800', 'nature-s41586-021-03819-2-alphafold', 'lecture-notes-mit-6.006-lec1'];
for (const f of NOT_FORMS) {
  test(`P0-7 ${f}: AcroForm flag but not a form`, async ({ formsPage }) => {
    const i = await formsPage(`learning/${f}.pdf`);
    await record('P0-7', {
      pass: i.formType === 'acroform' && !hasFillableFields(i),
      measured: `${f}: ${brief(i)}, fillable ${hasFillableFields(i)}`,
    });
    expect(i.formType).toBe('acroform');
    expect(hasFillableFields(i)).toBe(false);
  });
}
test('P0-7 HMRC SA100 (4 real text fields) is a form', async ({ formsPage }) => {
  const i = await formsPage('not-learning/tax-form-hmrc-sa100-2026.pdf');
  await record('P0-7', {
    pass: i.firstFillablePage !== null && hasFillableFields(i),
    measured: `HMRC SA100: ${brief(i)}, fillable ${hasFillableFields(i)}`,
  });
  expect(i.firstFillablePage).not.toBeNull();
  expect(hasFillableFields(i)).toBe(true);
});
test('P0-7 IRS W-9 (XFA + fields) is a form', async ({ formsPage }) => {
  const i = await formsPage('not-learning/tax-form-irs-w9.pdf');
  await record('P0-7', {
    pass: hasFillableFields(i),
    measured: `IRS W-9: ${brief(i)}, fillable ${hasFillableFields(i)}`,
  });
  expect(hasFillableFields(i)).toBe(true);
});
test('P0-7 detection on the 133-page NBER paper takes < 200 ms', async ({ formsPage }) => {
  const i = await formsPage('learning/nber-w29000.pdf');
  await record('P0-7', {
    pass: i.elapsedMs < 200,
    measured: `NBER w29000 (133 pages): detection ${i.elapsedMs} ms, ${i.pagesWalked} pages walked`,
  });
  expect(i.elapsedMs).toBeLessThan(200);
});

// Additions to the brief: the six real PDFs hold no push button, no signature and no choice field, so pdf-lib
// documents (`fixtures` runs scripts/make-forms-fixture.mjs, fixtures/out/forms/) pin the field-type rule and the
// form-type mapping, and a repeat run shows the walk closes everything it opens.
const FILLABLE_KINDS = { textfield: 'TEXTFIELD', checkbox: 'CHECKBOX', radiobutton: 'RADIOBUTTON', combobox: 'COMBOBOX', listbox: 'LISTBOX' };
for (const [kind, type] of Object.entries(FILLABLE_KINDS)) {
  test(`P0-7 ${type} counts, and the push button before it does not`, async ({ formsPage }) => {
    const i = await formsPage(`type-${kind}.pdf`, 'forms');
    await record('P0-7', {
      pass: i.formType === 'acroform' && i.firstFillablePage === 1 && !!i.widgetTypes[type] && i.widgetTypes.PUSHBUTTON === 1,
      measured: `pdf-lib ${kind} (push button on page 1, field on page 2): ${brief(i)}`,
    });
    expect(i.formType).toBe('acroform');
    expect(i.widgetTypes.PUSHBUTTON).toBe(1); // seen on page 1, and skipped
    expect(i.widgetTypes[type]).toBeGreaterThanOrEqual(1);
    expect(i.firstFillablePage).toBe(1);
    expect(hasFillableFields(i)).toBe(true);
  });
}
test('P0-7 push buttons and signatures alone make no form', async ({ formsPage }) => {
  const i = await formsPage('ignored.pdf', 'forms');
  await record('P0-7', {
    pass: i.formType === 'acroform' && i.firstFillablePage === null && !hasFillableFields(i) && i.widgetTypes.PUSHBUTTON === 1 && i.widgetTypes.SIGNATURE === 1,
    measured: `pdf-lib push button + signature: ${brief(i)}, fillable ${hasFillableFields(i)}`,
  });
  expect(i.widgetTypes).toEqual({ PUSHBUTTON: 1, SIGNATURE: 1 }); // both were seen, neither counts
  expect(i.firstFillablePage).toBeNull();
  expect(hasFillableFields(i)).toBe(false);
});
test('P0-7 a widget missing from /Fields still counts: PDFium links it when the page loads', async ({ formsPage }) => {
  const i = await formsPage('orphan-widget.pdf', 'forms');
  await record('P0-7', {
    pass: i.formType === 'acroform' && i.firstFillablePage === 1 && !i.widgetTypes.NO_FIELD,
    measured: `pdf-lib widgets outside /Fields: ${brief(i)}`,
  });
  expect(i.widgetTypes).toEqual({ PUSHBUTTON: 1, TEXTFIELD: 1 });
  expect(i.firstFillablePage).toBe(1);
});
test('P0-7 form types: none, XFA foreground and XFA full', async ({ formsPage }) => {
  const none = await formsPage('paper-50.pdf', '');
  const foreground = await formsPage('xfa-foreground.pdf', 'forms');
  const full = await formsPage('xfa-full.pdf', 'forms');
  await record('P0-7', {
    pass: none.formType === 'none' && foreground.formType === 'xfa-foreground' && full.formType === 'xfa-full' && [foreground, full].every(hasFillableFields) && !hasFillableFields(none),
    measured: `no /AcroForm (paper-50): ${none.formType}; /XFA: ${foreground.formType}; /XFA + /NeedsRendering: ${full.formType}; ${[none, foreground, full].map((i) => i.pagesWalked).join('/')} pages walked`,
  });
  expect([none.formType, foreground.formType, full.formType]).toEqual(['none', 'xfa-foreground', 'xfa-full']);
  expect(hasFillableFields(none)).toBe(false);
  expect(hasFillableFields(foreground) && hasFillableFields(full)).toBe(true);
  expect([none, foreground, full].map((i) => i.pagesWalked)).toEqual([0, 0, 0]); // only an acroform is walked
});
// The heap does not shrink, so a leak is read from the bytes in use (an estimate: heapInUse in spike-native.ts) over many calls.
const growth = (l: { inUseBefore: number; inUseAfter: number }) => l.inUseAfter - l.inUseBefore;
// Measured with the form-fill environment left open (+132 bytes a call), its info struct left open (+148) and both (+275)
// against +6 when closed (Node probe, 5,000 calls), so 40 bytes a call tells them apart.
const ENV_LEAK_LIMIT_PER_CALL = 40;
test('P0-7 the walk closes its form-fill environment: nothing grows over repeated calls', async ({ spikePage, server }) => {
  // empty-acroform.pdf opens nothing but the environment (no annotations), so growth here would be ours.
  const r = await spikePage({ check: 'forms', file: server.url('forms/empty-acroform.pdf'), repeat: 20_000 }, { timeout: 110_000 });
  const perCall = growth(r.leak) / r.leak.repeat;
  await record('P0-7', {
    pass: r.formType === 'acroform' && !hasFillableFields(r) && r.rawAnnotsOpened === 0 && perCall <= ENV_LEAK_LIMIT_PER_CALL,
    measured: `empty /AcroForm (${r.pageCount} pages, no annotations) ×${r.leak.repeat + 1}: wasm heap in use ${r.leak.inUseBefore} → ${r.leak.inUseAfter} bytes (${growth(r.leak)} = ${perCall.toFixed(1)} bytes a call)`,
  });
  expect(r.formType).toBe('acroform');
  expect(hasFillableFields(r)).toBe(false); // an AcroForm with no fields: the hyperref case, with nothing else in it
  expect(r.rawAnnotsOpened).toBe(0);
  expect(perCall).toBeLessThanOrEqual(ENV_LEAK_LIMIT_PER_CALL);
});
// EPDFPage_GetAnnotRaw leaks 130–240 bytes an annotation, though FPDFPage_CloseAnnot closes each one (a Node probe of the
// same wasm: close frees 63 of ~196 bytes, a page-based annotation leaks nothing, and the rest stays after the document
// closes). It is the engine's, not ours to fix, and the walk reads each annotation once a document. This test keeps the
// rate in the report and fails if it grows past 400 bytes an annotation.
const RAW_ANNOT_LEAK_LIMIT = 400;
test('P0-7 annotations read raw leak under 400 bytes each (EmbedPDF 2.15.1 defect, measured)', async ({ spikePage, server }) => {
  const r = await spikePage({ check: 'forms', file: server.url('classifier/learning/nber-w29000.pdf'), repeat: 100 }, { timeout: 110_000 });
  const perAnnot = Math.round(growth(r.leak) / (r.leak.repeat * r.rawAnnotsOpened));
  await record('P0-7', {
    pass: perAnnot <= RAW_ANNOT_LEAK_LIMIT,
    measured:
      `EPDFPage_GetAnnotRaw leak on NBER (${r.rawAnnotsOpened} annotations a call, ×${r.leak.repeat} calls): wasm heap in use +${growth(r.leak)} bytes = ${perAnnot} bytes an annotation, ` +
      `${Math.round(growth(r.leak) / r.leak.repeat)} bytes for the one call a document gets`,
  });
  expect(r.rawAnnotsOpened).toBeGreaterThan(1000);
  expect(perAnnot).toBeLessThanOrEqual(RAW_ANNOT_LEAK_LIMIT);
});
