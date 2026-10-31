"""Zero-shot NLI test (MobileBERT-MNLI int8 ONNX, same weights transformers.js would load). Usage: zeroshot_proto.py MODEL_DIR MANIFEST TEXT_DIR"""
import sys, json, os, re, time
import numpy as np, onnxruntime as ort
from tokenizers import Tokenizer
mdir, manp, tdir = sys.argv[1:4]
tok = Tokenizer.from_file(os.path.join(mdir, "tokenizer.json"))
tok.enable_truncation(max_length=256, strategy="only_first")
sess = ort.InferenceSession(os.path.join(mdir, "onnx/model_quantized.onnx"))
inames = [i.name for i in sess.get_inputs()]
LEARN = ["academic paper", "textbook chapter", "lecture notes or slides", "problem set or exam", "thesis or research report"]
ADMIN = ["invoice or receipt", "bank statement", "ticket or boarding pass", "payslip or tax form", "contract or legal agreement"]
LABELS = LEARN + ADMIN
def run(premise, hyp):
    enc = tok.encode(premise, hyp)
    feed = {"input_ids": np.array([enc.ids], dtype=np.int64), "attention_mask": np.array([enc.attention_mask], dtype=np.int64)}
    if "token_type_ids" in inames: feed["token_type_ids"] = np.array([enc.type_ids], dtype=np.int64)
    return sess.run(None, feed)[0][0]
man = json.load(open(manp)); ok = 0; tot = 0; t0 = time.time()
for it in man["items"]:
    if it.get("status") != "ok": continue
    full = open(os.path.join(tdir, it["file"] + ".full.txt"), errors="replace").read()
    first = re.sub(r"\s+", " ", full.split("\f")[0])[:1500]
    if len(first.split()) < 5: print(f'{it["label"][:5]:5} SKIP(no text) {it["file"]}'); continue
    ent = []
    for lab in LABELS:
        lg = run(first, f"This document is a {lab}.")
        ent.append(lg[0] - lg[2])  # entailment vs contradiction logit
    ent = np.array(ent); p = np.exp(ent - ent.max()); p /= p.sum()
    pl = p[:len(LEARN)].sum(); pred = "learning" if pl >= 0.5 else "not-learning"
    tot += 1; ok += (pred == it["label"])
    top = LABELS[int(p.argmax())]
    print(f'{it["label"][:5]:5} P(learn)={pl:.2f} {"OK " if pred==it["label"] else "ERR"} top="{top}" {it["file"]}')
print(f"accuracy {ok}/{tot}; {(time.time()-t0)/max(tot,1):.2f}s per doc (10 NLI passes, CPU, int8)")
