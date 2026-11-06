// "Save this page to library" (spec R103), the part that runs in the web page: it finds the article with Readability and
// turns it into plain data (article.ts), and later reads the article's pictures from the page itself.
//
// Rules this file keeps:
// - It runs only when the owner clicks "Save this page to library" (chrome.scripting, in the extension's own isolated world).
//   It never changes the page: Readability works on a copy of the document.
// - It sends nothing anywhere. Pictures come from the page: a loaded `<img>` is drawn onto a canvas; one the canvas may not
//   read (another site's picture) or that has not loaded yet is fetched the way the page itself would fetch it, from the
//   browser's cache when it is there. A picture that still cannot be read is left out, and the PDF says so.
// - It reads what the owner sees, signed in or not: the page's own document, never a fresh download of it.
import { Readability } from '@mozilla/readability';
import { type Article, type Block, bylineAuthors, type ImageRef, type ImageResult, type Inline, type ListItem, MAX_IMAGE_PX, type ReadResult, type TableRow } from './article';

/** Fewer letters than this is not an article (a sign-in page, a web app's screen). */
const MIN_ARTICLE_CHARS = 280;
/** A picture shown smaller than this (in CSS px, both ways) is an icon or an avatar, not part of the article. */
const MIN_PICTURE_PX = 48;
/** The attribute the copy of the document marks each `<img>` with: its index among the page's own pictures. */
const REF_ATTR = 'data-sop-img';
/** JPEG quality of a photo. */
const JPEG_QUALITY = 0.86;
/** A PNG bigger than this (as a data URL) is a photo after all: it is kept as a JPEG. */
const PNG_MAX_CHARS = 2_400_000;

/** Reads the article of the page this runs in. Never throws: a page it cannot make sense of has no article. */
export function readPage(doc: Document, live: readonly HTMLImageElement[]): ReadResult {
  try {
    if (doc.contentType === 'application/pdf') return { kind: 'pdf' };
    if (doc.body === null) return { kind: 'none' };
    const copy = doc.cloneNode(true) as Document;
    Array.from(copy.images).forEach((img, i) => img.setAttribute(REF_ATTR, String(i)));
    const parsed = new Readability<Node>(copy, { charThreshold: 500, serializer: (node) => node }).parse();
    const content = parsed?.content;
    const length = parsed?.textContent?.replace(/\s+/gu, ' ').trim().length ?? 0;
    // A copied document has no window, so its elements are recognised by their node type.
    if (parsed === null || content === null || content === undefined || content.nodeType !== 1 || length < MIN_ARTICLE_CHARS) return { kind: 'none' };
    const title = clean(parsed.title ?? '') || clean(doc.title) || hostOf(doc.URL);
    const byline0 = clean(parsed.byline ?? '') || null;
    const blocks = dropClutter(dropLeadingTitle(new Walker(doc, live).blocks(content as Element), title), byline0);
    if (!blocks.some((b) => b.kind === 'paragraph' || b.kind === 'list' || b.kind === 'quote')) return { kind: 'none' };
    const byline = byline0;
    const article: Article = {
      url: sourceLink(doc),
      title,
      byline,
      authors: bylineAuthors(byline),
      siteName: clean(parsed.siteName ?? '') || null,
      published: clean(parsed.publishedTime ?? '') || publishedFromMeta(doc),
      lang: clean(parsed.lang ?? '') || clean(doc.documentElement.lang) || null,
      blocks,
      words: (parsed.textContent ?? '').split(/\s+/u).filter(Boolean).length,
    };
    return { kind: 'article', article };
  } catch {
    return { kind: 'none' };
  }
}

const clean = (s: string): string => s.replace(/\s+/gu, ' ').trim();

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'Web page';
  }
}

