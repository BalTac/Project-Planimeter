# HANDOFF

Checklist operativa rapida per riprendere il progetto Project Planimeter su una nuova stazione di lavoro.

## 1) Setup Minimo

1. Verifica Python installato (`python --version`).
2. Apri la cartella progetto.
3. Avvia rapido (Windows):

```powershell
./start-planimeter.bat
```

Oppure avvio manuale server locale:

```powershell
python server.py
```

4. Apri il browser su:

```text
http://127.0.0.1:8000/planimeter.html
```

## 2) Verifica Funzionale Rapida (2 minuti)

1. Attiva layer `Catasto` con sorgente `Ufficiale Agenzia Entrate`.
2. Disegna un poligono e chiudilo con doppio clic.
3. Verifica che un click immediato non avvii subito un nuovo poligono (delay 1 secondo).
4. Disegna vicino a un bordo esistente e verifica snapping magnetico.
5. Tieni premuto `Ctrl` e verifica snapping disattivato temporaneamente.
6. Esegui export GeoJSON e import dello stesso file.

## 3) Troubleshooting Essenziale

### Layer catasto ufficiale non visibile

1. Controlla di aver avviato la pagina da `http://127.0.0.1:8000/...` e non da `file://`.
2. Verifica che `server.py` sia in esecuzione.
3. In caso di errore upstream temporaneo, usa `Sostitutivo` dalla toolbar.

### Errori CORS in console

1. Conferma che il layer ufficiale usi il proxy locale `/wms-proxy`.
2. Riavvia `server.py`.

### Il server non parte

1. Cambia porta:

```powershell
python server.py --port 8010
```

2. Apri l'URL sulla nuova porta.

## 4) File Chiave

- Shell app: [planimeter.html](planimeter.html)
- Logica mappa: [app.js](app.js)
- Stili UI: [styles.css](styles.css)
- Proxy locale WMS: [server.py](server.py)
- Documentazione principale: [README.md](README.md)
- Storico modifiche: [CHANGELOG.md](CHANGELOG.md)
- Prossime attività: [TODO_LIST.md](TODO_LIST.md)

## 5) Procedura di Chiusura

1. Interrompi server con `Ctrl+C` nel terminale.
2. Salva eventuali nuove attività in [TODO_LIST.md](TODO_LIST.md).
3. Registra modifiche concluse in [CHANGELOG.md](CHANGELOG.md).
