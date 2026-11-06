import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SavePage } from '../../webclip/SavePage';

// "Save this page to library" (spec R103): the tab that makes the PDF of a web page and saves it (webclip/SavePage.tsx).
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SavePage />
  </StrictMode>,
);
