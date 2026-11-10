// A reading's own page in the web library (/d/<sha>?page=N#c=<thread>): what it is, its notes and marks, and its page text.
//
// - Notes: every note on the reading, by page, as the viewer's notes panel shows them (Docs' comment cards). Add a note on a
//   page or on the whole reading, reply, edit your own words, delete (with Undo). Claude's comments are never rewritten (R57).
//   Every change goes into this tab's library and on to the cloud at once (the top bar says "Saving…", then "Saved").
//   A note's unsent text is kept in this browser until it is sent.
// - Marks: highlights and the other marks, with their passage, beside the notes of their page.
// - Page text: the reading's text from the cloud, page by page, read only.
// The PDF itself opens on the web in the next round (CL14); until then the page says so where its Open button will be.
import type { CommentId, CommentRow, DocumentId, DocumentRow, LocationRow, MarkRow, ThreadId, ThreadRow } from '@sop/core';
import { FileTypeIcon, IconButton, NoteBox, TextButton, ThreadCard } from '@sop/ui';
import { ContentCard, EmptyState, PageTitle } from '@sop/ui/library';
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLibrary } from '@ext/library/app/context';
import { formatAuthors, formatPages } from '@ext/library/components/format';
import { onWhat } from '@ext/library/pages/Notes/NoteCard';
import notesStyles from '@ext/library/pages/Notes/Notes.module.css';
import { shownTitle } from '@ext/shared/shown-title';
import { routeHref } from '@ext/library/routes/routes';
import { api, ownFetch } from '../sync/api';
import { webLibrary } from '../sync/engine';
import { goTo, readingHref, webViewerHref } from '../platform/web-route';
import { downloadPdf } from '../viewer/download';
import { clearDraft, readDraft, writeDraft } from './drafts';
import styles from './ReadingPage.module.css';

type Tab = 'notes' | 'text';

interface Loaded {
  doc: DocumentRow;
  link: string | null;
  marks: MarkRow[];
  threads: ThreadRow[];
  comments: CommentRow[];
}

const KIND_WORD: Record<DocumentRow['kind'], string> = { paper: 'Paper', book: 'Book', slides: 'Slides', other: 'PDF' };

const newId = () => crypto.randomUUID();

/** The page a note or mark is on (0-based), or null for the whole reading. */
function pageOf(thread: ThreadRow): number | null {
  if (thread.pageIndex !== null) return thread.pageIndex;
  const a = thread.anchor;
  return 'page' in a ? a.page : a.kind === 'text' ? (a.start.page ?? null) : null;
}

function useReading(sha: string): { state: 'loading' | 'missing' | 'ready'; loaded: Loaded | null; reload: () => void } {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [state, setState] = useState<'loading' | 'missing' | 'ready'>('loading');
  const load = useCallback(async () => {
    const { store } = webLibrary();
    const id = sha as DocumentId;
    const doc = await store.getDocument(id);
    if (doc === null) {
      setState('missing');
      return;
    }
    const [notes, places] = await Promise.all([store.listAnnotations(id), store.listLocations(id).catch(() => [] as LocationRow[])]);
    const newest = places.reduce<LocationRow | null>((best, l) => (best === null || l.lastSeen > best.lastSeen ? l : best), null);
    const link = newest !== null && /^https?:/i.test(newest.raw) ? newest.raw : null;
    setLoaded({ doc, link, ...notes });
    setState('ready');
  }, [sha]);
  useEffect(() => {
    void load().catch(() => setState('missing'));
    return webLibrary().store.onChange((c) => {
      if (c.documentId === undefined || c.documentId === sha || c.table === 'documents') void load().catch(() => {});
    });
  }, [load, sha]);
  return { state, loaded, reload: () => void load() };
}

