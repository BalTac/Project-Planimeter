# CHANGELOG

Tutte le modifiche rilevanti del progetto Project Planimeter.

## [2026-05-14] — Form dinamica per campi DSL con bind su feature.properties.dsl.values

### Added
- [planimeter.html](planimeter.html) aggiunge container `#dsl-fields-form` nella sezione assegnazione categoria.
- [src/planimeter.js](src/planimeter.js) implementa:
  - `buildFieldControl(field, currentValue)`: factory per generare elementi HTML in base al tipo di campo (boolean/enum/string/number).
  - `renderDslFieldForm(feature, domain, categoryId)`: popola il form con i campi della categoria selezionata, preserver i valori esistenti.
  - `updateFeatureDslFieldValue(fieldId, value)`: handler per aggiornare `feature.dsl.values[fieldId]` e persistere la modifica (schedulePersistenceSync).
  - Integrazione in `updateDslAssignmentControls()`: renderizza il form quando categoria scelta, cancella quando vuoto.
- [styles.css](styles.css) aggiunge stili `.dsl-fields-form`, `.dsl-field-wrapper`, `.dsl-field-label`, `.dsl-field-input` con supporto per checkbox, select, input text/number con focus states.
- [src/planimeter.js](src/planimeter.js) aggiunge `dslFieldsForm` a `collectElements()`.

### Changed
- [src/planimeter.js](src/planimeter.js) `updateDslAssignmentControls()` ora renderizza la form dinamica quando feature + categoria sono valide.
- Form dinamica integrata end-to-end: selezione categoria → rendering campi → fill/update campi → persist automatico su change.

## [2026-05-14] — UX wiring assegnazione categoria (context menu + pannello Operativo)

### Added
- [src/ui/context-menu.js](src/ui/context-menu.js) supporta azione opzionale `assignCategory(feature)` e voce contestuale `ctx.assignCategory` visibile solo su feature poligonali in modalità Navigate.
- [planimeter.html](planimeter.html) introduce sezione `#section-dsl-assignment` nel pannello Operativo con dominio attivo, feature selezionata, select categoria e bottone applicazione.
- [styles.css](styles.css) aggiunge classi `.dsl-assignment-grid`, `.dsl-assignment-meta` e stato disabled del bottone assegnazione.
- [src/planimeter.js](src/planimeter.js) aggiunge flusso end-to-end:
  - `openCategoryAssignmentFromContext(feature)` apre il pannello Operativo e prepara i controlli sulla feature target.
  - `updateDslAssignmentControls()` sincronizza dominio/feature/categoria selezionata e hint UX.
  - `applySelectedFeatureCategory()` scrive `feature.properties.dsl`, preserva valori field esistenti quando possibile, aggiorna `version`/`modifiedAt`, forza repaint e refresh riepilogo.
- [src/i18n/it.js](src/i18n/it.js), [src/i18n/en.js](src/i18n/en.js) estendono le stringhe `section.dsl.assignment.*`, `dsl.assign.*`, `msg.categoryPanelReady`, `msg.categoryAssigned`.

### Changed
- [src/planimeter.js](src/planimeter.js) integra il callback `assignCategory` in `initContextMenu(...)` e mantiene i controlli DSL aggiornati a ogni `updateSummary()`.
- [TODO_LIST.md](TODO_LIST.md) marca completati i task UX su context menu assegnazione, pannello operativo assegnazione e feedback visivo immediato.

## [2026-05-13] — DM3 style engine da categoria + legenda live + tabella riepilogo

### Added
- [src/dsl/aggregation.js](src/dsl/aggregation.js) — `aggregateByCategory()` computa totali area/count per categoria DSL; helper `totalAggArea()`; bucket "non assegnata" per feature senza DSL.
- [src/geometry/style.js](src/geometry/style.js) — `resolveColors()` legge `feature.dsl.categoryId` → cerca dominio/categoria nel registry → usa `cat.color`/`cat.stroke`; helper `hexToRgba()`; fallback al tema verde se nessuna categoria.
- [planimeter.html](planimeter.html) — sezione `#section-dsl-categories` (nascosta finché DSL non pronto) con `#dsl-legend` e `#dsl-category-table`.
- [styles.css](styles.css) — classi `.dsl-legend`, `.dsl-legend-item`, `.dsl-legend-swatch`, `.dsl-table`, `.dsl-table-swatch`, `.dsl-row-unassigned`, `tfoot` highlight.
- [src/planimeter.js](src/planimeter.js) — import `initDsl`/`getDomain`, `aggregateByCategory`/`totalAggArea`; `initDsl()` async al boot (non bloccante); `renderDslSummary()` richiamata da `updateSummary()`: popola legenda e tabella.
- [src/io/persistence.js](src/io/persistence.js) — `buildActiveCampaign` include `dslActiveDomainId`; `toHistoryRecord` include `dsl` payload.
- [src/i18n/it.js](src/i18n/it.js), [src/i18n/en.js](src/i18n/en.js) — chiavi `section.dsl.*`, `dsl.table.*`.

