# TODO LIST

## Regole operative
- [ ] Mantenere [CHANGELOG.md](CHANGELOG.md) aggiornato a ogni milestone.
- [ ] Flaggare come completate solo le voci realmente testate/validate.
- [ ] Mantenere la wiki solo locale (cartelle [wiki/](wiki/) e [raw/](raw/)), finche il progetto non e piu maturo.
- [x] Ripulire e riallineare [README.md](README.md) al codice reale (struttura unica, senza duplicazioni).
- [x] Estendere [README.md](README.md) con template screenshot e matrice compatibilita browser; registrare modifica in [CHANGELOG.md](CHANGELOG.md).

## Priorita prossime task

### P0 — Stabilizzazione e validazione corrente
- [ ] Verificare resa responsive desktop/mobile toolbar e tool icons senza overflow.
- [ ] Verificare hint hover IT/EN e accessibilita keyboard/screen-reader dei pulsanti.
- [ ] Verificare gruppi layer A/B: mutua esclusione nel gruppo e massimo 2 layer attivi totali.
- [ ] Verificare ripristino preferenze layer corretto dopo refresh.
- [ ] Verificare cache WMS: primo caricamento MISS, secondo HIT, anche su layer differenti.
- [ ] Verificare clear cache da Settings (contenuto + metriche azzerate).
- [ ] Verificare update runtime cache (TTL/MB) da UI e applicazione effettiva lato backend.
- [ ] Verificare download reale GeoTIFF dalla toolbar Export.
- [ ] Verificare ZIP PNG+PGW (coerenza file .png e .pgw).
- [ ] Verificare ZIP Bundle (image.tif, areas.geojson, meta.json).
- [ ] Validare input proxy WMS con allowlist parametri ammessi.
- [ ] Introdurre rate limit semplice sugli endpoint proxy.
- [ ] Aggiungere test automatici minimi backend (smoke server, parsing GeoJSON, utility area/format).
- [ ] Verificare compatibilita importmap cross-browser (Chrome/Firefox/Safari target).
- [ ] Aggiungere smoke E2E Playwright: draw polygon, export GeoJSON, locale switch.

### P1 — Interpretation layer backend
- [ ] Estendere [server.py](server.py) con `OUTPUT=json` per `GetFeatureInfo`, senza rompere il path raw HTML/XML corrente.
- [ ] Normalizzare il parser server-side in payload canonico (`parcel.id`, `parcel.label`, `parcel.namespace`, `parcel.local_id`) con diagnostica `raw`.
- [ ] Gestire contratto esplicito `parse_failed` quando l'HTML non produce campi affidabili.
- [ ] Implementare endpoint semantico `POST /parcel-at-point` che nasconde i dettagli WMS al frontend.

### P2 — Migrazione frontend parcel workflow
- [ ] Introdurre adapter/feature flag frontend per supportare sia risposta raw HTML sia risposta JSON normalizzata.
- [ ] Migrare progressivamente la query particella dal path raw al path JSON/semantico senza regressioni UX.
- [ ] Preparare integrazione di `parcel_id` nel workflow applicativo come riferimento stabile.

### P3 — Data model e versioning
- [ ] Evolvere data model feature con UUID stabile, bbox, timestamp, properties dinamiche e tags.
- [ ] Introdurre `links.cadastral[]` nel modello persistente con `parcel_id`, `intersection_area`, `coverage_ratio`.
- [ ] Implementare versioning append-only per mutazioni di geometria e proprieta.

### P4 — Geometria e analytics
- [ ] Introdurre engine intersection area/ratio riusabile e UI-agnostic.
- [ ] Valutare caching geometrie catastali o strategia equivalente per workload ripetuti.

### P5 — DSL e form dinamiche
- [ ] Definire DSL categorie indipendente dal dominio (`name`, `label`, `fields`, validation rules).
- [ ] Implementare loader categorie e modalita strict/flexible.
- [ ] Generare form dinamiche legate a `feature.properties` in base alla categoria selezionata.

### P6 — UX e prodotto
- [ ] Migliorare UX mobile: toggle snapping dedicato (senza Ctrl).
- [ ] Aggiungere tema chiaro opzionale.
- [ ] Aggiungere mini guida interattiva primo avvio.

### Futuro — Export AI-ready e scaling
- [ ] Aggiornare export AI-ready con schema esteso coerente tra feature, links catastali e metadata raster/vector.
- [ ] Garantire coerenza CRS/bbox tra snapshot raster e dataset vettoriale esportato.
- [ ] Valutare indexing spaziale, cache geometrica catastale e possibili ottimizzazioni server-side per dataset grandi.
