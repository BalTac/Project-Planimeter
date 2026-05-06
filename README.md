# Project Planimeter by BalTac
# Project Planimeter

> A lightweight, browser-based web planimeter for geodetic area measurement, polygon editing, and GIS interoperability — no backend persistence, no build step, no framework.

---

## Abstract

**Project Planimeter** lets you draw and measure polygons directly on top of satellite imagery, OpenStreetMap, and an Italian cadastral WMS overlay. Features include real-time geodesic area and perimeter computation (EPSG:3857 / WGS 84 sphere), multi-vertex polyline distance measurement, GeoJSON and KML export/import, localStorage persistence, and snap-to-vertex editing. The interface is fully internationalised (IT / EN) with runtime locale switching and a metric/imperial unit system selector.

The application runs entirely in the browser; the only server-side component is a small Python reverse proxy (`server.py`) required to bypass CORS restrictions on the Agenzia delle Entrate WMS endpoint.

---

## Architecture

```
planimeter.html          ← entry point; importmap + <script type="module">
src/
	main.js               ← DOMContentLoaded bootstrap
	planimeter.js         ← orchestrator class (map, interactions, UI binding)
	core/
		constants.js        ← shared compile-time constants
		state.js            ← createInitialState() factory
	i18n/
		i18n.js             ← t(), setLocale(), detectLocale()
		it.js               ← Italian string catalogue (~130 keys)
		en.js               ← English string catalogue
	units/
		units.js            ← UnitSystem class (metric / imperial)
	geometry/
		calculations.js     ← geodesic area, perimeter, length (ol/sphere)
		style.js            ← OL style function (labels + fill + stroke)
		decorate.js         ← feature ID / name assignment
	map/
		layers.js           ← TileLayer / ImageWMS / VectorLayer factories
		interactions.js     ← Select / Modify / Draw / Snap factories
	io/
		persistence.js      ← localStorage save / restore
		export.js           ← GeoJSON & KML export helpers
		import.js           ← GeoJSON & KML import + format detection
	ui/
		proxy-health.js     ← ProxyHealthMonitor class
		context-menu.js     ← right-click context menu
styles.css
server.py               ← Python WMS reverse proxy (Flask / http.server)
```

OpenLayers 8.2.0 is loaded via **importmap** from esm.sh — no bundler, no `node_modules`.

---

## Feature Set

| Feature | Notes |
|---|---|
| Polygon draw | Click to add vertices, double-click to close |
| Straight-line measurement | Two-point distance tool |
| Polyline measurement | Multi-vertex path; double-click to close |
| Vertex editing | Drag-to-reshape in Edit mode |
| Delete | Per-feature or clear-all |
| Snap | Snap-to-vertex / snap-to-edge; Ctrl to disable temporarily |
| Area + perimeter | Geodesic (ol/sphere), live labels on map |
| GeoJSON export/import | RFC 7946, EPSG:4326, 6 decimal places |
| KML export/import | Polygon and MultiPolygon features |
| localStorage persistence | Auto-save with 250 ms debounce |
| Cadastral overlay | Agenzia delle Entrate WMS (official) or administrative boundaries (substitute) |
| Cadastral parcel info | Optional `GetFeatureInfo` lookup with parcel metadata on map click |
| Geolocation | browser `navigator.geolocation` with high-accuracy flag |
| i18n | Italian / English runtime switching |
| Unit system | Metric (m, km, ha) / Imperial (ft, mi, ac) |
| Settings tab | Persistent UI preferences for layers, locale, units and overlay opacity |
| Right-click context menu | Cancel active drawing |

---

## GIS Interoperability

### Supported import/export formats

| Format | Extension | CRS on export | Notes |
|---|---|---|---|
| GeoJSON | `.geojson` | EPSG:4326 (WGS 84) | Recommended for web/GIS interop |
| KML | `.kml` | WGS 84 geographic | Compatible with Google Earth, QGIS |

