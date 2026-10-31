"""Download fixture PDFs listed in a JSON file. Usage: python3 -I fetch_fixtures.py fixtures.json OUT_ROOT TEXT_ROOT
Downloads are treated as untrusted data: only read bytes, run pdfinfo/pdftotext (parsers), never execute."""
import sys, json, os, subprocess, hashlib, datetime
spec, out_root, text_root = sys.argv[1], sys.argv[2], sys.argv[3]
MAX = 15 * 1024 * 1024
items = json.load(open(spec))
manifest = []
os.makedirs(text_root, exist_ok=True)
for it in items:
    d = os.path.join(out_root, it["cls"]); os.makedirs(d, exist_ok=True)
    dest = os.path.join(d, it["file"])
    rec = dict(it); rec["path"] = f'{it["cls"]}/{it["file"]}'
    if not os.path.exists(dest):
        r = subprocess.run(["curl", "-sSL", "--fail", "-m", "180", "--max-filesize", str(MAX), "-A", "Mozilla/5.0 (fixture fetch for classifier research)", "-o", dest, it["url"]], capture_output=True, text=True)
        if r.returncode != 0:
            rec["status"] = "download_failed: " + r.stderr.strip()[:200]
            if os.path.exists(dest): os.remove(dest)
            print("FAIL", it["file"], rec["status"]); manifest.append(rec); continue
    data = open(dest, "rb").read()
    if not data[:1024].lstrip().startswith(b"%PDF") and b"%PDF" not in data[:1024]:
        rec["status"] = "rejected_not_pdf"; os.remove(dest); print("NOTPDF", it["file"]); manifest.append(rec); continue
    if len(data) > MAX:
        rec["status"] = "rejected_too_large"; os.remove(dest); manifest.append(rec); continue
    rec["bytes"] = len(data); rec["sha256"] = hashlib.sha256(data).hexdigest()
    info = subprocess.run(["pdfinfo", dest], capture_output=True, text=True, errors="replace").stdout
    meta = {}
    for line in info.splitlines():
        if ":" in line:
            k, v = line.split(":", 1); meta[k.strip()] = v.strip()
    rec["pages"] = int(meta.get("Pages", "0") or 0)
    rec["pdf_meta"] = {k: meta.get(k, "") for k in ("Title", "Author", "Subject", "Keywords", "Creator", "Producer", "Page size", "Form", "Tagged")}
    txt = os.path.join(text_root, it["file"] + ".txt")
    subprocess.run(["pdftotext", "-l", "6", "-layout", dest, txt], capture_output=True)
    subprocess.run(["pdftotext", "-layout", dest, txt.replace(".txt", ".full.txt")], capture_output=True)
    rec["status"] = "ok"; rec["retrieved"] = datetime.date.today().isoformat()
    print("OK", rec["path"], rec["bytes"], rec["pages"])
    manifest.append(rec)
json.dump({"generated": datetime.date.today().isoformat(), "max_bytes": MAX, "note": "Public PDFs fetched as untrusted data for evaluating a learning-vs-not-learning classifier. Never execute. 'path' is relative to this folder.", "items": manifest}, open(os.path.join(out_root, "manifest.json"), "w"), indent=1)
