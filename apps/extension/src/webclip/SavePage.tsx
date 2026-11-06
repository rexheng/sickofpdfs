// "Save this page to library" (spec R103): the tab that saves the page. It opens next to the page as soon as the menu has
// read the article, shows what it is doing in plain words, and then turns into the new reading in the viewer. When the
// reading has card or bank numbers (D9) it stops first to say so; when something fails it says so and what to do.
import '@sop/ui/tokens.css';
import '@sop/ui/base.css';
import { createEmbedPdfBackend, ENGINE_WORKERS, engineAssets } from '@sop/viewer';
import { Icon, registerFonts, TextButton } from '@sop/ui';
import { ProductMark } from '@sop/ui/library';
import { useEffect, useRef, useState } from 'react';
import { buildViewerUrl } from '../shared/viewer-url';
import { openBlobStore } from '../store/blob-store';
import { connectStore } from '../store/client';
import { type PageJob, takeJob } from './job';
import { makePdf, readPictures } from './make-pdf';
import { pdfFileName } from './plan';
import { savePageAsReading } from './save-page';
import { UnsupportedScriptError } from './typeset';
import styles from './SavePage.module.css';

type Step =
  | { kind: 'starting' }
  | { kind: 'pictures'; done: number; total: number }
  | { kind: 'making' }
  | { kind: 'saving' }
  /** Saved, with the D9 warning: the reading opens when the owner says. */
  | { kind: 'warned'; open: string; warning: string }
  | { kind: 'failed'; message: string };

/** The viewer address of a reading (its saved copy), with "Back to page" going to the page it came from. */
function readingUrl(job: PageJob, documentId: string): string {
  return buildViewerUrl({ source: null, back: job.article.url, page: null, name: pdfFileName(job.article.title), doc: documentId });
}

export function SavePage() {
  const [job, setJob] = useState<PageJob | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'starting' });
  const started = useRef(false);

  useEffect(() => {
    void registerFonts().catch(() => {});
    if (started.current) return;
    started.current = true;
    void (async () => {
      const id = new URLSearchParams(location.search).get('job') ?? '';
      const j = await takeJob(id).catch(() => null);
      if (j === null) {
        setStep({ kind: 'failed', message: 'There’s nothing to save in this tab. Go back to the page and choose Save this page to library again.' });
        return;
      }
      setJob(j);
      document.title = `Saving “${j.article.title}” - sickofpdfs`;
      try {
        const pictures = await readPictures(j.tabId, j.article, (done, total) => total > 0 && setStep({ kind: 'pictures', done, total }));
        setStep({ kind: 'making' });
        const pdf = await makePdf(j.article, pictures, Date.now());
        setStep({ kind: 'saving' });
        const [store, blobs] = await Promise.all([connectStore(), openBlobStore().catch(() => null)]);
        const backend = createEmbedPdfBackend(engineAssets((p) => chrome.runtime.getURL(p)), { workers: ENGINE_WORKERS });
        try {
          const saved = await savePageAsReading(j.article, pdf.bytes, { textHash: j.textHash, earlier: j.earlier }, { store, blobs, backend, now: () => Date.now() });
          const open = readingUrl(j, saved.documentId);
          if (saved.warning !== null) setStep({ kind: 'warned', open, warning: saved.warning });
          else location.replace(open);
        } finally {
          store.close();
        }
      } catch (error) {
        setStep({
          kind: 'failed',
          message:
            error instanceof UnsupportedScriptError
              ? 'sickofpdfs can’t make a PDF of this page yet. It is written in letters its fonts don’t have.'
              : 'Couldn’t save this page. Go back to the page and try again.',
        });
      }
    })();
  }, []);

  const title = job?.article.title ?? 'Save this page to library';
  const site = job === null ? null : (job.article.siteName ?? hostOf(job.article.url));
  return (
    <div className={styles.page}>
      <header className={styles.top}>
        <ProductMark label="sickofpdfs" />
      </header>
      <main className={styles.card} aria-live="polite">
        {site !== null && <p className={styles.site}>{site}</p>}
        <h1 className={styles.title}>{title}</h1>
        <Status step={step} onClose={() => window.close()} />
      </main>
    </div>
  );
}

function Status({ step, onClose }: { step: Step; onClose(this: void): void }) {
  if (step.kind === 'failed') {
    return (
      <>
        <p className={styles.problem}>
          <Icon name="error" size={20} />
          <span>{step.message}</span>
        </p>
        <div className={styles.actions}>
          <TextButton label="Close this tab" onClick={onClose} />
        </div>
      </>
    );
  }
  if (step.kind === 'warned') {
    return (
      <>
        <p className={styles.done}>
          <Icon name="library_add_check" size={20} />
          <span>Saved to your library.</span>
        </p>
        <p className={styles.warning}>
          <Icon name="warning" size={20} />
          <span>{step.warning}</span>
        </p>
        <div className={styles.actions}>
          <TextButton label="Open it" variant="tonal" onClick={() => location.replace(step.open)} />
        </div>
      </>
    );
  }
  const words =
    step.kind === 'pictures'
      ? `Copying the pictures from the page · ${step.done} of ${step.total}`
      : step.kind === 'making'
        ? 'Making a PDF of the article…'
        : step.kind === 'saving'
          ? 'Saving it to your library…'
          : 'Getting ready…';
  const value = step.kind === 'pictures' ? 0.1 + 0.5 * (step.total === 0 ? 1 : step.done / step.total) : step.kind === 'making' ? 0.7 : step.kind === 'saving' ? 0.88 : 0.04;
  return (
    <>
      <div className={styles.bar} role="progressbar" aria-label="Saving" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
        <span className={styles.fill} style={{ inlineSize: `${Math.round(value * 100)}%` }} />
      </div>
      <p className={styles.step}>{words}</p>
      <p className={styles.note}>It is made on this computer. Nothing is sent anywhere.</p>
    </>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./u, '');
  } catch {
    return '';
  }
}
