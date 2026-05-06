# TODO LIST
- [ ] Mantenere [CHANGELOG.md](CHANGELOG.md) aggiornato a ogni milestone.

## Piano Implementazione — Tool Icons, Layer 2-Gruppi, Cache WMS Avanzata

### Obiettivo
- [ ] Consegnare una UX con icone standard + tooltip, gestione layer in 2 gruppi (max 2 layer totali sovrapposti), cache WMS completa con TTL e size limit configurabili anche da Settings.

### 1) Tool con icone standard + hint hover
- [x] Definire set icone standard (draw/edit/delete/navigate/measure/locate/export/import/duplicate/clear/cache).
- [x] Aggiornare toolbar strumenti e azioni con icona + testo accessibile.
- [x] Aggiungere tooltip hover coerenti (`title` + fallback accessibile) su tutti i pulsanti tool/action.
- [ ] Verificare resa responsive desktop/mobile senza overflow.

Test e validazione:
- [ ] Hover su ogni tool mostra hint corretto in IT/EN.
- [ ] Screen reader mantiene label descrittiva (nessun bottone "senza nome").
- [ ] Nessuna regressione su click/keyboard navigation (`Tab`, `Enter`, `Space`).

### 2) Layer separati in 2 gruppi (max 2 overlay)
- [x] Introdurre Gruppo A "Base" (es. satellite/rilievo/strade base): selezione mutuamente esclusiva (1 solo layer attivo).
- [x] Introdurre Gruppo B "Amministrativo/Tematico" (es. topo amministrativo, WMS, confini, flood): selezione mutuamente esclusiva (1 solo layer attivo).
- [x] Vincolo runtime: massimo 2 layer attivi contemporaneamente (1 per gruppo).
- [x] Aggiornare stato UI, persistenza preferenze e ripristino all'avvio.
- [x] Aggiornare i18n IT/EN per label gruppi, layer e hint.

Test e validazione:
- [ ] Attivando un layer nello stesso gruppo, il precedente viene spento automaticamente.
- [ ] È possibile tenere contemporaneamente 1 layer del gruppo Base + 1 del gruppo Amministrativo.
- [ ] Contatore/logica non permette mai 3 layer sovrapposti da questi gruppi.
- [ ] Ripristino preferenze corretto dopo refresh pagina.

### 3) TTL e dimensione cache configurabili da Settings
- [x] Estendere Settings con campi: TTL cache (giorni) e limite cache (MB), con default rispettivamente 30 giorni e 500 MB.
- [x] Persistenza preferenze TTL/size lato client e invio al backend endpoint dedicato.
- [x] Backend: applicare TTL configurabile e cap dimensionale con strategia di eviction (LRU o oldest-first documentata).
- [x] Validare input (range min/max) lato UI e lato server.

Test e validazione:
- [ ] Modifica TTL da UI applicata e riflessa nelle statistiche/config runtime.
- [ ] Modifica size limit da UI applicata; superata soglia parte eviction automatica.
- [ ] Con default pulito, cache parte a 500 MB limite senza errori.

### 4) Cache di tutti i layer WMS
- [x] Generalizzare chiave cache per includere layer/params WMS e non solo `CP.CadastralParcel`.
- [x] Applicare cache a tutte le richieste WMS `GetMap` idonee.
- [x] Aggiornare endpoint stats per metriche aggregate e (se utile) per-layer.
- [ ] Garantire compatibilita con source ufficiale e fallback WMS futuri.

Test e validazione:
- [ ] Primo caricamento tile WMS = MISS, secondo caricamento stessa tile = HIT.
- [ ] Hit/miss funzionano per layer WMS differenti.
- [ ] Clear cache da Settings azzera metriche e contenuto.

### Integrazione, QA e chiusura
- [ ] Aggiornare [CHANGELOG.md](CHANGELOG.md) con milestone "Layer/Cache UX v2".
- [ ] Eseguire test manuale end-to-end (navigate, draw/edit/delete, switch layer gruppi, cache settings, clear cache).
- [x] Verificare `python -m py_compile server.py` e assenza errori JS nei file modificati.
- [ ] Flaggare come completate solo le voci effettivamente testate.

### Quick wins da knowledge ingest (WMS ufficiale + export GIS)
- [x] Estendere formato export UI con `GeoTIFF`, `PNG + World File (PGW)`, `Dataset Bundle`.
- [x] Collegare export aree a endpoint backend dedicati (`/export-geotiff`, `/export-pgw`, `/export-bundle`).
- [x] Aggiungere endpoint server per export raster e bundle con metadata.
- [x] Aggiungere chiavi i18n IT/EN per nuovi formati e stati export backend.
- [x] Introdurre `maxZoom` sul layer catastale ufficiale per controllo scala esplicito.

