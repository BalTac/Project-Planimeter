# Project Planimeter by BalTac

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

## Possibili evoluzioni

- Separare CSS e JavaScript in file dedicati.
- Aggiungere misura perimetro oltre all'area.
- Aggiungere validazioni topologiche piu avanzate.
- Aggiungere una legenda o uno stato attivo dei layer piu esplicito.

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