// The wiring of notes into the viewer (Phase 2, S13). For each open document it builds the annotation session (S9) with
// its draft keeper and tab presence (S8), its anchor context (S7, S12, S3) and the store, then hands the result to the
// page layers, the keys and the mark-up menu.
//
// Three things other code meets here:
// - `notesSaveGate`: the one place that answers "is this PDF saved, and may notes be written?" (Task 30 replaces it).
// - `registerViewerFeature`: how the comments (S14), the notes panel (S15) and later the figures (S16) mount, with one
//   line each in App.tsx. A feature gets a NotesHost: the session and everything it needs to draw and act on the pages.
// - `marks.lastColor`: the colour H, the menu and a new comment's highlight use next.
//
// Incognito: no notes at all. `createNotes` returns null, so there are no marks, no menu and no features (spec).
import { type Anchor, type CharPos, type DocumentId, type MarkColor, type NormRect, planStyle, resolveAnchor } from '@sop/core';
import type { CharRange, DocHandle, FigureService, PageBox, PageSize, PageTextProviderImpl, PdfBackend, SaveController, ViewerStore } from '@sop/viewer';
import type { MarkLayerItem, MarkLayerPage, MarkLayerSource, PageLayerContext, PageListApi } from '@sop/viewer/react';
import type { ComponentType, RefObject } from 'react';
import type { StoreClient } from '../../store/client';
import type { CommandBehaviour, ViewerCommandId } from '../commands';
import { isIncognito } from '../incognito';
import type { OpenedDocument } from '../open-document';
import { whenStore } from '../runtime';
import { createAnchorContext, createDocumentFigures, createTextAnchorMaker, type DocumentText, markNormRects } from './anchor-context';
import { createDraftKeeper } from './drafts';
import { createMarkInput, type MarkInput } from './mark-input';
import { type AnnotationSession, type AnnotationState, createAnnotationSession } from './session';
import { createTabPresence } from './tab-presence';
import { anchorKey } from './undo';

type TextAnchor = Extract<Anchor, { kind: 'text' }>;

// ---------------------------------------------------------------------------------------------------------------------
// The save question
// ---------------------------------------------------------------------------------------------------------------------

/** What the session is told about saving: the save controller, and the library id rows are written under. */
export interface NotesSaveGate {
  save: SaveController | null;
  documentId(this: void): DocumentId | null;
}

/**
 * THE question "is this PDF saved in the library, and may its notes be written?" Everything that decides whether a
 * note reaches the store goes through here.
 *
 * Until Task 30 (the save decision) merges, the answer is "not saved": no save controller, so the annotation session
 * keeps every mark, comment and draft in memory only and writes nothing (a mark cannot be stored before its PDF has a
 * document row). Task 30 replaces this body: it returns its SaveController (ViewerContext.save) and the saved
 * document's id, and the session then writes, asks first, or stays in memory as the controller says.
 */
export function notesSaveGate(save: SaveController | null): NotesSaveGate {
  // Task 30: return { save, documentId: () => (save?.state.kind === 'saved' ? save.state.documentId : null) }.
  void save;
  return { save: null, documentId: () => null };
}

// ---------------------------------------------------------------------------------------------------------------------
// marks.lastColor
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Where marks.lastColor is kept: this browser's storage for the extension, on this computer only. The store has no
 * settings API yet; when Settings (Phase 3) adds one, this moves to the synced settings row of the same name.
 */
const LAST_COLOR_KEY = 'sop:marks.lastColor';

/** The colour H, the menu and a new comment's highlight use next. Yellow (1) until another is picked. */
export function readLastColor(): MarkColor {
  try {
    const v = Number(localStorage.getItem(LAST_COLOR_KEY));
    return v >= 1 && v <= 5 && Number.isInteger(v) ? (v as MarkColor) : 1;
  } catch {
    return 1;
  }
}

