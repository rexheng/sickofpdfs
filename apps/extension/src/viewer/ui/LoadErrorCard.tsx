import { Icon, TextButton } from '@sop/ui';
import { MAX_OPEN_BYTES, type PdfFormatError, PdfLoadError } from '@sop/viewer';
import styles from './cards.module.css';
import { useFilePicker } from './FilePicker';

export interface LoadErrorCardProps {
  error: PdfLoadError | PdfFormatError;
  /** The PDF's address; null when there is none (a picked file, or a viewer address without one). */
  sourceUrl: string | null;
  onOpenInChrome: (url: string) => void;
  onImport: (file: File) => void;
  /** "Try again": shown when the PDF was fetched without the owner's sign-in; it opens the address itself (App.tsx). */
  onTryAgain?: () => void;
}

/** "This PDF is 1.2 GB": bytes in decimal GB, one decimal. */
export function gigabytes(bytes: number): string {
  return (bytes / 1e9).toFixed(1);
}

/** Why a file is too large: over the 1 GB limit, or under it but more than the engine's memory holds. */
export function tooLargeText(bytes: number): string {
  return bytes > MAX_OPEN_BYTES
    ? `This PDF is ${gigabytes(bytes)} GB, larger than the 1 GB this viewer opens.`
    : `This PDF is ${gigabytes(bytes)} GB, too big for this viewer to open.`;
}

function copyFor(error: PdfLoadError | PdfFormatError, sourceUrl: string | null): { title: string; lines: string[] } {
  const couldNot = "Couldn't load this PDF";
  if (!(error instanceof PdfLoadError)) return { title: couldNot, lines: ['The file is damaged or incomplete.'] };
  switch (error.code) {
    case 'not-pdf':
      return { title: "This link didn't return a PDF", lines: ['The site sent a web page instead.', 'You may need to sign in to the site first.'] };
    case 'http': {
      const status = error.detail.status;
      if (status === 401 || status === 403) return { title: couldNot, lines: [`The site said no (error ${status}).`, 'You may need to sign in to the site first.'] };
      if (status === 404 || status === 410) return { title: couldNot, lines: [`The site couldn't find this file (error ${status}).`, 'The link may have expired.'] };
      return { title: couldNot, lines: [`The site sent an error (error ${status ?? 'unknown'}).`] };
    }
    case 'too-large':
      return { title: couldNot, lines: [tooLargeText(error.detail.size ?? 0)] };
    case 'file-access':
      return { title: couldNot, lines: ["Chrome isn't letting this viewer read files on your computer."] };
    case 'aborted':
      return { title: couldNot, lines: ['Opening was cancelled.', 'Reload the page to try again.'] };
    case 'network':
      return sourceUrl === null
        ? { title: couldNot, lines: ['There is no PDF address in this link.'] }
        : { title: couldNot, lines: ['The download stopped before the file arrived.', 'Check your connection, then try again.'] };
  }
}

/**
 * Why the PDF did not open, with the two ways forward (spec: "Our error page offers 'Import this PDF' and 'Open in
 * Chrome's viewer'"). "Open in Chrome's viewer" shows when there is an address to open.
 */
export function LoadErrorCard({ error, sourceUrl, onOpenInChrome, onImport, onTryAgain }: LoadErrorCardProps) {
  const { title, lines } = copyFor(error, sourceUrl);
  const picker = useFilePicker(onImport);
  const canOpen = sourceUrl !== null && /^(https?|file):/i.test(sourceUrl);
  return (
    <div className={styles.stage}>
      <section className={styles.card} aria-labelledby="load-error-title">
        <Icon name="error" className={styles.icon} />
        <h1 id="load-error-title" className={styles.title}>
          {title}
        </h1>
        {lines.map((line) => (
          <p key={line} className={styles.body}>
            {line}
          </p>
        ))}
        <div className={styles.actions}>
          {onTryAgain !== undefined && <TextButton label="Try again" onClick={onTryAgain} />}
          {canOpen && <TextButton label="Open in Chrome's viewer" icon="open_in_new" onClick={() => onOpenInChrome(sourceUrl)} />}
          <TextButton label="Import this PDF" onClick={picker.open} />
        </div>
        {picker.input}
      </section>
    </div>
  );
}