/** The page's address without its `#…` part; its canonical link instead when that is on the same site (no tracking parts). */
function sourceLink(doc: Document): string {
  const here = new URL(doc.URL);
  here.hash = '';
  const canonical = doc.querySelector<HTMLLinkElement>('link[rel~="canonical"][href]')?.href;
  if (canonical !== undefined) {
    try {
      const c = new URL(canonical);
      if ((c.protocol === 'https:' || c.protocol === 'http:') && c.host === here.host) {
        c.hash = '';
        return c.href;
      }
    } catch {
      // a broken canonical link: the page's own address is used
    }
  }
  return here.href;
}

function publishedFromMeta(doc: Document): string | null {
  const meta = doc.querySelector<HTMLMetaElement>('meta[property="article:published_time"], meta[name="date"], meta[name="publish-date"], meta[itemprop="datePublished"]');
  const time = doc.querySelector<HTMLTimeElement>('time[datetime]');
  return clean(meta?.content ?? time?.dateTime ?? '') || null;
}

/** An `<h1>` at the very start that only repeats the title is not shown twice. */
function dropLeadingTitle(blocks: Block[], title: string): Block[] {
  const first = blocks[0];
  if (first?.kind !== 'heading') return blocks;
  const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const text = first.runs.map((r) => ('text' in r ? r.text : ' ')).join('');
  return words(text) === words(title) ? blocks.slice(1) : blocks;
}

/**
 * Lines the PDF's first page says already, or that are not the article: near the top, a short line naming the author ("By Jane
 * Smith, Environment correspondent · 5 November", "Posted on 28 October by Sam Okafor"); anywhere, a line that only says
 * "Advertisement".
 */
function dropClutter(blocks: Block[], byline: string | null): Block[] {
  const names = bylineAuthors(byline).map((n) => n.toLowerCase());
  return blocks.filter((b, i) => {
    if (b.kind !== 'paragraph') return true;
    const text = b.runs.map((r) => ('text' in r ? r.text : ' ')).join('').trim();
    if (/^(?:advertisement|advert|sponsored(?: content)?|ad|story continues below(?: advertisement)?)$/iu.test(text)) return false;
    if (i >= 5 || text.length > 160) return true;
    const lower = text.toLowerCase();
    return !(names.length > 0 && names.some((n) => lower.includes(n)) && /^(?:by|posted|written|published|updated)\b/iu.test(text));
  });
}

// ---- the article's elements as blocks ----

type Style = { bold?: boolean; italic?: boolean; code?: boolean; sup?: boolean; sub?: boolean; href?: string };

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'FORM', 'SVG', 'CANVAS', 'NAV', 'ASIDE', 'FOOTER', 'OBJECT', 'EMBED', 'AUDIO', 'SOURCE', 'TRACK', 'MAP', 'DIALOG']);
const BLOCK_TAGS = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'FIGURE',
  'TABLE', 'HR', 'DL', 'DT', 'DD', 'IFRAME', 'VIDEO', 'DETAILS', 'SUMMARY', 'ADDRESS', 'CENTER',
]);

class Walker {
  constructor(
    private readonly doc: Document,
    private readonly live: readonly HTMLImageElement[],
  ) {}

  /** The blocks of a container: inline content in a row becomes one paragraph, block elements their own blocks. */
  blocks(root: Element): Block[] {
    const out: Block[] = [];
    let runs: Inline[] = [];
    const flush = () => {
      const tidy = tidyRuns(runs);
      if (tidy.length > 0) out.push({ kind: 'paragraph', runs: tidy });
      runs = [];
    };
    for (const node of Array.from(root.childNodes)) {
      if (node.nodeType === 3) {
        runs.push({ text: node.textContent ?? '' });
        continue;
      }
      if (node.nodeType !== 1) continue;
      const el = node as Element;
      const tag = el.tagName.toUpperCase();
      if (SKIP.has(tag) || isHidden(el)) continue;
      if (tag === 'IMG' || tag === 'PICTURE') {
        const image = this.image(tag === 'IMG' ? (el as HTMLImageElement) : el.querySelector('img'));
        if (image !== null) {
          flush();
          out.push({ kind: 'figure', images: [image], caption: [] });
        }
        continue;
      }
      if (!BLOCK_TAGS.has(tag) && !containsBlock(el)) {
        // An inline element (a link, emphasis, code): its own style counts too.
        const box = this.doc.createElement('span');
        box.appendChild(el.cloneNode(true));
        runs.push(...this.inline(box, {}));
        continue;
      }
      flush();
      out.push(...this.block(el, tag));
    }
    flush();
    return out;
  }