### Added
- [src/dsl/schema.js](src/dsl/schema.js) — schema DSL domain-agnostic con validatori `validateDomain`, `validateFeatureDsl`, helper `getCategoryById`, `buildDslPayload`; supporto modalità `strict`/`flexible`.
- [src/dsl/loader.js](src/dsl/loader.js) — loader con registry in-memory, fetch domini da `/domains/<id>.json`, merge override utente da localStorage, `initDsl()` per startup, `registerDomain()` per import runtime.
- [domains/agriculture.json](domains/agriculture.json) — dominio starter agricoltura con 13 categorie (grano tenero, grano duro, orzo, sorgo, favino, girasole, prato, vigna, oliveto, frutteto, orto, maggese, riposo) e campi `irrigated`, `fertilization`, `variety`, `expected_yield_q_ha`, `notes`.
- [src/core/state.js](src/core/state.js) aggiunge stato DSL (`dslActiveDomainId`, `dslValidationMode`, `dslReady`).
- [src/geometry/decorate.js](src/geometry/decorate.js) aggiunge placeholder `dsl: null` alle nuove feature.
- [src/i18n/it.js](src/i18n/it.js), [src/i18n/en.js](src/i18n/en.js) — chiavi i18n per `dsl.*`, `ctx.assignCategory`.

### Added
- [src/io/persistence.js](src/io/persistence.js) introduce persistenza a snapshot per campagna (`campaigns[]`) con metadati `id/year/season/savedAt` e supporto query storiche `historyAtPoint(lonLat)` / `historyAtParcel(parcelId)`.
- [src/planimeter.js](src/planimeter.js) espone metodi applicativi `historyAtPoint`, `historyAtPointFromPixel`, `historyAtParcel` per recuperare storico geometrie/assegnazioni tra campagne.
- [src/core/state.js](src/core/state.js) aggiunge stato campagna attiva (`activeCampaignId`, `activeCampaignYear`, `activeCampaignSeason`).

### Changed
- [src/core/constants.js](src/core/constants.js) aggiorna `LOCAL_STORAGE_SCHEMA_VERSION` da `2` a `3` per supportare lo store a campagne.
- [src/io/persistence.js](src/io/persistence.js) migra automaticamente payload legacy (schema v1/v2 con `features`) al nuovo formato campaign-based senza perdita dei feature metadata.
- [src/main.js](src/main.js) espone `window.planimeterApp` per accesso diretto alle nuove query storiche da console/debug.

### Validation
- Eseguito controllo sintassi JavaScript (`node --check`) sui file modificati.

## [2026-05-12] — Attribution+scala persistenti e coordinate live con copia da menu

### Added
- [src/planimeter.js](src/planimeter.js) estende i controlli OpenLayers con `ScaleLine` metrica e `attributionOptions` non collassabili, mantenendo attribution e scala sempre visibili.
- [planimeter.html](planimeter.html), [styles.css](styles.css) e [src/planimeter.js](src/planimeter.js) introducono widget overlay coordinate in basso a destra, aggiornato in tempo reale in modalità `Navigate` nel formato `lon, lat` (6 decimali).
- [src/ui/context-menu.js](src/ui/context-menu.js), [src/planimeter.js](src/planimeter.js), [src/i18n/it.js](src/i18n/it.js) e [src/i18n/en.js](src/i18n/en.js) aggiungono la voce contestuale `Copy coordinates` / `Copia coordinate` con copia negli appunti del punto selezionato con click destro.

### Changed
- [styles.css](styles.css) rifinisce il layout di attribution e scala in basso a destra con estetica coerente al tema e senza sovrapposizione al nuovo widget coordinate.
- [src/ui/context-menu.js](src/ui/context-menu.js) rende il click handler compatibile con azioni asincrone (`Promise.resolve(...).finally(...)`) garantendo chiusura menu anche su callback async.
- [TODO_LIST.md](TODO_LIST.md) marca completate le due nuove task UX su attribution/scala e coordinate live+copia.

### Validation
- Eseguiti check sintassi JavaScript (`node --check`) e suite test Python (`unittest discover`).

## [2026-05-11] — Refresh tile WMS singolo da menu contestuale

### Added
- [src/planimeter.js](src/planimeter.js) aggiunge `canRefreshWmsTile()` e `refreshTileAtPixel(pixel)`: reset dello stato tile a `IDLE` e `tile.load()` per ogni tile visibile dei layer `catastoOfficial` sotto il cursore, senza ricaricare l'intera mappa.
- [src/ui/context-menu.js](src/ui/context-menu.js) espone la voce "Ricarica tile WMS" nel menu contestuale (modalità Navigate) quando almeno un layer catasto ufficiale è attivo e visibile.
- [src/i18n/it.js](src/i18n/it.js) aggiunge chiave `ctx.refreshTile` con traduzione italiana.
- [src/i18n/en.js](src/i18n/en.js) aggiunge chiave `ctx.refreshTile` con traduzione inglese.

