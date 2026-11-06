// The toolbar button's menu (spec R103): "Save this page to library" and "Open library", in the library's light Drive look.
//
// - The page is read only when the owner clicks "Save this page to library": the page script goes in then, with the activeTab
//   grant that opening this menu gives. Opening the menu reads nothing but the tab's address.
// - On a PDF tab (the viewer, or Chrome's own viewer), and on pages Chrome does not let extensions read (chrome:// pages, the
//   Web Store), only "Open library" shows, and a short line says why. In an Incognito window nothing is saved.
// - "Save this page" reads the article here, then hands it to a tab of its own (save-page.html) that makes the PDF and
//   saves it, so closing this menu cannot stop a save half way. The same page with the same words opens its reading instead.
import '@sop/ui/tokens.css';
import '@sop/ui/base.css';
import { Icon, type IconName, registerFonts } from '@sop/ui';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { openLibrary } from '../background/open-library';
import { buildViewerUrl, VIEWER_PATH } from '../shared/viewer-url';
import { connectStore } from '../store/client';
import { type Article, articleTextHash, type ReadResult } from './article';
import { putJob, SAVE_PAGE_PATH } from './job';
import { type PagePlan, pdfFileName, planPageSave } from './plan';
import styles from './ActionMenu.module.css';

/** What the current tab is, as far as saving goes. */
type Target =
  | { kind: 'loading' }
  | { kind: 'page'; tab: chrome.tabs.Tab & { id: number } }
  /** Only "Open library", with this line. */
  | { kind: 'closed'; why: string };

export const WHY = {
  pdf: 'This is a PDF. Save it in the viewer, with the button at the top of the page.',
  chrome: 'Chrome doesn’t let extensions read this page.',
  incognito: 'In an Incognito window sickofpdfs saves nothing.',
  library: 'This is your library.',
  none: 'This page doesn’t have an article to save.',
  failed: 'Couldn’t read this page. Try again.',
} as const;

/** The Chrome Web Store: Chrome lets no extension run there. */
function isWebStore(u: URL): boolean {
  return u.host === 'chromewebstore.google.com' || (u.host === 'chrome.google.com' && u.pathname.startsWith('/webstore'));
}

/** Where `tab` is, decided from its address alone. `ownPage`: the address of this extension's page in it, if it is one. */
export function targetOf(tab: chrome.tabs.Tab | undefined, incognito: boolean, ownPage: string | null): Target {
  if (incognito) return { kind: 'closed', why: WHY.incognito };
  const raw = ownPage ?? tab?.url ?? tab?.pendingUrl;
  if (tab?.id === undefined || raw === undefined || raw === '') return { kind: 'closed', why: WHY.chrome };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { kind: 'closed', why: WHY.chrome };
  }
  const own = chrome.runtime.getURL('');
  if (raw.startsWith(own)) {
    if (u.pathname === `/${VIEWER_PATH}`) return { kind: 'closed', why: WHY.pdf };
    if (u.pathname === '/library.html') return { kind: 'closed', why: WHY.library };
    return { kind: 'closed', why: WHY.chrome };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:' && u.protocol !== 'file:') return { kind: 'closed', why: WHY.chrome };
  if (isWebStore(u)) return { kind: 'closed', why: WHY.chrome };
  // A PDF left to Chrome's own viewer (a very large file, or one a form posted).
  if (/\.pdf$/iu.test(u.pathname)) return { kind: 'closed', why: WHY.pdf };
  return { kind: 'page', tab: tab as chrome.tabs.Tab & { id: number } };
}

/** The tab the menu is for: the active tab of this window. Test builds may name another (`popup.html?tab=<id>`). */
async function currentTab(): Promise<chrome.tabs.Tab | undefined> {
  if (import.meta.env.MODE === 'test') {
    const id = Number(new URLSearchParams(location.search).get('tab') ?? '');
    if (Number.isInteger(id) && id > 0) return chrome.tabs.get(id);
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * The address of this extension's own page in tab `tabId` (the viewer, the library), or null. Chrome gives an extension the
 * addresses of its own pages without the "tabs" permission this way.
 */
async function ownPageIn(tabId: number | undefined): Promise<string | null> {
  if (tabId === undefined) return null;
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] }).catch(() => []);
  return contexts.find((c) => c.tabId === tabId)?.documentUrl ?? null;
}

/** How long the menu waits for the library to say whether the page is saved before it saves it anyway. */
const PLAN_WAIT_MS = 4000;