  private block(el: Element, tag: string): Block[] {
    switch (tag) {
      case 'H1':
      case 'H2':
      case 'H3':
      case 'H4':
      case 'H5':
      case 'H6': {
        // A heading is bold already: the bold inside it is not marked again.
        const runs = tidyRuns(this.inline(el, {}).map((r) => (!('text' in r) ? r : withoutBold(r))));
        return runs.length === 0 ? [] : [{ kind: 'heading', level: Number(tag[1]) as 1 | 2 | 3 | 4 | 5 | 6, runs }];
      }
      case 'P':
        // Its text is one paragraph; a picture in it becomes a figure of its own.
        return this.blocks(el);
      case 'UL':
      case 'OL': {
        const items: ListItem[] = [];
        for (const li of Array.from(el.children)) {
          if (li.tagName.toUpperCase() !== 'LI' || isHidden(li)) continue;
          const blocks = this.blocks(li);
          if (blocks.length > 0) items.push({ blocks });
        }
        if (items.length === 0) return [];
        const start = Number(el.getAttribute('start') ?? '1');
        return [{ kind: 'list', ordered: tag === 'OL', start: Number.isFinite(start) ? start : 1, items }];
      }
      case 'DL': {
        const items: ListItem[] = [];
        for (const child of Array.from(el.children)) {
          const t = child.tagName.toUpperCase();
          if (t === 'DT') {
            const runs = tidyRuns(this.inline(child, { bold: true }));
            if (runs.length > 0) items.push({ blocks: [{ kind: 'paragraph', runs }] });
          } else if (t === 'DD') {
            const blocks = this.blocks(child);
            if (blocks.length > 0) items.push({ blocks: [{ kind: 'quote', blocks }] });
          }
        }
        return items.flatMap((i) => i.blocks);
      }
      case 'BLOCKQUOTE': {
        const blocks = this.blocks(el);
        return blocks.length === 0 ? [] : [{ kind: 'quote', blocks }];
      }
      case 'PRE': {
        const text = (el.textContent ?? '').replace(/\r\n?/gu, '\n').replace(/\t/gu, '    ').replace(/^\n+|\s+$/gu, '');
        return text === '' ? [] : [{ kind: 'code', text }];
      }
      case 'FIGURE':
        return this.figure(el);
      case 'TABLE':
        return this.table(el as HTMLTableElement);
      case 'HR':
        return [{ kind: 'rule' }];
      case 'IFRAME':
      case 'VIDEO': {
        const src = absolute(el.getAttribute('src') ?? el.querySelector('source')?.getAttribute('src') ?? '', this.doc);
        return src === null ? [] : [{ kind: 'paragraph', runs: [{ text: 'Video on the page: ', italic: true }, { text: shortLink(src), href: src }] }];
      }
      default:
        return this.blocks(el);
    }
  }

  private figure(el: Element): Block[] {
    const images: ImageRef[] = [];
    for (const img of Array.from(el.querySelectorAll('img'))) {
      const image = this.image(img);
      if (image !== null) images.push(image);
    }
    const captionEl = el.querySelector('figcaption');
    const caption = captionEl === null ? [] : tidyRuns(this.inline(captionEl, {}));
    if (images.length > 0) return [{ kind: 'figure', images, caption }];
    // A figure with no picture (a quote, a code sample, an embed): its content as blocks.
    const rest = Array.from(el.childNodes).filter((n) => n !== captionEl);
    const box = this.doc.createElement('div');
    for (const n of rest) box.appendChild(n.cloneNode(true));
    const blocks = this.blocks(box);
    if (caption.length > 0) blocks.push({ kind: 'paragraph', runs: caption.map((r) => ('text' in r ? { ...r, italic: true } : r)) });
    return blocks;
  }

