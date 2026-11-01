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
// Ported from pdf.js 743102c: src/display/text_layer.js (class TextLayer), with the CSS of
// web/text_layer_builder.css and the mouse and selection handling of web/text_layer_builder.js
// (Copyright 2012 and 2014 Mozilla Foundation, same licence; LICENSE.pdfjs is next to this file).
// Changes from pdf.js:
// - Input is TextItem[] from items.ts (PDFium glyphs, drift-split), not a TextContent stream; there are no
//   marked-content items, no images and no FontInspector.
// - Each item has its PDFium box, so a span is placed by that box instead of by baseline and ascent: its content
//   area is scaled to the box height (--scale-y, new) and its width to the box width (--scale-x, measured for
//   every span, single chars included). Positions use calc(var(--total-scale-factor) * …px), not percentages.
// - One bundled font for every span (TEXT_LAYER_FONT_FAMILY); measuring and rendering both use font-kerning none
//   and font-variant-ligatures none. No Firefox font-size quantisation (the extension is Chrome only).
// - Each span has data-start (its first PDFium char index); a PDFium joined line-end hyphen is shown as an
//   unselectable "-" so copied text drops it, as getTextRange does.
// - The page's /Rotate turns the whole layer ([data-main-rotation], from pdf.js web/pdf_viewer.css).
// - Selection: pdf.js's Chromium-before-148 branch (moving .endOfContent) is kept with its version check,
//   though the spike's Chromium 153 never runs it. The copy handler is not ported.
import { cssFont, PDFIUM_HYPHEN, TEXT_LAYER_FONT_FAMILY, type TextItem } from './items';

/** The page as the layer lays it out: unrotated size in points, CSS px per point, and the page's /Rotate. */
export interface TextLayerViewport {
  scale: number;
  rotation: 0 | 90 | 180 | 270;
  pageWidth: number;
  pageHeight: number;
}

const MAX_TEXT_DIVS_TO_RENDER = 100000;
const METRICS_FONT_SIZE = 1000;

export class TextLayer {
  #container: HTMLElement;

  #items: TextItem[];

  #scale: number;

  #textDivs: HTMLElement[] = [];

  static #canvasContext: CanvasRenderingContext2D | null = null;

  static #canvasFont = '';

  static #metrics: { ascent: number; descent: number } | null = null;

  static #minFontSize: number | null = null;

  constructor({ items, container, viewport }: { items: TextItem[]; container: HTMLElement; viewport: TextLayerViewport }) {
    this.#container = container;
    this.#items = items;
    this.#scale = viewport.scale;
    TextLayer.#ensureMinFontSizeComputed();
    container.style.setProperty('--min-font-size', String(TextLayer.#minFontSize));
    setLayerDimensions(container, viewport);
  }

  /** Builds one span per item (and a <br> after an item with hasEOL). */
  render(): void {
    for (const item of this.#items) {
      // No point in rendering many divs as it would make the browser unusable even after the divs are rendered.
      if (this.#textDivs.length > MAX_TEXT_DIVS_TO_RENDER) {
        console.warn('Ignoring additional textDivs for performance reasons.');
        return;
      }
      this.#appendText(item);
    }
  }

  /** The spans, in PDFium char order. */
  get textDivs(): HTMLElement[] {
    return this.#textDivs;
  }

  #appendText(item: TextItem): void {
    const textDiv = document.createElement('span');
    this.#textDivs.push(textDiv);

    const [a, b, , , x, y] = item.transform;
    const angle = Math.atan2(b, a);
    const fontHeight = Math.hypot(a, b);
    const hyphen = item.str === PDFIUM_HYPHEN;
    const text = hyphen ? '-' : item.str;

    // The span's line box is 1em (line-height: 1); its content area (what selection paints and what Range
    // rects report) is the font's rounded ascent + descent, centred in it with the half-leading floored to a
    // whole pixel, as Blink does. Scale that area to the item's height and put its top on the item's top edge.
    const { ascent, descent } = TextLayer.#getMetrics();
    const content = Math.round(ascent * fontHeight) + Math.round(descent * fontHeight);
    const scaleY = item.height > 0 && content > 0 ? item.height / content : 1;
    const halfLeading = Math.floor((fontHeight - content) / 2);
    const left = x + Math.sin(angle) * scaleY * halfLeading;
    const top = y - Math.cos(angle) * scaleY * halfLeading;

    const divStyle = textDiv.style;
    // Setting the style properties individually, rather than all at once,
    // should be OK since the `textDiv` isn't appended to the document yet.
    divStyle.left = `calc(var(--total-scale-factor) * ${(left / this.#scale).toFixed(4)}px)`;
    divStyle.top = `calc(var(--total-scale-factor) * ${(top / this.#scale).toFixed(4)}px)`;
    divStyle.setProperty('--font-height', `${(fontHeight / this.#scale).toFixed(4)}px`);
    divStyle.setProperty('--scale-y', String(scaleY));

    // Keeps screen readers from pausing on every new text span.
    textDiv.setAttribute('role', 'presentation');
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
      br.setAttribute('role', 'presentation');
      this.#container.append(br);
    }
  }

