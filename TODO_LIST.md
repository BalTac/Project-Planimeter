# TODO LIST

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