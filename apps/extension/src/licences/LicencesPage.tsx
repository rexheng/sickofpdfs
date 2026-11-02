// Help → About sickofpdfs → "Open-source licences" (TB4): the licences of everything open-source inside the extension,
// on a page in the library's light Drive look, instead of the raw text file in Chrome's bare text view (tiny black
// monospace, no heading, no tab title). It reads the THIRD_PARTY_NOTICES.txt the build ships; nothing leaves the computer.
import '@sop/ui/tokens.css';
import '@sop/ui/base.css';
import { registerFonts } from '@sop/ui';
import { ProductMark } from '@sop/ui/library';
import { useEffect, useState } from 'react';
import styles from './LicencesPage.module.css';
import { type Notices, parseNotices } from './notices';

/** The notices file the build writes (scripts/third-party-notices.mjs), beside this page. */
const NOTICES_PATH = 'THIRD_PARTY_NOTICES.txt';

type Load = { kind: 'loading' } | { kind: 'ready'; notices: Notices } | { kind: 'failed' };

const anchor = (index: number) => `licence-${index}`;

export function LicencesPage() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  useEffect(() => {
    void registerFonts().catch(() => {}); // text falls back to the next font until the files load
    fetch(chrome.runtime.getURL(NOTICES_PATH))
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(
        (text) => setLoad({ kind: 'ready', notices: parseNotices(text) }),
        () => setLoad({ kind: 'failed' }),
      );
  }, []);

  return (
    <div className={styles.page}>
      <header className={styles.top}>
        <ProductMark label="sickofpdfs" />
      </header>
      <main className={styles.card}>
        <div className={styles.column}>
          <h1 className={styles.title}>Open-source licences</h1>
          {load.kind === 'loading' && <p className={styles.quiet}>Loading…</p>}
          {load.kind === 'failed' && <p className={styles.text}>The licences file couldn’t be read. Reload the page to try again.</p>}
          {load.kind === 'ready' && <Body notices={load.notices} />}
        </div>
      </main>
    </div>
  );
}

function Body({ notices }: { notices: Notices }) {
  const { intro, entries } = notices;
  return (
    <>
      <p className={styles.quiet}>{notices.product}</p>
      {intro.map((b, i) =>
        b.kind === 'paragraph' ? (
          // A line with no full stop is the label of the list after it ("What is listed"). The file's words are about the
          // file; on this page they are about the page.
          <p key={i} className={/[.!?:]$/u.test(b.text) ? styles.text : styles.lead}>
            {b.text.replace(/\bThis file\b/gu, 'This page')}
          </p>
        ) : (
          <ul key={i} className={styles.list}>
            {b.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ),
      )}
      <nav className={styles.contents} aria-labelledby="licences-contents">
        <h2 id="licences-contents" className={styles.contentsTitle}>
          {entries.length} components
        </h2>
        <ol className={styles.contentsList}>
          {entries.map((e) => (
            <li key={e.index}>
              <a className={styles.link} href={`#${anchor(e.index)}`}>
                {e.name}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      {entries.map((e) => (
        <section key={e.index} id={anchor(e.index)} className={styles.entry} aria-labelledby={`${anchor(e.index)}-name`}>
          <h2 id={`${anchor(e.index)}-name`} className={styles.name}>
            {e.name}
          </h2>
          <dl className={styles.facts}>
            {e.facts.map((f, i) => (
              <div key={i} className={styles.fact}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
          {e.texts.map((t, i) => (
            <div key={i}>
              <h3 className={styles.textLabel}>Licence text: {t.label}</h3>
              <pre className={styles.licence}>{t.body}</pre>
            </div>
          ))}
        </section>
      ))}
    </>
  );
}
