"""Checks one exported PDF against what was meant to be in it, with every reader that runs here.

usage: check_file.py EXPORTED ORIGINAL EXPECT.json [--base OTHER.pdf] [--password PW]

  1. the original is an exact byte prefix, and its SHA-256 is unchanged
  2. qpdf --check (structure)
  3. our engine's PDFium (wasm)   -> every expected annotation, field by field
  4. pypdf                        -> the same, from the raw dictionaries
  5. pdf.js                       -> the same, as pdf.js interprets them (replies, popups, quads, colour)
  6. pixels: poppler, MuPDF (mutool) and stock PDFium (pypdfium2) each draw the page; the annotated render is compared
     with the original's at each annotation's place
"""
import json, subprocess, sys, hashlib, os, tempfile, argparse
import numpy as np
from PIL import Image
import pypdf, pypdfium2 as pdfium

HERE = os.path.dirname(os.path.abspath(__file__))
SPIKE = os.path.dirname(HERE)
NODE = ['node', '--experimental-transform-types', '--no-warnings', '--import', os.path.join(SPIKE, 'loader/register.mjs')]
DPI = 144
S = DPI / 72

results = []
def check(group, name, ok, detail=''):
    results.append({'group': group, 'name': name, 'ok': bool(ok), 'detail': detail})

def tol(a, b, t=0.02):
    return abs(a - b) <= t

# ---------- helpers ----------
def run_json(cmd, **kw):
    p = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if p.returncode != 0:
        raise RuntimeError(p.stderr[-800:])
    return json.loads(p.stdout)

def qpdf_check(path, pw):
    cmd = ['qpdf', '--check'] + ([f'--password={pw}'] if pw else []) + [path]
    p = subprocess.run(cmd, capture_output=True, text=True)
    warns = [l for l in (p.stdout + p.stderr).splitlines() if 'WARNING' in l or 'ERROR' in l or 'error' in l.lower() and 'No syntax' not in l]
    return p.returncode, warns

