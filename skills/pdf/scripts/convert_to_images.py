# /// script
# requires-python = ">=3.10"
# dependencies = ["pdf2image"]
# ///
"""Convert each page of a PDF to a PNG image."""

import os
import sys
from pdf2image import convert_from_path


def main():
    if len(sys.argv) != 3:
        print("Usage: convert_to_images.py <input.pdf> <output_directory>")
        sys.exit(1)

    pdf_path = sys.argv[1]
    output_dir = sys.argv[2]
    os.makedirs(output_dir, exist_ok=True)

    images = convert_from_path(pdf_path, dpi=200)

    max_dim = 1000
    for i, image in enumerate(images):
        w, h = image.size
        if w > max_dim or h > max_dim:
            scale = min(max_dim / w, max_dim / h)
            image = image.resize((int(w * scale), int(h * scale)))

        out_path = os.path.join(output_dir, f"page_{i + 1}.png")
        image.save(out_path)
        print(f"Saved page {i + 1} as {out_path} (size: {image.size})")

    print(f"Converted {len(images)} pages to PNG images")


if __name__ == "__main__":
    main()