Test e validazione:
- [ ] Verificare download reale GeoTIFF da toolbar `Esporta`.
- [ ] Verificare ZIP `PNG+PGW` con file `.png` e `.pgw` coerenti.
- [ ] Verificare ZIP bundle con `image.tif`, `areas.geojson`, `meta.json`.

### Fix query particella e UX popup
- [x] Correggere il proxy `GetFeatureInfo` per evitare `502` con WMS Agenzia Entrate.
- [x] Correggere il fallback parser frontend: provare `text/plain`/`text/html` se il GML non contiene attributi utili.
- [x] Visualizzare le info catastali in una floating box vicino al cursore con pulsante `Copy Info`.
- [x] Chiudere la floating box con click sinistro esterno e con pulsante `X` dedicato.
- [x] Rendere il parser frontend più severo: scartare risposte che producono solo campi `-` e continuare il fallback.
- [x] Visualizzare direttamente la paginetta HTML `GetFeatureInfo` nel popup (iframe) per ridurre complessità di parsing campi.
- [x] Semplificare ulteriormente il frontend query particella: singola richiesta `text/html`, parser rimosso e bottone `Copy Info` rimosso.
- [x] Adattare dinamicamente altezza/larghezza del popup al contenuto iframe per limitare l'uso di scrollbar.
- [x] Aggiungere parsing tabella lato `server.py` con stampa/log dei campi estratti solo su terminale.

Test e validazione:
- [ ] Verificare che `Cadestral info here` mostri `Label`, `Reference`, `Local ID`, `Namespace` in popup.
- [ ] Verificare che `Copy Info` copi correttamente i valori negli appunti.
- [ ] Verificare che un click sinistro fuori dal popup lo chiuda senza riposizionarlo.
- [x] Limitare la query particella al solo menu contestuale in modalità `Navigate` (nessuna auto-query su click sinistro in `Edit/Delete`).

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
- [x] Aggiungere tab `Settings` alla toolbar:
	- separazione vista `Operativo` / `Settings`,
	- mantenimento selezione overlay nella vista `Operativo`, con spostamento in `Settings` solo delle preferenze non operative,
	- persistenza preferenze UI in `localStorage`.
- [x] Aggiungere interrogazione catastale opzionale via `GetFeatureInfo`:
	- toggle dedicato in `Settings`,
	- recupero metadati particella su click mappa (workflow attuale: modalità `Modifica` / `Elimina`),
	- pannello riepilogo con `Label`, `NationalCadastralReference`, `localId`, `namespace`.
- [x] Hardening interrogazione particelle da context-menu:
	- URL `GetFeatureInfo` generata tramite `TileWMS.getFeatureInfoUrl` (niente query WMS costruita a mano),
	- riconoscimento risposta upstream `ServiceException InvalidFormat` con messaggio UI dedicato (non più errore generico di proxy).
	- fallback automatico `INFO_FORMAT` su `application/vnd.ogc.gml` -> `text/plain` -> `text/html` e parser payload XML/plain-text oltre HTML.
- [x] Settings composizione mosaico WMS ufficiale:
	- selezione sottolayer catastali (`CP.CadastralParcel`, `codice_plla`, `fabbricati`, `strade`, `acque`, `CP.CadastralZoning`, `vestizioni`),
	- applicazione live ai parametri `LAYERS/QUERY_LAYERS` del `TileWMS`,
	- persistenza preferenze e blocco query particella quando il sottolayer `CP.CadastralParcel` non è attivo.
- [x] Menu contestuale Navigate: export view/selection/areas:
	- `Export view` snapshot PNG del viewport mappa (toolbar esclusa) con footer metadati (center, zoom, bbox, layer, timestamp),
	- `Export selection` con rettangolo a trascinamento e auto-pan ai bordi, export PNG della selezione con footer area,
	- `Export areas` instradato al flusso export aree già esistente (GeoJSON/KML toolbar).
	- Miglioramento UX export selection: la selezione resta modificabile (move/resize/rotate con handle), drag mappa disattivato durante editing, menu contestuale secondario `Export`/`Cancel`.
	- Preset qualità export immagine (`standard/high/ultra`) in Settings + fallback robusto su layer non esportabili per vincoli CORS.
- [ ] Verificare compatibilità importmap cross-browser (Chrome 89+, Firefox 108+, Safari 16.4+).
- [ ] Aggiungere test smoke E2E (Playwright) per: draw polygon, export GeoJSON, locale switch.
Proposte operative per i prossimi step del progetto Project Planimeter.

## Priorita Alta

- [x] Aggiungere script di avvio rapido Windows:
- `start-planimeter.bat` che lancia `python server.py` e apre il browser sulla URL locale.
- Supporto argomenti CLI pass-through (es. `--instance-policy replace`, `--host`, `--port`) nello script batch.
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

- [x] Logging proxy piu strutturato in [server.py](server.py):
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