### Fixed
- [src/ui/context-menu.js](src/ui/context-menu.js) rende robusto il click handler delle azioni contestuali (`try/finally`): il menu ora si chiude sempre anche in caso di errore runtime dell'azione.
- [src/planimeter.js](src/planimeter.js) corregge il refresh tile singolo con strategia cache-buster per il solo `img.src` della tile sotto cursore (`__refresh_ts=...`), evitando path fragili che potevano lasciare la voce apparentemente non operativa.
- [src/planimeter.js](src/planimeter.js) forza il repaint immediato quando il tile ricaricato completa (`load`/`error`) usando `layer.changed()` + `map.renderSync()`, evitando il caso in cui il nuovo tile compariva solo dopo zoom/pan.
- [src/planimeter.js](src/planimeter.js) aggiunge feedback toolbar con riferimento del tile ricaricato (`layer:z/x/y`) per debug rapido del refresh puntuale.

### Validation
- Nessuna regressione su `get_errors` per tutti e 4 i file modificati.

## [2026-05-11] — Bypass automatico rate-limit per connessioni localhost

### Added
- [server.py](server.py) aggiunge metodo statico `_is_localhost(ip)` che riconosce `127.0.0.1`, `::1`, `::ffff:127.0.0.1` come loopback.
- [server.py](server.py) aggiunge early-return in `_check_rate_limit()`: le richieste da localhost bypassano interamente il limiter senza consumare quota.
- [tests/test_server_smoke.py](tests/test_server_smoke.py) aggiunge `test_localhost_bypass_ignores_limit` che verifica il bypass per IP loopback noti.

### Validation
- Backend smoke: `22 passed`.

## [2026-05-11] — Rate-limit dinamico locale su concorrenza in-flight

### Changed
- [server.py](server.py) evolve il rate limiter da soglia fissa a soglia dinamica per IP, calcolata in base alle richieste proxy contemporanee in-flight (`/wms-proxy`, `/wms-tile`, `/parcel-at-point`), mantenendo lock thread-safe e finestra scorrevole.
- [server.py](server.py) aggiunge contatore thread-safe di richieste in-flight e usa il valore corrente nel check `429` per ridurre falsi positivi su burst locali.

### Added
- [tests/test_server_smoke.py](tests/test_server_smoke.py) aggiunge test su scaling dinamico del budget e rispetto del cap massimo.

### Validation
- Eseguiti test backend target: `30 passed` (`tests/test_server_smoke.py`, `tests/test_server_parcel_at_point.py`).

## [2026-05-11] — P4 geometria/analytics: intersection engine e cache geometrie catastali

### Added
- [src/geometry/intersection.js](src/geometry/intersection.js) introduce un motore UI-agnostic per calcolo area di intersezione e coverage ratio tra poligoni, con supporto a Polygon/MultiPolygon e output parametrizzabile (`ratioBase`).
- [src/geometry/intersection.js](src/geometry/intersection.js) introduce una cache in-memory per geometrie catastali normalizzate, con metriche `hits/misses` e helper per riuso delle geometrie tra confronti ripetuti.
- [tests/test_p4_intersection_engine.py](tests/test_p4_intersection_engine.py) valida calcolo intersezione su poligoni sovrapposti e riuso cache geometria catastale.

### Changed
- [TODO_LIST.md](TODO_LIST.md) marca completate le due task P4 su engine di intersezione e strategia di caching geometrie catastali.

### Validation
- Suite completa test repository: `79 passed`.

## [2026-05-11] — P0 validazioni UI/cache: responsive, accessibilita e runtime config

### Added
- [tests/test_e2e_p0.py](tests/test_e2e_p0.py) aggiunge test esplicito sul vincolo globale layer: massimo 2 attivi totali (1 base + 1 admin), oltre alla mutua esclusione nei gruppi.
- [tests/test_e2e_p0_extended.py](tests/test_e2e_p0_extended.py) aggiunge test responsive desktop/mobile per toolbar senza overflow orizzontale.
- [tests/test_e2e_p0_extended.py](tests/test_e2e_p0_extended.py) aggiunge test su hint hover IT/EN e operabilita keyboard dei pulsanti tool (`Enter` su elemento in focus).
- [tests/test_e2e_p0_extended.py](tests/test_e2e_p0_extended.py) aggiunge test integrazione cache WMS su `/wms-tile`: primo caricamento `MISS`, secondo `HIT`, incluso scenario con layer differente.
- [tests/test_e2e_p0_extended.py](tests/test_e2e_p0_extended.py) aggiunge test su `Settings > Cache` per applicazione runtime di `TTL/MB` e verifica lato backend tramite `GET /cache-config`.
- [tests/test_e2e_p0_extended.py](tests/test_e2e_p0_extended.py) aggiunge test clear cache da settings con verifica metriche azzerate (`count=0`, `size_bytes=0`).
- [tests/test_e2e_p0_extended.py](tests/test_e2e_p0_extended.py) estende i test export backend con validazione contenuti reali: firma TIFF, struttura ZIP PGW (`.png` + `.pgw`), struttura ZIP bundle (`image.tif`, `areas.geojson`, `meta.json`).