export function ReadingPage({ sha, page, note }: { sha: string; page: number | null; note: string | null }) {
  const { state, loaded } = useReading(sha);
  const [tab, setTab] = useState<Tab>(page !== null && note === null ? 'text' : 'notes');
  const title = loaded ? shownTitle(loaded.doc.title, loaded.link) : '';
  useEffect(() => {
    if (title !== '') document.title = `${title} - sickofpdfs`;
  }, [title]);

  if (state === 'missing') {
    return (
      <ContentCard header={<PageTitle title="Reading" />}>
        <EmptyState icon="search_off" title="This reading isn’t in your library" actions={<TextButton label="Go to My library" variant="tonal" onClick={() => goTo(`/${routeHref('library')}`)} />}>
          <p>It may have been removed, or it was never saved to your cloud.</p>
        </EmptyState>
      </ContentCard>
    );
  }
  if (loaded === null) return <ContentCard>{null}</ContentCard>;
  return <Reading loaded={loaded} title={title} tab={tab} setTab={setTab} page={page} note={note} />;
}

function Reading({ loaded, title, tab, setTab, page, note }: { loaded: Loaded; title: string; tab: Tab; setTab: (t: Tab) => void; page: number | null; note: string | null }) {
  const { doc, link } = loaded;
  const inCloud = usePdfInCloud(doc.id);
  const { notify } = useLibrary();
  const { store } = webLibrary();
  const noteCount = loaded.threads.length;
  const facts = [formatAuthors(doc.authors), doc.year !== null ? String(doc.year) : '', formatPages(doc.pageCount), KIND_WORD[doc.kind]].filter((s) => s !== '');
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const TABS: { id: Tab; label: string }[] = [
    { id: 'notes', label: noteCount === 0 ? 'Notes' : `Notes (${noteCount})` },
    { id: 'text', label: 'Page text' },
  ];
  const onTabKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = TABS[(TABS.findIndex((t) => t.id === tab) + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    if (next === undefined) return;
    setTab(next.id);
    tabRefs.current[TABS.indexOf(next)]?.focus();
  };

  const star = () => {
    void store.setStarred(doc.id, !doc.starred).then(
      () => notify({ text: doc.starred ? 'Removed from Starred' : 'Added to Starred' }),
      () => notify({ text: 'That didn’t work. Try again.' }),
    );
  };

  const header = (
    <>
      <PageTitle
        title={title}
        end={
          <>
            <IconButton icon="star" label={doc.starred ? 'Remove from Starred' : 'Add to Starred'} pressed={doc.starred} size={40} onClick={star} />
          </>
        }
      />
      <div role="tablist" aria-label="What to show" className={notesStyles.tabs} onKeyDown={onTabKey}>
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`reading-tab-${t.id}`}
            aria-selected={t.id === tab}
            aria-controls="reading-panel"
            tabIndex={t.id === tab ? 0 : -1}
            className={notesStyles.tab}
            onClick={() => setTab(t.id)}
          >
            <span className={notesStyles.tabLabel}>{t.label}</span>
          </button>
        ))}
      </div>
    </>
  );

  return (
    <ContentCard header={header}>
      <div id="reading-panel" role="tabpanel" aria-labelledby={`reading-tab-${tab}`} className={styles.column}>
        <section className={styles.about} aria-label="About this reading">
          <FileTypeIcon kind="pdf" size={24} />
          <div className={styles.aboutText}>
            <p className={styles.facts}>{facts.join(' · ')}</p>
            {link !== null && (
              <a className={styles.source} href={link} target="_blank" rel="noopener noreferrer">
                {hostOf(link)}
              </a>
            )}
          </div>
          <div className={styles.open}>
            {inCloud !== false ? (
              <div className={styles.openButtons}>
                <TextButton label="Download" icon="download" onClick={() => downloadPdf({ sha: doc.id, name: title })} />
                <TextButton label="Open PDF" icon="open_in_new" variant="tonal" onClick={() => location.assign(webViewerHref(doc.id, { name: title, page }))} />
              </div>
            ) : (
              <>
                <TextButton label="Open PDF" icon="open_in_new" variant="tonal" disabled />
                <span className={styles.openSoon}>The PDF isn’t in your cloud yet. It is on the computer you saved it on.</span>
              </>
            )}
          </div>
        </section>
        {tab === 'notes' ? <NotesTab loaded={loaded} focusNote={note} onShowPage={(p) => goTo(readingHref(doc.id, { page: p + 1 }), { replace: false })} /> : <TextTab doc={doc} loaded={loaded} startPage={page} />}
      </div>
    </ContentCard>
  );
}

