import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach } from 'vitest';

// Tells React that state updates in this environment run inside act(), so it flushes them and stays quiet.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; container: HTMLElement }[] = [];

/**
 * Renders `el` into the page (react-dom/client + act, no extra renderer) and returns the first element it produced.
 * An HTMLElement unless the caller says otherwise: `render<SVGSVGElement>(<FileTypeIcon kind="pdf" />)`.
 */
export function render<T extends Element = HTMLElement>(el: ReactElement): T {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(el);
  });
  mounted.push({ root, container });
  const first = container.firstElementChild;
  if (first === null) throw new Error('render(): the element rendered nothing');
  return first as T;
}

// Every test starts with an empty page.
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});