export function writeLastColor(c: MarkColor): void {
  try {
    localStorage.setItem(LAST_COLOR_KEY, String(c));
  } catch {
    // storage full or blocked: the colour is still used for this tab
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Features: how S14, S15 and S16 mount
// ---------------------------------------------------------------------------------------------------------------------

/** What a feature gets for the open document. */
export interface NotesHost {
  /** The open document's notes: marks, threads, comments, drafts, the active thread and the focused mark. */
  readonly session: AnnotationSession;
  readonly backend: PdfBackend;
  readonly doc: DocHandle;
  /** OpenResult.pages: each page's unrotated crop box in points, and its /Rotate. */
  readonly pages: readonly PageSize[];
  /** The page text everything reads (one cache for the document). */
  readonly pageText: PageTextProviderImpl;
  /** Figure detection (S12): figures(pageIndex), dHash, peek, pageRendered. */
  readonly figures: FigureService;
  /** The view state: zoom, rotation, the page in view. */
  readonly view: ViewerStore;
  /** The page list's moves and geometry (pageBoxes, clientPointOf, pdfPointAt, goToPage) while it is mounted. */
  readonly pageList: RefObject<PageListApi | null>;
  /** The selected text as char ranges, one per page; [] when nothing is selected. */
  selection(): CharRange[];
  /** A text anchor for char ranges: the quote with its context, the positions, and the rects the selection had. */
  textAnchor(ranges: CharRange[]): Promise<TextAnchor>;
  /** The colour H, the menu and a new comment's highlight use (marks.lastColor). */
  lastColor(): MarkColor;
  /** Where the pointer last was over the pages, in client px; null while it is elsewhere. */
  pointer(): { x: number; y: number } | null;
  /**
   * Where a placed mark or text thread is drawn on a page, 0–1 of the crop box (as the mark layer draws it); [] when it
   * is not on that page or not placed. For laying cards out level with their marks.
   */
  rectsOf(id: string, pageIndex: number): readonly NormRect[];
  /** Keeps `px` CSS px free on the right of the page list for this feature (the margin column, the panel); 0 frees it. */
  reserveRight(featureId: string, px: number): void;
}

export interface ViewerFeature {
  /** A short unique name: 'comments', 'notes-panel', 'figures'. */
  id: string;
  /** What this feature's commands do. Their names, icons and keys are in commands.ts; they stay greyed out until here. */
  commands?(host: NotesHost): Partial<Record<ViewerCommandId, CommandBehaviour>>;
  /** Shown while a document is open, in the area under the header (the margin column, the notes panel). */
  View?: ComponentType<{ host: NotesHost }>;
  /** Drawn on every page, over the marks and under the selection and text layer (figure outlines, pins). */
  PageLayer?: ComponentType<{ host: NotesHost; box: PageBox; ctx: PageLayerContext }>;
}

const features: ViewerFeature[] = [];

/**
 * Adds a feature to every document the viewer opens. Call it once, at load, from App.tsx (one line per feature). A
 * second call with the same id is ignored.
 */
export function registerViewerFeature(f: ViewerFeature): void {
  if (!features.some((x) => x.id === f.id)) features.push(f);
}

/** The registered features, in the order they were registered. */
export function viewerFeatures(): readonly ViewerFeature[] {
  return features;
}

// ---------------------------------------------------------------------------------------------------------------------
// The store, which connects after the first page
// ---------------------------------------------------------------------------------------------------------------------

type NoteStoreMethod =
  | 'listAnnotations' | 'writeAnnotations'
  | 'saveDraft' | 'listDrafts' | 'claimDrafts' | 'listDraftThreads' | 'discardDraft'
  | 'saveEditDraft' | 'listEditDrafts' | 'claimEditDrafts' | 'discardEditDraft';
type NoteStore = Pick<StoreClient, NoteStoreMethod | 'onChange'>;

/**
 * The store as the session and the draft keeper use it, before it has connected: each call waits for it. With no store
 * (it could not be reached) a call rejects with `no-store`, and the session keeps the notes in memory. Nothing calls
 * it while the PDF is not saved.
 */
function storeWhenReady(ready: Promise<StoreClient | null>): NoteStore {
  const need = async (): Promise<StoreClient> => {
    const s = await ready;
    if (s === null) throw new Error('no-store: the library is not available');
    return s;
  };
  const forward = <K extends NoteStoreMethod>(k: K): StoreClient[K] =>
    ((...args: unknown[]) => need().then((s) => (s[k] as (...a: unknown[]) => unknown)(...args))) as StoreClient[K];
  return {
    listAnnotations: forward('listAnnotations'),
    writeAnnotations: forward('writeAnnotations'),
    saveDraft: forward('saveDraft'),
    listDrafts: forward('listDrafts'),
    claimDrafts: forward('claimDrafts'),
    listDraftThreads: forward('listDraftThreads'),
    discardDraft: forward('discardDraft'),
    saveEditDraft: forward('saveEditDraft'),
    listEditDrafts: forward('listEditDrafts'),
    claimEditDrafts: forward('claimEditDrafts'),
    discardEditDraft: forward('discardEditDraft'),
    onChange(cb) {
      let off: (() => void) | null = null;
      let stopped = false;
      void ready.then((s) => {
        if (s !== null && !stopped) off = s.onChange(cb);
      });
      return () => {
        stopped = true;
        off?.();
      };
    },
  };
}

/** Failures the notes survive (a write that will be retried, a placement that threw). Never the note's text. */
function logNotesError(e: unknown, where: string): void {
  console.warn(`sickofpdfs: notes (${where})`, e instanceof Error ? e.message : String(e));
}

// ---------------------------------------------------------------------------------------------------------------------
// What the mark layer draws
// ---------------------------------------------------------------------------------------------------------------------

const EMPTY_PAGE: MarkLayerPage = { items: [], bold: [], focused: null };

function cmpPos(a: CharPos, b: CharPos): number {
  return a.page - b.page || a.index - b.index;
}

/** The anchor a row is drawn at in this file, or null while it has no placement (or could not be placed). */
function placedAnchor(state: AnnotationState, id: string): Anchor | null {
  const r = state.placement.get(id);
  return r?.placed === true ? r.anchor : null;
}

interface LayerSource extends MarkLayerSource {
  rectsOf(id: string, pageIndex: number): readonly NormRect[];
  /** The marks (not threads) on a page as drawn, for hit-testing a click. */
  marksOn(pageIndex: number): readonly MarkLayerItem[];
  dispose(): void;
}

/**
 * The mark layer's source: from the session's state, what each page draws. Built again only when the state changes,
 * and a page keeps its object while nothing on it changed, so only the pages that changed redraw.
 *
 * Positions and rects come from each row's placement (the anchor re-placed for these bytes), never from a row that
 * has no placement yet: a note is never drawn on text it may not belong to. A text anchor stored without rects (made
 * in claude.ai, contracts §8) gets them here, for the pages that are drawn, and keeps them in memory only.
 */
function createLayerSource(session: AnnotationSession, text: DocumentText, onDrawn: (pageIndex: number, what: 'marks' | 'bold') => void): LayerSource {
  const listeners = new Set<() => void>();
  let built: AnnotationState | null = null;
  let builtVersion = -1;
  let version = 0;
  let pages = new Map<number, MarkLayerPage>();
  let signatures = new Map<number, string>();
  let rectIndex = new Map<string, Map<number, readonly NormRect[]>>();
  /** Rects made on open for anchors stored without them: `${anchorKey}|${page}`. */
  const made = new Map<string, readonly NormRect[] | 'pending'>();
  /** Char counts of pages, for marks that run on over a page break. */
  const counts = new Map<number, number | 'pending'>();
  const ids = new WeakMap<object, number>();
  let nextId = 1;
  let disposed = false;

  const notify = () => {
    version++;
    for (const l of [...listeners]) l();
  };
  const off = session.subscribe(notify);

  const idOf = (o: object): number => {
    let n = ids.get(o);
    if (n === undefined) ids.set(o, (n = nextId++));
    return n;
  };

  function charCount(page: number): number | null {
    const c = counts.get(page);
    if (typeof c === 'number') return c;
    if (c === undefined) {
      counts.set(page, 'pending');
      text.pageText.rawText(page).then(
        (t) => {
          counts.set(page, t.length);
          if (!disposed) notify();
        },
        () => counts.delete(page),
      );
    }
    return null;
  }

  /** The char range of a text anchor on one page, or null while the page's length is not known yet. */
  function rangeOn(a: TextAnchor, page: number): { start: number; end: number } | null {
    const start = page === a.start.page ? a.start.index : 0;
    if (page === a.end.page) return { start, end: a.end.index };
    const n = charCount(page);
    return n === null ? null : { start, end: n };
  }

  /** The rects of a text anchor on one page: as placed, or made now for an anchor stored without them. */
  function rectsOn(a: TextAnchor, page: number): readonly NormRect[] | null {
    const stored = a.rects.find((r) => r.page === page);
    if (stored && stored.rects.length > 0) return stored.rects;
    if (a.rects.some((r) => r.rects.length > 0)) return stored ? stored.rects : null; // rects exist, none on this page
    const key = `${anchorKey(a)}|${page}`;
    const hit = made.get(key);
    if (hit !== undefined) return hit === 'pending' ? null : hit;
    const range = rangeOn(a, page);
    if (range === null) return null;
    made.set(key, 'pending');
    markNormRects(text, page, range.start, range.end - range.start).then(
      (r) => {
        made.set(key, r);
        if (!disposed) notify();
      },
      () => made.delete(key),
    );
    return null;
  }

  function build(state: AnnotationState): void {
    const items = new Map<number, MarkLayerItem[]>();
    const bold = new Map<number, { start: number; end: number }[]>();
    const nextIndex = new Map<string, Map<number, readonly NormRect[]>>();
    const push = (page: number, it: MarkLayerItem) => {
      let list = items.get(page);
      if (!list) items.set(page, (list = []));
      list.push(it);
      let byPage = nextIndex.get(it.id);
      if (!byPage) nextIndex.set(it.id, (byPage = new Map<number, readonly NormRect[]>()));
      byPage.set(page, it.rects);
    };

    // The active comment's passage: highlights over it are drawn in the active fill.
    const activeAnchor = state.active !== null ? placedAnchor(state, state.active) : null;
    const activeRange = activeAnchor?.kind === 'text' ? activeAnchor : null;

    const styled: TextAnchor[] = [];
    for (const m of state.marks) {
      const a = placedAnchor(state, m.id);
      if (a === null) continue;
      if (a.kind === 'area') {
        push(a.page, { id: m.id, style: 'area', color: null, rects: [a.rect] });
        continue;
      }
      if (a.kind !== 'text' || m.style === 'area') continue; // figure marks are drawn by the figure layer (S16)
      styled.push(a);
      for (let p = a.start.page; p <= a.end.page; p++) {
        if (m.style === 'bold') {
          const r = rangeOn(a, p);
          if (r !== null && r.end > r.start) {
            let list = bold.get(p);
            if (!list) bold.set(p, (list = []));
            list.push(r);
          }
          const rects = rectsOn(a, p);
          if (rects !== null) {
            let byPage = nextIndex.get(m.id);
            if (!byPage) nextIndex.set(m.id, (byPage = new Map<number, readonly NormRect[]>()));
            byPage.set(p, rects);
          }
          continue;
        }
        const rects = rectsOn(a, p);
        if (rects === null || rects.length === 0) continue;
        const active = m.style === 'highlight' && activeRange !== null && cmpPos(a.start, activeRange.end) < 0 && cmpPos(activeRange.start, a.end) < 0;
        push(p, { id: m.id, style: m.style, color: m.color, rects, ...(active ? { active } : {}) });
      }
    }

    // A comment whose passage has no style left shows a dotted underline (spec "What a note is made of").
    for (const t of state.threads) {
      const a = placedAnchor(state, t.id);
      if (a?.kind !== 'text') continue;
      const covered = styled.some((s) => cmpPos(s.start, a.end) < 0 && cmpPos(a.start, s.end) < 0);
      for (let p = a.start.page; p <= a.end.page; p++) {
        const rects = rectsOn(a, p);
        if (rects === null || rects.length === 0) continue;
        if (covered) {
          let byPage = nextIndex.get(t.id);
          if (!byPage) nextIndex.set(t.id, (byPage = new Map<number, readonly NormRect[]>()));
          byPage.set(p, rects);
        } else push(p, { id: t.id, style: 'dotted', color: null, rects });
      }
    }

    const nextPages = new Map<number, MarkLayerPage>();
    const nextSigs = new Map<number, string>();
    for (const page of new Set([...items.keys(), ...bold.keys()])) {
      const list = items.get(page) ?? [];
      const ranges = bold.get(page) ?? [];
      // The focus ring goes round the focused mark's rects on this page (a bold mark has rects but no drawn item).
      const ringRects = state.focusedMark !== null ? nextIndex.get(state.focusedMark)?.get(page) : undefined;
      const focused = state.focusedMark !== null && ringRects !== undefined && ringRects.length > 0 ? { id: state.focusedMark as string, rects: ringRects } : null;
      const sig = [
        ...list.map((i) => `${i.id}:${i.style}:${i.color ?? 0}:${i.active === true ? 1 : 0}:${idOf(i.rects)}`),
        ...ranges.map((r) => `b${r.start}-${r.end}`),
        `f${focused === null ? '' : `${focused.id}:${idOf(focused.rects)}`}`,
      ].join('|');
      nextSigs.set(page, sig);
      const prev = pages.get(page);
      nextPages.set(page, prev !== undefined && signatures.get(page) === sig ? prev : { items: list, bold: ranges, focused });
    }
    pages = nextPages;
    signatures = nextSigs;
    rectIndex = nextIndex;
  }

  function current(): void {
    const state = session.state();
    if (state === built && builtVersion === version) return;
    built = state;
    builtVersion = version;
    build(state);
  }

  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    page(pageIndex) {
      current();
      return pages.get(pageIndex) ?? EMPTY_PAGE;
    },
    drawn: onDrawn,
    rectsOf(id, pageIndex) {
      current();
      return rectIndex.get(id)?.get(pageIndex) ?? [];
    },
    marksOn(pageIndex) {
      current();
      const state = session.state();
      const marks = new Set(state.marks.map((m) => m.id as string));
      const page = pages.get(pageIndex);
      const out: MarkLayerItem[] = page ? page.items.filter((i) => marks.has(i.id)) : [];
      // Bold marks have no drawn item; they are hit by their rects.
      for (const m of state.marks) {
        if (m.style !== 'bold') continue;
        const rects = rectIndex.get(m.id)?.get(pageIndex);
        if (rects) out.push({ id: m.id, style: 'highlight', color: null, rects });
      }
      return out;
    },
    dispose() {
      disposed = true;
      off();
      listeners.clear();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// One document's notes
// ---------------------------------------------------------------------------------------------------------------------

export interface NotesDeps {
  backend: PdfBackend;
  opened: OpenedDocument;
  pageText: PageTextProviderImpl;
  view: ViewerStore;
  pageList: RefObject<PageListApi | null>;
  /** The text layer's selection (TextLayerController.selectionRanges). */
  selection(): CharRange[];
  /** ViewerContext.save: Task 30's controller, null until then. */
  save: SaveController | null;
}

export interface Notes {
  host: NotesHost;
  layer: MarkLayerSource;
  input: MarkInput;
  /** What the marks and every registered feature do for their commands. */
  behaviours(): Partial<Record<ViewerCommandId, CommandBehaviour>>;
  /** The right-hand space the features keep free (reserveRight), in CSS px. */
  reservedRight(this: void): number;
  onLayout(this: void, cb: () => void): () => void;
  dispose(): void;
}

/** The notes of the open document, or null in Incognito (no notes there at all). */
export function createNotes(d: NotesDeps): Notes | null {
  if (isIncognito()) return null;
  const doc = d.opened.open.doc;
  const pages = d.opened.open.pages;
  const gate = notesSaveGate(d.save);
  const presence = createTabPresence();
  const store = storeWhenReady(whenStore());
  const drafts = createDraftKeeper({
    store,
    presence,
    memoryOnly: () => gate.save?.state.kind !== 'saved',
    onError: (_id, e) => logNotesError(e, 'drafts'),
  });
  const text: DocumentText = { pageText: d.pageText, pages };
  const figures = createDocumentFigures({ backend: d.backend, doc, pages });
  const textAnchor = createTextAnchorMaker(text);
  const session = createAnnotationSession({
    store,
    save: gate.save,
    anchors: createAnchorContext(text, figures),
    drafts,
    presence,
    makeTextAnchor: textAnchor,
    documentId: gate.documentId,
    incognito: false,
    now: () => Date.now(),
    planStyle,
    resolveAnchor,
    onError: logNotesError,
  });

  let input: MarkInput | null = null;
  const layer = createLayerSource(session, text, (pageIndex, what) => input?.drawn(pageIndex, what));

  const reserved = new Map<string, number>();
  const layoutListeners = new Set<() => void>();
  let lastColor = readLastColor();

  const host: NotesHost = {
    session,
    backend: d.backend,
    doc,
    pages,
    pageText: d.pageText,
    figures,
    view: d.view,
    pageList: d.pageList,
    selection: () => d.selection(),
    textAnchor,
    lastColor: () => lastColor,
    pointer: () => input?.pointer() ?? null,
    rectsOf: (id, pageIndex) => layer.rectsOf(id, pageIndex),
    reserveRight(featureId, px) {
      const before = reserved.get(featureId) ?? 0;
      const next = Math.max(0, px);
      if (before === next) return;
      if (next === 0) reserved.delete(featureId);
      else reserved.set(featureId, next);
      for (const l of [...layoutListeners]) l();
    },
  };

  input = createMarkInput({
    session,
    layer,
    pages,
    pageList: d.pageList,
    selection: () => d.selection(),
    lastColor: () => lastColor,
    setLastColor(c) {
      lastColor = c;
      writeLastColor(c);
    },
    warm(pageIndex) {
      if (pageIndex >= 0 && pageIndex < pages.length) d.pageText.rawText(pageIndex).catch(() => {});
    },
  });
  const mounted = input;

  return {
    host,
    layer,
    input: mounted,
    behaviours() {
      const out: Partial<Record<ViewerCommandId, CommandBehaviour>> = { ...mounted.behaviours() };
      for (const f of features) Object.assign(out, f.commands?.(host) ?? {});
      return out;
    },
    reservedRight: () => [...reserved.values()].reduce((a, b) => a + b, 0),
    onLayout(cb) {
      layoutListeners.add(cb);
      return () => layoutListeners.delete(cb);
    },
    dispose() {
      mounted.dispose();
      layer.dispose();
      session.dispose();
      drafts.dispose();
      presence.close();
      figures.dispose();
      layoutListeners.clear();
    },
  };
}
