"""Research prototype of the learning-relevance score. Usage: python3 -I score_proto.py MANIFEST TEXT_DIR
Reads only pdftotext output + manifest metadata. Not product code."""
import sys, json, re, os
from urllib.parse import urlparse
man = json.load(open(sys.argv[1])); tdir = sys.argv[2]

SCHOLARLY_HOSTS = ["arxiv.org","doi.org","jstor.org","ssrn.com","nber.org","semanticscholar.org","openreview.net","aclanthology.org",
 "springer.com","sciencedirect.com","wiley.com","tandfonline.com","sagepub.com","academic.oup.com","cambridge.org","nature.com","science.org",
 "pnas.org","plos.org","frontiersin.org","mdpi.com","biorxiv.org","medrxiv.org","osf.io","researchgate.net","core.ac.uk","europepmc.org",
 "ncbi.nlm.nih.gov","repec.org","econstor.eu","cepr.org","imf.org","worldbank.org","oecd.org","bis.org","ecb.europa.eu","federalreserve.gov",
 "ipcc.ch","ifs.org.uk","ocw.mit.edu","openstax.org","libretexts.org","greenteapress.com","cs50.net","ieee.org","acm.org"]
LMS = ["moodle","canvas","instructure.com","blackboard","brightspace","d2l","echo360","talis","readinglists","panopto"]
ACADEMIC_TLD = re.compile(r"(\.ac\.[a-z]{2}|\.edu(\.[a-z]{2})?|\.uni-[a-z-]+\.de)$")
NEG_HOSTS = ["bank","paypal","stripe.com","amazon.","uber.com","trainline","nationalrail","ryanair","easyjet","ba.com","eventbrite","ticketmaster",
 "irs.gov","hmrc","docusign","hellosign","adobesign","monzo","revolut","barclays","hsbc","lloydsbank","natwest","santander","octopus.energy","invoice2data","my-receipts"]
NEG_PATH = re.compile(r"(invoice|receipt|billing|statement|payslip|payroll|pay-?stub|ticket|boarding|order|tax-?form|/forms?/|tenancy|contract)", re.I)

def url_score(u):
    if not u: return 0, []
    p = urlparse(u); h = (p.hostname or "").lower(); path = p.path.lower(); s = 0; why = []
    if any(h == d or h.endswith("." + d) or d in h for d in SCHOLARLY_HOSTS): s += 3; why.append("url:scholarly")
    elif any(k in h or k in path for k in LMS): s += 2; why.append("url:lms")
    elif ACADEMIC_TLD.search(h): s += 1; why.append("url:academic-tld")
    if any(k in h for k in NEG_HOSTS): s -= 4; why.append("url:neg-host")
    if NEG_PATH.search(path): s -= 2; why.append("url:neg-path")
    return s, why

RX = {k: re.compile(v, re.I | re.M) for k, v in {
 "arxiv": r"arXiv:\s?\d{4}\.\d{4,5}|arxiv\.org/abs/",
 "doi": r"\b10\.\d{4,9}/[-._;()/:a-z0-9]+",
 "isbn": r"\bISBN(-1[03])?:?\s?[0-9][-0-9 ]{9,16}[0-9x]\b",
 "abstract": r"^\s*(abstract|executive summary)\b",
 "refs": r"^\s*(\d+\.?\s*)?(references|bibliography|works cited|literature cited|further reading)\s*$",
 "chapter": r"^\s*(chapter|part|lecture|week|unit|module|section)\s+\d+|^\s*(table of )?contents\s*$",
 "thesis": r"(submitted in (partial )?fulfil?ment|doctor of philosophy|\bph\.?d\.? thesis|master'?s thesis|dissertation)",
}.items()}
CITE = re.compile(r"\[\d{1,3}(?:[,–-]\s?\d{1,3})*\]|\([A-Z][A-Za-z-]+(?: et al\.)?,? (?:19|20)\d{2}[a-z]?\)|\bet al\.")
ACAD_WORDS = re.compile(r"\b(theorem|lemma|proof|corollary|proposition|definition|exercise|problem set|lecture|chapter|equation|hypothesis|methodology|literature|empirical|estimat\w+|regression|figure|appendix|learning objectives|syllabus|tutorial|seminar|we show|we propose|in this paper|in this chapter|solution)\b", re.I)
MATH = re.compile(r"[=∑∫∂√≤≥≈≠∞±→∈∀∃αβγδεθλμπσφωΣΠΔΩ]")
NEG_TERMS = [r"\binvoice\b", r"\breceipt\b", r"bill(ed)? to", r"ship(ped)? to", r"(invoice|order|account|customer|booking|reference)\s*(no\.?|number|#|nr\.?)",
 r"amount due|balance due|total due|amount payable|to pay\b", r"\bsub-?total\b", r"payment (method|terms|due)", r"card ending|mastercard|\bvisa\b",
 r"\bvat\b|\bgst\b|\btva\b|\bmwst\b|\bust\b|\bbtw\b|\biva\b", r"rechnung|facture|factuur|quittung|kassenbon|fahrkarte|beleg",
 r"boarding pass|\bgate\b|\bseat\b|flight|\bpnr\b|e-?ticket|booking ref", r"statement (date|period)|sort code|\biban\b|\bbic\b|swift|opening balance|closing balance|available balance|direct debit",
 r"pay ?slip|pay statement|net pay|gross pay|deductions|national insurance|tax code|\bpaye\b|year[- ]to[- ]date|\bytd\b",
 r"omb no|internal revenue service|\bhmrc\b|self assessment|\butr\b|social security number|taxpayer|tax return",
 r"\blandlord\b|\btenant\b|hereinafter|the parties|terms and conditions|signature of|witness(ed)? by"]