# ---------- main ----------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('exported'); ap.add_argument('original'); ap.add_argument('expect')
    ap.add_argument('--base'); ap.add_argument('--password'); ap.add_argument('--json', action='store_true')
    ap.add_argument('--no-pixels', action='store_true')
    a = ap.parse_args()
    expect = json.load(open(a.expect))
    exp = {e['nm']: e for e in expect}
    out = open(a.exported, 'rb').read(); orig = open(a.original, 'rb').read()

    # 1 prefix
    check('bytes', 'original is an exact prefix', out[:len(orig)] == orig)
    check('bytes', 'prefix SHA-256 unchanged', hashlib.sha256(out[:len(orig)]).hexdigest() == hashlib.sha256(orig).hexdigest(),
          hashlib.sha256(orig).hexdigest()[:16])
    check('bytes', 'tail is appended only', len(out) > len(orig), f'tail {len(out) - len(orig)} bytes')

    # 2 qpdf
    rc, warns = qpdf_check(a.exported, a.password)
    base_rc, base_warns = qpdf_check(a.original, a.password)
    new_warns = [w for w in warns if w.split(':', 1)[-1].strip() not in {x.split(':', 1)[-1].strip() for x in base_warns}]
    # qpdf's "reported number of objects (N) is not one plus the highest object number" is the xref stream that has no entry for itself.
    benign = [w for w in new_warns if 'is not one plus the highest object number' in w]
    bad = [w for w in new_warns if w not in benign]
    check('qpdf', 'qpdf --check finds no damage', rc in (0, 3) and not bad, '; '.join(w[-110:] for w in bad) or ('benign: ' + '; '.join(w[-90:] for w in benign) if benign else 'clean'))

    # 3 our engine's PDFium
    cmd = NODE + [os.path.join(HERE, '../scripts/readback-dump.ts'), a.exported] + ([a.password] if a.password else [])
    eng = run_json(cmd, cwd=SPIKE)
    pf = {x['nm']: x for x in eng['annotations'] if x.get('nm') and x['nm'].startswith('sop:')}
    objnum = {nm: x['objectNumber'] for nm, x in pf.items()}
    check('pdfium-wasm', f'all {len(exp)} expected annotations are found by NM', set(exp) <= set(pf), f'missing {sorted(set(exp) - set(pf))[:3]}')
    for nm, e in exp.items():
        x = pf.get(nm)
        if not x: continue
        tag = f"{e['subtype']} {nm[-14:]}"
        check('pdfium-wasm', f'{tag}: subtype, page, flags', x['subtype'] == e['subtype'] and x['pageIndex'] == e['pageIndex'] and x['flags'] == e['flags'], f"{x['subtype']} p{x['pageIndex']} F{x['flags']}")
        r = x['rect']; er = e['rect']
        check('pdfium-wasm', f'{tag}: /Rect', all(tol(p, q, 0.02) for p, q in zip([r['x'], r['y'], r['x'] + r['width'], r['y'] + r['height']], er)), f"{r} vs {er}")
        if e.get('contents') is not None and e['subtype'] != 'Popup':
            check('pdfium-wasm', f'{tag}: /Contents', (x['contents'] or '') == e['contents'], repr(x['contents'])[:60])
        if e.get('author'):
            check('pdfium-wasm', f'{tag}: /T', x['author'] == e['author'], x['author'])
        if e.get('subject'):
            check('pdfium-wasm', f'{tag}: /Subj', x['subject'] == e['subject'], x['subject'])
        if e.get('rgb'):
            check('pdfium-wasm', f'{tag}: /C', x['rgb'] == e['rgb'], f"{x['rgb']} vs {e['rgb']}")
        if e.get('quads'):
            ok = len(x['quads']) == len(e['quads']) and all(
                all(tol(p, q, 0.02) for p, q in zip([qq['x'], qq['y'], qq['x'] + qq['width'], qq['y'] + qq['height']], eq))
                for qq, eq in zip(x['quads'], e['quads']))
            check('pdfium-wasm', f'{tag}: QuadPoints', ok, f"{len(x['quads'])} quads")
        if e.get('irt'):
            check('pdfium-wasm', f'{tag}: /IRT → root, /RT /R', x['irtNm'] == e['irt'] and x['replyType'] == 'R', f"{x['irtNm']} {x['replyType']}")
        if e.get('popupOf'):
            par = pf.get(e['popupOf'])
            check('pdfium-wasm', f'{tag}: parent /Popup points at it', bool(par) and par['popupNm'] == nm)
        if e['subtype'] != 'Popup':
            check('pdfium-wasm', f'{tag}: has an appearance stream', x['hasAppearance'])
        check('pdfium-wasm', f'{tag}: /M and /CreationDate read as dates', x['modifiedAt'] is not None and (e['subtype'] == 'Popup' or x['createdAt'] is not None))

    # 4 pypdf
    rd = pypdf.PdfReader(a.exported)
    if a.password: rd.decrypt(a.password)
    pp = {}
    for pi, page in enumerate(rd.pages):
        if pi > max([e['pageIndex'] for e in expect] + [0]): break
        for ref in page.get('/Annots') or []:
            o = ref.get_object()
            nm = o.get('/NM')
            if nm and str(nm).startswith('sop:'): pp[str(nm)] = (pi, o)
    check('pypdf', f'all {len(exp)} expected annotations are found by /NM', set(exp) <= set(pp))
    for nm, e in exp.items():
        if nm not in pp: continue
        pi, o = pp[nm]; tag = f"{e['subtype']} {nm[-14:]}"
        ok = str(o.get('/Subtype')) == '/' + e['subtype'] and pi == e['pageIndex'] and int(o.get('/F', 0)) == e['flags']
        check('pypdf', f'{tag}: subtype, page, flags', ok)
        check('pypdf', f'{tag}: /Rect', all(tol(float(p), q, 0.02) for p, q in zip(o['/Rect'], e['rect'])))
        if e.get('contents') is not None and e['subtype'] != 'Popup': check('pypdf', f'{tag}: /Contents', str(o.get('/Contents', '')) == e['contents'])
        if e.get('author'): check('pypdf', f'{tag}: /T', str(o.get('/T')) == e['author'])
        if e.get('subject'): check('pypdf', f'{tag}: /Subj', str(o.get('/Subj')) == e['subject'])
        if e.get('rgb'): check('pypdf', f'{tag}: /C', [round(float(v) * 255) for v in o['/C']] == e['rgb'])
        if e.get('quads'):
            q = [float(v) for v in o['/QuadPoints']]
            ok = len(q) == 8 * len(e['quads'])
            # Acrobat's order: TL, TR, BL, BR  ->  (x1,y1)=(left,top) (x2,y2)=(right,top) (x3,y3)=(left,bottom) (x4,y4)=(right,bottom)
            for i, eq in enumerate(e['quads']):
                if len(q) >= 8 * (i + 1):
                    v = q[8 * i:8 * i + 8]
                    ok = ok and tol(v[0], v[4]) and tol(v[2], v[6]) and tol(v[1], v[3]) and tol(v[5], v[7]) and v[0] < v[2] and v[1] > v[5]
            check('pypdf', f'{tag}: QuadPoints are in Acrobat order (TL, TR, BL, BR)', ok)
        if e.get('irt'):
            irt = o.get('/IRT'); check('pypdf', f'{tag}: /IRT points at the root, /RT /R', irt is not None and str(irt.get_object().get('/NM')) == e['irt'] and str(o.get('/RT')) == '/R')
        if e.get('popupOf'):
            par = pp[e['popupOf']][1]; pop = par.get('/Popup')
            check('pypdf', f'{tag}: parent /Popup is it, and its /Parent is the parent', pop is not None and str(pop.get_object().get('/NM')) == nm and o.get('/Parent') is not None and str(o['/Parent'].get_object().get('/NM')) == e['popupOf'])
        if e['subtype'] != 'Popup':
            apd = o.get('/AP')
            ok = False; det = 'no /AP'
            if apd and '/N' in apd:
                n = apd['/N'].get_object(); bb = [float(v) for v in n.get('/BBox', [])]
                ok = len(bb) == 4 and all(tol(p, q, 0.02) for p, q in zip(bb, [float(v) for v in o['/Rect']]))
                det = f'BBox {bb} Rect {[float(v) for v in o["/Rect"]]}'
            check('pypdf', f'{tag}: /AP /N /BBox equals /Rect', ok, det)

    # 4b conformance rules (the written list in docs/spikes/phase8-export-report.md, section "Rules"), applied to the raw dictionaries
    rules(rd, exp, pp)

    # 5 pdf.js
    pj = run_json(['node', os.path.join(HERE, 'pdfjs_dump.mjs'), a.exported] + ([a.password] if a.password else []), cwd=SPIKE, env={**os.environ, 'PAGES': str(max([e['pageIndex'] for e in expect]) + 1)})
    by_id = {x['id']: x for x in pj['annotations']}
    for nm, e in exp.items():
        if nm not in objnum: continue
        x = by_id.get(f'{objnum[nm]}R'); tag = f"{e['subtype']} {nm[-14:]}"
        check('pdf.js', f'{tag}: pdf.js lists it', x is not None and x['subtype'] == e['subtype'])
        if not x: continue
        if e.get('contents') is not None and e['subtype'] != 'Popup': check('pdf.js', f'{tag}: contents', (x['contents'] or '') == e['contents'])
        if e.get('author'): check('pdf.js', f'{tag}: title (/T)', x['title'] == e['author'])
        if e.get('rgb'): check('pdf.js', f'{tag}: colour', x['color'] == e['rgb'])
        if e.get('irt'): check('pdf.js', f'{tag}: inReplyTo is the root, replyType R', x['inReplyTo'] == f"{objnum[e['irt']]}R" and x['replyType'] == 'R', f"{x['inReplyTo']} {x['replyType']}")
        if e.get('popupOf'): pass
        if e['subtype'] != 'Popup' and not e.get('irt') and any(o.get('popupOf') == nm for o in expect):
            check('pdf.js', f'{tag}: pdf.js sees its popup', bool(x['popupRef']), x['popupRef'])
        if e.get('quads'):
            check('pdf.js', f'{tag}: quad count', x['quads'] is not None and len(x['quads']) == 8 * len(e['quads']))

    # 6 pixels
    if not a.no_pixels:
        pixel_checks(a, exp, orig)
    # summary
    fails = [r for r in results if not r['ok']]
    if a.json:
        print(json.dumps(results))
    else:
        groups = {}
        for r in results: groups.setdefault(r['group'], [0, 0]); groups[r['group']][0 if r['ok'] else 1] += 1
        print(os.path.basename(a.exported))
        for g, (p, f) in groups.items(): print(f'  {g:12s} {p} passed, {f} failed')
        for r in fails: print(f"  FAIL [{r['group']}] {r['name']} :: {r['detail']}")
    sys.exit(1 if fails else 0)

