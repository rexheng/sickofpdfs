// The recipes for the plan (slice 8.2's annots.ts and ap-streams.ts, in the spike): each PdfAnnotationPlan of slice 8.1
// becomes the calls writeback.ts makes. The call order that gave a conformant file for each kind is the report's "recipes".
import { contentStream, parseOutline } from './svgpath.ts';
import type { AnnotSpec } from './writeback.ts';

interface Rect { x: number; y: number; width: number; height: number }
export interface PlanItem {
  nm: string; subtype: AnnotSpec['subtype']; pageIndex: number; rect: Rect; quads: Rect[]; rgb: [number, number, number] | null; contents: string | null; author: string | null; subject: string | null;
  createdAt: number; modifiedAt: number; irt: string | null; popupOf: string | null; flags: number;
  ap: { kind: 'text-markup' | 'dotted-underline' | 'bold-outlines' | 'box' | 'note-icon' | 'empty'; chars?: { start: number; count: number } };
}
interface Geo { crop: [number, number, number, number]; rotation: 0 | 90 | 180 | 270 }
interface Outlines { getGlyphOutlines(id: string, p: number, s: number, c: number): { d: string; fill: number[] | null; stroke: number[] | null }[] }

const BOLD_STROKE = 0.03 * 10.5; // BOLD_STROKE_EM x the text's size, as the viewer draws it (packages/viewer/src/marks/BoldLayer.tsx)

export function planToSpecs(plan: readonly PlanItem[], geometry: readonly Geo[], engine: Outlines, quadPoints: (r: Rect, rotation: 0 | 90 | 180 | 270) => number[], viewId = 'v'): AnnotSpec[] {
  return plan.map((p): AnnotSpec => {
    const g = geometry[p.pageIndex]!;
    const spec: AnnotSpec = {
      subtype: p.subtype, pageIndex: p.pageIndex, rect: [p.rect.x, p.rect.y, p.rect.x + p.rect.width, p.rect.y + p.rect.height], nm: p.nm, flags: p.flags, rgb: p.rgb,
      created: new Date(p.createdAt), modified: new Date(p.modifiedAt), ap: 'none',
      ...(p.author !== null ? { author: p.author } : {}), ...(p.contents !== null ? { contents: p.contents } : {}), ...(p.subject !== null ? { subject: p.subject } : {}),
      ...(p.irt ? { irtNm: p.irt, rt: 'R' as const } : {}), ...(p.popupOf ? { popupOfNm: p.popupOf } : {}),
    };
    if (p.quads.length > 0) spec.quadNumbers = p.quads.map((q) => quadPoints(q, g.rotation));
    switch (p.ap.kind) {
      case 'text-markup': spec.ap = p.subtype === 'Highlight' ? 'pdfium-multiply' : 'pdfium'; break;
      case 'dotted-underline':
        spec.ap = { stream: contentStream(p.quads.map((q) => ({ cmds: [{ c: 'M' as const, x: q.x, y: q.y + 1.2 }, { c: 'L' as const, x: q.x + q.width, y: q.y + 1.2 }], stroke: [...(p.rgb ?? [0, 0, 0]), 255] as [number, number, number, number], width: 1, dash: [1.2, 1.8] }))) };
        break;
      case 'bold-outlines': {
        const chars = p.ap.chars!;
        const toUser = (x: number, y: number) => ({ x: g.crop[0] + x, y: g.crop[3] - y });
        spec.noBorder = true;
        spec.ap = { stream: contentStream(engine.getGlyphOutlines(viewId, p.pageIndex, chars.start, chars.count).map((o) => {
          const fill = (o.fill ?? o.stroke ?? [0, 0, 0, 255]) as [number, number, number, number];
          return { cmds: parseOutline(o.d, toUser), fill, stroke: fill, width: BOLD_STROKE };
        })) };
        break;
      }
      case 'box': spec.ap = 'pdfium'; spec.borderWidth = 1.5; break;
      case 'note-icon': spec.ap = 'pdfium'; spec.iconName = p.subject === 'Document note' || p.subject === 'Page note' ? 'Note' : 'Comment'; break;
      case 'empty': spec.ap = p.subtype === 'Popup' ? 'none' : { stream: 'q Q' }; break;
    }
    return spec;
  });
}
