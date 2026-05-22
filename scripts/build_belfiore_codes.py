"""Build a slim Belfiore code → comune mapping for the planimeter UI.

Source: matteocontrini/comuni-json (MIT-licensed, derived from official
ISTAT/AdE data and updated periodically).

Output: domains/belfiore-codes.json with shape `{ "<code>": "<Name> (PR)" }`.
Run from repo root:  python scripts/build_belfiore_codes.py
"""

from __future__ import annotations

import json
import pathlib
import sys
import urllib.request

SOURCE_URL = "https://raw.githubusercontent.com/matteocontrini/comuni-json/master/comuni.json"
OUTPUT_PATH = pathlib.Path(__file__).resolve().parent.parent / "domains" / "belfiore-codes.json"


def main() -> int:
    print(f"[belfiore] downloading {SOURCE_URL}")
    with urllib.request.urlopen(SOURCE_URL, timeout=30) as response:
        raw = response.read().decode("utf-8")
    comuni = json.loads(raw)
    print(f"[belfiore] parsed {len(comuni)} comuni")

    mapping: dict[str, str] = {}
    skipped = 0
    for entry in comuni:
        code = str(entry.get("codiceCatastale") or "").strip().upper()
        name = str(entry.get("nome") or "").strip()
        sigla = str((entry.get("sigla") or "")).strip().upper()
        if not code or not name:
            skipped += 1
            continue
        mapping[code] = f"{name} ({sigla})" if sigla else name

    # Stable, sorted output for deterministic diffs.
    ordered = {k: mapping[k] for k in sorted(mapping)}
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(
        json.dumps(ordered, ensure_ascii=False, indent=0, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    size_kb = OUTPUT_PATH.stat().st_size / 1024
    print(f"[belfiore] wrote {OUTPUT_PATH.relative_to(OUTPUT_PATH.parent.parent)} "
          f"({len(ordered)} codes, {size_kb:.1f} KB, skipped {skipped})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
