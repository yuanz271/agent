# /// script
# requires-python = ">=3.10"
# dependencies = ["pdfplumber"]
# ///
"""Extract text labels, lines, and checkboxes from a non-fillable PDF."""

import json
import sys
import pdfplumber


def extract_structure(pdf_path):
    structure = {
        "pages": [],
        "labels": [],
        "lines": [],
        "checkboxes": [],
        "row_boundaries": [],
    }

    with pdfplumber.open(pdf_path) as pdf:
        for page_num, page in enumerate(pdf.pages, 1):
            structure["pages"].append({
                "page_number": page_num,
                "width": round(float(page.width), 1),
                "height": round(float(page.height), 1),
            })

            # Text labels
            for word in page.extract_words():
                structure["labels"].append({
                    "page": page_num,
                    "text": word["text"],
                    "x0": round(float(word["x0"]), 1),
                    "top": round(float(word["top"]), 1),
                    "x1": round(float(word["x1"]), 1),
                    "bottom": round(float(word["bottom"]), 1),
                })

            # Horizontal lines (spanning >50% of page width)
            for line in page.lines:
                span = abs(float(line["x1"]) - float(line["x0"]))
                if span > page.width * 0.5:
                    structure["lines"].append({
                        "page": page_num,
                        "y": round(float(line["top"]), 1),
                        "x0": round(float(line["x0"]), 1),
                        "x1": round(float(line["x1"]), 1),
                    })

            # Checkboxes (small square-ish rectangles)
            for rect in page.rects:
                w = float(rect["x1"]) - float(rect["x0"])
                h = float(rect["bottom"]) - float(rect["top"])
                if 5 <= w <= 15 and 5 <= h <= 15 and abs(w - h) < 2:
                    structure["checkboxes"].append({
                        "page": page_num,
                        "x0": round(float(rect["x0"]), 1),
                        "top": round(float(rect["top"]), 1),
                        "x1": round(float(rect["x1"]), 1),
                        "bottom": round(float(rect["bottom"]), 1),
                        "center_x": round((float(rect["x0"]) + float(rect["x1"])) / 2, 1),
                        "center_y": round((float(rect["top"]) + float(rect["bottom"])) / 2, 1),
                    })

    # Compute row boundaries from horizontal lines
    by_page: dict[int, list[float]] = {}
    for line in structure["lines"]:
        by_page.setdefault(line["page"], []).append(line["y"])
    for pg, ys in by_page.items():
        ys = sorted(set(ys))
        for i in range(len(ys) - 1):
            structure["row_boundaries"].append({
                "page": pg,
                "row_top": ys[i],
                "row_bottom": ys[i + 1],
                "row_height": round(ys[i + 1] - ys[i], 1),
            })

    return structure


def main():
    if len(sys.argv) != 3:
        print("Usage: extract_structure.py <input.pdf> <output.json>")
        sys.exit(1)

    print(f"Extracting structure from {sys.argv[1]}...")
    s = extract_structure(sys.argv[1])

    with open(sys.argv[2], "w") as f:
        json.dump(s, f, indent=2)

    print(f"Found:")
    print(f"  {len(s['pages'])} pages")
    print(f"  {len(s['labels'])} text labels")
    print(f"  {len(s['lines'])} horizontal lines")
    print(f"  {len(s['checkboxes'])} checkboxes")
    print(f"  {len(s['row_boundaries'])} row boundaries")
    print(f"Saved to {sys.argv[2]}")


if __name__ == "__main__":
    main()
