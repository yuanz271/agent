# /// script
# requires-python = ">=3.10"
# dependencies = ["pypdf"]
# ///
"""Fill a non-fillable PDF form by adding FreeText annotations."""

import json
import sys
from pypdf import PdfReader, PdfWriter
from pypdf.annotations import FreeText


def _to_pypdf_rect_from_image(bbox, iw, ih, pw, ph):
    """Convert image-pixel bbox [x0,y0,x1,y1] to pypdf rect (origin bottom-left)."""
    sx, sy = pw / iw, ph / ih
    left = bbox[0] * sx
    right = bbox[2] * sx
    top = ph - bbox[1] * sy
    bottom = ph - bbox[3] * sy
    return (left, bottom, right, top)


def _to_pypdf_rect_from_pdf(bbox, ph):
    """Convert PDF-coord bbox [x0,y0,x1,y1] (y=0 at top) to pypdf rect (y=0 at bottom)."""
    left = bbox[0]
    right = bbox[2]
    top = ph - bbox[1]
    bottom = ph - bbox[3]
    return (left, bottom, right, top)


def main():
    if len(sys.argv) != 4:
        print("Usage: fill_annotations.py <input.pdf> <fields.json> <output.pdf>")
        sys.exit(1)

    input_pdf, fields_path, output_pdf = sys.argv[1], sys.argv[2], sys.argv[3]

    with open(fields_path) as f:
        data = json.load(f)

    reader = PdfReader(input_pdf)
    writer = PdfWriter()
    writer.append(reader)

    # Get actual PDF dimensions per page
    pdf_dims = {}
    for i, page in enumerate(reader.pages):
        mb = page.mediabox
        pdf_dims[i + 1] = (float(mb.width), float(mb.height))

    count = 0
    for field in data.get("form_fields", []):
        entry_text = field.get("entry_text", {})
        text = entry_text.get("text", "")
        if not text:
            continue

        pg = field["page_number"]
        pw, ph = pdf_dims[pg]
        page_info = next(p for p in data["pages"] if p["page_number"] == pg)

        if "pdf_width" in page_info:
            rect = _to_pypdf_rect_from_pdf(field["entry_bounding_box"], ph)
        else:
            iw = page_info["image_width"]
            ih = page_info["image_height"]
            rect = _to_pypdf_rect_from_image(field["entry_bounding_box"], iw, ih, pw, ph)

        font = entry_text.get("font", "Arial")
        font_size = str(entry_text.get("font_size", 14)) + "pt"
        font_color = entry_text.get("font_color", "000000")

        annotation = FreeText(
            text=text,
            rect=rect,
            font=font,
            font_size=font_size,
            font_color=font_color,
            border_color=None,
            background_color=None,
        )
        writer.add_annotation(page_number=pg - 1, annotation=annotation)
        count += 1

    with open(output_pdf, "wb") as f:
        writer.write(f)

    print(f"Added {count} text annotations and saved to {output_pdf}")


if __name__ == "__main__":
    main()