/**
 * Whether the cloud holds this reading's PDF (`blob_stored` is each copy's own, so the row cannot say): a HEAD to its address.
 * Null while asking, or when the cloud could not say (then "Open PDF" is offered, and the viewer says what it finds).
 */
function usePdfInCloud(sha: string): boolean | null {
  const [held, setHeld] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    ownFetch(`/api/blobs/${sha}`, { method: 'HEAD', cache: 'no-store' }).then(
      (r) => live && setHeld(r.ok ? true : r.status === 404 ? false : null),
      () => live && setHeld(null),
    );
    return () => {
      live = false;
    };
  }, [sha]);
  return held;
}

function hostOf(link: string): string {
  try {
    return `From ${new URL(link).hostname.replace(/^www\./, '')}`;
  } catch {
    return 'Original link';
  }
}

// ─── Notes ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Group {
  page: number | null;
  threads: { thread: ThreadRow; comments: CommentRow[] }[];
  marks: MarkRow[];
}

function groupsOf(loaded: Loaded): Group[] {
  const byPage = new Map<number | null, Group>();
  const group = (page: number | null) => {
    let g = byPage.get(page);
    if (g === undefined) {
      g = { page, threads: [], marks: [] };
      byPage.set(page, g);
    }
    return g;
  };
  const commentsOf = new Map<string, CommentRow[]>();
  for (const c of loaded.comments) commentsOf.set(c.threadId, [...(commentsOf.get(c.threadId) ?? []), c]);
  for (const t of loaded.threads) {
    const comments = (commentsOf.get(t.id) ?? []).sort((a, b) => a.createdAt - b.createdAt);
    if (comments.length === 0) continue;
    group(pageOf(t)).threads.push({ thread: t, comments });
  }
  // A mark whose passage a note is on shows once, as the note's quote.
  const quoted = new Set(loaded.threads.map((t) => (t.anchor.kind === 'text' ? `${t.pageIndex}:${t.anchor.quote.quote}` : '')));
  for (const m of loaded.marks) if (m.anchor.kind === 'text' && !quoted.has(`${m.pageIndex}:${m.anchor.quote.quote}`)) group(m.pageIndex).marks.push(m);
  for (const g of byPage.values()) {
    g.threads.sort((a, b) => (a.thread.sortKey ?? 0) - (b.thread.sortKey ?? 0) || a.thread.createdAt - b.thread.createdAt);
    g.marks.sort((a, b) => a.sortKey - b.sortKey);
  }
  return [...byPage.values()].sort((a, b) => (a.page ?? -1) - (b.page ?? -1));
}

const MARK_WORD: Record<MarkRow['style'], string> = { highlight: 'Highlight', underline: 'Underline', bold: 'Bold', strike: 'Strikethrough', area: 'Area' };

