# /// script
# requires-python = ">=3.10"
# dependencies = ["pypdf"]
# ///
"""Extract fillable form field info from a PDF to JSON."""

import json
import sys
from pypdf import PdfReader


def _full_field_id(annotation):
    """Walk the /Parent chain to build a dotted field ID."""
    parts = []
    node = annotation
    while node:
        name = node.get("/T")
        if name:
            parts.append(str(name))
        node = node.get("/Parent")
    return ".".join(reversed(parts)) if parts else None


def _field_dict(field, field_id):
    """Build a dict describing one form field."""
    info = {"field_id": field_id}
    ft = field.get("/FT")

    if ft == "/Tx":
        info["type"] = "text"
    elif ft == "/Btn":
        info["type"] = "checkbox"
        states = field.get("/_States_", [])
        if len(states) == 2:
            if "/Off" in states:
                info["checked_value"] = next(s for s in states if s != "/Off")
                info["unchecked_value"] = "/Off"
            else:
                info["checked_value"] = states[0]
                info["unchecked_value"] = states[1]
    elif ft == "/Ch":
        info["type"] = "choice"
        states = field.get("/_States_", [])
        info["choice_options"] = [{"value": s[0], "text": s[1]} for s in states]
    else:
        info["type"] = f"unknown ({ft})"
    return info


def extract_field_info(reader: PdfReader):
    fields = reader.get_fields()
    if not fields:
        return []

    by_id = {}
    possible_radios = set()

    for fid, field in fields.items():
        if field.get("/Kids"):
            if field.get("/FT") == "/Btn":
                possible_radios.add(fid)
            continue
        by_id[fid] = _field_dict(field, fid)

    radios = {}

    for page_idx, page in enumerate(reader.pages):
        for ann in page.get("/Annots", []):
            fid = _full_field_id(ann)
            if fid in by_id:
                by_id[fid]["page"] = page_idx + 1
                by_id[fid]["rect"] = [float(v) for v in ann.get("/Rect", [])]
            elif fid in possible_radios:
                try:
                    on_vals = [v for v in ann["/AP"]["/N"] if v != "/Off"]
                except (KeyError, TypeError):
                    continue
                if len(on_vals) == 1:
                    rect = [float(v) for v in ann.get("/Rect", [])]
                    if fid not in radios:
                        radios[fid] = {
                            "field_id": fid,
                            "type": "radio_group",
                            "page": page_idx + 1,
                            "radio_options": [],
                        }
                    radios[fid]["radio_options"].append({"value": on_vals[0], "rect": rect})

    result = []
    for info in by_id.values():
        if "page" in info:
            result.append(info)
        else:
            print(f"Warning: could not locate field '{info['field_id']}', skipping")
    result.extend(radios.values())

    def sort_key(f):
        r = f.get("rect") or (f.get("radio_options", [{}])[0].get("rect") or [0, 0, 0, 0])
        return (f.get("page", 0), -r[1], r[0])

    result.sort(key=sort_key)
    return result


def main():
    if len(sys.argv) != 3:
        print("Usage: extract_fields.py <input.pdf> <output.json>")
        sys.exit(1)

    reader = PdfReader(sys.argv[1])
    info = extract_field_info(reader)

    with open(sys.argv[2], "w") as f:
        json.dump(info, f, indent=2)
    print(f"Wrote {len(info)} fields to {sys.argv[2]}")


if __name__ == "__main__":
    main()