### Changed
- [TODO_LIST.md](TODO_LIST.md) aggiorna lo stato P0 marcando completate le verifiche validate dai nuovi test (responsive, hint/accessibilita keyboard, vincoli layer, restore preferenze layer, clear cache, apply runtime cache config).
- [TODO_LIST.md](TODO_LIST.md) marca completata anche la verifica compatibilita importmap cross-browser (target Chrome/Firefox/Safari) dopo smoke test su Chromium/Firefox/WebKit.
- [src/planimeter.js](src/planimeter.js) corregge export raster dalla toolbar: conversione extent da `EPSG:3857` a `EPSG:4326` (compatibile OpenLayers) evitando errore runtime `getCode` su proiezione non registrata.
- [src/io/export.js](src/io/export.js) rende piu robusto il download blob (`a` temporaneo nel DOM + revoke URL differito) per payload export più pesanti.
- [TODO_LIST.md](TODO_LIST.md) marca completate le 3 verifiche residue P0 su export toolbar (GeoTIFF, PNG+PGW, Bundle).

### Validation
- Eseguita suite completa test repository: `77 passed`.
- Eseguiti smoke test cross-browser su Firefox/WebKit: `6 passed` (titolo pagina, render mappa, assenza JS errors).
- Validazione runtime toolbar export (Chromium Playwright script): chiamate reali `POST /export-geotiff`, `POST /export-pgw`, `POST /export-bundle` tutte con HTTP 200 e messaggi UI di successo.

## [2026-05-08] — README ripulito e riallineato al progetto

### Changed
- [README.md](README.md) ristrutturato in una versione unica e coerente (rimossi contenuti duplicati e incongruenze pregresse).
- [README.md](README.md) aggiornato con dipendenze backend reali e sezione endpoint/server CLI allineata al comportamento corrente.
- [README.md](README.md) esteso con matrice di compatibilita browser (ES modules, import maps, API browser usate).
- [README.md](README.md) esteso con template operativo per screenshot futuri (titolo, filename suggerito, caption).

### Notes
- Nessuna immagine inclusa in questa milestone: sezione predisposta per inserimento progressivo quando disponibili asset visuali.

## [2026-05-07] — Layer WMS catastali separati e controlli opacity

### Added
- Pattern stile GeoLive per catasto ufficiale: un `TileWMS` separato per ogni sottolayer catastale.
- Controlli UI separati per visibilita e trasparenza di particelle, numeri particella, fabbricati, strade, acque, province, zonizzazione e vestizioni.
- Test unitari per validazione bbox export e world file PGW con centro pixel corretto.
- Sezione README con comandi lint/test standard.

### Changed
- Export backend usa solo sottolayer WMS visibili.
- Preferenze catasto migrate da lista `LAYERS` unica a configurazione `{visible, opacity}` per sottolayer, mantenendo compatibilita con le vecchie impostazioni salvate.
- Export `.tif` rinominato in UI/docs come TIFF raster, evitando di promettere tag GeoTIFF embedded.
- [app.js](app.js) documentato come bundle legacy; entry point attivo in [src/main.js](src/main.js).

### Fixed
- Validazione bbox export rifiuta valori non finiti, coordinate fuori range e bbox invertiti.
- World file PGW scrive coordinate del centro pixel upper-left, non del bordo raster.

## [2026-05-07] — Cross-platform startup e allineamento porta README

### Added
- [start_planimeter.sh](start_planimeter.sh) per avvio rapido su Linux/macOS con apertura browser automatica.

### Changed
- [README.md](README.md) allineato alla porta di default reale (`8000`) e aggiornato con istruzioni Windows + Unix.
- [server.py](server.py) migliora il supporto cross-platform in `--instance-policy replace` con rilevazione PID su Unix via `lsof`/`ss` (best effort).
- [TODO_LIST.md](TODO_LIST.md) aggiornato con task completato relativo ad avvio cross-platform e documentazione.

## [2026-05-07] — Cleanup documentazione operativa obsoleta

### Removed
- Rimossa checklist operativa legacy dal repository.

### Changed
- [README.md](README.md) pulito dai riferimenti alla checklist legacy (struttura progetto e sezione continuita operativa).
- [TODO_LIST.md](TODO_LIST.md) aggiornato con task completato relativo alla rimozione.

## [2026-05-07] — Ingest interpretation layer spec + TODO integrazione feature

### Added
- [wiki/wms-proxy-interpretation-layer.md](wiki/wms-proxy-interpretation-layer.md) con sintesi tecnica del documento `raw/wms_proxy_interpretation_layer_spec.md`.

### Changed
- [wiki/index.md](wiki/index.md) aggiornato con topic `WMS Proxy Interpretation Layer`.
- [wiki/log.md](wiki/log.md) aggiornato con ingest e implicazioni architetturali (dual-mode FeatureInfo + `/parcel-at-point`).
- [TODO_LIST.md](TODO_LIST.md) esteso con roadmap integrata: interpretation layer, endpoint semantico, data model evoluto, intersection engine, DSL categorie, export AI-ready e versioning.

## [2026-05-07] — Ingest project objectives + wiki health-check

### Added
- [wiki/project-objectives.md](wiki/project-objectives.md) con sintesi strutturata di `raw/project_objectives.md` (data model refactor, cadastral links, intersection engine, DSL categorie, dynamic forms, export constraints, versioning).

