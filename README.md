# Project Planimeter

> Web app standalone per misurare superfici e distanze su mappa, con GIS leggero, overlay catastale ufficiale e **autodetect particella** pixel-perfect tramite proxy WMS locale.

<p align="center">
  <img alt="Python" src="https://img.shields.io/badge/python-3.8%2B-blue?logo=python&logoColor=white">
  <img alt="OpenLayers" src="https://img.shields.io/badge/OpenLayers-8.2.0-1f6feb?logo=openlayers">
  <img alt="No bundler" src="https://img.shields.io/badge/build-no%20bundler-success">
  <img alt="License" src="https://img.shields.io/badge/license-see%20LICENSE-lightgrey">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-informational">
</p>

---

## Indice

- [Highlights](#highlights)
- [Stack](#stack)
- [Quick start](#quick-start)
- [Funzionalità](#funzionalità)
- [Architettura](#architettura)
- [API backend](#api-backend)
- [Workflow M3 (Detect → Trace)](#workflow-m3-detect--trace)
- [Formati GIS](#formati-gis)
- [CLI server](#cli-server)
- [Test e verifica locale](#test-e-verifica-locale)
- [Compatibilità browser](#compatibilità-browser)
- [Limitazioni note](#limitazioni-note)
- [Attribuzioni](#attribuzioni)

## Highlights

- **Zero build**: ES modules + importmap, nessun bundler, nessun `node_modules`.
- **Backend auto-contained**: `python http.server` + SQLite per cache tile + Pillow/OpenCV/numpy per export e segmentazione.
- **Overlay catastale ufficiale** (Agenzia delle Entrate WMS) con cache TTL, rate-limiting e fallback.
- **M3 Autodetect**: rileva il bordo di una particella catastale dal raster con espansione progressiva e preview live per ogni step.
- **M3 Trace** (nuovo): rifinisce il bordo pixel-per-pixel sulla `ownership_mask` via `findContours` + RDP a tolleranza in metri (default 0.35 m, validato a ±1 % di delta area su particelle reali).
- **Export raster geo-referenziato**: TIFF, PNG+PGW, bundle ZIP con metadati.
- **UI bilingue** IT/EN, sistema metrico/imperiale, layer Pertinenze separato dalle aree utente.

## Stack

| Layer | Tech |
|---|---|
| Frontend | HTML + CSS + JavaScript ES modules (no bundler) |
| Mappa | [OpenLayers 8.2.0](https://openlayers.org) via importmap su `esm.sh` |
| Backend locale | Python 3.10+, `http.server`, `urllib`, `sqlite3` |
| Image stack | Pillow, OpenCV (`opencv-python`), numpy |
| Cache tile WMS | SQLite con TTL e quota dimensione |
| Persistenza utente | `localStorage` lato browser |

## Quick start

```bash
# 1. Dipendenze backend
python -m pip install -r requirements.txt

# 2. Avvia il server locale
python server.py

# 3. Apri l'app
# http://127.0.0.1:8000/planimeter.html
```

Launcher pronti all'uso:

- Windows: [start-planimeter.bat](start-planimeter.bat)
- Linux/macOS: [start_planimeter.sh](start_planimeter.sh)

## Funzionalità

- Disegno e modifica poligoni con marker vertici dedicati (vuoto/pieno).
- Rimozione vertice via tasto destro o `Canc`.
- Misura distanze (segmento singolo e polyline).
- Calcolo area e perimetro **geodetici**.
- Import/Export GeoJSON e KML.
- Export raster: TIFF, PNG + PGW, bundle ZIP (`image.tif` + `areas.geojson` + `meta.json`).
- Overlay catastale ufficiale con fallback su layer Esri di reference.
- Query particella via menu contestuale in modalità Navigate.
- Autodetect M3 con espansione progressiva del raggio, preview live e conferma step-by-step.
- Trace M3: contorno catastale pixel-perfect con un singolo parametro (`toleranceM`) esposto in Settings.
- Layer Pertinenze separato dalle aree utente, con colore configurabile e toggle indipendente.
- Risincronizzazione metadati catastali da menu contestuale.
- Lookup metadati proxy-first con fallback semantico (robusto su 502 upstream).
- Overlay busy flottante durante detect M3 e caricamento tile.

## Architettura

```
planimeter.html         entry point
styles.css              layout + UI
src/main.js             bootstrap
src/planimeter.js       orchestrazione mappa/UI (monolite app class)
src/core/               costanti e stato
src/map/                layer e interazioni OpenLayers
src/geometry/           calcoli geometrici e stile feature
src/io/                 import/export/persistenza preferenze
src/i18n/               localizzazione IT/EN
src/ui/                 context menu + monitor proxy
src/units/              sistema unità metrico/imperiale
server.py               proxy WMS, cache, export, M3 detect/trace, lookup particella
tests/                  smoke e regression test
```

## API backend

| Method | Endpoint | Scopo |
|---|---|---|
| GET  | `/wms-proxy`              | Proxy GetMap/GetFeatureInfo (con `OUTPUT=json` opzionale) |
| GET  | `/wms-tile`               | Tile WMS singola, cached via SQLite |
| GET  | `/proxy-health`           | Stato proxy, contatori, rate-limit budget |
| GET  | `/cache-stats`            | Statistiche cache tile |
| GET  | `/cache-config`           | Lettura config cache runtime |
| POST | `/cache-config`           | Aggiornamento TTL/quota cache |
| POST | `/cache-clear`            | Pulizia cache tile |
| POST | `/export-geotiff`         | Export TIFF georeferenziato |
| POST | `/export-pgw`             | Export PNG + sidecar PGW |
| POST | `/export-bundle`          | Export ZIP bundle (image + GeoJSON + meta) |
| POST | `/parcel-at-point`        | Lookup semantico particella catastale |
| POST | `/parcel-geometry-m3`     | M3 detect — raster segmentation con flood-fill |
| POST | `/parcel-geometry-m3-trace` | **M3 trace** — bordo pixel-perfect da `ownership_mask` + RDP |

> Nota: `/parcel-geometry-m3-refine` (variante storica con snapping edge-attraction e budget di richieste) resta esposta per compatibilità test/tooling, ma il frontend è migrato al `trace`.

## Workflow M3 (Detect → Trace)

1. **Detect** (`/parcel-geometry-m3`): mosaico WMS attorno al click → mask logo rosso → Canny → flood-fill → contorno coarse (ring lon/lat). Espansione progressiva del raggio in UI con preview live.
2. **Trace** (`/parcel-geometry-m3-trace`): partendo dalla `ownership_mask` del detect, applica `cv2.findContours(RETR_EXTERNAL, CHAIN_APPROX_NONE)` + `cv2.approxPolyDP` con `epsilon = toleranceM * pxPerM`. Output: ring chiuso pixel-per-pixel sul bordo nero catastale.

Parametro esposto in Settings: **`Trace M3: tolleranza (m)`**, range `0.05`–`2.5`, default `0.35` m. Valori bassi = più vertici e dettaglio.

Validazione (vedi [CHANGELOG.md](CHANGELOG.md)):

- particella 21 (≈30156 m²): ∆area **+1.13 %**
- particella 402 (≈555 m²): ∆area **−1.10 %**

## Formati GIS

**Import**: GeoJSON, KML.
**Export**: GeoJSON, KML, TIFF raster, ZIP PNG+PGW, ZIP bundle (`image.tif` + `areas.geojson` + `meta.json`).

Scelta progettuale: Shapefile/GeoPackage **non** supportati nativamente per mantenere il progetto leggero (zero parser pesanti).

## CLI server

```text
python server.py \
  --host 127.0.0.1 \
  --port 8000 \
  --instance-policy reuse|replace \
  --upstream-timeout 20 \
  --upstream-retries 1 \
  --tile-cache-ttl 30 \
  --tile-cache-max-mb 500 \
  --tile-cache-dir <path>
```

- Se la porta è occupata da un'altra istanza Planimeter e `--instance-policy reuse`, il server riusa l'istanza esistente.
- Se la porta è occupata da un servizio diverso, può fare fallback su una porta libera.

## Test e verifica locale

```bash
# Compile check
python -m py_compile server.py

# Unit test (unittest)
python -m unittest discover -s tests

# Test suite completa (pytest + E2E Playwright)
python -m pytest tests

# Solo E2E Playwright
python -m pytest tests/test_e2e_p0.py tests/test_e2e_p0_extended.py

# Smoke test M3 (detect + trace su coordinata nota)
python tests/test_smoke_parcel_402_methods.py \
  --method3-only --trace --trace-tolerance 0.35 \
  --lon 12.561465 --lat 43.012393 \
  --case-name trace-402 --radius 2
```

Nota E2E: al primo setup installare anche i browser Playwright:

```bash
python -m playwright install chromium
```

Check sintassi JavaScript senza build (PowerShell):

```powershell
Get-ChildItem src -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
```

## Compatibilità browser

| Feature | Chrome | Firefox | Safari |
|---|---:|---:|---:|
| ES modules | 61+ | 60+ | 10.1+ |
| Import Maps | 89+ | 108+ | 16.4+ |
| Geolocation API | moderno | moderno | moderno |
| localStorage | moderno | moderno | moderno |

> Internet Explorer e Legacy Edge (EdgeHTML) **non** sono supportati.

## Limitazioni note

- Overlay catastale ufficiale dipende dalla disponibilità upstream WMS.
- UX touch/mobile da migliorare per snapping e precisione vertici.
- Nessuna persistenza cloud o multiutente.
- TIFF esportato senza tag GeoTIFF embedded (PGW sidecar resta opzione georeferenziata).

## Attribuzioni

| Layer | Attribuzione |
|---|---|
| **Esri World Imagery** (`sat`) | Tiles © [Esri](https://www.esri.com/) — Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community |
| **Esri World Topo Map** (`esriTopo`) | Tiles © [Esri](https://www.esri.com/) — Esri, HERE, Garmin, Intermap, increment P Corp., GEBCO, USGS, FAO, NPS, NRCAN, GeoBase, IGN, Kadaster NL, Ordnance Survey, Esri Japan, METI, Esri China (Hong Kong), and the GIS User Community |
| **Esri World Shaded Relief** (`esriRelief`) | Tiles © [Esri](https://www.esri.com/) — Source: Esri |
| **OpenStreetMap** (`osm`) | © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL) |
| **OpenTopoMap** | Map data: © [OpenStreetMap](https://openstreetmap.org/copyright) contributors, [SRTM](https://viewfinderpanoramas.org) \| Style: © [OpenTopoMap](https://opentopomap.org) ([CC-BY-SA](https://creativecommons.org/licenses/by-sa/3.0/)) |
| **WMS Catasto** (`catastoOfficial`) | © [Agenzia delle Entrate](https://www.agenziaentrate.gov.it/) — [WMS endpoint](https://wms.cartografia.agenziaentrate.gov.it/inspire/wms/ows01.php) |
| **Esri Reference** (`catastoFallback`) | Tiles © [Esri](https://www.esri.com/) |

Librerie:

- **OpenLayers 8.2.0** — https://openlayers.org (BSD-2-Clause)

---

<sub>Knowledge base interna e materiali grezzi (`wiki/`, `raw/`) restano locali e non versionati.</sub>
