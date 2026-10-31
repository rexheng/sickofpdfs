"""Embedding-prototype classifier test (all-MiniLM-L6-v2 int8 ONNX). Usage: embed_proto.py MODEL_DIR MANIFEST TEXT_DIR"""
import sys, json, os, re, time
import numpy as np, onnxruntime as ort
from tokenizers import Tokenizer
mdir, manp, tdir = sys.argv[1:4]
tok = Tokenizer.from_file(os.path.join(mdir, "tokenizer.json")); tok.enable_truncation(max_length=256)
sess = ort.InferenceSession(os.path.join(mdir, "onnx/model_quantized.onnx")); inames = [i.name for i in sess.get_inputs()]
def emb(t):
    e = tok.encode(t); ids = np.array([e.ids], dtype=np.int64); am = np.array([e.attention_mask], dtype=np.int64)
    feed = {"input_ids": ids, "attention_mask": am}
    if "token_type_ids" in inames: feed["token_type_ids"] = np.zeros_like(ids)
    h = sess.run(None, feed)[0][0]; v = (h * am[0][:, None]).sum(0) / am.sum(); return v / np.linalg.norm(v)
PROTOS = {
 "learning": ["Abstract. In this paper we propose a method and evaluate it empirically. Related work. References.",
   "Chapter 3. Definitions, theorems and proofs, with exercises at the end of the chapter.",
   "Lecture 5 slides: learning objectives, key concepts, examples and a summary for this week of the course.",
   "Problem set 2. Answer all questions. Show your working. Question 1: derive the equilibrium.",
   "A thesis submitted for the degree of Doctor of Philosophy. Acknowledgements. Table of contents.",
   "Working paper / discussion paper on economics and policy with literature review, data, methodology and results."],
 "not": ["Invoice number, invoice date, bill to, item description, quantity, unit price, subtotal, VAT, total amount due.",
   "Receipt. Thank you for your purchase. Card ending 1234. Subtotal, tax, total paid.",
   "Account statement. Statement period, sort code, account number, opening balance, payments in, payments out, closing balance.",
   "Boarding pass. Passenger name, flight number, gate, seat, boarding time, booking reference. E-ticket.",
   "Payslip. Employee number, tax code, gross pay, deductions, national insurance, net pay, year to date.",
   "Tax return form. Name, address, taxpayer identification number, income, signature, date.",
   "This agreement is made between the landlord and the tenant. The parties agree to the following terms and conditions. Signed."]}
P = {k: np.stack([emb(t) for t in v]) for k, v in PROTOS.items()}
man = json.load(open(manp)); ok = tot = 0; t0 = time.time()
for it in man["items"]:
    if it.get("status") != "ok": continue
    full = open(os.path.join(tdir, it["file"] + ".full.txt"), errors="replace").read()
    pages = full.split("\f"); txt = re.sub(r"\s+", " ", " ".join(pages[:2]))[:2000]
    if len(txt.split()) < 5: print(f'{it["label"][:5]:5} SKIP {it["file"]}'); continue
    v = emb(txt); sl = float((P["learning"] @ v).max()); sn = float((P["not"] @ v).max())
    pred = "learning" if sl > sn else "not-learning"; tot += 1; ok += pred == it["label"]
    print(f'{it["label"][:5]:5} learn={sl:.2f} not={sn:.2f} margin={sl-sn:+.2f} {"OK " if pred==it["label"] else "ERR"} {it["file"]}')
print(f"accuracy {ok}/{tot}; {(time.time()-t0)/max(tot,1):.3f}s/doc")
