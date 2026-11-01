// One figure controller per open document (NotesHost), shared by the feature's page layers, its view, its commands, the
// rail's Figures tab and the cards' thumbnails. It is made on first use and let go of when the document's view goes.
import type { NotesHost } from '../annotations/wire';
import { createFigureController, type FigureController } from './controller';

const controllers = new WeakMap<NotesHost, FigureController>();

/** The document's figure controller, made on first use. */
export function controllerOf(host: NotesHost): FigureController {
  let c = controllers.get(host);
  if (!c) controllers.set(host, (c = createFigureController(host)));
  return c;
}

/** The document's view has gone: its controller is disposed (a later use makes a new one). */
export function releaseController(host: NotesHost, c: FigureController): void {
  if (controllers.get(host) === c) controllers.delete(host);
  c.dispose();
}
