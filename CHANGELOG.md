# CHANGELOG

Tutte le modifiche rilevanti del progetto Project Planimeter.

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