function NotesTab({ loaded, focusNote, onShowPage }: { loaded: Loaded; focusNote: string | null; onShowPage: (page: number) => void }) {
  const { doc } = loaded;
  const { notify } = useLibrary();
  const { store } = webLibrary();
  const groups = useMemo(() => groupsOf(loaded), [loaded]);
  const [active, setActive] = useState<string | null>(focusNote);
  const [editing, setEditing] = useState<{ id: CommentId; body: string } | null>(null);
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [composing, setComposing] = useState(() => readDraft(doc.id, 'new') !== '');
  const now = Date.now();

  // A note named in the address (#c=<id>): show it open and bring it into view.
  useEffect(() => {
    if (focusNote === null) return;
    setActive(focusNote);
    requestAnimationFrame(() => document.getElementById(`note-${focusNote}`)?.scrollIntoView({ block: 'center' }));
  }, [focusNote]);

  const failed = () => notify({ text: 'That didn’t save. Check your connection and try again.' });

  const reply = (thread: ThreadRow, body: string) => {
    const text = body.trim();
    if (text === '') return;
    const t = Date.now();
    const row: CommentRow = { id: newId() as CommentId, threadId: thread.id, documentId: doc.id, author: 'me', body: text, draftOfTab: null, meta: {}, createdAt: t, editedAt: null, deletedAt: null, rev: 0, hlc: '' };
    void store.writeAnnotations([{ table: 'comments', op: 'upsert', row }]).then(() => {
      clearDraft(doc.id, thread.id);
      setReplies((r) => ({ ...r, [thread.id]: '' }));
    }, failed);
  };

  const saveEdit = (comments: CommentRow[], body: string) => {
    const c = comments.find((x) => x.id === editing?.id);
    const text = body.trim();
    if (c === undefined || c.author !== 'me' || text === '') return;
    void store.writeAnnotations([{ table: 'comments', op: 'upsert', row: { ...c, body: text, editedAt: Date.now() } }]).then(() => setEditing(null), failed);
  };

  const remove = (thread: ThreadRow, comments: CommentRow[], id: CommentId) => {
    const isRoot = comments[0]?.id === id;
    const ops = isRoot
      ? [{ table: 'threads' as const, op: 'soft-delete' as const, row: thread }, ...comments.map((c) => ({ table: 'comments' as const, op: 'soft-delete' as const, row: c }))]
      : comments.filter((c) => c.id === id).map((c) => ({ table: 'comments' as const, op: 'soft-delete' as const, row: c }));
    void store.writeAnnotations(ops).then(
      () =>
        notify({
          text: isRoot ? 'Note deleted' : 'Reply deleted',
          action: { label: 'Undo', onClick: () => void store.writeAnnotations(ops.map((o) => ({ ...o, op: 'restore' as const }))).catch(failed) },
        }),
      failed,
    );
  };

  return (
    <div className={styles.notes}>
      {composing ? (
        <NewNote doc={doc} onDone={() => setComposing(false)} onSent={(id) => setActive(id)} />
      ) : (
        <div className={styles.addRow}>
          <TextButton label="Add a note" icon="add_comment" variant="tonal" onClick={() => setComposing(true)} />
        </div>
      )}
      {groups.length === 0 && !composing && (
        <EmptyState icon="comment" title="No notes on this reading yet">
          <p>Add a note here, or select text in the PDF in Chrome. Notes show on every computer and phone you use.</p>
        </EmptyState>
      )}
      {groups.map((g) => (
        <section key={g.page ?? 'doc'} className={styles.group} aria-label={g.page === null ? 'Whole document' : `Page ${g.page + 1}`}>
          <h2 className={styles.groupHead}>
            {g.page === null ? (
              'Whole document'
            ) : (
              <button type="button" className={styles.pageLink} onClick={() => onShowPage(g.page!)} title="Show this page’s text">
                Page {g.page + 1}
              </button>
            )}
          </h2>
          {g.marks.map((m) => (
            <MarkLine key={m.id} mark={m} />
          ))}
          {g.threads.map(({ thread, comments }) => {
            const isActive = active === thread.id;
            const draft = replies[thread.id] ?? readDraft(doc.id, thread.id);
            const what = onWhat(thread.anchor);
            return (
              <ThreadCard
                key={thread.id}
                id={`note-${thread.id}`}
                className={styles.card}
                comments={comments}
                active={isActive}
                onActivate={() => setActive(thread.id)}
                onDeactivate={() => setActive(null)}
                quote={what}
                draft={isActive ? draft : draft === '' ? null : draft}
                onDraftChange={(body) => {
                  setReplies((r) => ({ ...r, [thread.id]: body }));
                  writeDraft(doc.id, thread.id, body);
                }}
                onDraftSend={(body) => reply(thread, body)}
                onDraftCancel={() => {
                  setReplies((r) => ({ ...r, [thread.id]: '' }));
                  clearDraft(doc.id, thread.id);
                }}
                editing={isActive ? editing : null}
                onEditStart={(id) => {
                  const c = comments.find((x) => x.id === id);
                  if (c !== undefined && c.author === 'me') setEditing({ id, body: c.body });
                }}
                onEditChange={(body) => setEditing((e) => (e === null ? null : { ...e, body }))}
                onEditSave={(body) => saveEdit(comments, body)}
                onEditCancel={() => setEditing(null)}
                onDelete={(id) => remove(thread, comments, id)}
                replyPlaceholder="Reply"
                now={now}
              />
            );
          })}
        </section>
      ))}
    </div>
  );
}

