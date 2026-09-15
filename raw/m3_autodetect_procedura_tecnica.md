# Procedura Autodetect M3 - Impostazione Tecnica Completa

## 1. Scopo

Questo documento descrive in modo esaustivo come e stata impostata la procedura di autodetect M3 delle particelle catastali nel progetto Planimeter.

Obiettivo operativo:
- rilevare automaticamente il contorno particella da raster WMS
- creare una feature editabile nel layer Pertinenze
- mantenere separazione tra geometrie utente e geometrie M3
- arricchire la feature con metadati catastali robusti
- dare feedback utente chiaro durante elaborazione

## 2. Principi architetturali adottati

1. Separazione layer:
- Layer aree utente: `vectorSource`
- Layer pertinenze M3: `pertenenzaSource`

2. Non bloccare UX:
- detect progressivo con preview e conferma utente per ogni espansione
- spinner flottante durante detect M3 e caricamento tile

3. Robustezza metadata:
- lookup parcel proxy-first
- fallback endpoint semantico
- risincronizzazione manuale da menu contestuale

4. Compatibilita evolutiva:
- mantenimento percorsi esistenti
- fallback quando upstream WMS risponde con errori transitori o ServiceException

## 3. Componenti coinvolti

- Backend: `server.py`
- Orchestrazione frontend: `src/planimeter.js`
- Menu contestuale: `src/ui/context-menu.js`
- Naming/metadata iniziali feature: `src/geometry/decorate.js`
- Etichette e stile pertinenze: `src/geometry/style.js`
- Test smoke M3: `tests/test_smoke_parcel_402_methods.py`

## 4. Backend M3

### 4.1 Endpoint

`POST /parcel-geometry-m3`

Payload input:
- `lat` (float)
- `lon` (float)
- `radius` (int opzionale, clamp 0..5)

Risposta successo:
- `ok: true`
- `ring: [[lon,lat], ...]`
- `debug`
- `durationMs`

Risposta fallimento funzionale:
- `ok: false`
- `message`
- `debug`
- `durationMs`

### 4.2 Pipeline algoritmo (`_m3_detect_parcel_boundary`)

1. Import runtime dipendenze:
- `opencv-python`
- `numpy`
- `Pillow`

2. Costanti base:
- `tile_half = 0.00030`
- `tile_px = 420`

3. Fetch tile WMS:
- layer `CP.CadastralParcel`
- CRS `EPSG:6706`
- formato PNG trasparente

4. Costruzione mosaico:
- griglia `(2*radius + 1)^2`
- centro mosaico sulla coordinata cliccata

5. Pre-processing raster:
- conversione RGBA -> BGR
- mascheramento rosso logo Agenzia

6. Segmentazione:
- Canny (`threshold1=50`, `threshold2=120`)
- flood-fill da centro (con ricerca seed vicina se centro su bordo)

7. Rifinitura:
- dilatazione regione (`3x3`, 2 iterazioni) per includere bordo nero esterno
- estrazione contorno esterno principale
- semplificazione con `approxPolyDP`

8. Conversione geometria:
- pixel -> lon/lat
- chiusura ring se necessario
- check minimo vertici

9. Debug tecnico restituito:
- area regione in px
- numero vertici contorno
- flag `touches_border`
- raggio usato
- numero tile mosaico
- coordinate seed flood-fill

### 4.3 Decisione chiave: raggio esatto lato backend

Il backend lavora in single-shot sul raggio richiesto.

Motivo:
- evitare il bug storico "0..radius" che restituiva spesso lo stesso risultato a step diversi
- demandare al frontend la logica progressiva con conferma utente

## 5. Frontend M3 (`detectParcelM3AtPixel`)

### 5.1 Flusso operativo

1. Pixel -> coordinate mappa -> lon/lat
2. Avvio busy overlay (`m3.wait`)
3. Avvio detect con `currentRadius = 1`
4. Chiamata backend `/parcel-geometry-m3`
5. Se successo:
- creazione `Feature(Polygon)`
- `overlayLayer = 'pertenenze'`
- `decorateFeature(...)`
- tentativo arricchimento metadata parcel
- aggiunta a `pertenenzaSource`
- preview su mappa + messaggio area/vertici/raggio
6. Se `touches_border` e `radius < 5`:
- repaint forzato
- confirm utente per espandere
- se conferma: rimuove preview corrente, incremento raggio, retry
- se annulla: mantiene preview come risultato finale
7. Messaggio finale successo o errore
8. Chiusura busy overlay in `finally`

### 5.2 Perche preview + conferma

Scelta UX per particelle grandi:
- evita crescita automatica "alla cieca"
- utente vede geometria corrente prima di espandere
- mantiene controllo manuale sul compromesso velocita/accuratezza

## 6. Metadati catastali: strategia robusta

### 6.1 Lookup principale

Metodo: `fetchParcelSummaryAtLonLat(lon, lat)`