# ---------- the rules ----------
DATE = __import__('re').compile(r"^D:\d{4}(\d{2}(\d{2}(\d{2}(\d{2}(\d{2}(Z|[+-]\d{2}'?(\d{2}'?)?)?)?)?)?)?)?$")
def rules(rd, exp, pp):
    by_page = {}
    for nm, (pi, o) in pp.items(): by_page.setdefault(pi, []).append((nm, o))
    for pi, items in by_page.items():
        nms = [nm for nm, _ in items]
        check('rules', f'R1 page {pi + 1}: every /NM is unique on its page and starts "sop:"', len(nms) == len(set(nms)) and all(n.startswith('sop:') for n in nms))
    for nm, (pi, o) in pp.items():
        e = exp.get(nm)
        if not e: continue
        st = str(o.get('/Subtype'))[1:]; tag = f'{st} {nm[-14:]}'
        rect = [float(v) for v in o['/Rect']]
        check('rules', f'R2 {tag}: /Rect is 4 numbers, lower-left before upper-right', len(rect) == 4 and rect[0] < rect[2] and rect[1] < rect[3])
        if st in ('Highlight', 'Underline', 'StrikeOut'):
            q = [float(v) for v in o['/QuadPoints']]
            okq = len(q) % 8 == 0 and len(q) > 0
            lo = [min(q[0::2]), min(q[1::2]), max(q[0::2]), max(q[1::2])]
            check('rules', f'R3 {tag}: /QuadPoints are whole quads and /Rect is their union', okq and all(abs(a - b) < 0.02 for a, b in zip(lo, rect)))
        if st != 'Popup':
            ap = o.get('/AP'); n = ap['/N'].get_object() if ap and '/N' in ap else None
            check('rules', f'R4 {tag}: /AP /N is a form XObject whose /BBox equals /Rect', n is not None and str(n.get('/Subtype')) == '/Form' and all(abs(float(a) - b) < 0.02 for a, b in zip(n.get('/BBox', [0, 0, 0, 0]), rect)))
            if st == 'Highlight' and n is not None:
                res = n.get('/Resources'); gs = res.get_object().get('/ExtGState') if res else None
                bm = [str(v.get_object().get('/BM')) for v in gs.get_object().values()] if gs else []
                check('rules', f'R5 {tag}: the highlight is drawn with /BM /Multiply', '/Multiply' in bm, str(bm))
        for k in ('/M', '/CreationDate'):
            if k in o: check('rules', f'R6 {tag}: {k} is a PDF date', bool(DATE.match(str(o[k]))), str(o[k]))
        if '/C' in o: check('rules', f'R7 {tag}: /C is three numbers from 0 to 1', len(o['/C']) == 3 and all(0 <= float(v) <= 1 for v in o['/C']))
        if '/IRT' in o:
            t = o['/IRT'].get_object()
            same_page = any(str(a.get_object().get('/NM')) == str(t.get('/NM')) for a in rd.pages[pi]['/Annots'])
            check('rules', f'R8 {tag}: /IRT target is on the same page, is a root (no nested reply), /RT is /R', same_page and '/IRT' not in t and str(o.get('/RT')) == '/R' and st == 'Text')
        if st == 'Popup':
            par = o['/Parent'].get_object() if '/Parent' in o else None
            check('rules', f'R9 {tag}: /Parent set, and the parent\'s /Popup is this popup', par is not None and '/Popup' in par and str(par['/Popup'].get_object().get('/NM')) == nm)
            check('rules', f'R9 {tag}: closed (no /Open true) and not printed', not bool(o.get('/Open', False)) and not (int(o.get('/F', 0)) & 4))
        elif not e.get('irt') or int(o.get('/F', 0)) != 2:
            check('rules', f'R10 {tag}: /F has Print (4)' + (', NoZoom and NoRotate on a note' if st == 'Text' else ''), bool(int(o.get('/F', 0)) & 4) and (st != 'Text' or (int(o.get('/F', 0)) & 24) == 24))
        if st != 'Popup': check('rules', f'R11 {tag}: /T (author) is set', bool(str(o.get('/T', ''))))