Shapefile import is intentionally **not** supported — the binary format requires a dedicated parser library that would add significant weight for a use case already covered by GeoJSON/KML round-trips through QGIS or ogr2ogr.

### Geometry types

Only `Polygon` and `MultiPolygon` features are imported as areas; `LineString` and `MultiLineString` features are imported as distance measurements. Other geometry types are silently filtered.

### Projection

Map tiles and vector features are stored in **EPSG:3857** (Web Mercator) at runtime. All geodesic computations use the `ol/sphere` module with the view's native projection. Export always reprojects to **EPSG:4326**.

---

## Stack

| Component | Version / Source |
|---|---|
| OpenLayers | 8.2.0 (esm.sh, ES modules via importmap) |
| HTML5 / CSS3 | Vanilla, no framework |
| JavaScript | ES2022, native ES modules, no transpiler |
| Python proxy | Python 3.8+, stdlib `http.server` + `urllib` |
| Tile sources | ESRI World Imagery, OpenStreetMap, Agenzia delle Entrate WMS |

---

## Quick Start

### 1 — Start the Python proxy

```bash
python server.py
# Default: http://localhost:8765
```

The proxy exposes:
- `GET /wms-proxy?...` — transparent WMS relay to Agenzia delle Entrate
- `GET /proxy-health` — JSON health check (`{"ok": true, "durationMs": N}`)
- All other requests — static file server rooted at the project directory

### 2 — Open the application