### Changed
- [wiki/index.md](wiki/index.md) aggiorna i topic con la nuova pagina `Project Objectives`.
- [wiki/log.md](wiki/log.md) registra ingest e health-check wiki eseguito.
- [TODO_LIST.md](TODO_LIST.md) allinea il tracciamento attività documentali.

## [2026-05-07] — Ingest documenti raw

### Changed
- [wiki/log.md](wiki/log.md) aggiorna il log di ingest con passaggio `raw/` del 2026-05-07.
- [wiki/wms-export.md](wiki/wms-export.md) refresh sintesi (`Last Synthesized`) e allineamento wording architettura proxy locale.
- [TODO_LIST.md](TODO_LIST.md) allinea il tracciamento documentale con completamento ingest `raw/`.

## [2026-05-06] — Refinement da knowledge ingest (Catasto WMS + export GIS)

### Added
- [planimeter.html](planimeter.html) estende `Formato export` con opzioni `GeoTIFF`, `PNG + World File (PGW)` e `Dataset Bundle`.
- [src/io/export.js](src/io/export.js) aggiunge `requestBackendExport()` per i nuovi formati raster/server-side.
- [server.py](server.py) aggiunge endpoint `POST /export-geotiff`, `POST /export-pgw`, `POST /export-bundle`.
- [server.py](server.py) introduce helper backend per export: parsing payload JSON, fetch WMS PNG, conversione TIFF, generazione world file PGW e creazione ZIP bundle.
- [src/i18n/it.js](src/i18n/it.js) e [src/i18n/en.js](src/i18n/en.js) aggiungono nuove chiavi i18n per formati export, stato elaborazione e messaggi di successo/errore backend.

### Changed
- [src/planimeter.js](src/planimeter.js) rende `exportFeatures()` asincrono con instradamento automatico verso backend per `geotiff/pgw/bundle`.
- [src/map/layers.js](src/map/layers.js) estende il layer catastale ufficiale con `maxZoom: 28` per controllo scala più esplicito.
- [server.py](server.py) aggiorna CORS preflight (`OPTIONS`) includendo i nuovi endpoint export.

## [2026-05-07] — Fix query particella + floating info box

### Fixed
- [server.py](server.py) normalizza anche le richieste `GetFeatureInfo`, eliminando il `502` sul percorso `Cadestral info here` verso il WMS Agenzia Entrate.
- [src/planimeter.js](src/planimeter.js) corregge il fallback `GetFeatureInfo`: se il payload GML contiene solo geometria, prosegue su `text/plain` e `text/html` invece di fermarsi con esito vuoto.
- [src/planimeter.js](src/planimeter.js) estende il parser HTML per leggere i campi `InspireId localId` e `InspireId_namespace` restituiti dal servizio ufficiale.
- [src/planimeter.js](src/planimeter.js) evita falsi positivi su payload GML/plain deboli: il fallback accetta un risultato solo se contiene una vera identità particella (`reference` o `localId`), riducendo i casi con popup valorizzato a trattini.

### Changed
- [planimeter.html](planimeter.html), [styles.css](styles.css) e [src/planimeter.js](src/planimeter.js) sostituiscono la visualizzazione toolbar delle info catastali con una floating box vicino al cursore, completa di pulsante `Copy Info`.
- [planimeter.html](planimeter.html), [styles.css](styles.css), [src/core/state.js](src/core/state.js) e [src/planimeter.js](src/planimeter.js) aggiungono chiusura esplicita del popup (`X`) e dismiss su click sinistro esterno, evitando che la box segua il puntatore al click successivo.
- [src/planimeter.js](src/planimeter.js) irrigidisce il parsing `GetFeatureInfo`: un risultato con soli trattini viene ora scartato e il fallback continua sui formati successivi, con estrazione HTML più robusta per le tabelle Agenzia.
- [src/planimeter.js](src/planimeter.js), [src/ui/context-menu.js](src/ui/context-menu.js), [src/i18n/it.js](src/i18n/it.js) e [src/i18n/en.js](src/i18n/en.js) allineano il workflow query particella: richiesta disponibile solo da menu contestuale in modalità `Navigate`, senza interrogazioni automatiche su click sinistro mappa in `Edit/Delete`.
- [planimeter.html](planimeter.html), [styles.css](styles.css), [src/core/state.js](src/core/state.js) e [src/planimeter.js](src/planimeter.js) introducono rendering diretto del payload `GetFeatureInfo` HTML in `iframe` nel popup; il parser campi resta come fallback per formati non HTML.
- [planimeter.html](planimeter.html), [styles.css](styles.css), [src/core/state.js](src/core/state.js) e [src/planimeter.js](src/planimeter.js) rimuovono `Copy Info`, campi parser nel popup e parser frontend legacy: la query particella ora esegue una sola richiesta `text/html` e rende il risultato raw nel frame con dimensionamento dinamico.
- [server.py](server.py) aggiunge estrazione campi da tabella `GetFeatureInfo` HTML e logging su terminale (`wms-proxy parsed-featureinfo ...`) senza alterare la risposta inviata al frontend.