NEG_RX = [re.compile(t, re.I) for t in NEG_TERMS]
CURRENCY = re.compile(r"(?:[£$€₹¥]|\b(?:USD|GBP|EUR|INR|CAD|CHF)\b)\s?\d[\d,.]*|\b\d[\d.,]*[.,]\d{2}\s?(?:€|EUR|\$|£)")
GEN_PRODUCERS = re.compile(r"wkhtmltopdf|apache fop|itext|tcpdf|fpdf|reportlab|jasper|crystal reports|reporting services|bi publisher|stripe|odoo|antenna house|xsl formatter|sliced invoices|pypdf2|docraptor|prince", re.I)
SCANNER = re.compile(r"scansnap|camscanner|adobe scan|genius scan|scanner|^notes$|pfu", re.I)
LATEX = re.compile(r"latex|pdftex|xetex|luatex|tex\b|beamer", re.I)

def score(it, use_url=True):
    f = it["file"]; base = os.path.join(tdir, f)
    full = open(base + ".full.txt", errors="replace").read()
    pages = full.split("\f"); n = it.get("pages") or len(pages)
    head = "\n".join(pages[:5]); tail = "\n".join(pages[-5:]) if n > 5 else ""
    text = head + "\n" + tail
    words = max(1, len(re.findall(r"\w+", text)))
    meta = it.get("pdf_meta", {}); prod = (meta.get("Creator","") + " " + meta.get("Producer",""))
    s = -1.0; why = ["prior:-1"]
    def add(v, w): 
        nonlocal s; s += v; why.append(f"{w}:{v:+g}")
    if words < 15 and len(re.findall(r"\w+", full)) < 30:
        u, uw = url_score(it["url"]) if use_url else (0, [])
        return ("no-text", s + u, why + uw)
    if RX["arxiv"].search(text) or re.match(r"\d{4}\.\d{4,5}", f): add(4, "arxiv-id")
    if RX["doi"].search(text): add(2, "doi")
    if RX["isbn"].search(text): add(1.5, "isbn")
    if RX["abstract"].search("\n".join(pages[:2])): add(2, "abstract")
    if RX["refs"].search(text): add(2.5, "references-heading")
    if RX["chapter"].search(head): add(1.5, "chapter/contents/lecture")
    if RX["thesis"].search(head): add(2, "thesis")
    c = len(CITE.findall(text)) 
    if c >= 20: add(2.5, f"citations({c})")
    elif c >= 5: add(1.5, f"citations({c})")
    a = 1000 * len(ACAD_WORDS.findall(text)) / words
    if a >= 8: add(2, f"acad-vocab({a:.1f}/kw)")
    elif a >= 3: add(1, f"acad-vocab({a:.1f}/kw)")
    m = 100 * len(MATH.findall(text)) / max(1, len(text))
    if m >= 1.5: add(1.5, f"math({m:.2f}%)")
    elif m >= 0.5: add(1, f"math({m:.2f}%)")
    if LATEX.search(prod): add(1.5, "latex-producer")
    if n >= 100: add(2.5, f"pages({n})")
    elif n >= 30: add(2, f"pages({n})")
    elif n >= 8: add(1, f"pages({n})")
    elif n <= 2: add(-1, f"pages({n})")
    ps = re.findall(r"([\d.]+) x ([\d.]+)", meta.get("Page size",""))
    if ps:
        w, h = map(float, ps[0])
        if w < 300 or h / max(w,1) > 2.2: add(-2, "receipt-roll-size")
        if w > h and n >= 10: add(1, "landscape-deck")
    neg = sum(1 for r in NEG_RX if r.search(text))
    if neg: add(-min(5, 1.0 * neg), f"admin-terms({neg})")
    cur = 1000 * len(CURRENCY.findall(text)) / words
    if cur >= 30: add(-3, f"currency({cur:.0f}/kw)")
    elif cur >= 15: add(-2, f"currency({cur:.0f}/kw)")
    elif cur >= 5: add(-1, f"currency({cur:.0f}/kw)")
    if meta.get("Form") == "XFA": add(-2, "xfa-form")
    if GEN_PRODUCERS.search(prod): add(-1, "doc-generator-producer")
    if use_url:
        u, uw = url_score(it["url"])
        if u: add(u, "+".join(uw))
    return ("text", s, why)

def decide(kind, s):
    if kind == "no-text": return "learning" if s >= 3 else "not-learning(no-text)"
    return "learning" if s >= 3 else ("not-learning" if s <= 0 else "ambiguous")

for use_url in (False, True):
    print("\n##### use_url =", use_url)
    tally = {}
    for it in man["items"]:
        if it.get("status") != "ok": continue
        kind, s, why = score(it, use_url)
        d = decide(kind, s)
        key = (it["label"], d.split("(")[0]); tally[key] = tally.get(key, 0) + 1
        print(f'{it["label"][:5]:5} {d:22} {s:+5.1f} {it["file"][:44]:44} {" ".join(why[1:])[:150]}')
    print(tally)
