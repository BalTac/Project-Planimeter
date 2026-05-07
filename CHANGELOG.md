# CHANGELOG

Tutte le modifiche rilevanti del progetto Project Planimeter.

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