# TODO LIST
- [ ] Mantenere [CHANGELOG.md](CHANGELOG.md) aggiornato a ogni milestone.

## Refactoring ES Modules + i18n + Unità di Misura

- [x] Ristrutturare codebase in ES modules con importmap OL 8.2.0 (no bundler):
	- `src/core/constants.js`, `src/core/state.js`
	- `src/i18n/it.js`, `src/i18n/en.js`, `src/i18n/i18n.js`
	- `src/units/units.js` (UnitSystem metric/imperial, autoDetect da navigator.language)
	- `src/geometry/calculations.js`, `src/geometry/style.js`, `src/geometry/decorate.js`
	- `src/io/persistence.js`, `src/io/export.js`, `src/io/import.js`
	- `src/map/layers.js`, `src/map/interactions.js`
	- `src/ui/proxy-health.js`, `src/ui/context-menu.js`
	- `src/planimeter.js` (orchestratore), `src/main.js` (entry point)
- [x] Aggiungere internazionalizzazione IT/EN con runtime switching (`t()`, `setLocale()`, `detectLocale()`).
- [x] Aggiungere sistema di misura metrico/imperiale con autodetect da locale del browser.
- [x] Aggiungere `<select id="lang-switcher">` e `<select id="unit-system">` in toolbar.
- [x] Aggiungere attributi `data-i18n` su tutti i nodi statici HTML.
- [x] Riscrivere README.md in inglese STEM/GIS professionale.
- [x] Fix runtime bootstrap post-refactor:
	- corretto `planimeter.html` (tag `body` duplicato e sezione `Riepilogo` con `dl` annidati in modo invalido),
	- ripristinato caricamento overlay e aggiornamento live di lingua/unità.
- [x] Fix risoluzione moduli browser senza bundler:
	- aggiornato `importmap` OpenLayers in `planimeter.html` da jsDelivr package path a `https://esm.sh/ol@8.2.0/`,
	- eliminato errore console `Failed to resolve module specifier "color-space/lchuv.js"` (bare specifier dipendenze transitive OL).
- [x] Fix proxy WMS ufficiale Agenzia (test locale Cannara):
	- normalizzazione automatica richieste `GetMap` in `server.py`:
		- conversione `CRS=EPSG:3857` + `BBOX` WebMercator in `CRS=EPSG:6706` (axis order lat,lon per WMS 1.3.0),
		- intercettazione risposte XML `ServiceException` restituite con HTTP 200.
	- verifica riproducibile: stessa URL Cannara del log utente ora produce PNG valido con contenuto non trasparente.
- [x] Fix allineamento overlay WMS ufficiale:
	- rimosso ridimensionamento forzato `WIDTH/HEIGHT` lato proxy (causava patch rettangolare disallineata),
	- impostato `hidpi: false` sul layer `ImageWMS` ufficiale in `src/map/layers.js` per evitare richieste oversized da display ad alto DPI.
- [x] Stabilizzazione richieste oversized (`502`) su WMS ufficiale:
	- in `server.py` aggiunto fallback robusto per `GetMap` oltre limiti upstream:
		- richiesta upstream ridotta sotto `MaxWidth/MaxHeight` Agenzia,
		- ri-campionamento PNG di ritorno alla dimensione originaria richiesta dal client,
		- eliminazione errori intermittenti `502` + `EncodingError: The source image cannot be decoded` osservati in console.
- [x] Hardening startup server locale (`server.py`):
	- controllo istanze già attive con policy configurabile `--instance-policy reuse|replace`,
	- in caso di porta occupata da servizio non Planimeter: fallback automatico su porta random libera,
	- prevenzione listener multipli sulla stessa porta (`allow_reuse_address = False` + probe porta robusto).
- [ ] Verificare compatibilità importmap cross-browser (Chrome 89+, Firefox 108+, Safari 16.4+).
- [ ] Aggiungere test smoke E2E (Playwright) per: draw polygon, export GeoJSON, locale switch.
Proposte operative per i prossimi step del progetto Project Planimeter.

## Priorita Alta

- [x] Aggiungere script di avvio rapido Windows:
- `start-planimeter.bat` che lancia `python server.py` e apre il browser sulla URL locale.
- [x] Introdurre health check proxy in UI:
- Indicatore `Proxy WMS: OK/KO` nella toolbar con ultimo errore leggibile.
- [x] Migliorare resilienza catasto ufficiale:
- Retry breve su errori transitori upstream.
- Timeout configurabile lato proxy.

## Priorita Media

- [x] Persistenza locale geometrie:
- Salvataggio automatico in `localStorage` con versione schema.
- Ripristino stato all'apertura successiva.
- [x] Supportare `MultiPolygon` in import/export.
- [x] Ampliare interoperabilita GIS leggera:
- Export `GeoJSON` e `KML`.
- Import `GeoJSON` e `KML` con autodetect del formato.
- [x] Aggiungere tool misuratore distanze:
- Misura linea retta (2 punti).
- Misura polyline (tracciato multi-vertice).
- [x] Aggiungere misura perimetro (m) oltre all'area (ha).
- [x] Aggiungere comando `Duplica area selezionata`.
- [x] Correggere monitoraggio `Proxy WMS` per evitare `Health check HTTP 404` quando il layer ufficiale non e attivo.
- [x] Riordinare layout riga strumenti su viewport stretti (wrapping responsive pulsanti).
- [ ] Migliorare UX mobile:
- Toggle dedicato per disattivare snapping (in assenza di Ctrl).

## Priorita Bassa

- [ ] Aggiungere i18n minimale (IT/EN) per testi toolbar.
- [ ] Aggiungere tema chiaro opzionale.
- [ ] Aggiungere mini guida interattiva al primo avvio.

## Hardening Tecnico

- [ ] Logging proxy piu strutturato in [server.py](server.py):
- codice risposta upstream,
- durata richiesta,
- query WMS sanitizzata.
- [ ] Validare parametri input del proxy con allowlist (`SERVICE`, `REQUEST`, `LAYERS`, `CRS`, ecc.).
- [ ] Aggiungere limite semplice di rate per evitare abuso endpoint proxy.
- [ ] Aggiungere test automatici:
- smoke test server locale,
- test parsing GeoJSON,
- test utility area/formatting.

## Deploy e Operativita

- [ ] Preparare variante deploy VPS con reverse proxy:
- Nginx su HTTPS,
- route `/wms-proxy` verso backend Python,
- caching breve tile/image.
- [ ] Aggiungere file `.env.example` per host/porta/timeouts.
- [x] Documentare runbook essenziale in [README.md](README.md):
- start,
- stop,
- troubleshooting.

## Migliorie Documentazione

- [x] Pulizia repository: rimosso asset di test non usato (`wms-test.png`) e aggiunta regola preventiva in [.gitignore](.gitignore).
- [x] Aggiungere sezione "Known Issues" in [README.md](README.md).
- [x] Aggiungere sezione "FAQ" (CORS, proxy, differenza ufficiale/sostitutivo).
- [x] Aggiungere sezione "Riferimenti e attribuzioni" in [README.md](README.md) per pubblicazione GitHub.
- [ ] Mantenere [CHANGELOG.md](CHANGELOG.md) aggiornato a ogni milestone.