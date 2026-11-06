import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ActionMenu } from '../../webclip/ActionMenu';

// The toolbar button's menu (spec R103): "Save this page to library" and "Open library" (webclip/ActionMenu.tsx).
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ActionMenu />
  </StrictMode>,
);
