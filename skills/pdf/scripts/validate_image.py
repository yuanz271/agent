# /// script
# requires-python = ">=3.10"
# dependencies = ["Pillow"]
# ///
"""Draw bounding boxes on a page image for visual validation of fields.json."""

import json
import sys
from PIL import Image, ImageDraw


def main():
    if len(sys.argv) != 5:
        print("Usage: validate_image.py <page_number> <fields.json> <input_image> <output_image>")
        sys.exit(1)

    page_num = int(sys.argv[1])
    fields_path = sys.argv[2]
    input_path = sys.argv[3]
    output_path = sys.argv[4]

    with open(fields_path) as f:
        data = json.load(f)

    img = Image.open(input_path)
    draw = ImageDraw.Draw(img)

    count = 0
    for field in data.get("form_fields", []):
        if field.get("page_number") != page_num:
            continue
        draw.rectangle(field["label_bounding_box"], outline="blue", width=2)
        draw.rectangle(field["entry_bounding_box"], outline="red", width=2)
        count += 2

    img.save(output_path)
    print(f"Created validation image at {output_path} with {count} bounding boxes")


if __name__ == "__main__":
    main()
