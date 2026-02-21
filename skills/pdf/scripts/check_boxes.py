# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Validate bounding boxes in a fields.json file before filling."""

import json
import sys


def _intersects(a, b):
    """Check if two [x0, y0, x1, y1] rects overlap."""
    return not (a[0] >= b[2] or a[2] <= b[0] or a[1] >= b[3] or a[3] <= b[1])


def validate(fields_data):
    messages = []
    form_fields = fields_data.get("form_fields", [])
    messages.append(f"Checking {len(form_fields)} fields")

    rects = []  # (rect, rect_type, field)
    for f in form_fields:
        rects.append((f["label_bounding_box"], "label", f))
        rects.append((f["entry_bounding_box"], "entry", f))

    errors = 0
    for i, (ri, ti, fi) in enumerate(rects):
        for j in range(i + 1, len(rects)):
            rj, tj, fj = rects[j]
            if fi.get("page_number") != fj.get("page_number"):
                continue
            if _intersects(ri, rj):
                errors += 1
                if fi is fj:
                    messages.append(
                        f"FAILURE: label and entry overlap for '{fi['description']}' ({ri}, {rj})"
                    )
                else:
                    messages.append(
                        f"FAILURE: {ti} of '{fi['description']}' ({ri}) overlaps "
                        f"{tj} of '{fj['description']}' ({rj})"
                    )
                if errors >= 20:
                    messages.append("Too many errors; fix and retry")
                    return messages

        if ti == "entry" and "entry_text" in fi:
            font_size = fi["entry_text"].get("font_size", 14)
            height = ri[3] - ri[1]
            if height < font_size:
                errors += 1
                messages.append(
                    f"FAILURE: entry box height ({height:.1f}) for '{fi['description']}' "
                    f"is shorter than font size ({font_size}). Increase box height or decrease font size."
                )

    if errors == 0:
        messages.append("SUCCESS: All bounding boxes are valid")
    return messages


def main():
    if len(sys.argv) != 2:
        print("Usage: check_boxes.py <fields.json>")
        sys.exit(1)

    with open(sys.argv[1]) as f:
        data = json.load(f)

    for msg in validate(data):
        print(msg)


if __name__ == "__main__":
    main()