Navigate to [http://localhost:8765/planimeter.html](http://localhost:8765/planimeter.html).

> **Note**: Opening `planimeter.html` directly as a `file://` URL will work for basic drawing and measurement, but the official cadastral WMS overlay requires the proxy to be running.

---

## server.py CLI Options

```
python server.py [--port PORT] [--host HOST] [--instance-policy reuse|replace]

Options:
	--port  PORT   Listening port (default: 8765)
	--host  HOST   Bind address (default: 127.0.0.1)
	--instance-policy  Startup behavior when requested port already has Planimeter:
	                   reuse (default) uses existing instance;
	                   replace terminates existing instance and starts a new one.
```

Startup port policy summary:
- If requested port is free: server starts normally.
- If requested port is occupied by another Planimeter instance:
  - `reuse`: exits successfully and keeps the existing instance.
  - `replace`: terminates existing instance (best effort) and starts a new one.
- If requested port is occupied by a non-Planimeter service: server auto-falls back to a random free port and prints the final URL.

---

## Browser Requirements

| Feature | Minimum version |
|---|---|
| ES modules + `import` | Chrome 61, Firefox 60, Safari 10.1 |
| `<script type="importmap">` | Chrome 89, Firefox 108, Safari 16.4 |
| `navigator.geolocation` | All modern browsers |
| `localStorage` | All modern browsers |

Internet Explorer and legacy Edge (EdgeHTML) are not supported.

---

## Known Limitations

- **Mobile / touch**: Snap interaction and small polygon vertices are difficult to hit accurately on touch screens.
- **WMS latency**: The Agenzia delle Entrate WMS can be slow or unavailable during peak hours. Use the substitute source if tiles do not load.
- **Cadastral rendering**: The official WMS renders cadastral parcels only at zoom ≥ 14.
- **No cloud persistence**: Features are stored in browser `localStorage` only. Clearing browser data removes all drawings.
- **Single-user**: No collaboration or multi-tab sync.

---

## Attribution

- **OpenLayers** — [openlayers.org](https://openlayers.org) — BSD 2-Clause
- **ESRI World Imagery** — [Esri](https://www.esri.com) — [terms](https://www.esri.com/en-us/legal/terms/full-master-agreement)
- **OpenStreetMap** — [openstreetmap.org](https://www.openstreetmap.org) — ODbL
- **Agenzia delle Entrate WMS** — [geoportale.cartografia.agenziaentrate.gov.it](https://geoportale.cartografia.agenziaentrate.gov.it) — public service
- **Project Planimeter** — [BalTac](https://github.com/BalTac) — MIT
Applicazione web standalone per misurare superfici direttamente su mappa, usando OpenLayers e una struttura front-end separata in HTML, CSS e JavaScript.

## Overview

Il progetto implementa un planimetro browser-based con interfaccia minimale e tre sorgenti cartografiche combinabili:

- immagine satellitare ESRI come base principale;
- layer OpenStreetMap per strade e toponimi;
- overlay catastale WMS dell'Agenzia delle Entrate.

L'utente puo disegnare uno o piu poligoni sulla mappa e visualizzare l'area calcolata automaticamente in ettari.

## Struttura del progetto

Il repository contiene questi file principali:

- [planimeter.html](planimeter.html): shell HTML con struttura semantica, metadati SEO e collegamento agli asset.
- [styles.css](styles.css): layout, overlay toolbar, responsive behavior e tema visuale.
- [app.js](app.js): inizializzazione mappa, interazioni OpenLayers, export/import e strumenti di editing.
- [server.py](server.py): server locale con proxy WMS per evitare il blocco CORS del layer ufficiale Agenzia Entrate.
- [HANDOFF.md](HANDOFF.md): checklist operativa rapida per ripartenza su nuova postazione.
- [start-planimeter.bat](start-planimeter.bat): avvio one-click su Windows (server + apertura browser).

Il progetto e ispirato a tool esistenti per la misurazione di aree su mappa, sviluppato in modo indipendente.

La logica e incapsulata nella classe `Planimeter`, che gestisce:

- inizializzazione dei layer cartografici;
- creazione della mappa OpenLayers;
- interazione di disegno dei poligoni;
- selezione, modifica ed eliminazione delle feature;
- export e import dei dati in formato GeoJSON e KML;
- styling delle feature e label area;
- binding dei controlli UI;
- geolocalizzazione del browser.

## Funzionalita principali

- Attivazione/disattivazione dei layer mappa tramite checkbox.
- Disegno di poligoni multipli senza limite applicativo esplicito.
- Calcolo area tramite `ol.sphere.getArea(...)`.
- Visualizzazione del risultato con area e perimetro in label interna al poligono.
- Toolbar flottante in overlay con comandi di lavoro e riepilogo live.
- Indicatore health check `Proxy WMS: OK/KO` con ultimo errore leggibile in toolbar.
- Persistenza locale automatica delle geometrie in `localStorage` con ripristino all'apertura successiva.
- Modalita dedicate per disegno, modifica, eliminazione e misura distanza.
- Misuratore distanza in linea retta (2 punti) e polyline (tracciato multi-vertice).
- Riepilogo live con totale area e totale perimetro poligoni.
- Snapping magnetico su vertici e bordi in modalita Disegna e Modifica.
- Override rapido dello snapping tenendo premuto `Ctrl`.
- Ritardo di sicurezza di 1 secondo dopo la chiusura del poligono con doppio clic.
- Export delle geometrie in GeoJSON e KML.
- Import di feature `Polygon` e `MultiPolygon` da file GeoJSON e KML.
- Comando `Duplica area` sulla feature poligonale selezionata.
- Pulsante di geolocalizzazione con animazione della vista.
- Reset completo delle aree disegnate.

## Stack tecnico

- HTML5
- CSS3 embedded
- JavaScript vanilla
- [OpenLayers 8.2.0](https://openlayers.org/) caricato via CDN `jsDelivr`

## Formati GIS supportati

- `GeoJSON`: formato principale consigliato per export/import. Aperto, leggero, molto compatibile con QGIS, ArcGIS Pro e workflow web.
- `KML`: formato secondario supportato in export/import per interoperabilita rapida con Google Earth e GIS desktop.

Scelta progettuale:

- Non sono stati aggiunti `Shapefile`, `GeoPackage` o raster: aumentano complessita, dipendenze o gestione multi-file, poco coerenti con una web app standalone leggera.
- Per conversioni verso formati piu pesanti, il flusso consigliato resta export GeoJSON/KML e conversione successiva in QGIS o GDAL.

Sorgenti esterne usate dalla mappa:

- ESRI World Imagery
- OpenStreetMap
- WMS Agenzia delle Entrate

## Flusso di utilizzo

1. Avviare il server locale dalla cartella progetto con `python server.py`.
2. Aprire in browser `http://127.0.0.1:8000/planimeter.html`.

Per personalizzare resilienza proxy:

- `python server.py --upstream-timeout 12 --upstream-retries 1`

Alternativa Windows one-click:

- Eseguire [start-planimeter.bat](start-planimeter.bat).
3. Attivare i layer desiderati dal pannello laterale.
4. Usare la modalita `Disegna` per aggiungere i vertici di un poligono.
5. Fare doppio clic per chiudere il poligono.
6. Usare `Retta` per misurare la distanza tra due punti.
7. Usare `Polyline` per misurare la distanza lungo un percorso a piu vertici.
8. Usare `Modifica` per selezionare una feature e spostarne i vertici.
9. Usare `Duplica area` per creare una copia offset dell'area selezionata.
10. Usare `Elimina` o `Elimina selezione` per rimuovere una singola area o misura.
11. Usare `Esporta` e `Importa` per scambiare GeoJSON o KML.
12. Per il layer catasto scegliere manualmente la sorgente tra `Ufficiale Agenzia Entrate` e `Sostitutivo`.
13. Tenere premuto `Ctrl` mentre si disegna/modifica/misura per disattivare temporaneamente l'effetto magnete.

## Runbook essenziale

### Start

1. Avviare il backend locale:

```powershell
python server.py
```

2. Aprire la web app:

```text
http://127.0.0.1:8000/planimeter.html
```

Alternativa rapida su Windows:

```powershell
./start-planimeter.bat
```

### Stop

1. Tornare al terminale dove e in esecuzione `server.py`.
2. Interrompere con `Ctrl+C`.

### Troubleshooting rapido

1. Se il layer catastale ufficiale non compare, verificare l'indicatore `Proxy WMS` in toolbar.
2. Se `Proxy WMS` e `KO`, riavviare `server.py` e ritentare.
3. Se il servizio upstream non risponde, usare temporaneamente il layer `Sostitutivo`.
4. Se la porta e occupata, avviare su porta diversa:

```powershell
python server.py --port 8010
```

e aprire la stessa pagina sulla nuova porta.
5. Se compare `Health check HTTP 404`, la pagina e probabilmente servita da un server statico diverso da [server.py](server.py): aprire l'app da `http://127.0.0.1:8000/planimeter.html` avviando il server locale del progetto.

## Note architetturali

- Il progetto non richiede build, transpiler o dipendenze locali.
- La UI adotta una floating toolbar overlay per mantenere la mappa sempre visibile.
- HTML, stile e logica sono separati per migliorare manutenibilita e riuso.
- La pagina include metadati head utili per SEO e condivisione social.
- Il layer catastale ufficiale usa il WMS 1.3.0 dell'Agenzia delle Entrate.
- Il layer catastale ufficiale passa tramite proxy locale `/wms-proxy` implementato in `server.py`.
- La UI interroga anche `/proxy-health` per verificare raggiungibilita del proxy/WMS e mostrare ultimo errore leggibile.
- Il proxy supporta `--upstream-timeout` e `--upstream-retries` per adattare timeout e retry brevi verso il WMS upstream.
- Il layer sostitutivo e una sorgente visuale di confini amministrativi, non catastale.
- Il layer catasto e limitato a `minZoom: 14` per evitare richieste troppo pesanti a zoom bassi.

## Limiti attuali

- Nessuna gestione avanzata degli errori di rete per i layer remoti.
- Nessuna persistenza backend o sincronizzazione multi-device.
- La resa del WMS ufficiale puo variare in base a zona, scala e compatibilita CRS del servizio.
- La geolocalizzazione dipende dai permessi del browser e dal contesto di esecuzione.
- Non sono supportati in-app `Shapefile`, `GeoPackage`, `KMZ` o raster: richiederebbero parsing multi-file o dipendenze piu pesanti.

## Known Issues

- Il WMS catastale ufficiale puo avere latenza elevata o indisponibilita temporanee indipendenti dall'app.
- In aree con georeferenziazione complessa, il rendering catastale puo risultare parziale a certi livelli di zoom.
- Su mobile, il toggle rapido dello snapping non e ancora disponibile come controllo dedicato (attualmente l'override e pensato per `Ctrl` su desktop).

## FAQ

### Perche devo avviare `server.py`?

Il browser blocca richieste dirette cross-origin verso alcuni servizi WMS (CORS). Il proxy locale `/wms-proxy` evita questo blocco.

### Qual e la differenza tra layer `Ufficiale` e `Sostitutivo`?

- `Ufficiale`: WMS dell'Agenzia delle Entrate, usato come riferimento catastale.
- `Sostitutivo`: confini amministrativi Esri, utile come fallback visuale ma non equivalente al dato catastale.

### Perche import/export solo `GeoJSON` e `KML`?

Sono formati aperti e leggeri, adatti a una web app standalone. Formati piu pesanti (es. Shapefile/GeoPackage) richiedono parsing avanzato o gestione multi-file.

## Possibili evoluzioni

- Migliorare UX mobile con toggle dedicato per attivare/disattivare snapping.
- Aggiungere i18n minimale IT/EN per i testi toolbar.
- Introdurre tema chiaro opzionale.
- Aggiungere mini guida interattiva al primo avvio.
- Valutare validazioni topologiche piu avanzate durante editing/import.

## Continuita Operativa

Per riprendere velocemente il lavoro da un'altra macchina, usa la checklist in [HANDOFF.md](HANDOFF.md).

## Riferimenti e attribuzioni

Questa applicazione utilizza librerie, servizi e dataset esterni. In ottica pubblicazione su GitHub, i riferimenti principali sono riportati qui in forma trasparente.

### Librerie e standard

- OpenLayers (v8.2.0): https://openlayers.org/
	- Distribuzione usata via CDN jsDelivr.
	- Licenza: BSD-2-Clause (verificare sempre i termini correnti del progetto OpenLayers).
- GeoJSON specification (RFC 7946): https://datatracker.ietf.org/doc/html/rfc7946
- KML specification (OGC KML 2.2): https://www.ogc.org/standards/kml/

### Basemap e servizi cartografici

- OpenStreetMap (layer strade): https://www.openstreetmap.org/
	- Attribuzione richiesta: "© OpenStreetMap contributors".
	- Termini/licenza dati: https://www.openstreetmap.org/copyright
- Esri World Imagery (basemap satellitare):
	- Servizio: https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer
	- Termini d'uso Esri: https://www.esri.com/en-us/legal/terms/full-master-agreement
- Esri World Boundaries and Places (layer sostitutivo):
	- Servizio: https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer
	- Termini d'uso Esri: https://www.esri.com/en-us/legal/terms/full-master-agreement
- WMS Agenzia delle Entrate (overlay catastale ufficiale):
	- Endpoint upstream usato dal proxy locale: https://wms.cartografia.agenziaentrate.gov.it/inspire/wms/ows01.php
	- Portale cartografico: https://www.agenziaentrate.gov.it/portale/web/guest/schede/fabbricatiterreni/cartografia-catasto

### Note di conformita per pubblicazione GitHub

- Questo repository non rivendica proprieta sui dati cartografici esterni: ogni dataset/servizio resta di titolarita dei rispettivi fornitori.
- L'uso pubblico del progetto deve rispettare licenze e termini dei servizi esterni, incluse eventuali clausole su attribuzione, rate limit e uso commerciale.
- Prima di rilasci o deploy pubblici, verificare eventuali aggiornamenti dei termini ai link ufficiali sopra.
- Project Planimeter by BalTac e un progetto indipendente, non affiliato ne sponsorizzato da OpenStreetMap Foundation, Esri o Agenzia delle Entrate.