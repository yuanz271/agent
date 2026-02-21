# /// script
# requires-python = ">=3.10"
# dependencies = ["pypdf"]
# ///
"""Fill fillable PDF form fields from a JSON values file."""

import json
import sys
from pypdf import PdfReader, PdfWriter


def _full_field_id(annotation):
    parts = []
    node = annotation
    while node:
        name = node.get("/T")
        if name:
            parts.append(str(name))
        node = node.get("/Parent")
    return ".".join(reversed(parts)) if parts else None


def _get_field_info(reader):
    """Minimal field info extraction for validation."""
    fields = reader.get_fields() or {}
    by_id = {}
    possible_radios = set()

    for fid, field in fields.items():
        if field.get("/Kids"):
            if field.get("/FT") == "/Btn":
                possible_radios.add(fid)
            continue
        info = {"field_id": fid, "type": "text"}
        ft = field.get("/FT")
        if ft == "/Btn":
            info["type"] = "checkbox"
            states = field.get("/_States_", [])
            if len(states) == 2:
                info["checked_value"] = next((s for s in states if s != "/Off"), states[0])
                info["unchecked_value"] = "/Off" if "/Off" in states else states[1]
        elif ft == "/Ch":
            info["type"] = "choice"
            info["choice_options"] = [{"value": s[0], "text": s[1]} for s in field.get("/_States_", [])]
        by_id[fid] = info

    radios = {}
    for page_idx, page in enumerate(reader.pages):
        for ann in page.get("/Annots", []):
            fid = _full_field_id(ann)
            if fid in by_id:
                by_id[fid]["page"] = page_idx + 1
            elif fid in possible_radios:
                try:
                    on_vals = [v for v in ann["/AP"]["/N"] if v != "/Off"]
                except (KeyError, TypeError):
                    continue
                if len(on_vals) == 1:
                    if fid not in radios:
                        radios[fid] = {"field_id": fid, "type": "radio_group", "page": page_idx + 1, "radio_options": []}
                    radios[fid]["radio_options"].append({"value": on_vals[0]})

    for fid in by_id:
        if "page" not in by_id[fid]:
            by_id[fid]["page"] = None
    by_id.update(radios)
    return by_id


def _validate_value(info, value):
    t = info["type"]
    fid = info["field_id"]
    if t == "checkbox":
        cv = info.get("checked_value")
        uv = info.get("unchecked_value")
        if value != cv and value != uv:
            return f'ERROR: invalid value "{value}" for checkbox "{fid}". Use "{cv}" (checked) or "{uv}" (unchecked)'
    elif t == "radio_group":
        opts = [o["value"] for o in info.get("radio_options", [])]
        if value not in opts:
            return f'ERROR: invalid value "{value}" for radio "{fid}". Valid: {opts}'
    elif t == "choice":
        opts = [o["value"] for o in info.get("choice_options", [])]
        if value not in opts:
            return f'ERROR: invalid value "{value}" for choice "{fid}". Valid: {opts}'
    return None


def main():
    if len(sys.argv) != 4:
        print("Usage: fill_fields.py <input.pdf> <field_values.json> <output.pdf>")
        sys.exit(1)

    input_pdf, values_path, output_pdf = sys.argv[1], sys.argv[2], sys.argv[3]

    with open(values_path) as f:
        values = json.load(f)

    reader = PdfReader(input_pdf)
    field_info = _get_field_info(reader)

    # Validate
    has_error = False
    for entry in values:
        fid = entry["field_id"]
        info = field_info.get(fid)
        if not info:
            print(f"ERROR: '{fid}' is not a valid field ID")
            has_error = True
            continue
        if info.get("page") and entry.get("page") and entry["page"] != info["page"]:
            print(f"ERROR: wrong page for '{fid}' (got {entry['page']}, expected {info['page']})")
            has_error = True
        if "value" in entry:
            err = _validate_value(info, entry["value"])
            if err:
                print(err)
                has_error = True

    if has_error:
        sys.exit(1)

    # Group by page and fill
    by_page: dict[int, dict] = {}
    for entry in values:
        if "value" not in entry:
            continue
        pg = entry.get("page", 1)
        by_page.setdefault(pg, {})[entry["field_id"]] = entry["value"]

    writer = PdfWriter(clone_from=reader)
    for pg, vals in by_page.items():
        writer.update_page_form_field_values(writer.pages[pg - 1], vals, auto_regenerate=False)
    writer.set_need_appearances_writer(True)

    with open(output_pdf, "wb") as f:
        writer.write(f)

    total = sum(len(v) for v in by_page.values())
    print(f"Filled {total} fields and saved to {output_pdf}")


if __name__ == "__main__":
    main()
