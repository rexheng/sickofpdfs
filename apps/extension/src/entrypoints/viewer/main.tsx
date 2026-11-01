import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

/** The viewer's root element. e2e waits for it before it reads anything else. */
const VIEWER_ROOT_ID = 'viewer-root';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <main id={VIEWER_ROOT_ID} />
  </StrictMode>,
);