# ---------- pixels ----------
def page_crop(path, pi, pw=None):
    rd = pypdf.PdfReader(path)
    if pw: rd.decrypt(pw)
    b = [float(v) for v in (rd.pages[pi].cropbox)]
    return b  # left, bottom, right, top

def render_all(path, pages, pw=None):
    """{'poppler': {page: ndarray}, 'mupdf': ..., 'pdfium': ...}"""
    out = {'poppler': {}, 'mupdf': {}, 'pdfium': {}}
    tmp = tempfile.mkdtemp()
    for pi in pages:
        base = os.path.join(tmp, f'pp{pi}')
        cmd = ['pdftoppm', '-r', str(DPI), '-png', '-f', str(pi + 1), '-l', str(pi + 1), '-singlefile'] + (['-upw', pw] if pw else []) + [path, base]
        subprocess.run(cmd, check=True, capture_output=True)
        out['poppler'][pi] = np.array(Image.open(base + '.png').convert('RGB')).astype(int)
        mp = os.path.join(tmp, f'mu{pi}.png')
        cmd = ['mutool', 'draw', '-r', str(DPI), '-o', mp] + (['-p', pw] if pw else []) + [path, str(pi + 1)]
        subprocess.run(cmd, check=True, capture_output=True)
        out['mupdf'][pi] = np.array(Image.open(mp).convert('RGB')).astype(int)
        doc = pdfium.PdfDocument(path, password=pw)
        out['pdfium'][pi] = np.array(doc[pi].render(scale=S).to_pil().convert('RGB')).astype(int)
        doc.close()
    return out

