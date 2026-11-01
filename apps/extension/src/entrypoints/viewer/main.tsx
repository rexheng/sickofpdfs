import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { parseViewerUrl } from '../../shared/viewer-url';
import { backTarget, goBackToPage } from '../../viewer/back-to-page';
import { maybeLeaveFrame, mayShowSourceHere, wantsFullTab } from '../../viewer/frame-escape';
import { openInChrome } from '../../viewer/open-in-chrome';

/** The viewer's root element. e2e waits for it before it reads anything else. */
const VIEWER_ROOT_ID = 'viewer-root';

/** The last part of the address, as a person would read it. */
function fileNameOf(source: string | null): string {
  if (source === null) return 'No PDF';
  try {
    const name = new URL(source).pathname.split('/').filter(Boolean).pop();
    return name ? decodeURIComponent(name) : source;
  } catch {
    return source;
  }
}

// Until the viewer chrome arrives (Tasks 20 to 23), this page shows which PDF was asked for and the two ways out of it.
function Viewer() {
  const [params] = useState(() => parseViewerUrl(location.href));
  const [leaving, setLeaving] = useState(() => wantsFullTab(params));
  const [chromeRefused, setChromeRefused] = useState(false);
  const back = backTarget(params);
  const name = fileNameOf(params.source);

  useEffect(() => {
    // In a frame of some page: the PDF opens in the whole tab (unless the person just came back from there).
    maybeLeaveFrame(params, () => setLeaving(false));
  }, [params]);

  useEffect(() => {
    document.title = leaving ? 'sickofpdfs' : name;
  }, [leaving, name]);

  if (leaving) return <p role="status">Opening in the full tab…</p>;
  if (!mayShowSourceHere(params)) return <p role="alert">A web page asked to show a file from your computer here. It is not shown.</p>;

  return (
    <>
      {back !== null && (
        <button type="button" onClick={() => void goBackToPage(params)}>
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
          </svg>
          Back to page
        </button>
      )}
      <h1>{name}</h1>
      {params.source !== null && <p>{params.source}</p>}
      {params.source !== null && (
        <button
          type="button"
          onClick={() => {
            setChromeRefused(false);
            void openInChrome(params.source!).then((ok) => setChromeRefused(!ok));
          }}
        >
          Open in Chrome&rsquo;s viewer
        </button>
      )}
      {chromeRefused && <p role="alert">Chrome cannot open this file. For a local file, turn on &ldquo;Allow access to file URLs&rdquo; for sickofpdfs.</p>}
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <main id={VIEWER_ROOT_ID}>
      <Viewer />
    </main>
  </StrictMode>,
);
