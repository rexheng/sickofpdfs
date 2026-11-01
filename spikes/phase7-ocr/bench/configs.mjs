// Every engine configuration the bake-off measures. `ppocr(...)` builds the PP-OCR ones.
const SETS = {
  'v6-tiny': ['PP-OCRv6_tiny_det', 'PP-OCRv6_tiny_rec'],
  'v6-small': ['PP-OCRv6_small_det', 'PP-OCRv6_small_rec'],
  'v6-medium': ['PP-OCRv6_medium_det', 'PP-OCRv6_medium_rec'],
  'v5-mobile': ['PP-OCRv5_mobile_det', 'PP-OCRv5_mobile_rec'],
  'v5-latin': ['PP-OCRv5_mobile_det', 'latin_PP-OCRv5_mobile_rec'],
  'v5-en': ['PP-OCRv5_mobile_det', 'en_PP-OCRv5_mobile_rec'],
  // mixed: the small v6 detector with other recognisers, to separate the two stages' contributions
  'v6s-det+v6t-rec': ['PP-OCRv6_small_det', 'PP-OCRv6_tiny_rec'],
};
export const ppocr = (set, backend, threads, detMaxSide = 1280, extra = {}) => {
  const [det, rec] = SETS[set];
  const id = `pp-${set}-${backend}${backend === 'wasm' ? threads : ''}-d${detMaxSide}${extra.tag ? `-${extra.tag}` : ''}`;
  return { kind: 'ppocr', id, det, rec, backend, threads, detMaxSide, ...extra.cfg };
};
export const tess = (langs, data = 'fast', tag = '') => ({ kind: 'tesseract', id: `tess-${data}-${langs.join('+')}${tag}`, langs, data, workers: 1 });

export function configById(id) {
  const m = /^pp-(v[56][a-z+\-]*?)-(wasm|webgpu)(\d*)-d(\d+)(?:-(.+))?$/.exec(id);
  if (m) return ppocr(m[1], m[2], Number(m[3] || 1), Number(m[4]), m[5] ? { tag: m[5] } : {});
  const t = /^tess-(fast|best)-([a-z+]+)$/.exec(id);
  if (t) return tess(t[2].split('+'), t[1]);
  throw new Error(`unknown config id ${id}`);
}