## [2026-05-06] — Layer groups A/B con vincolo max 2 overlay

### Added
- [planimeter.html](planimeter.html) separa i layer in due gruppi espliciti: `Gruppo A (Base)` e `Gruppo B (Amministrativo/Tematico)` con hint dedicati.
- [src/io/preferences.js](src/io/preferences.js) e [src/core/state.js](src/core/state.js) introducono preferenze/stato `activeBaseLayer` e `activeAdminLayer`.
- [src/i18n/it.js](src/i18n/it.js) e [src/i18n/en.js](src/i18n/en.js) aggiungono nuove chiavi i18n per i hint dei gruppi layer.

### Changed
- [src/planimeter.js](src/planimeter.js) sostituisce la logica legacy con gestione a gruppi:
  - mutua esclusione nel gruppo Base,
  - mutua esclusione nel gruppo Amministrativo,
  - massimo due overlay simultanei (1 base + 1 amministrativo/tematico),
  - sincronizzazione UI/layer OpenLayers,
  - persistenza e ripristino automatico all'avvio.
- [src/planimeter.js](src/planimeter.js) aggiorna `setCatastoSource` per persistere subito la scelta sorgente in preferenze.

## [2026-05-06] — Settings cache runtime (TTL + size limit)

### Added
- [planimeter.html](planimeter.html) aggiunge in `Settings > Cache Tile WMS` i campi configurabili `TTL cache (giorni)` e `Limite cache (MB)` con default 30/500 e range validati.
- [planimeter.html](planimeter.html) aggiunge pulsante `Applica parametri cache` per inviare la configurazione runtime al backend.
- [src/planimeter.js](src/planimeter.js), [src/core/state.js](src/core/state.js) e [src/io/preferences.js](src/io/preferences.js) introducono persistenza client di `cacheTtlDays` e `cacheSizeMb`.
- [server.py](server.py) aggiunge endpoint `GET/POST /cache-config` per leggere/aggiornare TTL e limite dimensionale cache in runtime.

### Changed
- [server.py](server.py) estende `TileCache` con configurazione dinamica (`set_config`, `get_config`) e applica eviction `oldest-first` quando `SUM(LENGTH(data))` supera `max_size_mb`.
- [server.py](server.py) estende `--tile-cache-max-mb` (e `PLANIMETER_TILE_CACHE_MAX_MB`) e include TTL/limite nei log di avvio.
- [src/planimeter.js](src/planimeter.js) sincronizza i campi cache con `/cache-stats` e mostra feedback utente in toolbar su update config riuscito/fallito.

## [2026-05-06] — Cache WMS generalizzata + logging strutturato proxy

### Added
- [server.py](server.py) estende la cache SQLite su **tutti** i layer WMS `GetMap` (non solo `CP.CadastralParcel`); ogni richiesta tile viene cached a prescindere dal layer richiesto.
- [server.py](server.py) introduce logging strutturato via modulo `logging`: ogni risposta upstream registra livello (`INFO`/`WARNING`/`ERROR`), endpoint (`wms-proxy`/`wms-tile`), layers, bbox troncata, durata in ms e dimensione risposta in byte.

### Changed
- [server.py](server.py) `handle_wms_tile` aggiornato: rimosse la variabile `layers` e il filtro `layers == "CP.CadastralParcel"` dalla condizione `use_cache`; docstring aggiornata.
- [server.py](server.py) `handle_wms_proxy` aggiornato: aggiunto timing `started_at`/`elapsed_ms` e chiamate `_log.info/warning/error` coerenti con il pattern di `handle_wms_tile`.


## [2026-05-05] — Tool icons e tooltip hover (step 1)

### Added
- [planimeter.html](planimeter.html) aggiunge icone standard ai pulsanti di `Strumenti` e `Azioni` (incluso clear cache) tramite classe condivisa `icon-button`.
- [planimeter.html](planimeter.html) aggiunge tooltip hover localizzati con attributo `data-i18n-title` su tutti i pulsanti tool/action.
- [src/i18n/it.js](src/i18n/it.js) e [src/i18n/en.js](src/i18n/en.js) introducono nuove chiavi `hint.tool.*` e `hint.action.*`.

### Changed
- [styles.css](styles.css) estende lo stile pulsanti con allineamento icona+testo consistente, mantenendo compatibilità con stato attivo e varianti danger.

### Notes
- Gli hint vengono aggiornati automaticamente al cambio lingua grazie al supporto già presente per `data-i18n-title` in [src/i18n/i18n.js](src/i18n/i18n.js).

## [2026-05-05] — Settings tab e interrogazione particelle catastali

### Added
- [planimeter.html](planimeter.html) introduce una toolbar a tab con viste separate `Operativo` e `Settings`.
- [planimeter.html](planimeter.html) aggiunge un pannello `Info catastali` che mostra `Label`, `NationalCadastralReference`, `localId` e `namespace` della particella interrogata.
- [src/io/preferences.js](src/io/preferences.js) salva in `localStorage` lingua, unità, tab attiva, opacità overlay e toggle query particella.