def px_box(crop, r, pad=0):
    l, b, rr, t = crop
    x0 = int(round((r[0] - l) * S)) + pad; x1 = int(round((r[2] - l) * S)) - pad
    y0 = int(round((t - r[3]) * S)) + pad; y1 = int(round((t - r[1]) * S)) - pad
    return x0, y0, x1, y1

def boxes_of(e):
    if e.get('quads'): return e['quads']
    return [e['rect']]

def dist(img, rgb):
    return np.abs(img - np.array(rgb)).sum(axis=2)

def pixel_checks(a, exp, orig_bytes):
    pages = sorted({e['pageIndex'] for e in exp.values()})
    # the original, from the original file on disk
    renders = render_all(a.exported, pages, a.password)
    base = render_all(a.original, pages, a.password)
    for nm, e in exp.items():
        kind = e.get('pixel')
        if not kind or kind == 'none': continue
        pi = e['pageIndex']; crop = page_crop(a.exported, pi, a.password); tag = f"{e['subtype']} {nm[-14:]} ({kind})"
        for rname in ('poppler', 'mupdf', 'pdfium'):
            new, old = renders[rname][pi], base[rname][pi]
            H, W = new.shape[:2]
            if kind == 'fill':
                good = tot = 0
                for r in boxes_of(e):
                    x0, y0, x1, y1 = px_box(crop, r, 1)
                    # the top 70% of each quad: the foot of a quad can carry another annotation's dotted underline on the same words
                    y1 = y0 + int((y1 - y0) * 0.7)
                    sub_old, sub_new = old[y0:y1, x0:x1], new[y0:y1, x0:x1]
                    white = sub_old.min(axis=2) > 235
                    if white.sum() == 0: continue
                    d = np.abs(sub_new - np.array(e['rgb'])).max(axis=2)
                    good += int(((d <= 14) & white).sum()); tot += int(white.sum())
                check('pixels-' + rname, f'{tag}: paper inside the quads takes the mark colour', tot > 0 and good / tot > 0.9, f'{good}/{tot}')
            elif kind in ('underline', 'strike'):
                cov = []
                for r in boxes_of(e):
                    x0, y0, x1, y1 = px_box(crop, r, 0)
                    h = y1 - y0
                    band = slice(y1 - int(h * 0.45) - 1, y1 + 1) if kind == 'underline' else slice(y0 + int(h * 0.25), y0 + int(h * 0.75))
                    sub_new, sub_old = new[band, x0:x1], old[band, x0:x1]
                    changed = (np.abs(sub_new - sub_old).sum(axis=2) > 60) & (dist(sub_new, e['rgb']) < dist(sub_old, e['rgb']))
                    cov.append(changed.any(axis=0).mean() if changed.size else 0)
                need = 0.25 if e.get('subject') == 'Thread' else 0.6
                check('pixels-' + rname, f'{tag}: a line in the mark colour crosses the quads', min(cov) >= need, f'coverage {[round(c, 2) for c in cov]}')
            elif kind == 'bold':
                x0, y0, x1, y1 = px_box(crop, e['rect'], 0)
                dark = lambda im: (im[y0:y1, x0:x1].sum(axis=2) < 300).sum()
                ratio = dark(new) / max(1, dark(old))
                check('pixels-' + rname, f'{tag}: the text gets heavier (more dark pixels than the original)', ratio >= 1.05, f'dark pixels x{ratio:.2f} (stroke 0.03 em, as the viewer draws it)')
            elif kind == 'box':
                x0, y0, x1, y1 = px_box(crop, e['rect'], 0)
                edges = [(slice(y0 - 2, y0 + 4), slice(x0, x1)), (slice(y1 - 4, y1 + 2), slice(x0, x1)), (slice(y0, y1), slice(x0 - 2, x0 + 4)), (slice(y0, y1), slice(x1 - 4, x1 + 2))]
                fr = []
                for ys, xs in edges:
                    ys = slice(max(ys.start, 0), ys.stop); xs = slice(max(xs.start, 0), xs.stop)
                    sub_new, sub_old = new[ys, xs], old[ys, xs]
                    near = dist(sub_new, e['rgb']) < 90
                    chg = np.abs(sub_new - sub_old).sum(axis=2) > 60
                    horiz = (ys.stop - ys.start) < (xs.stop - xs.start)
                    fr.append(((near & chg).any(axis=0 if horiz else 1)).mean())
                check('pixels-' + rname, f'{tag}: the outline is drawn on all four sides in the outline colour', min(fr) > 0.85, f'{[round(f, 2) for f in fr]}')
            elif kind == 'icon':
                x0, y0, x1, y1 = px_box(crop, e['rect'], 0)
                chg = (np.abs(new[y0:y1, x0:x1] - old[y0:y1, x0:x1]).sum(axis=2) > 60).mean()
                check('pixels-' + rname, f'{tag}: the note icon is drawn', chg > 0.25, f'{chg:.2f} of the rect changed')
    # replies and popups draw nothing: A/B against C (folded) are pixel-identical when --base is given
    if a.base:
        other = render_all(a.base, pages, a.password)
        for rname in ('poppler', 'mupdf', 'pdfium'):
            diff = max(int(np.abs(renders[rname][pi] - other[rname][pi]).max()) for pi in pages)
            check('pixels-' + rname, 'replies and popups draw nothing (page identical to the folded copy)', diff == 0, f'max difference {diff}')

main()
