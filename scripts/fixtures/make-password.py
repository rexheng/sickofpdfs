# Writes packages/viewer/test/fixtures/password-secret.pdf: 2 Letter pages, each with one line of Helvetica
# ("Secret page 1", "Secret page 2"), encrypted with AES-256 (user password "secret", owner password "owner-secret").
# pdf-lib cannot encrypt, so this one generator is Python. It runs once; the PDF is committed (encryption uses random
# salts and IVs, so every run gives different bytes).
#   python3 -I -m venv .venv-fixtures
#   .venv-fixtures/bin/python -I -m pip install -r scripts/fixtures/requirements.txt
#   .venv-fixtures/bin/python -I scripts/fixtures/make-password.py
from pathlib import Path

from pypdf import PdfWriter
from pypdf.generic import ContentStream, DictionaryObject, NameObject

OUT = Path(__file__).resolve().parents[2] / "packages/viewer/test/fixtures/password-secret.pdf"

writer = PdfWriter()
font = writer._add_object(  # noqa: SLF001 (pypdf has no public call for a bare font object)
    DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
)
for n in (1, 2):
    page = writer.add_blank_page(width=612, height=792)
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})}
    )
    stream = ContentStream(None, None)
    stream.set_data(f"BT /F1 24 Tf 72 700 Td (Secret page {n}) Tj ET".encode("ascii"))
    page.replace_contents(stream)
writer.add_metadata({"/Title": "Password fixture"})
writer.encrypt(user_password="secret", owner_password="owner-secret", algorithm="AES-256")

OUT.parent.mkdir(parents=True, exist_ok=True)
with OUT.open("wb") as f:
    writer.write(f)
print(f"{OUT.name}: 2 pages, AES-256, {OUT.stat().st_size} bytes")