### Changed
- [src/planimeter.js](src/planimeter.js) inizializza il runtime a partire dalle preferenze persistite e sincronizza header rapido + pannello `Settings`.
- [src/planimeter.js](src/planimeter.js) invia richieste `GetFeatureInfo` via proxy WMS quando il catasto ufficiale è attivo e l'utente clicca la mappa in modalità `Modifica` o `Elimina`.
- [styles.css](styles.css) aggiunge layout/stili per tab toolbar, controlli `Settings` e card delle info catastali.
- [src/i18n/it.js](src/i18n/it.js) e [src/i18n/en.js](src/i18n/en.js) estendono il catalogo con chiavi per `Settings` e interrogazione particelle.

### Notes
- Le query particella sono volutamente limitate al catasto ufficiale e ai workflow non di disegno, per evitare conflitti con il click usato da draw/measure.

## [2026-05-05] — Fix health check proxy e layout strumenti

### Fixed
- [app.js](app.js) esegue monitoraggio `Proxy WMS` solo quando il layer `Catasto` ufficiale e attivo, evitando richieste inutili e rumore in console quando non serve.
- [app.js](app.js) usa URL assoluto basato su `window.location.origin` per `proxy-health`.
- [server.py](server.py) accetta anche gli endpoint con slash finale (`/proxy-health/`, `/wms-proxy/`) per maggiore robustezza.
- [styles.css](styles.css) riordina la riga `Strumenti` con wrapping responsive dei pulsanti su larghezze ridotte.

### Validation
- Verificato runtime locale: `GET /proxy-health` -> HTTP 200.
- Verificato runtime locale: `GET /proxy-health/` -> HTTP 200.
- Verificato runtime locale: `GET /planimeter.html` -> HTTP 200.

## [2026-05-05] — Pulizia struttura repository

### Removed
- Eliminato [wms-test.png](wms-test.png), file immagine di test non usato dall'applicazione.

### Changed
- Aggiornato [.gitignore](.gitignore) con regola esplicita `wms-test.png` per evitare reintroduzioni accidentali.
- Aggiornato [TODO_LIST.md](TODO_LIST.md) per tracciare il completamento della pulizia.

## [2026-05-05] — Allineamento documentazione operativa

### Added
- [README.md](README.md) include ora una sezione `Runbook essenziale` con start, stop e troubleshooting rapido.
- [README.md](README.md) include ora sezione `Known Issues` esplicita.
- [README.md](README.md) include ora sezione `FAQ` (CORS/proxy, differenza ufficiale/sostitutivo, scelta formati GIS).

### Changed
- [README.md](README.md) aggiorna la sezione `Possibili evoluzioni` con soli punti realmente futuri.
- [TODO_LIST.md](TODO_LIST.md) marca come completati i task documentali appena implementati.

## [2026-05-05] — Perimetro poligoni e duplicazione area

### Added
- [app.js](app.js) calcola ora il perimetro delle aree (`Polygon`/`MultiPolygon`) e lo mostra in label insieme all'area.
- [planimeter.html](planimeter.html) include il nuovo comando `Duplica area` per la feature poligonale selezionata.
- [planimeter.html](planimeter.html) include nuovo campo riepilogo `Perimetro` con totale live.

### Changed
- [app.js](app.js) aggiorna il riepilogo selezione: per le aree mostra sia area sia perimetro.
- [README.md](README.md) aggiornata con nuovo flusso operativo e nuove capacita su perimetro/duplicazione.

## [2026-05-05] — Attribuzioni per pubblicazione GitHub

### Added
- Sezione "Riferimenti e attribuzioni" aggiunta in [README.md](README.md), con fonti, standard, servizi cartografici usati e note di conformita per pubblicazione su GitHub.
- Inclusa dichiarazione esplicita di non affiliazione ai provider esterni (OSM, Esri, Agenzia delle Entrate).

## [2026-05-05] — Tool misuratore distanze

### Added
- Nuove modalita strumenti in [planimeter.html](planimeter.html): `Retta` e `Polyline`.
- Nuove interazioni draw in [app.js](app.js) per misurare distanze lineari (2 punti) e percorsi multi-vertice.
- Label metrica su feature lineari con formattazione automatica metri/chilometri.

### Changed
- [app.js](app.js) include ora anche `LineString`/`MultiLineString` tra geometrie supportate per import, restore e styling.
- Riepilogo in [app.js](app.js): conteggio e totale area restano focalizzati sulle aree; campo selezione mostra area o distanza in base alla feature selezionata.
- Menu contestuale aggiornato a "Annulla tracciamento" per coprire disegno aree e misure.

## [2026-05-05] — Interoperabilita GIS leggera

### Added
- Selettore formato export in [planimeter.html](planimeter.html) con supporto `GeoJSON` e `KML`.
- Import automatico in [app.js](app.js) da file `GeoJSON` o `KML` con rilevamento del formato da estensione o contenuto.

### Changed
- `GeoJSON` resta formato predefinito di export per compatibilita web/GIS leggera.
- [README.md](README.md) documenta ora in modo esplicito i formati GIS supportati e quelli esclusi per mantenere il progetto leggero.

## [2026-05-05] — Proxy health check UI