  private table(el: HTMLTableElement): Block[] {
    const rows: TableRow[] = [];
    for (const tr of Array.from(el.rows)) {
      const cells = Array.from(tr.cells).map((c) => tidyRuns(this.inline(c, {})));
      if (cells.every((c) => c.length === 0)) continue;
      rows.push({ header: tr.parentElement?.tagName.toUpperCase() === 'THEAD' || Array.from(tr.cells).every((c) => c.tagName.toUpperCase() === 'TH'), cells });
    }
    if (rows.length === 0) return [];
    // A one-column "table" is page layout: its cells read as paragraphs.
    if (rows.every((r) => r.cells.length <= 1)) return rows.map((r): Block => ({ kind: 'paragraph', runs: r.cells[0] ?? [] })).filter((b) => b.kind !== 'paragraph' || b.runs.length > 0);
    return [{ kind: 'table', rows }];
  }

  /** The text of an element as styled runs. Pictures inside a line of text (emoji, icons) are left out. */
  private inline(el: Element, style: Style): Inline[] {
    const out: Inline[] = [];
    const walk = (node: Node, s: Style) => {
      if (node.nodeType === 3) {
        const text = node.textContent ?? '';
        if (text !== '') out.push({ text, ...s });
        return;
      }
      if (node.nodeType !== 1) return;
      const e = node as Element;
      const tag = e.tagName.toUpperCase();
      if (SKIP.has(tag) || isHidden(e)) return;
      if (tag === 'BR') return void out.push({ br: true });
      if (tag === 'IMG') {
        const alt = e.getAttribute('alt')?.trim() ?? '';
        if (alt !== '' && isEmojiImage(e as HTMLImageElement)) out.push({ text: alt, ...s });
        return;
      }
      // Maths: its TeX source, which reads, rather than the copy drawn for the screen and the copy for screen readers.
      if (e.classList.contains('katex') || tag === 'MATH' || tag === 'MJX-CONTAINER') {
        const tex = e.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? e.getAttribute('alttext') ?? e.getAttribute('aria-label') ?? e.textContent ?? '';
        if (tex.trim() !== '') out.push({ text: tex.trim(), ...s, code: true });
        return;
      }
      const next: Style = { ...s };
      if (tag === 'STRONG' || tag === 'B') next.bold = true;
      if (tag === 'EM' || tag === 'I' || tag === 'CITE' || tag === 'VAR') next.italic = true;
      if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP' || tag === 'TT') next.code = true;
      if (tag === 'SUP') next.sup = true;
      if (tag === 'SUB') next.sub = true;
      if (tag === 'A') {
        const href = linkOf(e as HTMLAnchorElement, this.doc);
        if (href !== null) next.href = href;
        else delete next.href;
      }
      if (BLOCK_TAGS.has(tag) && out.length > 0) out.push({ text: ' ', ...s });
      for (const child of Array.from(e.childNodes)) walk(child, next);
    };
    for (const child of Array.from(el.childNodes)) walk(child, style);
    return out;
  }

