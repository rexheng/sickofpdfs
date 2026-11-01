// SVG path data from getGlyphOutlines (absolute `M`, then relative `m l c z`, 1/100 pt precision, top-left origin, y down)
// to absolute commands in PDF user space (y up).
export type PathCmd = { c: 'M' | 'L'; x: number; y: number } | { c: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number } | { c: 'Z' };

export function parseOutline(d: string, toUser: (x: number, y: number) => { x: number; y: number }): PathCmd[] {
  const tokens = d.match(/[MmLlCcZz]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  const out: PathCmd[] = [];
  let i = 0, cx = 0, cy = 0, sx = 0, sy = 0;
  let cmd = '';
  const num = () => Number(tokens[i++]);
  const pt = (x: number, y: number) => toUser(x, y);
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i]!)) cmd = tokens[i++]!;
    if (cmd === 'Z' || cmd === 'z') { out.push({ c: 'Z' }); cx = sx; cy = sy; continue; }
    if (cmd === 'M' || cmd === 'm') {
      const x = num(), y = num();
      [cx, cy] = cmd === 'M' ? [x, y] : [cx + x, cy + y];
      [sx, sy] = [cx, cy];
      out.push({ c: 'M', ...pt(cx, cy) });
      cmd = cmd === 'M' ? 'L' : 'l';
    } else if (cmd === 'L' || cmd === 'l') {
      const x = num(), y = num();
      [cx, cy] = cmd === 'L' ? [x, y] : [cx + x, cy + y];
      out.push({ c: 'L', ...pt(cx, cy) });
    } else if (cmd === 'C' || cmd === 'c') {
      const rel = cmd === 'c';
      const [a, b, c, e, f, g] = [num(), num(), num(), num(), num(), num()];
      const x1 = rel ? cx + a : a, y1 = rel ? cy + b : b, x2 = rel ? cx + c : c, y2 = rel ? cy + e : e, x = rel ? cx + f : f, y = rel ? cy + g : g;
      const p1 = pt(x1, y1), p2 = pt(x2, y2), p = pt(x, y);
      out.push({ c: 'C', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x: p.x, y: p.y });
      [cx, cy] = [x, y];
    } else throw new Error(`unsupported path command ${cmd}`);
  }
  return out;
}

/** Path commands as "M x y L x y C … Z" for the recipe writer. */
export const toPathData = (cmds: PathCmd[]): string =>
  cmds.map((p) => (p.c === 'Z' ? 'Z' : p.c === 'C' ? `C ${p.x1} ${p.y1} ${p.x2} ${p.y2} ${p.x} ${p.y}` : `${p.c} ${p.x} ${p.y}`)).join(' ');

const f = (n: number) => (Math.round(n * 1000) / 1000).toString();
const c1 = (v: number) => f(v / 255);

/**
 * A content stream for an appearance: paths in user space, each with its own fill and/or stroke colour.
 * No resources are needed (colours and dash are set with operators), which is why `FPDFAnnot_SetAP` can carry it.
 */
export function contentStream(paths: { cmds: PathCmd[]; fill?: [number, number, number, number] | null; stroke?: [number, number, number, number] | null; width?: number; dash?: number[]; evenOdd?: boolean }[]): string {
  const out: string[] = ['q'];
  for (const p of paths) {
    out.push('q');
    if (p.fill) out.push(`${c1(p.fill[0])} ${c1(p.fill[1])} ${c1(p.fill[2])} rg`);
    if (p.stroke) out.push(`${c1(p.stroke[0])} ${c1(p.stroke[1])} ${c1(p.stroke[2])} RG ${f(p.width ?? 1)} w 1 j 1 J`);
    if (p.dash?.length) out.push(`[${p.dash.map(f).join(' ')}] 0 d`);
    for (const c of p.cmds) {
      if (c.c === 'M') out.push(`${f(c.x)} ${f(c.y)} m`);
      else if (c.c === 'L') out.push(`${f(c.x)} ${f(c.y)} l`);
      else if (c.c === 'C') out.push(`${f(c.x1)} ${f(c.y1)} ${f(c.x2)} ${f(c.y2)} ${f(c.x)} ${f(c.y)} c`);
      else out.push('h');
    }
    const op = p.fill && p.stroke ? (p.evenOdd ? 'B*' : 'B') : p.fill ? (p.evenOdd ? 'f*' : 'f') : 'S';
    out.push(op, 'Q');
  }
  out.push('Q');
  return out.join('\n');
}