### Added
- Endpoint locale `/proxy-health` in [server.py](server.py) che esegue probe `GetCapabilities` verso WMS upstream e restituisce JSON con stato, durata e messaggio.
- Nuovo indicatore `Proxy WMS` nella toolbar di [planimeter.html](planimeter.html) con stati `OK`, `KO`, `Verifica...`.
- Messaggio dettagliato in toolbar con ultimo esito leggibile del proxy health check.
- Polling periodico lato client in [app.js](app.js) ogni 45 secondi per aggiornare stato proxy.

### Changed
- Quando layer catastale ufficiale viene selezionato o riattivato, [app.js](app.js) forza un nuovo health check del proxy.
- Gli errori di caricamento del layer ufficiale aggiornano anche lo stato `Proxy WMS` in UI.
- [server.py](server.py) ora supporta retry breve su errori transitori upstream e opzioni `--upstream-timeout` / `--upstream-retries`.
- [app.js](app.js) salva ora automaticamente le feature in `localStorage` e le ripristina al caricamento con schema versionato.
- [app.js](app.js) accetta ora feature `MultiPolygon` in import e restore, con label posizionata sul poligono piu esteso.

### Fixed
- Allineato [TODO_LIST.md](TODO_LIST.md): task health check proxy marcato completato.
- Corretto avanzamento di `nextFeatureId` su feature gia numerate importate o ripristinate.

## [2026-05-05] — Context menu e allineamento TODO

### Added
- Menu contestuale mappa (`#map-context-menu`):
  - Appare con tasto destro del mouse durante una sessione di disegno attiva (tra `drawstart` e `drawend`).
  - Voce "Annulla disegno" chiama `Draw.abortDrawing()` via API pubblica OL 8.
  - Struttura `<nav>` + `<ul>` riusabile: aggiungere nuovi item richiede solo un `<li>` in HTML e un listener.
  - Auto-chiusura su click esterno, `Escape`, o selezione voce.
  - Clamping automatico bordo destra/basso per non uscire dal viewport.
  - Evento `drawabort` gestito in `app.js` per ripristinare `state.isDrawing` e aggiornare toolbar.
- Nuova proprietà stato `isDrawing` in `Planimeter.state` (toggle su `drawstart`/`drawend`/`drawabort`).
- Classe CSS `.context-menu-separator` (disponibile per divisori futuri tra voci menu).

### Fixed
- Allineato [TODO_LIST.md](TODO_LIST.md): task `start-planimeter.bat` marcato `[x]` (file presente da release precedente).

### Changed
- Messaggio `drawstart` toolbar aggiornato: include hint tasto destro per annullare.

## [2026-05-05]

### Added
- Separazione della web app in asset distinti:
- [planimeter.html](planimeter.html) come shell semantica.
- [styles.css](styles.css) per layout/stile responsive della floating toolbar.
- [app.js](app.js) per logica applicativa OpenLayers.
- Nuova toolbar overlay con sezioni Layer, Strumenti, Azioni, Riepilogo e Istruzioni.
- Modalita operative `Disegna`, `Modifica`, `Elimina`.
- Export/Import GeoJSON (feature `Polygon` e `MultiPolygon`).
- Riepilogo live di numero aree, area totale, area selezionata e zoom.
- Geolocalizzazione con feedback stato in toolbar.
- Snapping magnetico su vertici e bordi in modalita Disegna+Modifica.
- Override temporaneo snapping con tasto Ctrl.
- Delay di 1 secondo dopo `drawend` per evitare apertura involontaria di nuova area.
- Scelta manuale sorgente catasto:
- `Ufficiale Agenzia Entrate`.
- `Sostitutivo confini amministrativi`.
- Nuovo server locale con proxy WMS:
- [server.py](server.py) espone `/wms-proxy` per bypass CORS browser verso WMS ufficiale.

### Changed
- Migliorati i metadati SEO/social nella head della pagina HTML.
- Aggiornato layer catasto ufficiale in [app.js](app.js) per usare il proxy locale `/wms-proxy`.
- Aggiornata comunicazione stato in toolbar per casi di errore/indisponibilita layer ufficiale.
- Aggiornato [README.md](README.md) con nuovo flusso d'uso via server locale e nuove funzionalita.

### Fixed
- Risolto blocco CORS lato browser per il layer ufficiale Agenzia Entrate usando proxy locale.
- Ridotto il rischio di creazione accidentale di poligoni subito dopo doppio click di chiusura.
- Migliorata precisione del disegno vicino a poligoni esistenti grazie allo snapping.

### Validation
- Diagnostica editor senza errori su:
- [planimeter.html](planimeter.html)
- [styles.css](styles.css)
- [app.js](app.js)
- [server.py](server.py)
- [README.md](README.md)
- Verifica runtime proxy: richiesta `GetMap` tramite `/wms-proxy` ricevuta con HTTP 200.

### Notes
- Eseguire sempre la web app via `http://127.0.0.1:8000/...` (non da `file://`) per usare il proxy.
- Il layer `Sostitutivo` e di supporto visuale, non sostituisce il dato catastale ufficiale.
