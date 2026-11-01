/* Copyright 2015 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Modified for sickofpdfs: fed from PDFium glyphs
//
// Ported from pdf.js 743102c: src/display/text_layer.js (class TextLayer), with the CSS of web/text_layer_builder.css
// (text-layer.css here) and the mouse and selection handling of web/text_layer_builder.js (Copyright 2012 and 2014
// Mozilla Foundation, same licence; LICENSE.pdfjs is next to this file), by way of the Phase 0 spike.
// Changes from pdf.js:
// - Input is TextItem[] from items.ts (PDFium glyphs, drift-split), not a TextContent stream; there are no marked-content
//   items, no images and no FontInspector.
// - Each item has its PDFium box, so a span is placed by that box instead of by baseline and ascent: its content area
//   is scaled to the box height (--scale-y, new) and its width to the box width (--scale-x, measured for every span,
//   single chars included). Font sizes follow --total-scale-factor (CSS px per point); positions and --scale-y are
//   laid out again for each zoom (update()), because Blink rounds the content area at the size it draws.
// - One bundled font for every span (TEXT_LAYER_FONT_FAMILY, set on the layer); measuring and rendering both use
//   font-kerning none and font-variant-ligatures none. No Firefox font-size quantisation (the extension is Chrome only).
// - Each span has data-start (its first PDFium char index); a PDFium joined line-end hyphen is shown as an
//   unselectable "-" so copied text drops it, as getTextRange does.
// - The page's rotation (its /Rotate plus the viewer's) turns the whole layer ([data-main-rotation], from pdf.js
//   web/pdf_viewer.css).
// - The browser's own selection highlight is transparent: the viewer paints the selection itself from PDFium's line
//   rectangles (R44). The DOM selection stays, for copy, find and screen readers.
// - Selection: pdf.js's Chromium-before-148 branch (moving .endOfContent) is kept with its version check. The copy
//   handler is the viewer's (TextLayer.tsx), not pdf.js's.
import type { Rotation } from '../backend/types';
import type { PageBox } from '../layout/page-layout';
import { cssFont, itemsScale, PDFIUM_HYPHEN, TEXT_LAYER_FONT_FAMILY, type TextItem } from './items';

/** The class of a text layer's root element. */
export const TEXT_LAYER_CLASS = 'sop-text-layer';
/** The attribute on a text layer's root that holds its page index. */
export const TEXT_LAYER_PAGE_ATTR = 'data-text-page';

export interface TextLayerHandle {
  /** The layer's root element (`.sop-text-layer`), inside the container. */
  root: HTMLElement;
  /** Shows the layer at `scale` CSS px per point, turned by `rotation` (the page's /Rotate plus the view's). */
  update(scale: number, rotation: Rotation): void;
  /** Unbinds the layer and removes it from the DOM. */
  destroy(): void;
}

const MAX_TEXT_DIVS_TO_RENDER = 100000;
const METRICS_FONT_SIZE = 1000;

class TextLayer {
  #container: HTMLElement;

  #items: TextItem[];

  #scale: number;

  #textDivs: { div: HTMLElement; item: TextItem }[] = [];

  /** The scale (CSS px a point) the spans were last laid out for. */
  #layoutScale = 0;

  static #canvasContext: CanvasRenderingContext2D | null = null;

  static #canvasFont = '';

  static #metrics: { ascent: number; descent: number } | null = null;

  static #minFontSize: number | null = null;

