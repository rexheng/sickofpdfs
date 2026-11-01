"""Verifies the save matrix written by scripts/write-matrix.ts (matrix.json): one highlight + popup + reply tail-saved
into each input. Prints one line per input.  usage: verify_matrix.py OUTDIR  (run with the pyHanko venv's python)"""
import json, sys, subprocess, hashlib, os, re
import pypdf

out_dir = sys.argv[1]
rows = json.load(open(os.path.join(out_dir, 'matrix.json')))

def qpdf(path, *args, pw=None):
    cmd = ['qpdf'] + ([f'--password={pw}'] if pw else []) + list(args) + [path]
    p = subprocess.run(cmd, capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr

def pypdf_annots(path, pw):
    r = pypdf.PdfReader(path)
    if r.is_encrypted: r.decrypt(pw or '')
    res = []
    for pi, pg in enumerate(r.pages):
        for ref in pg.get('/Annots') or []:
            o = ref.get_object()
            res.append((pi, str(o.get('/Subtype')), tuple(round(float(v), 2) for v in o.get('/Rect', [])), str(o.get('/Contents', '')), str(o.get('/NM', ''))))
    return res

for r in rows:
    name = r['name']; out = r['file']; src = r['source']; pw = r['password']
    o = open(out, 'rb').read(); s = open(src, 'rb').read()
    line = {'name': name, 'prefix': o[:len(s)] == s, 'tailKB': round((len(o) - len(s)) / 1024, 1)}
    rc, text = qpdf(out, '--check', pw=pw)
    rc0, text0 = qpdf(src, '--check', pw=pw)
    warn = lambda t: {re.sub(r'^.*?: ', '', l) for l in t.splitlines() if 'WARNING' in l or 'ERROR' in l}
    new = [w for w in warn(text) - warn(text0) if 'is not one plus the highest object number' not in w]
    line['qpdf'] = 'clean' if not new and rc in (0, 3) else f'{rc}: {new[:2]}'
    # annotations
    before = pypdf_annots(src, pw); after = pypdf_annots(out, pw)
    added = [a for a in after if a[4].startswith('sop:matrix')]
    kept = all(a in after for a in before)
    line['annots'] = f'{len(before)} -> {len(after)} (+{len(added)}: {sorted(a[1] for a in added)}), existing kept: {kept}'
    ok_reply = False
    try:
        r2 = pypdf.PdfReader(out)
        if r2.is_encrypted: r2.decrypt(pw or '')
        for ref in r2.pages[0]['/Annots']:
            d = ref.get_object()
            if str(d.get('/NM')) == 'sop:matrix-root~r1': ok_reply = str(d['/IRT'].get_object().get('/NM')) == 'sop:matrix-root' and str(d.get('/Contents')) == 'reply'
    except Exception as e:
        line['pypdf_error'] = str(e)[:80]
    line['reply_ok'] = ok_reply
    # encryption
    if pw:
        _, e0 = qpdf(src, '--show-encryption', pw=pw); _, e1 = qpdf(out, '--show-encryption', pw=pw)
        strip = lambda t: [l for l in t.splitlines() if not l.startswith('File:') and 'User password' not in l]
        line['encryption'] = 'same' if strip(e0) == strip(e1) else f'CHANGED\n{e0}\n---\n{e1}'
        rc_wrong, _ = qpdf(out, '--check', pw='wrong')
        line['wrong_password_refused'] = rc_wrong == 2
        # the strings of the new annotations are encrypted in the file, not stored in the clear
        line['reply_text_in_clear_in_tail'] = b'(reply)' in o[len(s):] or b'reply' in o[len(s):].replace(b'/RT', b'')
    # linearization
    if 'linear' in name:
        rc_l0, l0 = qpdf(src, '--check-linearization'); rc_l1, l1 = qpdf(out, '--check-linearization')
        line['linearized'] = {'source': 'ok' if rc_l0 == 0 else l0.strip()[:60], 'exported': l1.strip().replace('\n', ' | ')[:160],
                              'qpdf says linearized': 'File is linearized' in qpdf(out, '--check')[1]}
    print(json.dumps(line, ensure_ascii=False))
