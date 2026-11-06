// The body of "About this PDF" (R92), the same in the library's details panel and in the viewer's: the title (it can be
// renamed), authors and year; the tags; "Your context"; the details (kind, course, year, DOI or arXiv id, pages, first and
// last opened, reading time); where it came from; and the 5 related readings. It uses only the shared components, so the
// dark viewer and the light library both draw it in their own colours.
import type { DocumentId, LocationRow } from '@sop/core';
import { FileTypeIcon, IconButton, TextButton, TextField } from '@sop/ui';
import { type ReactNode, useEffect, useState } from 'react';
import { shownTitle } from '../../shared/shown-title';
import { SAVED_THOUGH_NOT_LEARNING } from '../../store/reading-flags';
import { formatReadingTime } from '../components/format';
import { bareName } from '../tags/tag-format';
import { TagEditor } from '../tags/TagEditor';
import type { TagsData } from '../tags/tags-data';
import { useReadingTags } from '../tags/use-tags';
import styles from './AboutDetails.module.css';
import type { AboutData, AboutDetails as Details, RelatedReading } from './about-data';

export interface AboutDetailsProps {
  documentId: DocumentId;
  about: AboutData;
  tags: TagsData | null;
  say(this: void, text: string, undo?: () => void): void;
  /** A related reading was clicked. */
  onOpenRelated(this: void, r: RelatedReading): void;
  /** The "Your context" box: the library's writes to the store, the viewer's go through its notes. */
  contextBox: ReactNode;
  /** The first page, at the top (the library's panel); `stored` says whether a copy of the PDF is kept. */
  thumbnail?(this: void, stored: boolean): ReactNode;
}

export const KIND_ONE: Record<Details['doc']['kind'], string> = { paper: 'Paper', book: 'Book', slides: 'Slides', other: 'Other' };

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
/** "2 Nov 2026, 07:12": short enough for one line of the details. */
const formatWhen = (t: number): string => when.format(t);

/** The details, kept up to date with changes from any tab. */
export function useAboutDetails(about: AboutData, documentId: DocumentId): { details: Details | null; missing: boolean; related: RelatedReading[] | null } {
  const [state, setState] = useState<{ id: DocumentId; details: Details | null; missing: boolean; related: RelatedReading[] | null } | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      void Promise.all([about.details(documentId), about.related(documentId, 5).catch(() => [])]).then(
        ([details, related]) => live && setState({ id: documentId, details, missing: details === null, related }),
        () => live && setState((s) => s ?? { id: documentId, details: null, missing: true, related: null }),
      );
    };
    load();
    const stop = about.onReadingChange(documentId, () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(load, 120);
    });
    return () => {
      live = false;
      stop();
      if (timer !== null) clearTimeout(timer);
    };
  }, [about, documentId]);
  const mine = state !== null && state.id === documentId ? state : null;
  return { details: mine?.details ?? null, missing: mine?.missing ?? false, related: mine?.related ?? null };
}

