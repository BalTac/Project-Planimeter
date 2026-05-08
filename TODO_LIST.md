# TODO LIST

## Regole operative
- [ ] Mantenere [CHANGELOG.md](CHANGELOG.md) aggiornato a ogni milestone.
- [ ] Flaggare come completate solo le voci realmente testate/validate.
- [ ] Mantenere la wiki solo locale (cartelle [wiki/](wiki/) e [raw/](raw/)), finche il progetto non e piu maturo.
- [x] Ripulire e riallineare [README.md](README.md) al codice reale (struttura unica, senza duplicazioni).
- [x] Estendere [README.md](README.md) con template screenshot e matrice compatibilita browser; registrare modifica in [CHANGELOG.md](CHANGELOG.md).

## QA immediata (Layer/Cache UX v2)
- [ ] Verificare resa responsive desktop/mobile toolbar e tool icons senza overflow.
- [ ] Verificare hint hover IT/EN e accessibilita keyboard/screen-reader dei pulsanti.
- [ ] Verificare gruppi layer A/B: mutua esclusione nel gruppo e massimo 2 layer attivi totali.
- [ ] Verificare ripristino preferenze layer corretto dopo refresh.
- [ ] Verificare cache WMS: primo caricamento MISS, secondo HIT, anche su layer differenti.
- [ ] Verificare clear cache da Settings (contenuto + metriche azzerate).
- [ ] Verificare update runtime cache (TTL/MB) da UI e applicazione effettiva lato backend.

## Export GIS (validazione)
- [ ] Verificare download reale GeoTIFF dalla toolbar Export.
- [ ] Verificare ZIP PNG+PGW (coerenza file .png e .pgw).
- [ ] Verificare ZIP Bundle (image.tif, areas.geojson, meta.json).

## Debito tecnico prioritario
- [ ] Validare input proxy WMS con allowlist parametri ammessi.
- [ ] Introdurre rate limit semplice sugli endpoint proxy.
- [ ] Aggiungere test automatici minimi backend (smoke server, parsing GeoJSON, utility area/format).
- [ ] Verificare compatibilita importmap cross-browser (Chrome/Firefox/Safari target).
- [ ] Aggiungere smoke E2E Playwright: draw polygon, export GeoJSON, locale switch.

## UX e prodotto (medio termine)
- [ ] Migliorare UX mobile: toggle snapping dedicato (senza Ctrl).
- [ ] Aggiungere tema chiaro opzionale.
- [ ] Aggiungere mini guida interattiva primo avvio.

## Roadmap evolutiva (futuro)
- [ ] Interpretation layer non-breaking su [server.py](server.py): supporto OUTPUT=json per GetFeatureInfo.
- [ ] Endpoint semantico `POST /parcel-at-point` con payload normalizzato particella.
- [ ] Evolvere data model feature (UUID stabile, metadata, links cadastral).
- [ ] Introdurre engine intersection area/ratio (riusabile, testabile).
- [ ] DSL categorie + form dinamiche per properties feature.
- [ ] Export AI-ready versionato con schema esteso e tracciabilita mutazioni.
