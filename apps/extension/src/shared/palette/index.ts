// The search palette (Ctrl+K), for the viewer and the library (Phase 3, S15).
// S18 makes `tag:` and `course:` mean something with `registerPaletteOperator` (query.ts).
export { openTargetInNewTab } from './open-hit';
export { Palette, type PaletteProps } from './Palette';
export { type PaletteOperator, registerPaletteOperator } from './query';
export { palette, type PaletteState, usePaletteState } from './state';
export type { PaletteCommand, PaletteCommandGroup, PaletteStore, PaletteTarget, TextPart } from './types';
