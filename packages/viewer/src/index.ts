// @sop/viewer: the PDF engine adapter (Task 15). Later tasks add the viewer's components here.
export type * from './backend/types';
export { PdfEngineCrashedError, PdfFormatError, PdfPasswordError, type EngineFailure } from './backend/errors';
export { hasFillableFields } from './backend/forms';
export { ENGINE_WORKERS, type EngineAssets } from './backend/engine-config';
export { engineAssets } from './backend/embedpdf/assets';
export { createEmbedPdfBackend, type EmbedPdfBackendOptions } from './backend/embedpdf/backend';
export { createPageTextProvider, type PageTextProvider, type PageTextProviderImpl } from './text/page-text';
export * from './marks/geometry';
export * from './marks/card-layout';
