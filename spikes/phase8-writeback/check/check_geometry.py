"""Highlight and bold placement on pages with an offset crop box and /Rotate 0/90/180/270, against poppler's own word boxes
(pdftotext -bbox reports the page AS DISPLAYED, so it does not share any of our coordinate maths)."""
import json, subprocess, re, sys, tempfile, os
import numpy as np
from PIL import Image
OUT = sys.argv[1]
ann = os.path.join(OUT, 'geometry-annotated.pdf'); orig = os.path.join(OUT, 'inputs/geometry-crop-rotate.pdf')
meant = json.load(open(os.path.join(OUT, 'geometry-annotated.json')))['meant']
DPI = 144; S = DPI / 72
tmp = tempfile.mkdtemp()
def words(pdf, page):
    p = os.path.join(tmp, 'w.html'); subprocess.run(['pdftotext', '-bbox', '-f', str(page + 1), '-l', str(page + 1), pdf, p], check=True)
    return [(float(a), float(b), float(c), float(d), w) for a, b, c, d, w in re.findall(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</word>', open(p).read())]
def render(pdf, page, name):
    base = os.path.join(tmp, name); subprocess.run(['pdftoppm', '-r', str(DPI), '-png', '-f', str(page + 1), '-l', str(page + 1), '-singlefile', pdf, base], check=True)
    return np.array(Image.open(base + '.png').convert('RGB')).astype(int)
ok_all = True
for page in range(4):
    a, b = render(orig, page, f'o{page}'), render(ann, page, f'a{page}')
    ws = words(orig, page)
    for m in [x for x in meant if x['page'] == page]:
        if m['kind'] == 'pin':
            d = np.abs(a - b).sum(axis=2) > 60
            continue
        toks = m['phrase'].split()
        # the run of consecutive words that spells the phrase
        for i in range(len(ws) - len(toks) + 1):
            if [w[4] for w in ws[i:i + len(toks)]] == toks: run = ws[i:i + len(toks)]; break
        else: print('phrase not found', m); ok_all = False; continue
        x0 = min(w[0] for w in run); x1 = max(w[2] for w in run); y0 = min(w[1] for w in run); y1 = max(w[3] for w in run)
        # changed pixels near the phrase (window of 6pt around it), per kind
        W, H = a.shape[1], a.shape[0]
        wx0, wx1, wy0, wy1 = int((x0 - 6) * S), int((x1 + 6) * S), int((y0 - 6) * S), int((y1 + 6) * S)
        diff = np.abs(a[wy0:wy1, wx0:wx1] - b[wy0:wy1, wx0:wx1]).sum(axis=2) > (40 if m['kind'] == 'highlight' else 120)
        ys, xs = np.where(diff)
        if len(xs) == 0: print('NOTHING CHANGED', page, m); ok_all = False; continue
        cx0, cx1 = (xs.min() + wx0) / S, (xs.max() + wx0 + 1) / S; cy0, cy1 = (ys.min() + wy0) / S, (ys.max() + wy0 + 1) / S
        dx0, dx1 = cx0 - x0, cx1 - x1
        vert_ok = cy0 <= (y0 + y1) / 2 <= cy1
        good = abs(dx0) < 2.0 and abs(dx1) < 2.0 and vert_ok if m['kind'] == 'highlight' else (cx0 >= x0 - 1.5 and cx1 <= x1 + 1.5 and cy0 >= y0 - 2 and cy1 <= y1 + 2)
        ok_all &= good
        print(f"page {page} (rot {[0,90,180,270][page]}) {m['kind']:9s} {'OK ' if good else 'BAD'} phrase '{m['phrase']}': words x {x0:.1f}-{x1:.1f} y {y0:.1f}-{y1:.1f}; changed x {cx0:.1f}-{cx1:.1f} y {cy0:.1f}-{cy1:.1f}")
print('ALL PLACEMENTS OK' if ok_all else 'SOME PLACEMENTS WRONG')
