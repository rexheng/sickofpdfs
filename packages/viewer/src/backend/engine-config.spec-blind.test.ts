// Spec-blind unit tests for the pure parts of the PdfBackend module (Task 15): the Phase 0 decision as code, the asset
// URL mapping and the fillable-form rule. Node environment: nothing here may need a Worker or a DOM.
import { describe, expect, it } from 'vitest';
import { ENGINE_WORKERS } from './engine-config';
import { hasFillableFields } from './forms';
import type { FormInfo } from './types';
import { engineAssets } from './embedpdf/assets';

describe('engine decisions (docs/spikes/phase0-report.md, Decision)', () => {
  it('ENGINE_WORKERS is 1: two workers were not faster on the 4-core runner (R25)', () => {
    expect(ENGINE_WORKERS).toBe(1);
  });
});

describe('engineAssets', () => {
  // Interface file: { wasmUrl: resolve('pdf/pdfium.wasm'), fontBaseUrl: resolve('pdf/') }. The extension passes
  // chrome.runtime.getURL; every engine file, font and model ships inside the extension and nothing is downloaded.
  it.each([
    { name: 'an extension URL', resolve: (p: string) => `chrome-extension://abcdefghijklmnop/${p}`, wasm: 'chrome-extension://abcdefghijklmnop/pdf/pdfium.wasm', fonts: 'chrome-extension://abcdefghijklmnop/pdf/' },
    { name: 'a dev-server URL', resolve: (p: string) => `http://localhost:5173/apps/extension/public/${p}`, wasm: 'http://localhost:5173/apps/extension/public/pdf/pdfium.wasm', fonts: 'http://localhost:5173/apps/extension/public/pdf/' },
    { name: 'a relative path', resolve: (p: string) => `/${p}`, wasm: '/pdf/pdfium.wasm', fonts: '/pdf/' },
  ])('maps through the resolver ($name)', ({ resolve, wasm, fonts }) => {
    expect(engineAssets(resolve)).toEqual({ wasmUrl: wasm, fontBaseUrl: fonts });
  });

  it('never points at a CDN, whatever the resolver does', () => {
    const urls = Object.values(engineAssets((p) => `chrome-extension://id/${p}`));
    for (const u of urls) expect(u).not.toMatch(/jsdelivr|unpkg|cdnjs|https?:/);
  });
});

describe('hasFillableFields', () => {
  // Spec ("Forms"): real fillable fields (text boxes, choices, checkboxes) or XFA make a form; the link boxes LaTeX adds do not.
  // Phase 0 P0-7: hyperref papers read as `acroform` with no fillable page; an XFA form is never walked, so its first
  // fillable page stays null, and it still counts.
  const CASES: { name: string; info: FormInfo; expected: boolean }[] = [
    { name: 'no /AcroForm at all', info: { formType: 'none', firstFillablePage: null }, expected: false },
    { name: 'an empty /AcroForm (hyperref)', info: { formType: 'acroform', firstFillablePage: null }, expected: false },
    { name: 'a text field on the first page (page index 0 is a page, not "none")', info: { formType: 'acroform', firstFillablePage: 0 }, expected: true },
    { name: 'a field on the third page (HMRC SA100)', info: { formType: 'acroform', firstFillablePage: 2 }, expected: true },
    { name: 'XFA foreground form (IRS W-9)', info: { formType: 'xfa-foreground', firstFillablePage: null }, expected: true },
    { name: 'XFA full form', info: { formType: 'xfa-full', firstFillablePage: null }, expected: true },
  ];
  it.each(CASES)('$name', ({ info, expected }) => {
    expect(hasFillableFields(info)).toBe(expected);
  });
});