  constructor({ items, container, scale }: { items: TextItem[]; container: HTMLElement; scale: number }) {
    this.#container = container;
    this.#items = items;
    this.#scale = scale;
    this.#layoutScale = scale;
    TextLayer.#ensureMinFontSizeComputed();
    container.style.setProperty('--min-font-size', String(TextLayer.#minFontSize));
  }

  /**
   * Builds one span per item (and a <br> after an item with hasEOL), and the line's text for screen readers: drift-split
   * cuts most words into several spans, and each absolutely placed span is a block of its own in the accessibility tree,
   * so the spans themselves are hidden from it. Each line (the items up to a PDFium line break) gets one more element
   * before its first span that shows the whole line's text as generated content (::before, attr(data-text)): screen
   * readers read it, while selection, copying and find-in-page never see it.
   */
  render(): void {
    let line: { el: HTMLElement; item: TextItem; text: string } | null = null;
    for (const item of this.#items) {
      // No point in rendering many divs as it would make the browser unusable even after the divs are rendered.
      if (this.#textDivs.length > MAX_TEXT_DIVS_TO_RENDER) {
        console.warn('Ignoring additional textDivs for performance reasons.');
        break;
      }
      if (!line) {
        const el = document.createElement('span');
        el.className = 'sop-a11y-line';
        this.#container.append(el);
        line = { el, item, text: '' };
      }
      line.text += item.str === PDFIUM_HYPHEN ? '' : item.str;
      this.#appendText(item);
      if (item.hasEOL) {
        this.#finishLine(line);
        line = null;
      }
    }
    if (line) this.#finishLine(line);
  }

  #finishLine(line: { el: HTMLElement; item: TextItem; text: string }): void {
    if (line.text.trim() === '') {
      line.el.remove();
      return;
    }
    this.#textDivs.push({ div: line.el, item: line.item });
    const [a, b] = line.item.transform;
    line.el.style.setProperty('--font-height', `${(Math.hypot(a, b) / this.#scale).toFixed(4)}px`);
    const angle = Math.atan2(b, a);
    if (angle !== 0) line.el.style.setProperty('--rotate', `${(angle * 180) / Math.PI}deg`);
    line.el.dir = line.item.dir;
    line.el.dataset.text = line.text;
    this.#place(line.el, line.item, this.#scale);
  }

  #appendText(item: TextItem): void {
    const textDiv = document.createElement('span');
    this.#textDivs.push({ div: textDiv, item });

    const [a, b] = item.transform;
    const angle = Math.atan2(b, a);
    const fontHeight = Math.hypot(a, b);
    const hyphen = item.str === PDFIUM_HYPHEN;
    const text = hyphen ? '-' : item.str;

    const divStyle = textDiv.style;
    // Setting the style properties individually, rather than all at once,
    // should be OK since the `textDiv` isn't appended to the document yet.
    divStyle.setProperty('--font-height', `${(fontHeight / this.#scale).toFixed(4)}px`);
    this.#place(textDiv, item, this.#scale);

    // Screen readers read the line's text instead (render()).
    textDiv.setAttribute('aria-hidden', 'true');
    textDiv.dataset.start = String(item.start);
    if (hyphen) textDiv.className = 'sop-unselectable';
    textDiv.textContent = text;
    textDiv.dir = item.dir;

    // Unlike pdf.js, single chars are scaled too: every char edge should sit on PDFium's box.
    const width = TextLayer.#measure(text, fontHeight);
    if (width > 0) divStyle.setProperty('--scale-x', String(Math.max(item.width, 0.01) / width));
    if (angle !== 0) divStyle.setProperty('--rotate', `${(angle * 180) / Math.PI}deg`);

    if (text !== '') this.#container.append(textDiv);
    if (item.hasEOL) {
      const br = document.createElement('br');
      br.setAttribute('aria-hidden', 'true');
      this.#container.append(br);
    }
  }

