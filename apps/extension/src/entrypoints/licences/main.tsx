import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LicencesPage } from '../../licences/LicencesPage';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LicencesPage />
  </StrictMode>,
);