  /** A picture of the article, or null for one too small to be part of it (an icon) or with no address. */
  private image(img: HTMLImageElement | null): ImageRef | null {
    if (img === null) return null;
    const index = Number(img.getAttribute(REF_ATTR) ?? '-1');
    const liveImg = Number.isInteger(index) && index >= 0 ? this.live[index] : undefined;
    const src = bestSource(img, this.doc) ?? (liveImg?.currentSrc || null);
    if (src === null) return null;
    // Its size as the page shows it. A picture that has not loaded (lazy, or missing) is drawn as its alt text, so its box says
    // nothing: the size the page asks for (`width` and `height`) counts then.
    const loaded = liveImg !== undefined && liveImg.complete && liveImg.naturalWidth > 2;
    const asked = (name: string) => Number(img.getAttribute(name) ?? liveImg?.getAttribute(name) ?? 0) || 0;
    const w = (loaded ? liveImg.width : 0) || asked('width') || (loaded ? liveImg.naturalWidth : 0);
    const h = (loaded ? liveImg.height : 0) || asked('height') || (loaded ? liveImg.naturalHeight : 0);
    if (w > 0 && h > 0 && w < MIN_PICTURE_PX && h < MIN_PICTURE_PX) return null;
    if (isEmojiImage(img)) return null;
    return { ref: liveImg === undefined ? -1 : index, src, alt: clean(img.getAttribute('alt') ?? ''), width: Number.isFinite(w) ? w : 0, height: Number.isFinite(h) ? h : 0 };
  }
}

/** The run without its bold (a heading is bold already). */
function withoutBold(r: Extract<Inline, { text: string }>): Inline {
  const out = { ...r };
  delete out.bold;
  return out;
}

function isHidden(el: Element): boolean {
  return el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true';
}

function containsBlock(el: Element): boolean {
  for (const tag of BLOCK_TAGS) if (el.getElementsByTagName(tag).length > 0) return true;
  return el.getElementsByTagName('img').length > 0;
}

function isEmojiImage(img: HTMLImageElement): boolean {
  return /\bemoji\b/iu.test(img.className) || /\/emoji\//iu.test(img.getAttribute('src') ?? '');
}

function absolute(href: string, doc: Document): string | null {
  if (href.trim() === '') return null;
  try {
    const u = new URL(href, doc.baseURI);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** A link worth keeping: to a web page, a `mailto:`, or a place on another page. A jump within this page is dropped. */
function linkOf(a: HTMLAnchorElement, doc: Document): string | null {
  const raw = a.getAttribute('href') ?? '';
  if (raw.startsWith('#')) return null;
  if (/^mailto:/iu.test(raw)) return raw;
  return absolute(raw, doc);
}

/** The picture's address: `src`, or the widest of `srcset` when there is no `src` (or it is a placeholder). */
function bestSource(img: Element, doc: Document): string | null {
  const src = img.getAttribute('src') ?? '';
  if (src !== '' && !/^data:image\/(?:gif|png);base64,.{0,200}$/u.test(src)) {
    if (src.startsWith('data:')) return src;
    const a = absolute(src, doc);
    if (a !== null) return a;
  }
  const sets = [img.getAttribute('srcset'), ...Array.from(img.parentElement?.tagName.toUpperCase() === 'PICTURE' ? img.parentElement.querySelectorAll('source') : []).map((s) => s.getAttribute('srcset'))];
  let best: { url: string; w: number } | null = null;
  for (const set of sets) {
    for (const part of (set ?? '').split(',')) {
      const [url, size] = part.trim().split(/\s+/u);
      if (url === undefined || url === '') continue;
      const w = size?.endsWith('w') ? Number(size.slice(0, -1)) : size?.endsWith('x') ? Number(size.slice(0, -1)) * 1000 : 1;
      const abs = absolute(url, doc);
      if (abs !== null && (best === null || w > best.w)) best = { url: abs, w };
    }
  }
  return best?.url ?? null;
}

function shortLink(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return url;
  }
}

/** Runs with their spaces collapsed, as the browser shows them: no space at either end, one between words. */
function tidyRuns(runs: readonly Inline[]): Inline[] {
  const out: Inline[] = [];
  let lastSpace = true; // at the start, as after a space: leading spaces go
  for (const r of runs) {
    if (!('text' in r)) {
      if (out.length > 0) {
        // no space before a line break
        const prev = out[out.length - 1];
        if (prev !== undefined && 'text' in prev) prev.text = prev.text.replace(/ $/u, '');
        out.push(r);
      }
      lastSpace = true;
      continue;
    }
    let text = r.text.replace(/[\s\u00a0]+/gu, (m) => (m.includes('\u00a0') && !/[\n\t ]/u.test(m) ? '\u00a0' : ' '));
    if (lastSpace) text = text.replace(/^ +/u, '');
    if (text === '') continue;
    lastSpace = text.endsWith(' ');
    const prev = out[out.length - 1];
    if (prev !== undefined && 'text' in prev && sameStyle(prev, r)) prev.text += text;
    else out.push({ ...r, text });
  }
  // no space (or line break) at the end
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (!('text' in last)) {
      out.pop();
      continue;
    }
    last.text = last.text.replace(/ +$/u, '');
    if (last.text === '') out.pop();
    else break;
  }
  return out;
}

