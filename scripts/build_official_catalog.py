"""Build official EU/SIAN plant species catalog and populate official varieties in SQLite.

Source: EU Common Catalogue of Varieties of Agricultural Plant Species
(data.europa.eu / DG SANTE, downloadable via circabc.europa.eu).

Outputs:
1. domains/official-species.json (species metadata with botanical genus, PAC group, cycle, Eco4 role)
2. official_varieties table in .planimeter_agriculture.db (or PLANIMETER_CULTIVAR_STORE_FILE)
"""

from __future__ import annotations

import io
import json
import os
import pathlib
import re
import sqlite3
import ssl
import sys
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOMAINS_DIR = ROOT / "domains"
OFFICIAL_SPECIES_PATH = DOMAINS_DIR / "official-species.json"
DEFAULT_DB_PATH = ROOT / ".planimeter_agriculture.db"
EUPVP_ZIP_URL = "https://circabc.europa.eu/sd/a/60ac6c8b-d1f1-4570-a361-b2dab6246f1c/plantcat_new.zip"


def deduce_pac_classification(genus: str, scientific_name: str, label_it: str, catalogue_type: str) -> dict[str, str]:
    g = (genus or "").strip().lower()
    s = (scientific_name or "").strip().lower()
    lbl = (label_it or "").strip().lower()

    # Straw cereals (Cereali a paglia - BCAA 7 e depauperanti Eco4)
    if g in {"triticum", "hordeum", "secale", "avena", "xtriticosecale", "oryza"}:
        return {
            "pacGroup": "cereal_straw",
            "cycleType": "annual",
            "eco4Role": "depauperating",
            "color": "#e8b400" if g == "triticum" else ("#d4c87a" if g == "hordeum" else "#d7b46a"),
            "stroke": "#a07a00" if g == "triticum" else "#8a7f30",
        }

    # Renewal cereals (Cereali da rinnovo - BCAA 7 e ammessi Eco4)
    if g in {"zea", "sorghum", "panicum", "setaria"}:
        return {
            "pacGroup": "cereal_renewal",
            "cycleType": "annual",
            "eco4Role": "renewal",
            "color": "#ff9800" if g == "zea" else "#e07b3a",
            "stroke": "#b26a00" if g == "zea" else "#a04010",
        }

    # Legumes (Proteaginose / azotofissatrici - miglioratrici Eco4)
    if g in {"vicia", "pisum", "glycine", "cicer", "lens", "lupinus", "phaseolus", "lathyrus"}:
        return {
            "pacGroup": "legume",
            "cycleType": "annual",
            "eco4Role": "improver",
            "color": "#7ac47a" if g in {"vicia", "glycine"} else "#81c784",
            "stroke": "#3a803a",
        }

    # Forage legumes & grasses (Foraggere avvicendate o permanenti)
    if g in {"medicago", "trifolium", "lotus", "onobrychis", "festuca", "lolium", "dactylis", "phleum", "poa", "bromus", "arrhenatherum", "agrostis", "alopecurus", "cynodon"}:
        is_multi = True
        return {
            "pacGroup": "forage",
            "cycleType": "multiannual" if is_multi else "annual",
            "eco4Role": "forage",
            "color": "#4caf50",
            "stroke": "#1b5e20",
        }

    # Oilseeds (Oleaginose - rinnovo/miglioratrici Eco4)
    if g in {"brassica", "helianthus", "linum", "carthamus", "sinapis"}:
        return {
            "pacGroup": "oilseed",
            "cycleType": "annual",
            "eco4Role": "renewal",
            "color": "#cddc39" if g == "brassica" else "#ffd040",
            "stroke": "#827717" if g == "brassica" else "#c09000",
        }

    # Roots & Vegetables (Barbabietola, Patata, Orticole)
    if g in {"beta", "solanum", "daucus", "allium", "cichorium", "brassica oleracea"}:
        return {
            "pacGroup": "vegetable",
            "cycleType": "annual",
            "eco4Role": "renewal",
            "color": "#26c6da",
            "stroke": "#00838f",
        }

    # Default fallback
    return {
        "pacGroup": "other",
        "cycleType": "annual",
        "eco4Role": "exempt",
        "color": "#78909c",
        "stroke": "#455a64",
    }


def fetch_or_read_eupvp_data() -> bytes:
    # Check if a cached copy exists in temp
    tmp_path = pathlib.Path(os.environ.get("TEMP", "/tmp")) / "eupvp_plantcat_cache.zip"
    if tmp_path.exists() and tmp_path.stat().st_size > 5_000_000:
        print(f"[catalog] using cached zip at {tmp_path}")
        return tmp_path.read_bytes()

    print(f"[catalog] downloading EU Common Catalogue from {EUPVP_ZIP_URL}...")
    ctx = ssl._create_unverified_context()
    req = urllib.request.Request(EUPVP_ZIP_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=45, context=ctx) as resp:
        raw = resp.read()

    try:
        tmp_path.write_bytes(raw)
    except Exception:
        pass
    return raw


