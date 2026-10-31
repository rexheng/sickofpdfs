"""DiT (RVL-CDIP) page-image classifier test. Usage: dit_proto.py MODEL_DIR MANIFEST IMG_DIR"""
import sys, json, os, glob, time
import numpy as np, onnxruntime as ort
from PIL import Image
mdir, manp, idir = sys.argv[1:4]
labels = json.load(open(os.path.join(mdir, "config.json")))["id2label"]
sess = ort.InferenceSession(os.path.join(mdir, "onnx/model_quantized.onnx")); iname = sess.get_inputs()[0].name
LEARN = {"scientific publication", "scientific report", "presentation"}
man = json.load(open(manp)); ok = tot = 0; t0 = time.time()
for it in man["items"]:
    if it.get("status") != "ok": continue
    b = it["file"][:-4]; c = sorted(glob.glob(os.path.join(idir, b + "-*.png")))
    if not c: print("NOIMG", b); continue
    im = Image.open(c[0]).convert("RGB").resize((224, 224), Image.BILINEAR)
    x = (np.asarray(im, dtype=np.float32) / 255.0 - 0.5) / 0.5
    x = x.transpose(2, 0, 1)[None]
    lg = sess.run(None, {iname: x})[0][0]; p = np.exp(lg - lg.max()); p /= p.sum()
    top = labels[str(int(p.argmax()))]; pl = sum(p[int(k)] for k, v in labels.items() if v in LEARN)
    pred = "learning" if pl >= 0.5 else "not-learning"; tot += 1; ok += pred == it["label"]
    print(f'{it["label"][:5]:5} P(learn)={pl:.2f} {"OK " if pred==it["label"] else "ERR"} top={top:22} {b}')
print(f"accuracy {ok}/{tot}; {(time.time()-t0)/max(tot,1):.2f}s/page")
