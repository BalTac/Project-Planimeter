# Project Planimeter

Web app standalone per misurare superfici e distanze su mappa, con supporto GIS leggero e overlay catastale WMS tramite proxy locale.

## Stato progetto

- Frontend: HTML, CSS, JavaScript ES modules (nessun bundler)
- Mappa: OpenLayers 8.2.0 via importmap su esm.sh
- Backend locale: Python con http.server + urllib + sqlite3
- Cache tile WMS: SQLite con TTL e limite dimensione configurabili
- Persistenza utente: localStorage nel browser

## Cosa fa

- Disegno e modifica poligoni
- Misura distanze (linea retta e polyline)
- Calcolo area e perimetro geodetici
- Export/Import GeoJSON e KML
- Export raster: TIFF, PNG+PGW, bundle ZIP
- Overlay catastale ufficiale Agenzia Entrate (con fallback)
- Query particella via menu contestuale in modalita Navigate
- UI bilingue IT/EN e sistema unita metrico/imperiale

## Architettura

- [planimeter.html](planimeter.html): entry point
- [styles.css](styles.css): layout e stile UI
- [src/main.js](src/main.js): bootstrap app
- [src/planimeter.js](src/planimeter.js): orchestrazione logica mappa/UI
- [src/core](src/core): costanti e stato
- [src/map](src/map): layer e interazioni OpenLayers
- [src/geometry](src/geometry): calcoli e stile feature
- [src/io](src/io): import/export/persistenza preferenze
- [src/i18n](src/i18n): localizzazione IT/EN
- [src/ui](src/ui): context menu e monitor proxy
- [server.py](server.py): proxy WMS, cache tile, endpoint export
- [app.js](app.js): file legacy non usato come entrypoint corrente

## Requisiti

- Python 3.8+
- Browser moderno con supporto importmap
- Dipendenza Python: Pillow (PIL)

Installazione dipendenza backend:

```bash
python -m pip install Pillow
```

## Compatibilita browser

| Feature | Chrome | Firefox | Safari |
|---|---:|---:|---:|
| ES modules | 61+ | 60+ | 10.1+ |
| Import Maps | 89+ | 108+ | 16.4+ |
| Geolocation API | moderno | moderno | moderno |
| localStorage | moderno | moderno | moderno |

Nota:

- Internet Explorer e Legacy Edge (EdgeHTML) non sono supportati.

## Avvio rapido

1. Avvia il server locale:

```bash
python server.py
```

2. Apri l'app:

- http://127.0.0.1:8000/planimeter.html

Launcher rapidi:

- Windows: [start-planimeter.bat](start-planimeter.bat)
- Linux/macOS: [start_planimeter.sh](start_planimeter.sh)

## Endpoint principali backend

- GET /wms-proxy
- GET /wms-tile
- GET /proxy-health
- GET /cache-stats
- GET /cache-config
- POST /cache-config
- POST /cache-clear
- POST /export-geotiff
- POST /export-pgw
- POST /export-bundle

## Opzioni CLI server

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

Note:

- Se la porta e occupata da un'altra istanza Planimeter e instance-policy=reuse, il server riusa l'istanza esistente.
- Se la porta e occupata da un servizio diverso, il server puo fare fallback su una porta libera.

## Formati GIS supportati

Import:

- GeoJSON
- KML

Export:

- GeoJSON
- KML
- TIFF raster
- ZIP PNG + PGW
- ZIP bundle (image.tif, areas.geojson, meta.json)

Scelta progettuale:

- Shapefile/GeoPackage non sono supportati nativamente per mantenere il progetto leggero e senza parser pesanti.

## Test e verifica locale

Controlli consigliati:

```bash
python -m py_compile server.py
python -m unittest discover -s tests
```

Check sintassi JavaScript senza build:

```powershell
Get-ChildItem src -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
```

## Limitazioni note

- Overlay catastale ufficiale dipendente dalla disponibilita upstream WMS
- UX touch/mobile ancora migliorabile per snapping e precisione vertici
- Nessuna persistenza cloud o multiutente
- TIFF esportato senza tag GeoTIFF embedded

## Immagini e documentazione visuale

Sezione pronta per screenshot e immagini operative.

Al momento non sono incluse immagini. Template consigliato per quando saranno disponibili:

1. Panoramica UI principale
- File suggerito: screenshot-ui-overview.png
- Caption: Vista completa della toolbar e dei layer principali.

2. Workflow disegno e modifica
- File suggerito: screenshot-draw-edit.png
- Caption: Disegno poligono, modifica vertici, misura area/perimetro.

3. Export vettoriale
- File suggerito: screenshot-export-geojson-kml.png
- Caption: Export e import GeoJSON/KML dal pannello operativo.

4. Export raster e bundle
- File suggerito: screenshot-export-raster-bundle.png
- Caption: Export TIFF, PNG+PGW e bundle ZIP con metadata.

5. Query particella
- File suggerito: screenshot-parcel-query.png
- Caption: Query da menu contestuale in Navigate e popup risultato.

## Wiki locale

La knowledge base in [wiki/](wiki/) e le sorgenti in [raw/](raw/) restano locali in questa fase.
Saranno valutate per tracking Git quando il progetto sara piu maturo.

## Attribuzioni

- OpenLayers: https://openlayers.org
- OpenStreetMap: https://www.openstreetmap.org
- Esri World Imagery: https://www.esri.com/en-us/legal/terms/full-master-agreement
- WMS Agenzia Entrate: https://wms.cartografia.agenziaentrate.gov.it/inspire/wms/ows01.php