def build_catalog(target_db_path: pathlib.Path | None = None) -> tuple[int, int]:
    db_path = target_db_path or pathlib.Path(os.environ.get("PLANIMETER_CULTIVAR_STORE_FILE", str(DEFAULT_DB_PATH)))
    raw_zip = fetch_or_read_eupvp_data()
    zf = zipfile.ZipFile(io.BytesIO(raw_zip))

    print("[catalog] parsing rdf_plantcat.jsonld (may take ~5-10s)...")
    with zf.open("rdf_plantcat.jsonld") as f:
        data = json.load(f)

    graph = data.get("@graph", [])

    species_dict: dict[str, dict[str, object]] = {}
    varieties_by_species: dict[str, set[str]] = {}

    for node in graph:
        t = str(node.get("@type", ""))
        if "Species" in t or "Subspecies" in t:
            nid = str(node.get("@id", ""))
            labels = node.get("label", [])
            it_l, en_l, la_l = "", "", ""
            if isinstance(labels, list):
                for l in labels:
                    if isinstance(l, dict):
                        lang = l.get("@language")
                        val = str(l.get("@value", "")).strip()
                        if lang == "it": it_l = val
                        elif lang == "en": en_l = val
                        elif lang == "la": la_l = val
            elif isinstance(labels, str):
                en_l = labels

            code = str(node.get("code", "")).strip()
            ctype = "A" if "/catalogueType/A" in str(node.get("catalogueType", "")) else "H"
            parts = la_l.split() if la_l else en_l.split()
            genus = parts[0].replace(",", "").replace(".", "").strip() if parts else ""

            # Standard clean Italian display label
            clean_it = it_l.split("/")[0].split("(")[0].strip() if it_l else ""
            if not clean_it:
                clean_it = en_l.split("/")[0].strip() or la_l
            if clean_it.lower() == "granturco":
                clean_it = "Mais"

            # ID slug
            slug = re.sub(r"[^a-z0-9_]+", "_", clean_it.lower()).strip("_")
            if not slug:
                slug = f"crop_{code}"

            pac_meta = deduce_pac_classification(genus, la_l, clean_it, ctype)

            species_dict[nid] = {
                "id": slug,
                "uri": nid,
                "code": code,
                "label": clean_it,
                "label_it": it_l or clean_it,
                "label_en": en_l,
                "scientificName": la_l,
                "botanicalGenus": genus,
                "catalogueType": ctype,
                **pac_meta,
            }

        elif "Varietas" in t:
            if node.get("http://data.europa.eu/dph/def/plantcat#deleted") is True:
                continue
            parent = str(node.get("hasHigherRank", "")).strip()
            var_name = str(node.get("label") or node.get("prefLabel") or "").strip()
            if parent and var_name:
                if parent not in varieties_by_species:
                    varieties_by_species[parent] = set()
                varieties_by_species[parent].add(var_name)

    # Sort species list: Agricultural first, then by Italian label
    species_list = sorted(
        species_dict.values(),
        key=lambda s: (0 if s["catalogueType"] == "A" else 1, s["label"].lower())
    )

    # Write domains/official-species.json
    DOMAINS_DIR.mkdir(parents=True, exist_ok=True)
    clean_species_output = []
    seen_ids = set()
    for s in species_list:
        sid = s["id"]
        if sid in seen_ids:
            sid = f"{sid}_{s['code']}"
        seen_ids.add(sid)
        clean_species_output.append({
            "id": sid,
            "label": s["label"],
            "label_it": s["label_it"],
            "label_en": s["label_en"],
            "scientificName": s["scientificName"],
            "botanicalGenus": s["botanicalGenus"],
            "pacGroup": s["pacGroup"],
            "cycleType": s["cycleType"],
            "eco4Role": s["eco4Role"],
            "color": s["color"],
            "stroke": s["stroke"],
            "catalogueType": s["catalogueType"],
            "code": s["code"],
            "varietyCount": len(varieties_by_species.get(str(s["uri"]), set())),
        })

    OFFICIAL_SPECIES_PATH.write_text(
        json.dumps(clean_species_output, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"[catalog] wrote {len(clean_species_output)} official species to {OFFICIAL_SPECIES_PATH}")

    # Populate SQLite table official_varieties in db_path
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    with conn:
        conn.execute("DROP TABLE IF EXISTS official_varieties")
        conn.execute("""
            CREATE TABLE official_varieties (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                genus TEXT NOT NULL,
                species_code TEXT NOT NULL,
                species_name TEXT NOT NULL,
                variety TEXT NOT NULL
            )
        """)
        conn.execute("CREATE INDEX idx_official_varieties_genus ON official_varieties(genus COLLATE NOCASE, variety COLLATE NOCASE)")
        conn.execute("CREATE INDEX idx_official_varieties_name ON official_varieties(species_name COLLATE NOCASE, variety COLLATE NOCASE)")

        insert_rows = []
        total_var_count = 0
        for nid, var_set in varieties_by_species.items():
            sp = species_dict.get(nid)
            if not sp:
                continue
            genus = str(sp.get("botanicalGenus") or "").strip()
            code = str(sp.get("code") or "").strip()
            sp_name = str(sp.get("label") or "").strip()
            for v in var_set:
                insert_rows.append((genus, code, sp_name, v))
                total_var_count += 1
                if len(insert_rows) >= 5000:
                    conn.executemany(
                        "INSERT INTO official_varieties (genus, species_code, species_name, variety) VALUES (?, ?, ?, ?)",
                        insert_rows,
                    )
                    insert_rows = []

        if insert_rows:
            conn.executemany(
                "INSERT INTO official_varieties (genus, species_code, species_name, variety) VALUES (?, ?, ?, ?)",
                insert_rows,
            )

    conn.close()
    print(f"[catalog] inserted {total_var_count} active varieties into {db_path} (table official_varieties)")
    return len(clean_species_output), total_var_count


if __name__ == "__main__":
    species_cnt, var_cnt = build_catalog()
    print(f"[catalog] completed successfully: {species_cnt} species, {var_cnt} varieties.")