async function planFor(article: Article, textHash: string): Promise<PagePlan> {
  const fallback: PagePlan = { kind: 'new', earlier: null };
  const store = await Promise.race([connectStore().catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), PLAN_WAIT_MS))]);
  if (store === null) return fallback; // the save itself still finds a copy of the same words (the identity check)
  try {
    return await planPageSave(store, article, textHash);
  } catch {
    return fallback;
  } finally {
    store.close();
  }
}

export function ActionMenu() {
  const [target, setTarget] = useState<Target>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void registerFonts().catch(() => {});
    currentTab()
      .then(async (tab) => setTarget(targetOf(tab, chrome.extension.inIncognitoContext, await ownPageIn(tab?.id))))
      .catch(() => setTarget({ kind: 'closed', why: WHY.chrome }));
  }, []);

  useEffect(() => {
    if (target.kind !== 'loading') list.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, [target.kind]);

  const savePage = async () => {
    if (target.kind !== 'page' || busy) return;
    const tab = target.tab;
    setBusy(true);
    setNote(null);
    let result: ReadResult | undefined;
    try {
      const [answer] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['/page-reader.js'] });
      result = answer?.result as ReadResult | undefined;
    } catch {
      setBusy(false);
      setTarget({ kind: 'closed', why: WHY.chrome });
      return;
    }
    if (result === undefined || result === null) {
      setBusy(false);
      setNote(WHY.failed);
      return;
    }
    if (result.kind === 'pdf') {
      setBusy(false);
      setTarget({ kind: 'closed', why: WHY.pdf });
      return;
    }
    if (result.kind === 'none') {
      setBusy(false);
      setNote(WHY.none);
      return;
    }
    const article = result.article;
    try {
      const textHash = await articleTextHash(article);
      const plan = await planFor(article, textHash);
      const at = { index: tab.index + 1, openerTabId: tab.id, windowId: tab.windowId };
      if (plan.kind === 'existing') {
        await chrome.tabs.create({ ...at, url: buildViewerUrl({ source: null, back: article.url, page: null, name: pdfFileName(article.title), doc: plan.documentId }) });
      } else {
        const job = await putJob({ tabId: tab.id, article, textHash, earlier: plan.earlier, createdAt: Date.now() });
        await chrome.tabs.create({ ...at, url: `${chrome.runtime.getURL(SAVE_PAGE_PATH)}?job=${job}` });
      }
      window.close();
    } catch {
      setBusy(false);
      setNote(WHY.failed);
    }
  };

  const showLibrary = () => {
    void openLibrary()
      .catch(() => chrome.tabs.create({ url: chrome.runtime.getURL('library.html') }))
      .finally(() => window.close());
  };

  // Up and Down move between the rows; Escape closes the menu.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') return window.close();
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []);
    if (rows.length === 0) return;
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[(at + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
    e.preventDefault();
  };

  const line = target.kind === 'closed' ? target.why : note;
  return (
    <div className={styles.menu} onKeyDown={onKey}>
      <header className={styles.head}>
        <span className={styles.tile} aria-hidden="true">
          menu_book
        </span>
        <span className={styles.word}>sickofpdfs</span>
      </header>
      <div ref={list} role="menu" aria-label="sickofpdfs" className={styles.rows}>
        {target.kind === 'page' &&
          (busy ? (
            <div className={styles.busy} role="status">
              <span className={styles.spinner} aria-hidden="true" />
              <span>Reading this page…</span>
            </div>
          ) : (
            <Row icon="library_add" label="Save this page to library" onClick={() => void savePage()} />
          ))}
        <Row icon="library_books" label="Open library" onClick={showLibrary} disabled={busy} />
      </div>
      {line !== null && (
        <p className={styles.line} role={target.kind === 'closed' ? undefined : 'alert'}>
          <Icon name={line === WHY.none || line === WHY.failed ? 'info' : 'block'} size={20} />
          <span>{line}</span>
        </p>
      )}
    </div>
  );
}

function Row({ icon, label, onClick, disabled = false }: { icon: IconName; label: string; onClick(this: void): void; disabled?: boolean }) {
  return (
    <button type="button" role="menuitem" className={styles.row} onClick={onClick} disabled={disabled}>
      <Icon name={icon} size={20} className={styles.icon} />
      <span className={styles.label}>{label}</span>
    </button>
  );
}
