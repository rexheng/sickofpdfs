// Writes fixtures/out/forms/*.pdf (pdf-lib, Letter, two pages each) for P0-7. The six fetched classifier PDFs hold
// no push button, no signature and only text fields, so these pin down the rule that the real files cannot:
//   empty-acroform.pdf
//                    three pages with no annotations and an /AcroForm with no fields, as hyperref writes (one form-fill
//                    environment per call and nothing else to open, so it isolates what the walk leaks of its own).
//   type-<kind>.pdf  page 1 has a push button, page 2 has one field of <kind>: checkbox, radiobutton, combobox,
//                    listbox or textfield. Each must count (firstFillablePage 1), and the push button before it must not.
//   ignored.pdf      page 1 a push button, page 2 a signature field: an /AcroForm with widgets, but no fillable field.
//   orphan-widget.pdf
//                    page 1 a push button, page 2 a text field, but the /AcroForm /Fields array is empty: the widgets
//                    are on the pages and in no field tree. PDFium links them once a page is loaded.
//   xfa-foreground.pdf, xfa-full.pdf
//                    an /AcroForm with an /XFA entry, without and with /NeedsRendering true in the catalog
//                    (FPDF_GetFormType reads only those two).
//   node scripts/make-forms-fixture.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFBool, PDFDocument, PDFName, PDFString } from 'pdf-lib';

const OUT = fileURLToPath(new URL('../fixtures/out/forms/', import.meta.url));
const BOX = { x: 72, y: 650, width: 200, height: 28 };

/** A two-page document whose first page holds a push button. */
async function twoPages() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const pages = [doc.addPage([612, 792]), doc.addPage([612, 792])];
  doc.getForm().createButton('go').addToPage('Go', pages[0], BOX);
  return { doc, form: doc.getForm(), pages };
}

const KINDS = {
  textfield: ({ form, pages }) => form.createTextField('name').addToPage(pages[1], BOX),
  checkbox: ({ form, pages }) => form.createCheckBox('agree').addToPage(pages[1], BOX),
  radiobutton: ({ form, pages }) => {
    const group = form.createRadioGroup('choice');
    group.addOptionToPage('a', pages[1], BOX);
    group.addOptionToPage('b', pages[1], { ...BOX, y: 600 });
  },
  combobox: ({ form, pages }) => {
    const box = form.createDropdown('country');
    box.addOptions(['UK', 'US']);
    box.addToPage(pages[1], BOX);
  },
  listbox: ({ form, pages }) => {
    const list = form.createOptionList('colour');
    list.addOptions(['red', 'green']);
    list.addToPage(pages[1], { ...BOX, height: 60 });
  },
};

/** pdf-lib cannot make a signature field: write its widget dictionary and register it as page annotation and field. */
function addSignature({ doc, form, pages }) {
  const widget = doc.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('sig'), Rect: [72, 600, 272, 660], F: 4, P: pages[1].ref });
  const ref = doc.context.register(widget);
  pages[1].node.addAnnot(ref);
  form.acroForm.addField(ref);
}

function addXfa({ doc, form }, needsRendering) {
  const xdp = doc.context.register(doc.context.stream('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"/>'));
  form.acroForm.dict.set(PDFName.of('XFA'), doc.context.obj([PDFString.of('template'), xdp]));
  if (needsRendering) doc.catalog.set(PDFName.of('NeedsRendering'), PDFBool.True);
}

await mkdir(OUT, { recursive: true });
const files = [];
// updateFieldAppearances: false keeps the /XFA entry: by default save() deletes it, as pdf-lib cannot write XFA.
const write = async (name, doc, options = {}) => {
  const bytes = await doc.save(options);
  await writeFile(join(OUT, name), bytes);
  files.push(`${name} (${bytes.length} bytes)`);
};
for (const [kind, add] of Object.entries(KINDS)) {
  const parts = await twoPages();
  add(parts);
  await write(`type-${kind}.pdf`, parts.doc);
}
{
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (let k = 0; k < 3; k++) doc.addPage([612, 792]);
  doc.getForm(); // makes the empty /AcroForm
  await write('empty-acroform.pdf', doc);
}
{
  const parts = await twoPages();
  addSignature(parts);
  await write('ignored.pdf', parts.doc);
}
{
  const parts = await twoPages();
  KINDS.textfield(parts);
  parts.form.acroForm.dict.set(PDFName.of('Fields'), parts.doc.context.obj([]));
  await write('orphan-widget.pdf', parts.doc);
}
for (const [name, needsRendering] of [['xfa-foreground.pdf', false], ['xfa-full.pdf', true]]) {
  const parts = await twoPages();
  addXfa(parts, needsRendering);
  await write(name, parts.doc, { updateFieldAppearances: false });
}
console.log(`forms/: ${files.join(', ')}`);