  static #getCtx(): CanvasRenderingContext2D {
    if (!this.#canvasContext) {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;display:none;letter-spacing:normal;word-spacing:normal';
      document.body.append(canvas);
      this.#canvasContext = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!;
      // As the spans: no kerning, no ligatures (canvas has no font-variant-ligatures; optimizeSpeed drops them).
      this.#canvasContext.fontKerning = 'none';
      this.#canvasContext.textRendering = 'optimizeSpeed';
    }
    return this.#canvasContext;
  }

  static #measure(text: string, sizePx: number): number {
    const ctx = this.#getCtx();
    const font = cssFont(sizePx);
    if (font !== this.#canvasFont) {
      ctx.font = font;
      this.#canvasFont = font;
    }
    return ctx.measureText(text).width;
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

/** Sizes the layer to the unrotated page at --total-scale-factor and turns it by the page's /Rotate. */
function setLayerDimensions(div: HTMLElement, { scale, rotation, pageWidth, pageHeight }: TextLayerViewport): void {
  div.style.setProperty('--total-scale-factor', String(scale));
  div.style.width = `calc(var(--total-scale-factor) * ${pageWidth}px)`;
  div.style.height = `calc(var(--total-scale-factor) * ${pageHeight}px)`;
  div.setAttribute('data-main-rotation', String(rotation));
}

/**
 * Loads the bundled font the layer measures and renders with (TEXT_LAYER_FONT_FAMILY). Await it before the
 * first TextLayer: the font's ascent and descent are cached on first use, and buildTextItems' measurer needs it too.
 */
export async function loadTextLayerFont(url: string): Promise<void> {
  const face = new FontFace('sop-text-layer', `url(${url})`);
  await face.load();
  document.fonts.add(face);
}

/** web/text_layer_builder.css (plus pdf_viewer.css's rotation rules), adapted as described at the top. */
export const TEXT_LAYER_CSS = `
.textLayer {
  color-scheme: only light;
  position: absolute;
  text-align: initial;
  left: 0;
  top: 0;
  overflow: clip;
  opacity: 1;
  line-height: 1;
  letter-spacing: normal;
  word-spacing: normal;
  text-size-adjust: none;
  forced-color-adjust: none;
  transform-origin: 0 0;
  caret-color: CanvasText;
  z-index: 0;
  --min-font-size: 1;
  --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
  --min-font-size-inv: calc(1 / var(--min-font-size));
}
.textLayer[data-main-rotation="90"] { transform: rotate(90deg) translateY(-100%); }
.textLayer[data-main-rotation="180"] { transform: rotate(180deg) translate(-100%, -100%); }
.textLayer[data-main-rotation="270"] { transform: rotate(270deg) translateX(-100%); }
.textLayer :is(span, br) {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0% 0%;
  user-select: text;
  font-family: ${TEXT_LAYER_FONT_FAMILY};
  font-kerning: none;
  font-variant-ligatures: none;
}
.textLayer > :not(.markedContent) {
  z-index: 1;
  --font-height: 0;
  font-size: calc(var(--text-scale-factor) * var(--font-height));
  --scale-x: 1;
  --scale-y: 1;
  --rotate: 0deg;
  transform: rotate(var(--rotate)) scale(var(--scale-x), var(--scale-y)) scale(var(--min-font-size-inv));
}
.textLayer .sop-unselectable { user-select: none; }
.textLayer ::selection {
  background: rgba(0 0 255 / 0.25);
  background: color-mix(in srgb, AccentColor, transparent 50%);
  color: transparent;
}
/* Avoids https://github.com/mozilla/pdf.js/issues/13840 in Chrome */
.textLayer br::selection { background: transparent; }
.textLayer .endOfContent {
  display: block;
  position: absolute;
  inset: 100% 0 0;
  z-index: 0;
  cursor: default;
  user-select: none;
}
.textLayer.selecting .endOfContent { top: 0; }
`;

export function installTextLayerStyles(): void {
  if (document.getElementById('sop-text-layer-css')) return;
  const style = document.createElement('style');
  style.id = 'sop-text-layer-css';
  style.textContent = TEXT_LAYER_CSS;
  document.head.append(style);
}

const textLayers = new Map<HTMLElement, HTMLElement>();
let selectionChangeAC: AbortController | null = null;

/**
 * TextLayerBuilder's #bindMouse and global selection listener: appends .endOfContent (which covers the layer
 * while selecting, so dragging over empty space does not hit other content) and keeps .selecting on every
 * layer the selection touches. Returns a function that unbinds the layer.
 */
export function bindTextLayer(div: HTMLElement): () => void {
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
      // Collect all the .textLayer elements where the selection is happening.
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

      const parentTextLayer = anchor.parentElement?.closest<HTMLElement>('.textLayer');
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
