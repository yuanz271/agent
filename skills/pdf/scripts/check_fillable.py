# /// script
# requires-python = ">=3.10"
# dependencies = ["pypdf"]
# ///
"""Check whether a PDF has fillable form fields."""

import sys
from pypdf import PdfReader


def main():
    if len(sys.argv) != 2:
        print("Usage: check_fillable.py <input.pdf>")
        sys.exit(1)

    reader = PdfReader(sys.argv[1])
    fields = reader.get_fields()
    if fields:
        print(f"This PDF has fillable form fields ({len(fields)} fields found)")
    else:
        print("This PDF does not have fillable form fields; you will need to visually determine where to enter data")


if __name__ == "__main__":
    main()