export function AboutDetails({ documentId, about, tags, say, onOpenRelated, contextBox, thumbnail }: AboutDetailsProps) {
  const { details, missing, related } = useAboutDetails(about, documentId);
  const ids = useIds(documentId);
  const readingTags = useReadingTags(tags, ids).get(documentId) ?? [];
  if (missing) return <p className={styles.note}>This reading isn’t in your library any more.</p>;
  if (details === null) return <div className={styles.loading} aria-busy="true" />;
  const { doc, locations, reading } = details;
  const link = locations[0]?.raw ?? null;
  const title = shownTitle(doc.title, link);
  const courses = readingTags.filter((t) => t.kind === 'course').map((t) => bareName(t.name));
  const visited = reading?.pagesVisited.length ?? 0;
  // R102: a reading saved without searchable text, or saved although it doesn't look like a learning PDF, is never related to
  // others. It says so, rather than promising related readings that will never come.
  const keptOut = !doc.indexText || (Array.isArray(doc.saveReasons) && doc.saveReasons.includes(SAVED_THOUGH_NOT_LEARNING));
  // R103: the earlier version of a web page has its own row under "Where it came from", so it is not listed again here.
  const relatedShown = related?.filter((r) => r.id !== details.earlier?.id && r.id !== details.notesMovedTo?.id) ?? null;

  return (
    <div className={styles.details}>
      {thumbnail !== undefined && <div className={styles.thumb}>{thumbnail(doc.blobStored)}</div>}
      <TitleBlock title={title} authors={doc.authors} year={doc.year} onRename={(t) => about.setTitle(documentId, t)} say={say} />

      {tags !== null && (
        <Section title="Tags">
          <TagEditor tags={tags} documentIds={ids} say={say} />
        </Section>
      )}

      <Section title="Your context">{contextBox}</Section>

      <Section title="Details">
        <dl className={styles.facts}>
          <Fact label="Kind">{details.webPage ? 'Web page' : KIND_ONE[doc.kind]}</Fact>
          <Fact label={courses.length > 1 ? 'Courses' : 'Course'}>{courses.length === 0 ? '—' : courses.join(', ')}</Fact>
          <Fact label="Authors">{doc.authors.length === 0 ? '—' : doc.authors.join(', ')}</Fact>
          <Fact label="Year">{doc.year ?? '—'}</Fact>
          {doc.doi !== null && (
            <Fact label="DOI">
              <ExternalLink href={`https://doi.org/${doc.doi}`}>{doc.doi}</ExternalLink>
            </Fact>
          )}
          {doc.arxivId !== null && (
            <Fact label="arXiv">
              <ExternalLink href={`https://arxiv.org/abs/${doc.arxivId}`}>{doc.arxivId}</ExternalLink>
            </Fact>
          )}
          <Fact label="Pages">
            {doc.pageCount}
            {visited > 0 && <span className={styles.aside}> · you have looked at {visited === doc.pageCount ? 'all of them' : visited}</span>}
          </Fact>
          <Fact label="First opened">{formatWhen(details.firstOpened)}</Fact>
          <Fact label="Last opened">{formatWhen(details.lastOpened)}</Fact>
          <Fact label="Reading time">{reading === null || reading.readingMs === 0 ? '—' : formatReadingTime(reading.readingMs)}</Fact>
        </dl>
      </Section>

      <Section title="Where it came from">
        {locations.length === 0 ? (
          details.webPage ? (
            // When the notes moved, the line below says so, with the newer version under it.
            details.notesMovedTo === null && <p className={styles.note}>Saved from a web page. A newer version of it is in your library now.</p>
          ) : (
            <p className={styles.note}>It was added from a file. No link was kept.</p>
          )
        ) : (
          <Places locations={locations} webPage={details.webPage} />
        )}
        {details.notesMovedTo !== null && (
          <div className={styles.earlier}>
            <p className={styles.movedNote}>Your notes moved to the newer version.</p>
            <button type="button" className={styles.relatedRow} onClick={() => details.notesMovedTo !== null && onOpenRelated(details.notesMovedTo)} title={`Open the newer version, saved ${formatWhen(details.notesMovedTo.savedAt)}`}>
              <FileTypeIcon kind="pdf" size={24} />
              <span className={styles.relatedText}>
                <span className={styles.relatedTitle}>{details.notesMovedTo.title}</span>
                <span className={styles.relatedMeta}>Newer version · saved {formatWhen(details.notesMovedTo.savedAt)}</span>
              </span>
            </button>
          </div>
        )}
        {details.earlier !== null && (
          <div className={styles.earlier}>
            <span className={styles.placeKind}>Earlier version</span>
            <button type="button" className={styles.relatedRow} onClick={() => details.earlier !== null && onOpenRelated(details.earlier)} title={`Open the earlier version, saved ${formatWhen(details.earlier.savedAt)}`}>
              <FileTypeIcon kind="pdf" size={24} />
              <span className={styles.relatedText}>
                <span className={styles.relatedTitle}>{details.earlier.title}</span>
                <span className={styles.relatedMeta}>Saved {formatWhen(details.earlier.savedAt)}</span>
              </span>
            </button>
          </div>
        )}
      </Section>

      <Section title="Related readings">
        {keptOut ? (
          <p className={styles.note}>This PDF is kept out of related readings and topics, because it doesn’t look like a learning PDF.</p>
        ) : relatedShown === null || relatedShown.length === 0 ? (
          <p className={styles.note}>Readings close to this one in meaning show here once sickofpdfs has read a few of your PDFs.</p>
        ) : (
          <ul className={styles.related}>
            {relatedShown.map((r) => (
              <li key={r.id}>
                <button type="button" className={styles.relatedRow} onClick={() => onOpenRelated(r)} title={`Open “${r.title}”`}>
                  <FileTypeIcon kind="pdf" size={24} />
                  <span className={styles.relatedText}>
                    <span className={styles.relatedTitle}>{r.title}</span>
                    <span className={styles.relatedMeta}>{[authorsShort(r.authors), r.year].filter((x) => x !== '' && x !== null).join(' · ') || ' '}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <p className={styles.footnote}>Your PDF file is never changed.</p>
    </div>
  );
}

/** One id, kept as the same array between renders (the tag hooks re-ask when their list changes). */
function useIds(id: DocumentId): readonly DocumentId[] {
  const [ids, setIds] = useState<readonly DocumentId[]>([id]);
  useEffect(() => setIds((cur) => (cur[0] === id ? cur : [id])), [id]);
  return ids[0] === id ? ids : [id];
}

function authorsShort(authors: readonly string[]): string {
  const names = authors.map((a) => a.trim()).filter(Boolean);
  if (names.length === 0) return '';
  const last = (n: string) => n.split(/\s+/u).pop() ?? n;
  if (names.length === 1) return names[0] ?? '';
  if (names.length === 2) return `${last(names[0] ?? '')} and ${last(names[1] ?? '')}`;
  return `${last(names[0] ?? '')} et al.`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section} aria-label={title}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className={styles.label}>{label}</dt>
      <dd className={styles.value}>{children}</dd>
    </>
  );
}

/** A link the owner chose to follow: it opens in a new tab. Nothing is fetched until it is clicked. */
function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className={styles.link} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** A link as people read it: the site and the path, without "https://". */
function shortLink(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/u, '$1');
    return `${u.host}${u.pathname === '/' ? '' : decodeURIComponent(u.pathname)}`;
  } catch {
    return raw;
  }
}

function Places({ locations, webPage }: { locations: readonly LocationRow[]; webPage: boolean }) {
  return (
    <ul className={styles.places}>
      {locations.slice(0, 5).map((l) => (
        <li key={l.id} className={styles.place}>
          <span className={styles.placeKind}>{l.kind === 'file' ? 'File on this computer' : webPage ? 'Web page' : 'Web link'}</span>
          {l.kind === 'url' ? (
            <ExternalLink href={l.raw}>{shortLink(l.raw)}</ExternalLink>
          ) : (
            <span className={styles.path} title={shortLink(l.raw)}>
              {shortLink(l.raw)}
            </span>
          )}
          {l.viaPage !== null && (
            <span className={styles.via}>
              From the page <ExternalLink href={l.viaPage}>{shortLink(l.viaPage)}</ExternalLink>
            </span>
          )}
          <span className={styles.when}>
            {l.firstSeen === l.lastSeen ? `Seen ${formatWhen(l.firstSeen)}` : `First seen ${formatWhen(l.firstSeen)} · last seen ${formatWhen(l.lastSeen)}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

function TitleBlock({ title, authors, year, onRename, say }: { title: string; authors: readonly string[]; year: number | null; onRename(this: void, t: string): Promise<void>; say: AboutDetailsProps['say'] }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  useEffect(() => {
    if (!editing) setValue(title);
  }, [title, editing]);
  const clean = value.trim().replace(/\s+/gu, ' ');
  const save = () => {
    if (clean === '' || clean === title) {
      setEditing(false);
      return;
    }
    onRename(clean).then(
      () => {
        setEditing(false);
        say('Renamed');
      },
      () => say('Couldn’t rename it. Try again.'),
    );
  };
  const by = [authorsShort(authors), year === null ? '' : String(year)].filter((x) => x !== '').join(' · ');
  return (
    <div className={styles.titleBlock}>
      {editing ? (
        <div className={styles.titleEdit}>
          <TextField label="Title" value={value} onChange={setValue} onEnter={save} autoFocus maxLength={300} invalid={clean === ''} onKeyDown={(e) => {
              if (e.key !== 'Escape') return;
              e.stopPropagation();
              setEditing(false);
            }}
          />
          <span className={styles.titleActions}>
            <TextButton label="Cancel" onClick={() => setEditing(false)} />
            <TextButton label="Save" variant="tonal" onClick={save} disabled={clean === ''} />
          </span>
        </div>
      ) : (
        <div className={styles.titleRow}>
          <p className={styles.title}>{title}</p>
          <IconButton icon="edit" size={32} label="Rename" onClick={() => setEditing(true)} />
        </div>
      )}
      {by !== '' && <p className={styles.by}>{by}</p>}
    </div>
  );
}
