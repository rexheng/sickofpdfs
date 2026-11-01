// Figures, areas and pins (S16) as a viewer feature: App.tsx mounts it with one line, registerViewerFeature(figuresFeature),
// after the comments (S14), whose Ctrl+Alt+M it extends (notes-host.ts specialNoteTarget).
//
// - On each page: the figure outlines (FigureLayer), and a call to detect the page's figures at idle once its full
//   render is on screen (figure detection never delays drawing a page).
// - Beside the pages: the numbered pins (in the page list's overlay) and the figure menu.
// - In the rail: the Figures tab.
// - Commands: Copy image (Ctrl+C on a selected figure or area) and the area tool.
import { FigureLayer } from '@sop/viewer/react';
import type { PageBox } from '@sop/viewer';
import type { PageLayerContext } from '@sop/viewer/react';
import { useEffect } from 'react';
import type { NotesHost, ViewerFeature } from '../annotations/wire';
import { FigureMenu } from './FigureMenu';
import { FigurePins } from './FigurePins';
import { FiguresPanel } from './FiguresPanel';
import { controllerOf, releaseController } from './registry';

function FiguresView({ host }: { host: NotesHost }) {
  const c = controllerOf(host);
  useEffect(() => {
    const detach = c.attach();
    return () => {
      detach();
      // Let go once the view has really gone (React's StrictMode mounts it again at once in development).
      setTimeout(() => {
        if (!c.attached()) releaseController(host, c);
      }, 0);
    };
  }, [host, c]);
  return (
    <>
      <FigurePins controller={c} />
      <FigureMenu controller={c} />
    </>
  );
}

function FiguresPageLayer({ host, box, ctx }: { host: NotesHost; box: PageBox; ctx: PageLayerContext }) {
  const c = controllerOf(host);
  const index = box.index;
  // The page's figures are found at idle once its full render is on screen, never before.
  useEffect(() => {
    let live = true;
    void ctx.whenPainted().then(() => live && c.pagePainted(index));
    return () => {
      live = false;
    };
  }, [c, ctx, index]);
  const page = host.pages[index];
  return page === undefined ? null : <FigureLayer source={c.layer} box={box} ctx={ctx} page={page} />;
}

export const figuresFeature: ViewerFeature = {
  id: 'figures',
  commands: (host) => controllerOf(host).behaviours(),
  View: FiguresView,
  PageLayer: FiguresPageLayer,
  rail: { icon: 'image', label: 'Figures', Panel: FiguresPanel },
};
