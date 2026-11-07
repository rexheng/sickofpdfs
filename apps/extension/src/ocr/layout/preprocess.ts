// The layout model's input: the page squeezed (no keep-ratio) to 480 x 480 with bilinear sampling, RGB, ImageNet mean and std,
// planar (CHW). `scale_factor` is [480 / height, 480 / width]: the model divides its boxes by it, so they come back in px of the
// image it was given.
import { LAYOUT_INPUT } from './models';

export interface Rgba {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export function layoutInput(img: Rgba, size = LAYOUT_INPUT): { image: Float32Array; scaleFactor: Float32Array } {
  const out = new Float32Array(3 * size * size);
  const plane = size * size;
  const sx = img.width / size;
  const sy = img.height / size;
  const d = img.data;
  const W = img.width;
  for (let y = 0; y < size; y++) {
    const fy = Math.min(img.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = fy | 0;
    const y1 = Math.min(img.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < size; x++) {
      const fx = Math.min(W - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = fx | 0;
      const x1 = Math.min(W - 1, x0 + 1);
      const wx = fx - x0;
      const i00 = (y0 * W + x0) * 4;
      const i01 = (y0 * W + x1) * 4;
      const i10 = (y1 * W + x0) * 4;
      const i11 = (y1 * W + x1) * 4;
      for (let c = 0; c < 3; c++) {
        const v = (d[i00 + c] * (1 - wx) + d[i01 + c] * wx) * (1 - wy) + (d[i10 + c] * (1 - wx) + d[i11 + c] * wx) * wy;
        out[c * plane + y * size + x] = (v / 255 - MEAN[c]) / STD[c];
      }
    }
  }
  return { image: out, scaleFactor: new Float32Array([size / img.height, size / img.width]) };
}
