// `@sop/core`'s type index mentions one browser type (ImageBitmap, in a viewer type it re-exports). The Worker has no DOM, so name
// it here instead of pulling the whole DOM library in next to the Workers types.
interface ImageBitmap {
  readonly width: number;
  readonly height: number;
}
