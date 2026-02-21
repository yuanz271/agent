---
name: pdf
description: "Use this skill for any PDF task: reading/extracting text and tables, merging, splitting, rotating, creating PDFs, filling PDF forms (fillable and non-fillable), encrypting/decrypting, extracting images, and OCR on scanned PDFs."
---

# PDF Processing Skill

## Overview

This skill covers PDF processing using Python libraries and CLI tools. All scripts
use `uv run` with inline metadata — no manual `pip install` needed.

For form filling, follow the dedicated workflow in [Form Filling](#form-filling).

## Quick Start

```bash
uv run --with pypdf python3 -c "
from pypdf import PdfReader
reader = PdfReader('document.pdf')
print(f'Pages: {len(reader.pages)}')
for page in reader.pages:
    print(page.extract_text())
"
```

## Common Tasks

### Extract Text

```bash
# With pdfplumber (best for structured text and tables)
uv run --with pdfplumber python3 -c "
import pdfplumber
with pdfplumber.open('document.pdf') as pdf:
    for page in pdf.pages:
        print(page.extract_text())
"
```

### Extract Tables

```bash
uv run --with pdfplumber,pandas python3 -c "
import pdfplumber, pandas as pd
with pdfplumber.open('document.pdf') as pdf:
    for i, page in enumerate(pdf.pages):
        for j, table in enumerate(page.extract_tables()):
            df = pd.DataFrame(table[1:], columns=table[0])
            print(f'--- Table {j+1} on page {i+1} ---')
            print(df.to_string())
"
```

### Merge PDFs

```bash
uv run --with pypdf python3 -c "
from pypdf import PdfReader, PdfWriter
writer = PdfWriter()
for f in ['doc1.pdf', 'doc2.pdf']:
    for page in PdfReader(f).pages:
        writer.add_page(page)
with open('merged.pdf', 'wb') as out:
    writer.write(out)
print('Wrote merged.pdf')
"
```

### Split PDF

```bash
uv run --with pypdf python3 -c "
from pypdf import PdfReader, PdfWriter
reader = PdfReader('input.pdf')
for i, page in enumerate(reader.pages):
    w = PdfWriter()
    w.add_page(page)
    with open(f'page_{i+1}.pdf', 'wb') as out:
        w.write(out)
    print(f'Wrote page_{i+1}.pdf')
"
```

### Rotate Pages

```bash
uv run --with pypdf python3 -c "
from pypdf import PdfReader, PdfWriter
reader = PdfReader('input.pdf')
writer = PdfWriter()
for page in reader.pages:
    page.rotate(90)  # 90, 180, or 270
    writer.add_page(page)
with open('rotated.pdf', 'wb') as out:
    writer.write(out)
print('Wrote rotated.pdf')
"
```

### Extract Metadata

```bash
uv run --with pypdf python3 -c "
from pypdf import PdfReader
meta = PdfReader('document.pdf').metadata
for key in ('title', 'author', 'subject', 'creator'):
    print(f'{key}: {getattr(meta, key, None)}')
"
```

### Password Protect / Decrypt

```bash
# Encrypt
uv run --with pypdf python3 -c "
from pypdf import PdfReader, PdfWriter
writer = PdfWriter()
for page in PdfReader('input.pdf').pages:
    writer.add_page(page)
writer.encrypt('userpass', 'ownerpass')
with open('encrypted.pdf', 'wb') as out:
    writer.write(out)
"

# Decrypt
uv run --with pypdf python3 -c "
from pypdf import PdfReader, PdfWriter
reader = PdfReader('encrypted.pdf')
reader.decrypt('password')
writer = PdfWriter()
for page in reader.pages:
    writer.add_page(page)
with open('decrypted.pdf', 'wb') as out:
    writer.write(out)
"
```

### Add Watermark

```bash
uv run --with pypdf python3 -c "
from pypdf import PdfReader, PdfWriter
watermark = PdfReader('watermark.pdf').pages[0]
reader = PdfReader('document.pdf')
writer = PdfWriter()
for page in reader.pages:
    page.merge_page(watermark)
    writer.add_page(page)
with open('watermarked.pdf', 'wb') as out:
    writer.write(out)
"
```

### OCR Scanned PDFs

```bash
uv run --with pytesseract,pdf2image python3 -c "
import pytesseract
from pdf2image import convert_from_path
images = convert_from_path('scanned.pdf')
for i, img in enumerate(images):
    print(f'--- Page {i+1} ---')
    print(pytesseract.image_to_string(img))
"
```

### Create a PDF with ReportLab

```bash
uv run --with reportlab python3 -c "
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
c = canvas.Canvas('output.pdf', pagesize=letter)
w, h = letter
c.drawString(100, h - 100, 'Hello World!')
c.save()
print('Wrote output.pdf')
"
```

**Important**: Never use Unicode subscript/superscript characters (₀₁₂ etc.) in
ReportLab — built-in fonts render them as black boxes. Use `<sub>` and `<super>`
tags in `Paragraph` objects instead.

### Convert PDF to Images

Run from this skill's directory:

```bash
uv run scripts/convert_to_images.py input.pdf output_dir/
```

## CLI Tools (if available)

| Tool | Install | Example |
|------|---------|---------|
| `pdftotext` | `poppler-utils` | `pdftotext -layout input.pdf output.txt` |
| `qpdf` | `qpdf` | `qpdf --empty --pages a.pdf b.pdf -- merged.pdf` |
| `pdftk` | `pdftk` | `pdftk input.pdf burst` |
| `pdfimages` | `poppler-utils` | `pdfimages -j input.pdf prefix` |

## Quick Reference

| Task | Best Approach |
|------|---------------|
| Extract text | `pdfplumber` or `pdftotext` |
| Extract tables | `pdfplumber` |
| Merge/split | `pypdf` or `qpdf` |
| Create PDFs | `reportlab` |
| Fill forms | See [Form Filling](#form-filling) below |
| OCR scanned | `pytesseract` + `pdf2image` |
| Extract images | `pdfimages` CLI |

---

## Form Filling

**CRITICAL: Follow these steps in order. Do not skip ahead.**

### Step 1: Check for Fillable Fields

Run from this skill's directory:

```bash
uv run scripts/check_fillable.py input.pdf
```

Based on the result, go to either **Fillable Forms** or **Non-Fillable Forms**.

---

### Fillable Forms

If the PDF has fillable form fields:

#### 1. Extract field info

```bash
uv run scripts/extract_fields.py input.pdf field_info.json
```

This produces a JSON array of fields:

```json
[
  { "field_id": "last_name", "page": 1, "type": "text", "rect": [x0, y0, x1, y1] },
  { "field_id": "agree_checkbox", "page": 1, "type": "checkbox",
    "checked_value": "/Yes", "unchecked_value": "/Off" },
  { "field_id": "color_choice", "page": 2, "type": "radio_group",
    "radio_options": [{ "value": "/Red", "rect": [...] }, ...] },
  { "field_id": "dropdown", "page": 2, "type": "choice",
    "choice_options": [{ "value": "opt1", "text": "Option 1" }, ...] }
]
```

#### 2. Convert to images for visual analysis

```bash
uv run scripts/convert_to_images.py input.pdf images/
```

Examine the images to understand each field's purpose.

#### 3. Create field_values.json

```json
[
  { "field_id": "last_name", "page": 1, "value": "Smith" },
  { "field_id": "agree_checkbox", "page": 1, "value": "/Yes" }
]
```

- For checkboxes: use the `checked_value` or `unchecked_value` from field_info.json
- For radio groups: use one of the `value` entries from `radio_options`
- For choice fields: use one of the `value` entries from `choice_options`

#### 4. Fill the form

```bash
uv run scripts/fill_fields.py input.pdf field_values.json output.pdf
```

The script validates field IDs and values before writing. Fix any errors and retry.

---

### Non-Fillable Forms

If the PDF does not have fillable fields, you add text as annotations.

#### Strategy A: Structure-Based (preferred)

Try extracting text labels and layout structure first:

```bash
uv run scripts/extract_structure.py input.pdf structure.json
```

If the result has meaningful labels, use those coordinates directly.

#### Strategy B: Visual Estimation (fallback)

If the PDF is scanned/image-based with no extractable text:

```bash
uv run scripts/convert_to_images.py input.pdf images/
```

Examine each page image. For precise coordinates, crop and zoom:

```bash
magick images/page_1.png -crop 300x80+50+120 +repage crop.png
```

Then convert crop-local coords back to full-image coords:
`full_x = crop_x + crop_offset_x`, `full_y = crop_y + crop_offset_y`.

#### Create fields.json

For **PDF coordinates** (from structure extraction):

```json
{
  "pages": [{ "page_number": 1, "pdf_width": 612, "pdf_height": 792 }],
  "form_fields": [
    {
      "page_number": 1,
      "description": "Last name",
      "field_label": "Last Name",
      "label_bounding_box": [43, 63, 87, 73],
      "entry_bounding_box": [92, 63, 260, 79],
      "entry_text": { "text": "Smith", "font_size": 10 }
    }
  ]
}
```

For **image coordinates** (from visual estimation):

```json
{
  "pages": [{ "page_number": 1, "image_width": 1700, "image_height": 2200 }],
  "form_fields": [...]
}
```

#### Validate bounding boxes

```bash
uv run scripts/check_boxes.py fields.json
```

Fix any intersection or sizing errors before filling.

#### Fill the form

```bash
uv run scripts/fill_annotations.py input.pdf fields.json output.pdf
```

#### Verify output

```bash
uv run scripts/convert_to_images.py output.pdf verify/
```

Check the images. If text is mispositioned, adjust coordinates and re-fill.