function MarkLine({ mark }: { mark: MarkRow }) {
  const quote = mark.anchor.kind === 'text' ? mark.anchor.quote.quote.replace(/\s+/g, ' ').trim() : '';
  if (quote === '') return null;
  return (
    <p className={styles.mark} data-style={mark.style} data-color={mark.color ?? 0}>
      <span className={styles.markWord}>{MARK_WORD[mark.style]}</span>
      <span className={styles.markQuote}>{quote}</span>
    </p>
  );
}

/** A new note: on a page, or on the whole reading. Its text is kept in this browser until it is sent. */
function NewNote({ doc, onDone, onSent }: { doc: DocumentRow; onDone: () => void; onSent: (threadId: string) => void }) {
  const { notify } = useLibrary();
  const { store } = webLibrary();
  const [body, setBody] = useState(() => readDraft(doc.id, 'new'));
  const [where, setWhere] = useState<string>(() => readDraft(doc.id, 'new-page') || 'doc');
  const [sending, setSending] = useState(false);
  const send = (text: string) => {
    const words = text.trim();
    if (words === '' || sending) return;
    setSending(true);
    const t = Date.now();
    const page = where === 'doc' ? null : Number(where);
    const thread: ThreadRow = {
      id: newId() as ThreadId,
      documentId: doc.id,
      anchor: page === null ? { kind: 'document' } : { kind: 'page', page },
      pageIndex: page,
      // after the notes on passages of the same page
      sortKey: 1,
      placement: 'placed',
      draftOfTab: null,
      createdAt: t,
      updatedAt: t,
      deletedAt: null,
      rev: 0,
      hlc: '',
    };
    const comment: CommentRow = { id: newId() as CommentId, threadId: thread.id, documentId: doc.id, author: 'me', body: words, draftOfTab: null, meta: {}, createdAt: t, editedAt: null, deletedAt: null, rev: 0, hlc: '' };
    void store
      .writeAnnotations([
        { table: 'threads', op: 'upsert', row: thread },
        { table: 'comments', op: 'upsert', row: comment },
      ])
      .then(
        () => {
          clearDraft(doc.id, 'new');
          clearDraft(doc.id, 'new-page');
          onSent(thread.id);
          onDone();
        },
        () => {
          setSending(false);
          notify({ text: 'That didn’t save. Your words are still in the box. Try again.' });
        },
      );
  };
  const pages = Array.from({ length: Math.max(0, doc.pageCount) }, (_, i) => i);
  return (
    <div className={styles.compose}>
      <label className={styles.where}>
        <span>On</span>
        <select
          className={styles.select}
          value={where}
          onChange={(e) => {
            setWhere(e.target.value);
            writeDraft(doc.id, 'new-page', e.target.value === 'doc' ? '' : e.target.value);
          }}
        >
          <option value="doc">Whole document</option>
          {pages.map((p) => (
            <option key={p} value={String(p)}>
              Page {p + 1}
            </option>
          ))}
        </select>
      </label>
      <NoteBox
        value={body}
        onChange={(v) => {
          setBody(v);
          writeDraft(doc.id, 'new', v);
        }}
        onSend={send}
        onCancel={() => {
          clearDraft(doc.id, 'new');
          clearDraft(doc.id, 'new-page');
          onDone();
        }}
        variant="note"
        autoFocus
      />
    </div>
  );
}

// ─── Page text ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface TextPage {
  pageIndex: number;
  text: string;
}

const STEP = 8;