function sameStyle(a: Extract<Inline, { text: string }>, b: Extract<Inline, { text: string }>): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.code === b.code && a.sup === b.sup && a.sub === b.sub && a.href === b.href;
}

// ---- the pictures ----

/**
 * Reads one picture: the live `<img>` when it has loaded and the canvas may read it, else a fetch made the way the page
 * makes it (from the cache when it is there). It comes back at most 1,600 px wide, as a JPEG, or as a PNG when it has
 * see-through parts or is a drawing. `{ ok: false }` when it cannot be read.
 */
export async function readImage(live: readonly HTMLImageElement[], ref: number, src: string): Promise<ImageResult> {
  try {
    const img = ref >= 0 ? live[ref] : undefined;
    const lossless = /\.(?:png|gif|svg)(?:[?#]|$)/iu.test(src) || /^data:image\/(?:png|gif|svg)/iu.test(src);
    if (img !== undefined && img.complete && img.naturalWidth > 0 && (img.currentSrc === src || img.src === src || img.naturalWidth >= MIN_PICTURE_PX * 2)) {
      const drawn = encode(img, img.naturalWidth, img.naturalHeight, lossless || /\.(?:png|gif|svg)(?:[?#]|$)/iu.test(img.currentSrc));
      if (drawn !== null) return drawn;
    }
    const response = await fetch(src, { credentials: 'same-origin', cache: 'force-cache' });
    if (!response.ok) return { ok: false };
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob).catch(() => null);
    if (bitmap !== null) {
      const out = encode(bitmap, bitmap.width, bitmap.height, lossless || /png|gif|svg/iu.test(blob.type));
      bitmap.close();
      return out ?? { ok: false };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

/** Draws `source` at most 1,600 px wide and encodes it; null when the canvas may not be read (another site's picture). */
function encode(source: CanvasImageSource, w0: number, h0: number, lossless: boolean): ImageResult | null {
  if (w0 <= 0 || h0 <= 0) return null;
  const scale = Math.min(1, MAX_IMAGE_PX / w0);
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);
  let seeThrough = false;
  try {
    const data = ctx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < data.length; i += 4 * 7) {
      if (data[i] < 250) {
        seeThrough = true;
        break;
      }
    }
  } catch {
    return null; // tainted: another site's picture, without its permission
  }
  // See-through parts need PNG. A drawing (a PNG, GIF or SVG on the page) stays PNG, so its lines and letters stay sharp,
  // unless that makes it very large, when it is a photo after all. Everything else is a JPEG.
  if (seeThrough) return { ok: true, dataUrl: canvas.toDataURL('image/png'), width: w, height: h };
  if (lossless) {
    const png = canvas.toDataURL('image/png');
    if (png.length <= PNG_MAX_CHARS) return { ok: true, dataUrl: png, width: w, height: h };
  }
  return { ok: true, dataUrl: canvas.toDataURL('image/jpeg', JPEG_QUALITY), width: w, height: h };
}