Ordine attuale:
1. proxy JSON via `wms-proxy&OUTPUT=json` (proxy-first)
2. fallback endpoint semantico `/parcel-at-point`
3. fallback finale di nuovo proxy JSON

Motivo:
- ridurre rumore/instabilita da 502 su `/parcel-at-point`
- riuso canale gia robusto nel flusso `GetFeatureInfo`

### 6.2 Applicazione metadata su feature

Metodo: `applyParcelMetadataToFeature(feature, parcelData)`

Campi scritti:
- `parcelNumber`
- `featureName`
- `parcel_id`
- `inspire_local_id`
- `parcel_local_id`
- `parcel_label`

Derivazione numero particella (`deriveParcelDisplayNumber`):
- priorita: `id` -> `local_id` -> `label` (estrazione numerica finale)

## 7. Risincronizzazione manuale metadata

### 7.1 Accesso UI

Menu contestuale in Navigate su feature `pertenenze`:
- voce: "Risincronizza metadati catastali"

### 7.2 Flusso (`resyncParcelMetadataForFeature`)

1. valida feature poligonale Pertinenze
2. ricava punto label (`getFeatureLabelGeometry`)
3. lookup metadata al punto
4. se presente parcel:
- aggiorna campi feature
- aggiorna/aggiunge link catastale
- incrementa `version`
- aggiorna `modifiedAt`
- persistenza schedulata
- update summary + messaggio conferma
5. se assente: messaggio unavailable

## 8. Busy overlay unificato (M3 + tile map)

### 8.1 Obiettivo

Evitare overlay sempre visibile o incoerente.

### 8.2 Stato interno

- `m3BusyActive`
- `m3BusyMessage`
- `mapTileLoadCount`

### 8.3 Eventi tile

`bindTileLoadingIndicator()` registra su tutte le source tile:
- `tileloadstart`: incrementa contatore
- `tileloadend`/`tileloaderror`: decrementa contatore (clamp >= 0)

### 8.4 Regola visibilita (`updateBusyOverlay`)

Overlay visibile se:
- M3 attivo OR
- `mapTileLoadCount > 0`

Label:
- se M3 attivo: messaggio M3
- altrimenti: `map.loadingTiles`

Nota CSS:
- regola dedicata `[hidden] { display:none !important; }` per evitare residui visuali

## 9. Persistenza e modello dati feature Pertinenze

Campi chiave tipici:
- `overlayLayer = 'pertenenze'`
- `featureId` con prefisso `pert-`
- `parcelNumber` (numero visualizzato)
- campi catastali (`parcel_id`, `parcel_local_id`, `inspire_local_id`, `parcel_label`)
- `links.cadastral[]`
- metadata revisione (`version`, `modifiedAt`)

## 10. Error handling e fallback

1. Coordinate non valide:
- reject con `400` lato backend

2. Dipendenze CV mancanti:
- `missing_dependencies` nel debug

3. Flood fill non valido:
- ragioni specifiche (`center_on_border`, `region_too_small`, ecc.)

4. Upstream WMS exception:
- gestione `BAD_GATEWAY` lato endpoint semantico
- fallback proxy-first lato frontend

5. Resync senza metadata disponibili:
- messaggio esplicito utente

## 11. Verifica operativa

### 11.1 Smoke test backend M3

```bash
cd tests
python test_smoke_parcel_402_methods.py --method3-only --lon 12.562264 --lat 43.013170 --radius 2
```

### 11.2 Test manuale UX

1. Navigate mode + catasto ufficiale attivo
2. Tasto destro -> "Rileva particella (M3)"
3. Verifica:
- overlay busy visibile durante detect
- preview visibile a ogni step
- conferma espansione quando `touches_border=true`
- feature finale nel layer Pertinenze
4. Tasto destro su pertinenza -> "Risincronizza metadati catastali"
5. Verifica update numero particella e localId

## 12. Troubleshooting rapido

### Sintomo: particella mostra numero interno invece del numero catastale
Possibili cause:
- metadata lookup assente/null
- fallback non raggiunge parcel valido

Check:
- response `wms-proxy&OUTPUT=json`
- campi `id/local_id/label` presenti

### Sintomo: resync non cambia nulla
Possibili cause:
- punto label fuori particella utile
- nessun parcel nel lookup

Check:
- messaggio toolbar unavailable
- payload lookup da coord label

### Sintomo: overlay busy resta visibile
Possibili cause:
- vecchia build frontend in cache
- contatore tile non azzerato per source non registrata

Check:
- hard reload pagina
- eventi `tileloadstart/end/error` su layer attivi

## 13. Limiti attuali e next step

- Segmentazione M3 ancora dipendente da qualita raster e scala WMS
- Geometria rilevata non e equivalente a vettore catastale ufficiale certificato
- Da valutare in futuro:
  - heuristics seed piu robuste
  - cache geometrica parcel per coordinate ripetute
  - opzione confronto geometria M3 vs eventuale geometria semantica

---

Documento allineato allo stato corrente del branch main (M3 detect + pertinenze + resync + busy overlay unificato).