function TextTab({ doc, loaded, startPage }: { doc: DocumentRow; loaded: Loaded; startPage: number | null }) {
  const [pages, setPages] = useState<TextPage[]>([]);
  const [next, setNext] = useState<number | null>(startPage !== null ? Math.max(0, startPage - 1) : 0);
  const [first, setFirst] = useState<number>(startPage !== null ? Math.max(0, startPage - 1) : 0);
  const [state, setState] = useState<'loading' | 'ready' | 'none' | 'failed'>('loading');
  const busy = useRef(false);
  const notesOnPage = useMemo(() => {
    const m = new Map<number, number>();
    for (const t of loaded.threads) {
      const p = pageOf(t);
      if (p !== null) m.set(p, (m.get(p) ?? 0) + 1);
    }
    return m;
  }, [loaded.threads]);

  const loadFrom = useCallback(
    async (from: number, prepend = false) => {
      if (busy.current) return;
      busy.current = true;
      try {
        const r = await api<{ pages: TextPage[]; nextFromIndex: number | null }>(`/api/documents/${doc.id}/pages?from=${from}&to=${from + STEP - 1}&maxChars=200000`);
        setPages((old) => {
          const seen = new Set(old.map((p) => p.pageIndex));
          const add = r.pages.filter((p) => !seen.has(p.pageIndex));
          return prepend ? [...add, ...old] : [...old, ...add];
        });
        if (!prepend) setNext(r.nextFromIndex);
        setState((s) => (r.pages.length === 0 && s === 'loading' ? 'none' : 'ready'));
      } catch {
        setState((s) => (s === 'loading' ? 'failed' : s));
      } finally {
        busy.current = false;
      }
    },
    [doc.id],
  );

  useEffect(() => {
    void loadFrom(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, from where the address says
  }, []);

  useEffect(() => {
    if (startPage === null || pages.length === 0) return;
    document.getElementById(`page-${startPage - 1}`)?.scrollIntoView({ block: 'start' });
  }, [startPage, pages.length]);

  const earlier = () => {
    const from = Math.max(0, first - STEP);
    setFirst(from);
    void loadFrom(from, true);
  };

  if (state === 'none' || !doc.hasText) {
    return (
      <EmptyState icon="description" title="No page text in your cloud yet">
        <p>The text comes from Chrome once the PDF has been opened and saved there. A scan has text after its words are read.</p>
      </EmptyState>
    );
  }
  if (state === 'failed') {
    return (
      <EmptyState icon="cloud_off" title="Couldn’t get the page text" actions={<TextButton label="Try again" variant="tonal" onClick={() => void loadFrom(next ?? 0)} />}>
        <p>Your cloud can’t be reached right now.</p>
      </EmptyState>
    );
  }
  return (
    <div className={styles.text}>
      {first > 0 && pages.length > 0 && <TextButton label={`Show pages before ${first + 1}`} icon="keyboard_arrow_up" onClick={earlier} />}
      {pages.map((p) => (
        <article key={p.pageIndex} id={`page-${p.pageIndex}`} className={styles.page} aria-label={`Page ${p.pageIndex + 1}`}>
          <h2 className={styles.pageHead}>
            <span>Page {p.pageIndex + 1}</span>
            {(notesOnPage.get(p.pageIndex) ?? 0) > 0 && <span className={styles.pageNotes}>{notesOnPage.get(p.pageIndex) === 1 ? '1 note' : `${notesOnPage.get(p.pageIndex)} notes`}</span>}
          </h2>
          <PageText text={p.text} />
        </article>
      ))}
      {next !== null && pages.length > 0 && <MoreOnView onView={() => void loadFrom(next)} />}
    </div>
  );
}

/** The page's words as paragraphs: a blank line (or a line ending a sentence before a short one) starts a new one. */
function PageText({ text }: { text: string }): ReactNode {
  const paras = text
    .replace(/\r/g, '')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/-\n(?=\p{Ll})/gu, '').replace(/\s*\n\s*/g, ' ').trim())
    .filter((p) => p !== '');
  if (paras.length === 0) return <p className={styles.empty}>This page has no text.</p>;
  return (
    <div className={styles.words}>
      {paras.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </div>
  );
}

/** Loads more pages when the end of the list comes into view. */
function MoreOnView({ onView }: { onView: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const io = new IntersectionObserver((e) => {
      if (e.some((x) => x.isIntersecting)) onView();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [onView]);
  return (
    <div ref={ref} className={styles.more}>
      Loading more pages…
    </div>
  );
}
