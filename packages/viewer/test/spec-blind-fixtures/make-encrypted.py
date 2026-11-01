"""Writes the encrypted fixtures used by backend.spec-blind.browser.test.ts (run: python3 -I make-encrypted.py).

Each file has one Letter page that says "Secret passage: swordfish 42".
  enc-<algorithm>.pdf   user password "open-sesame", owner password "owner-pw"
  enc-owner-only.pdf    AES-128, empty user password (opens without a prompt, but is encrypted)
Needs reportlab, pypdf and cryptography.
"""
import io
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas

OUT = Path(__file__).resolve().parent


def plain_pdf() -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(612, 792), invariant=1)
    c.setFont("Helvetica", 18)
    c.drawString(72, 700, "Secret passage: swordfish 42")
    c.showPage()
    c.save()
    return buf.getvalue()


def encrypt(name: str, algorithm: str, user: str) -> None:
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(plain_pdf())))
    writer.encrypt(user_password=user, owner_password="owner-pw", algorithm=algorithm)
    with open(OUT / name, "wb") as f:
        writer.write(f)
    print(name, (OUT / name).stat().st_size, "bytes")


for algo in ("RC4-128", "AES-128", "AES-256"):
    encrypt(f"enc-{algo}.pdf", algo, "open-sesame")
encrypt("enc-owner-only.pdf", "AES-128", "")
