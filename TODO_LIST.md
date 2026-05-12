# TODO LIST

## Regole operative
- [ ] Mantenere [CHANGELOG.md](CHANGELOG.md) aggiornato a ogni milestone.
- [ ] Flaggare come completate solo le voci realmente testate/validate.
- [ ] Mantenere la wiki solo locale (cartelle [wiki/](wiki/) e [raw/](raw/)), finche il progetto non e piu maturo.
- [x] Ripulire e riallineare [README.md](README.md) al codice reale (struttura unica, senza duplicazioni).
- [x] Estendere [README.md](README.md) con template screenshot e matrice compatibilita browser; registrare modifica in [CHANGELOG.md](CHANGELOG.md).

## Priorita prossime task

### P0 — Stabilizzazione e validazione corrente
- [x] Verificare resa responsive desktop/mobile toolbar e tool icons senza overflow.
- [x] Verificare hint hover IT/EN e accessibilita keyboard/screen-reader dei pulsanti.
- [x] Verificare gruppi layer A/B: mutua esclusione nel gruppo e massimo 2 layer attivi totali.
- [x] Verificare ripristino preferenze layer corretto dopo refresh.
- [x] Verificare cache WMS: primo caricamento MISS, secondo HIT, anche su layer differenti.
- [x] Verificare clear cache da Settings (contenuto + metriche azzerate).
- [x] Verificare update runtime cache (TTL/MB) da UI e applicazione effettiva lato backend.
- [x] Verificare download reale GeoTIFF dalla toolbar Export.
- [x] Verificare ZIP PNG+PGW (coerenza file .png e .pgw).
- [x] Verificare ZIP Bundle (image.tif, areas.geojson, meta.json).
- [x] Validare input proxy WMS con allowlist parametri ammessi.
- [x] Introdurre rate limit semplice sugli endpoint proxy.
- [x] Rendere il rate limit dinamico in base alle richieste concorrenti in-flight, mantenendo thread safety.
- [x] Aggiungere bypass automatico rate-limit per connessioni da localhost.
- [x] Aggiungere test automatici minimi backend (smoke server, parsing GeoJSON, utility area/format).
- [x] Verificare compatibilita importmap cross-browser (Chrome/Firefox/Safari target).
- [x] Aggiungere smoke E2E Playwright: draw polygon, export GeoJSON, locale switch.

### P1 — Interpretation layer backend
- [x] Estendere [server.py](server.py) con `OUTPUT=json` per `GetFeatureInfo`, senza rompere il path raw HTML/XML corrente.
- [x] Normalizzare il parser server-side in payload canonico (`parcel.id`, `parcel.label`, `parcel.namespace`, `parcel.local_id`) con diagnostica `raw`.
- [x] Gestire contratto esplicito `parse_failed` quando l'HTML non produce campi affidabili.
- [x] Implementare endpoint semantico `POST /parcel-at-point` che nasconde i dettagli WMS al frontend.

### P2 — Migrazione frontend parcel workflow
- [x] Introdurre adapter/feature flag frontend per supportare sia risposta raw HTML sia risposta JSON normalizzata.
- [x] Migrare progressivamente la query particella dal path raw al path JSON/semantico senza regressioni UX.
- [x] Preparare integrazione di `parcel_id` nel workflow applicativo come riferimento stabile.

### P3 — Data model e versioning
- [x] Evolvere data model feature con UUID stabile, bbox, timestamp, properties dinamiche e tags.
- [x] Introdurre `links.cadastral[]` nel modello persistente con `parcel_id`, `intersection_area`, `coverage_ratio`.
- [x] Implementare versioning append-only per mutazioni di geometria e proprieta.

### P4 — Geometria e analytics
- [x] Introdurre engine intersection area/ratio riusabile e UI-agnostic.
- [x] Valutare caching geometrie catastali o strategia equivalente per workload ripetuti.

### P5 — DSL e form dinamiche
- [ ] Definire DSL categorie indipendente dal dominio (`name`, `label`, `fields`, validation rules).
- [ ] Implementare loader categorie e modalita strict/flexible.
- [ ] Generare form dinamiche legate a `feature.properties` in base alla categoria selezionata.

### P6 — UX e prodotto
- [x] Aggiungere refresh tile WMS singolo da menu contestuale (tasto destro, modalità Navigate).
- [x] Mostrare riferimento tile ricaricato (`layer:z/x/y`) nella toolbar dopo refresh WMS singolo.
- [x] Aggiungere attribution/licenze cartografiche persistenti in basso a destra, con scala metrica visibile.
- [x] Aggiungere widget coordinate live in modalità Navigate e voce menu contestuale per copia coordinate.
- [ ] Migliorare UX mobile: toggle snapping dedicato (senza Ctrl).
- [ ] Aggiungere tema chiaro opzionale.
- [ ] Aggiungere mini guida interattiva primo avvio.

### Futuro — Export AI-ready e scaling
- [ ] Aggiornare export AI-ready con schema esteso coerente tra feature, links catastali e metadata raster/vector.
- [ ] Garantire coerenza CRS/bbox tra snapshot raster e dataset vettoriale esportato.
- [ ] Valutare indexing spaziale, cache geometrica catastale e possibili ottimizzazioni server-side per dataset grandi.
