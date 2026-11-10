// The web's version of the viewer's "Reading text" chip (apps/extension/src/viewer/ocr/OcrChip.tsx): nothing. The web ships no
// text-recognition models (plan CL15), so reading a scan's text never runs here, and a chip that starts and then fails would
// only confuse. Text already read in Chrome or on the phone still comes with the reading, through sync.
import type { OcrChipProps } from '@ext/viewer/ocr/OcrChip';

export type { OcrChipProps };

export function OcrChip(props: OcrChipProps): null {
  void props;
  return null;
}