  /**
   * Puts a span on its item's box at `scale` (CSS px a point). The span's line box is 1em (line-height: 1); its content
   * area (what selection paints and what Range rects report) is the font's ascent + descent rounded to whole pixels at
   * the size it is drawn, centred in it with the half-leading floored to a whole pixel, as Blink does. That area is
   * scaled to the item's height and its top put on the item's top edge. The rounding depends on the size drawn, so a
   * zoom lays every span out again (layout()).
   */
  #place(div: HTMLElement, item: TextItem, scale: number): void {
    const k = scale / this.#scale;
    const [a, b, , , x, y] = item.transform;
    const angle = Math.atan2(b, a);
    const fontHeight = Math.hypot(a, b) * k;
    const { ascent, descent } = TextLayer.#getMetrics();
    const content = Math.round(ascent * fontHeight) + Math.round(descent * fontHeight);
    const scaleY = item.height > 0 && content > 0 ? (item.height * k) / content : 1;
    const halfLeading = Math.floor((fontHeight - content) / 2);
    const left = x * k + Math.sin(angle) * scaleY * halfLeading;
    const top = y * k - Math.cos(angle) * scaleY * halfLeading;
    div.style.left = `${left.toFixed(3)}px`;
    div.style.top = `${top.toFixed(3)}px`;
    div.style.setProperty('--scale-y', String(scaleY));
  }

  /** Lays the spans out for `scale` CSS px a point (their font size follows --total-scale-factor by itself). */
  layout(scale: number): void {
    if (scale === this.#layoutScale) return;
    this.#layoutScale = scale;
    for (const { div, item } of this.#textDivs) this.#place(div, item, scale);
  }

  static #getCtx(): CanvasRenderingContext2D {
    if (!this.#canvasContext) {
      const canvas = document.createElement('canvas');
      this.#canvasContext = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!;
      // As the spans: no kerning, no ligatures (canvas has no font-variant-ligatures; optimizeSpeed drops them).
      this.#canvasContext.fontKerning = 'none';
      this.#canvasContext.textRendering = 'optimizeSpeed';
    }
    return this.#canvasContext;
  }

  static measure(text: string, font: string): number {
    const ctx = this.#getCtx();
    if (font !== this.#canvasFont) {
      ctx.font = font;
      this.#canvasFont = font;
    }
    return ctx.measureText(text).width;
  }

  static #measure(text: string, sizePx: number): number {
    return this.measure(text, cssFont(sizePx));
  }

  /** Ascent and descent of TEXT_LAYER_FONT_FAMILY as fractions of the font size. */
  static #getMetrics(): { ascent: number; descent: number } {
    if (!this.#metrics) {
      this.#measure('', METRICS_FONT_SIZE);
      const m = this.#getCtx().measureText('');
      this.#metrics = { ascent: m.fontBoundingBoxAscent / METRICS_FONT_SIZE, descent: Math.abs(m.fontBoundingBoxDescent) / METRICS_FONT_SIZE };
    }
    return this.#metrics;
  }

  /**
   * Compute the minimum font size enforced by the browser.
   */
  static #ensureMinFontSizeComputed(): void {
    if (this.#minFontSize !== null) {
      return;
    }
    const div = document.createElement('div');
    div.style.opacity = '0';
    div.style.lineHeight = '1';
    div.style.fontSize = '1px';
    div.style.position = 'absolute';
    div.textContent = 'X';
    document.body.append(div);
    // In `display:block` elements contain a single line of text,
    // the height matches the line height (which, when set to 1,
    // matches the actual font size).
    this.#minFontSize = div.getBoundingClientRect().height;
    div.remove();
  }
}

/**
 * buildTextItems' measurer: the layer's own canvas, with no kerning and no ligatures, like the spans. Load the font
 * first (loadTextLayerFont): measuring before it has loaded measures a fallback font.
 */
export function measureTextLayerText(text: string, font: string): number {
  return TextLayer.measure(text, font);
}

let fontLoad: Promise<void> | null = null;

/**
 * Loads the bundled font the layer measures and renders with (TEXT_LAYER_FONT_FAMILY), once per page. Await it before
 * the first layer: the font's ascent and descent are cached on first use, and buildTextItems' measurer needs it too.
 */
export function loadTextLayerFont(url: string): Promise<void> {
  fontLoad ??= (async () => {
    const face = new FontFace('sop-text-layer', `url(${url})`);
    await face.load();
    document.fonts.add(face);
  })();
  return fontLoad;
}

/**
 * Renders `items` (built by buildTextItems for this page) into a new `.sop-text-layer` inside `container`: one
 * transparent span per item over the page, which the browser selects, copies and reads aloud. `box` is the page's box
 * at the scale the items were built at; the layer is turned by `box.rotation`. Call `update` when the zoom or the
 * rotation changes.
 */
export function renderTextLayer(container: HTMLElement, items: TextItem[], box: PageBox, pageIndex: number): TextLayerHandle {
  const scale = itemsScale(items) ?? 1;
  const turned = box.rotation % 180 !== 0;
  const pageWidth = (turned ? box.height : box.width) / scale; // unrotated, points
  const pageHeight = (turned ? box.width : box.height) / scale;

  const root = document.createElement('div');
  root.className = TEXT_LAYER_CLASS;
  root.setAttribute(TEXT_LAYER_PAGE_ATTR, String(pageIndex));
  root.style.fontFamily = TEXT_LAYER_FONT_FAMILY;
  root.style.width = `calc(var(--total-scale-factor) * ${pageWidth}px)`;
  root.style.height = `calc(var(--total-scale-factor) * ${pageHeight}px)`;
  const layer = new TextLayer({ items, container: root, scale });
  layer.render();
  container.append(root);
  const unbind = bindTextLayer(root);

  const handle: TextLayerHandle = {
    root,
    update(s, rotation) {
      root.style.setProperty('--total-scale-factor', String(s));
      root.setAttribute('data-main-rotation', String(rotation));
      layer.layout(s);
    },
    destroy() {
      unbind();
      root.remove();
    },
  };
  handle.update(scale, box.rotation);
  return handle;
}

const textLayers = new Map<HTMLElement, HTMLElement>();
let selectionChangeAC: AbortController | null = null;

/**
 * TextLayerBuilder's #bindMouse and global selection listener: appends .endOfContent (which covers the layer while
 * selecting, so dragging over empty space does not hit other content) and keeps .selecting on every layer the
 * selection touches. Returns a function that unbinds the layer.
 */
function bindTextLayer(div: HTMLElement): () => void {
  const end = document.createElement('div');
  end.className = 'endOfContent';
  div.append(end);
  const ac = new AbortController();
  div.addEventListener('mousedown', () => div.classList.add('selecting'), { signal: ac.signal });
  textLayers.set(div, end);
  enableGlobalSelectionListener();
  return () => {
    ac.abort();
    textLayers.delete(div);
    if (textLayers.size === 0) {
      selectionChangeAC?.abort();
      selectionChangeAC = null;
    }
  };
}

function enableGlobalSelectionListener(): void {
  if (selectionChangeAC) {
    // document-level event listeners already installed
    return;
  }
  selectionChangeAC = new AbortController();
  const { signal } = selectionChangeAC;

  const reset = (end: HTMLElement, textLayer: HTMLElement) => {
    textLayer.append(end);
    end.style.width = '';
    end.style.height = '';
    textLayer.classList.remove('selecting');
  };

  let isPointerDown = false;
  let isModernChromium: boolean | undefined;
  let prevRange: Range | undefined;
  document.addEventListener('pointerdown', () => (isPointerDown = true), { signal });
  document.addEventListener(
    'pointerup',
    () => {
      isPointerDown = false;
      textLayers.forEach(reset);
    },
    { signal },
  );
  window.addEventListener(
    'blur',
    () => {
      isPointerDown = false;
      textLayers.forEach(reset);
    },
    { signal },
  );
  document.addEventListener(
    'keyup',
    () => {
      if (!isPointerDown) textLayers.forEach(reset);
    },
    { signal },
  );
  document.addEventListener(
    'selectionchange',
    () => {
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0) {
        textLayers.forEach(reset);
        return;
      }
      // Collect all the .sop-text-layer elements where the selection is happening.
      const activeTextLayers = new Set<HTMLElement>();
      for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        if (range.collapsed && !isPointerDown) {
          // A click's selectionchange can arrive after pointerup and restore
          // the selecting class. Ignore its collapsed range.
          continue;
        }
        for (const textLayerDiv of textLayers.keys()) {
          if (!activeTextLayers.has(textLayerDiv) && range.intersectsNode(textLayerDiv)) {
            activeTextLayers.add(textLayerDiv);
          }
        }
      }
      for (const [textLayerDiv, endDiv] of textLayers) {
        if (activeTextLayers.has(textLayerDiv)) {
          textLayerDiv.classList.add('selecting');
        } else {
          reset(endDiv, textLayerDiv);
        }
      }
      if (isModernChromium === undefined) {
        const chromiumVersion = /\bChrome\/(\d+)\b/.exec(navigator.userAgent)?.[1];
        isModernChromium = !!chromiumVersion && parseInt(chromiumVersion, 10) >= 148;
      }
      if (isModernChromium) {
        return;
      }

      // In browsers other than Firefox or Chromium 148+, when hovering over
      // an empty space (thus, on .endOfContent), the selection will expand to
      // cover all the text between the current selection and .endOfContent.
      // By moving .endOfContent to right after (or before, depending on which
      // side of the selection the user is moving), we limit the selection
      // jump to at most cover the entirety of the <span> where the selection
      // is being modified.
      const range = selection.getRangeAt(0);
      const modifyStart =
        prevRange &&
        (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 || range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);
      let anchor: Node = modifyStart ? range.startContainer : range.endContainer;
      if (anchor.nodeType === Node.TEXT_NODE) {
        anchor = anchor.parentNode!;
      }
      if (!modifyStart && range.endOffset === 0) {
        do {
          while (!anchor.previousSibling) {
            anchor = anchor.parentNode!;
          }
          anchor = anchor.previousSibling;
        } while (!anchor.childNodes.length);
      }

      const parentTextLayer = anchor.parentElement?.closest<HTMLElement>(`.${TEXT_LAYER_CLASS}`);
      const endDiv = parentTextLayer ? textLayers.get(parentTextLayer) : undefined;
      if (parentTextLayer && endDiv) {
        endDiv.style.width = parentTextLayer.style.width;
        endDiv.style.height = parentTextLayer.style.height;
        endDiv.style.userSelect = 'text';
        anchor.parentElement!.insertBefore(endDiv, modifyStart ? anchor : anchor.nextSibling);
      }

      prevRange = range.cloneRange();
    },
    { signal },
  );
}
