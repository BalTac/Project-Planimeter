# PORTABILITY_ROADMAP

> **What this file is.** A hand-off checklist written on the `user` machine
> (`C:\Users\user\OneDrive\myPython\Planimeter`) to be executed on the **original** machine
> (`C:\Users\balta\OneDrive\myPython\Planimeter`), where the graphify graph and the virtual
> environments were created. It tells you exactly what to write/run there so this repository
> becomes relocatable between machines, users and OneDrive roots.
>
> Language: English, per `.github/copilot-instructions.md` (internal docs are English-only).
>
> Scope of the audit: `README.md`, `CHANGELOG.md`, `TODO_LIST.md`, `.github/`, `raw/`,
> `graphify-out/**`, `requirements.txt`, `.gitignore`, launcher scripts, `graph.json`.

---

## 0. TL;DR (IT)

Sul PC originale fai **tre cose**, in quest'ordine:

1. **Elimina le due virtualenv dal repo** (`.venv_pc/`, `.venv_notebook/`): contengono path assoluti
   (`C:\Users\balta\...`, `D:\AITools\...`) e non sono spostabili. Vanno ricreate per macchina da un
   `requirements` *pinnato*.
2. **Rigenera il grafo da zero** con `/graphify .` eseguito dalla root del repo (non con
   `--update`): 12 nodi hanno come `id` un path assoluto `C:/Users/balta/...` e `--update` non li
   tocca perché quei file non sono cambiati.
3. **Applica i fix di `.gitignore`** per non far trapelare venv e file di stato con nome macchina.

Poi verifica con lo script in §5: deve stampare `absolute node ids: 0` e `leaked paths: 0`.
Il prompt pronto da incollare a un agente è in §6.

---

## 1. Evidence — why this workspace is not portable today

### 1.1 Virtual environments (worst offender)

| Artefatto | Valore osservato | Perché blocca la portabilità |
|---|---|---|
| `.venv_notebook/pyvenv.cfg` | `home = C:\Users\balta\AppData\Local\Programs\Python\Python311`<br>`executable = D:\AITools\unsloth_studio_custom\venv\Scripts\python.exe` | Punta a un altro utente **e a un'altra unità**. Creato *da una venv* (`unsloth_studio_custom\venv`) invece che da un interprete di sistema. |
| `.venv_pc/pyvenv.cfg` | `version = 3.14.3`<br>`command = ...pythoncore-3.14-64\python.exe -m venv ...\Planimeter\.venv` | La cartella si chiama `.venv_pc` ma la venv è stata creata come `.venv`: **è stata rinominata**. |
| `.venv_pc/Scripts/activate*` | `VIRTUAL_ENV=c:\Users\user\OneDrive\myPython\Planimeter\.venv` | Path hardcoded che **non esiste più** → `activate` rotto ovunque, anche sulla stessa macchina. |
| `.venv_pc/Include/site/` | contiene **sia** `python3.11/` **sia** `python3.14/` | Residui di due interpreti diversi nella stessa venv → ambiente sporco, non riproducibile. |
| `.venv_notebook/` | manca il `.gitignore` interno (`*`) che `venv` crea sempre | Per questo trapela in `git status` come `?? .venv_notebook/` mentre `.venv_pc/` è auto-ignorata. |
| entrambe | 80 MB + 57 MB = **137 MB** dentro OneDrive | Sync inutile di migliaia di file binari. |
| `requirements.txt` | solo lower bound (`Pillow>=10.0.0`, `numpy>=1.26.0`, …) | Nessuna build è riproducibile: due macchine ottengono versioni diverse. |

Due interpreti diversi nella stessa repo (3.11.9 e 3.14.3) mentre `README.md` dichiara "Python 3.10+".
Su Python 3.14 i wheel di `opencv-python` / `playwright` sono ancora instabili: la venv `.venv_pc`
non è affidabile.

### 1.2 graphify artefacts

| Artefatto | Valore osservato | Impatto |
|---|---|---|
| `graphify-out/graph.json` → 12 `node.id` | `C:/Users/balta/OneDrive/myPython/Planimeter/{planimeter.html, server.py, src/main.js, src/geometry/calculations.js, src/geometry/intersection.js, src/i18n/i18n.js, src/io/belfiore.js, src/io/history.js, tests/conftest.py, tests/test_e2e_p0.py, tests/test_e2e_m3_intersections_case.py, tests/test_e2e_summary_context_menu.py}` | Nodi non riusabili/merge-abili su un'altra macchina: lo stesso file produce due nodi diversi. |
| `graphify-out/graph.html` | 2 occorrenze di `balta` | Path assoluto nella visualizzazione. |
| `graphify-out/wiki/Community_*.md` | ≥10 articoli contengono path assoluti | La wiki esportata leak-a il layout della macchina sorgente. |
| `graphify-out/.graphify_python` | `C:\Users\balta\AppData\Roaming\uv\tools\graphifyy\Scripts\python.exe` (**inesistente qui**) | Ogni runbook che fa `$(cat graphify-out/.graphify_python)` fallisce. |
| `graphify-out/.graphify_root` | `C:\Users\user\OneDrive\myPython\Planimeter` | Root di scan appartenente all'*altra* macchina rispetto a `.graphify_python`. |
| `graphify-out/manifest.json` | 5 entry sotto `.venv_notebook/` e `.venv_pc/` | La scansione graphify è **entrata nelle venv**. |
| `graphify-out/.graphify_chunk_01.json`, `_02.json` | residui del 22 mag | File temporanei mai ripuliti. |
| `wiki/index.md` vs `GRAPH_REPORT.md` vs `graph.json` | 1523 / 1782 / 1787 nodi | Tre snapshot contraddittori nella stessa cartella. |
| `graph.json` → `built_at_commit` | `e086bf65` ≠ HEAD `c07e972` | Grafo stale di 1 commit (feature `agriculture` assente). |

### 1.3 Machine-specific state files leaking

| File | Stato | Nota |
|---|---|---|
| `.planimeter_request_quota-LAPTOP-G78O6FI2.json` | `?? ` (untracked, NON ignorato) | Il nome include l'hostname. `.gitignore` copre solo `.planimeter_request_quota.json` esatto. |
| `.venv_notebook/` | `?? ` (untracked, NON ignorato) | `.gitignore` ha `.venv/` che **non** matcha `.venv_pc/` né `.venv_notebook/`. |

### 1.4 Cosa è già portabile (nessun intervento)

- Nessun path assoluto in nessun file **tracciato** da git (verificato su tutti i 65 file con `git ls-files`).
- `start-planimeter.bat` usa `cd /d "%~dp0"` e `start_planimeter.sh` usa `BASH_SOURCE`/`SCRIPT_DIR`: entrambi corretti e relativi.
- `tests/conftest.py` deriva `ROOT` da `Path(__file__).parent.parent`: corretto.
- L'app usa URL relativi (`/wms-proxy`, `styles.css`, `src/main.js`): corretta.
- `graphify-out/`, `raw/`, `tests/output/`, `*.db`, `_tile_cache/` sono già in `.gitignore`.

---

## 2. Request A — make the Python side reproducible

### A1. Remove the virtual environments from the repository (on the original PC)

```powershell
cd C:\Users\balta\OneDrive\myPython\Planimeter
# Keep them out of OneDrive/git entirely — recreate per machine instead:
Remove-Item -Recurse -Force .venv_pc, .venv_notebook
```

Rationale: `venv` has **no relocatable mode**. `pyvenv.cfg`, `Scripts/activate*`,
`Scripts/*.exe` and `.pth`/`.egg-link` files embed absolute paths. Copying or syncing a venv
between users/drives/OneDrive roots can never be made to work; the only correct cross-machine
mechanism is *recreate from a pinned dependency list*.

> If you want to keep a venv outside the repo, the recommended location is
> `%LOCALAPPDATA%\planimeter\venv` — outside OneDrive and outside the working tree.

### A2. Produce a pinned, split dependency set

```powershell
# from the repo, using a *system* Python 3.12 (see A3)
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
# freeze the exact resolved set:
.\.venv\Scripts\python.exe -m pip freeze > requirements.lock.txt
```

Then restructure so the files mean what they say:

- `requirements.txt` — **runtime only**, pinned (`==`):
  `Pillow==11.x`, `opencv-python==4.10.x`, `numpy==2.x`
- `requirements-dev.txt` — test/QA only, pinned:
  `-r requirements.txt`, `pytest==8.x`, `playwright==1.50.x`, `pytest-playwright==0.5.x`
- `requirements.lock.txt` — full `pip freeze` output for byte-identical rebuilds.

Right now `pytest`, `playwright`, `pytest-playwright` sit in the runtime file: a user who only
wants to *run* the app drags in ~130 MB of browser automation.

### A3. Declare exactly one supported Python version

Add a `.python-version` file (one line, e.g. `3.12.5`) and align `README.md` ("Python 3.10+" →
the chosen version). Recommendation: **3.12.x**, because `opencv-python`, `numpy`, `playwright`
and `Pillow` all publish stable wheels there; 3.14 (used by `.venv_pc`) does not.

### A4. Add a per-machine bootstrap script

`scripts/bootstrap.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path .venv)) { python -m venv .venv }
& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
& .\.venv\Scripts\python.exe -m playwright install chromium
Write-Host "Ready. Start with: .\.venv\Scripts\python.exe server.py"
```

`scripts/bootstrap.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

[ -d .venv ] || python3 -m venv .venv
./.venv/bin/python -m pip install --upgrade pip
./.venv/bin/python -m pip install -r requirements-dev.txt
./.venv/bin/python -m playwright install chromium
echo "Ready. Start with: ./.venv/bin/python server.py"
```

### A5. Make the launchers prefer `.venv` when present

`start-planimeter.bat`: replace the bare `python` lookup with a check for
`%~dp0.venv\Scripts\python.exe` and use it if it exists, falling back to `python` on PATH.
`start_planimeter.sh`: same with `$SCRIPT_DIR/.venv/bin/python`.

Without this, the launchers silently pick whatever `python` is on PATH — which is how a
3.14 environment ended up being used for a 3.11 project.

### A6. Fix `.gitignore`

Current file has `.venv/`, `.planimeter_history_store.json`, `.planimeter_request_quota.json`,
`.planimeter_state_store.json` (exact names). Replace those four lines with:

```gitignore
.venv*/
.planimeter_history_store*.json
.planimeter_request_quota*.json
.planimeter_state_store*.json
```

This covers `.venv_pc/`, `.venv_notebook/`, any future `.venv-*/`, and the hostname-suffixed
`.planimeter_request_quota-LAPTOP-G78O6FI2.json` that currently leaks.
(The per-venv `.gitignore` created by stdlib `venv` is not something to rely on: `.venv_notebook/`
lacks it, which is exactly why it shows up in `git status`.)

---

## 3. Request B — make the graphify graph relocatable

### B1. Rebuild the graph **from scratch**, from the repository root

A plain `/graphify . --update` is **not enough**. Incremental update only re-extracts *changed*
files, and the 12 stale absolute ids belong to files such as `src/main.js`, `planimeter.html` and
`tests/conftest.py` that have not changed — so `--update` would leave them exactly as they are.
The stale ids were produced by a *semantic* extraction pass that received an absolute
`source_file`. Only a full rebuild with `root` relativized to `.` rewrites them.

```
cd C:\Users\balta\OneDrive\myPython\Planimeter
```
then, in the agent session on that machine:

```
/graphify .
```

Key rules to keep it portable afterwards:

1. **Always invoke graphify with a relative path from the repo root** (`.`), never with
   `C:\Users\...\Planimeter`. That is the single root cause of the absolute node ids.
2. Immediately after the build, re-stamp the interpreter path for that machine:
   ```powershell
   python -c "import sys; open('graphify-out/.graphify_python','w',encoding='utf-8').write(sys.executable)"
   ```
   (`.graphify_python` is deliberately machine-local and must never be shared between machines.)
3. Delete the leftovers:
   ```powershell
   Remove-Item graphify-out\.graphify_chunk_*.json -ErrorAction SilentlyContinue
   ```
4. Keep `graphify-out/` untracked (already in `.gitignore`) — it is a derived artefact, not a source.

### B2. Keep the scans out of the virtual environments

`graphify-out/manifest.json` currently contains 5 entries under `.venv_notebook/` and `.venv_pc/`,
i.e. the scanner walked into the venvs. Once A1 removes them this stops on its own, but the
invariant to preserve is: **no path under `.venv*` may ever appear in `manifest.json` or
`graph.json`.** Check with §5.

### B3. Decide one snapshot, delete the stale ones

`wiki/index.md` (1523 nodes), `GRAPH_REPORT.md` (1782) and `graph.json` (1787) disagree.
After the rebuild they must agree. If the wiki export is not regenerated, delete `graphify-out/wiki/`
rather than leaving a stale, differently-numbered copy that readers will trust.

### B4. Do not treat the graph as a source of truth for paths

`graphify-out/graph.html` and `graphify-out/wiki/Community_*.md` embed the source machine's
absolute paths. If those artefacts are ever shared (screenshot, PR, chat), the leak goes with them.
Regenerating after B1 fixes the current files; the rule is what prevents it from coming back.

---

## 4. Request C — decide the fate of `raw/` and `wiki/`

`raw/` and `wiki/` are in `.gitignore`, so they exist only on machines where they were created.
Consequence observed from this side:

- `TODO_LIST.md` L6 states the rule «Mantenere la wiki solo locale (cartelle `wiki/` e `raw/`)» —
  but `wiki/` **does not exist** on this machine at all.
- `CHANGELOG.md` links to 5 wiki pages that exist nowhere (`wiki/index.md`, `wiki/log.md`,
  `wiki/project-objectives.md`, `wiki/wms-export.md`, `wiki/wms-proxy-interpretation-layer.md`).
- `raw/` **was** copied here (5 `.md` + 1 `.pdf`) and is fully ingested in the graph, while `wiki/`
  was not.

Pick one and write it down in `TODO_LIST.md`:

- **(a) Keep them local-only** → then remove/neutralise the now-dead `wiki/...` links in
  `CHANGELOG.md` and `TODO_LIST.md` (7 references), because a link that can never resolve is worse
  than no link.
- **(b) Make them shared knowledge** → remove `raw/` and `wiki/` from `.gitignore` and commit them,
  so every machine has the same corpus and the links resolve. Note the `raw/` corpus includes a
  ~PDF and the graph already depends on it.

Either way, the 7 broken `wiki/...` links must be fixed. My recommendation: **(b) for `raw/`**
(it is already the graph's evidence base), **(a) for `wiki/`** until the export is regenerated and
stable.

---

## 5. Verification script (run on either machine)

Save as `scripts/check_portability.py`. It must print `absolute ids: 0` and `leaked: 0`.

```python
"""Assert that no machine-specific absolute path survives in tracked files or graphify-out."""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ABS_ID = re.compile(r"^(?:[A-Za-z]:[\\/]|/)")
# Any drive-rooted user path, or a POSIX home path, inside text artefacts.
ABS_TEXT = re.compile(r"(?:[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/])|(?:/(?:Users|home)/[A-Za-z0-9._-]+/)")

fail = False


def report(label: str, items: list[str]) -> None:
    global fail
    status = "OK" if not items else "FAIL"
    if items:
        fail = True
    print(f"[{status}] {label}: {len(items)}")
    for item in items[:20]:
        print(f"       {item}")


# 1. Tracked files must not embed absolute paths.
tracked = subprocess.run(
    ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
).stdout.split()
tracked_hits = []
for rel in tracked:
    path = ROOT / rel
    try:
        text = path.read_text(encoding="utf-8", errors="strict")
    except (UnicodeDecodeError, OSError):
        continue
    if ABS_TEXT.search(text):
        tracked_hits.append(rel)
report("tracked files containing absolute paths", tracked_hits)

# 2. graphify-out must not contain machine-specific absolute paths.
out = ROOT / "graphify-out"
leaks = []
if out.exists():
    for path in out.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in {".json", ".md", ".html", ".txt"}:
            continue
        if ABS_TEXT.search(path.read_text(encoding="utf-8", errors="replace")):
            leaks.append(str(path.relative_to(ROOT)))
report("graphify-out files containing absolute paths", leaks)

# 3. graph.json node ids must be relative keys.
graph_path = out / "graph.json"
if graph_path.exists():
    graph = json.loads(graph_path.read_text(encoding="utf-8"))
    bad = [n["id"] for n in graph.get("nodes", []) if ABS_ID.match(str(n.get("id", "")))]
    report("graph.json nodes with absolute ids", bad)

    # 4. No virtual environment may be part of the corpus.
    venv = sorted({n.get("source_file", "") for n in graph.get("nodes", []) if ".venv" in str(n.get("source_file", ""))})
    report("graph.json nodes sourced from .venv*", venv)

    # 4b. The incremental manifest must not list anything under a virtualenv either.
    manifest_path = out / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        report("manifest.json entries under .venv*", sorted(k for k in manifest if ".venv" in k))

    # 5. Snapshot agreement between graph.json and GRAPH_REPORT.md.
    report_md = out / "GRAPH_REPORT.md"
    if report_md.exists():
        head = report_md.read_text(encoding="utf-8")[:2000]
        match = re.search(r"(\d+)\s+nodes?\s*[·\-]\s*(\d+)\s+edges?", head)
        if match:
            nodes, edges = int(match.group(1)), int(match.group(2))
            actual_nodes, actual_edges = len(graph["nodes"]), len(graph["links"])
            if (nodes, edges) != (actual_nodes, actual_edges):
                report("GRAPH_REPORT.md vs graph.json count mismatch",
                       [f"report={nodes}/{edges} json={actual_nodes}/{actual_edges}"])

# 6. No virtual environment may live inside the working tree.
report("virtualenvs inside the repository", sorted(p.name for p in ROOT.glob(".venv*") if p.is_dir()))

print("\nFAIL: portability problems remain." if fail else "\nPASS: workspace is portable.")
sys.exit(1 if fail else 0)
```

---

## 6. Ready-to-paste prompt for the agent on the original PC

```
Read PORTABILITY_ROADMAP.md in this repository and execute Request A and Request B.

Context: this repo must become relocatable between two Windows machines with different
usernames (balta / user) syncing the same OneDrive folder. Today it is not: the virtual
environments embed absolute paths, the graphify graph has 12 node ids that are absolute
C:/Users/balta paths, and .gitignore leaks .venv* and hostname-suffixed state files.

Do, in this order:
1. Delete .venv_pc/ and .venv_notebook/ from the working tree (they are not relocatable; the
   project will recreate .venv per machine).
2. Split requirements.txt into requirements.txt (runtime, pinned with ==) and
   requirements-dev.txt (test/QA, pinned), and generate requirements.lock.txt via pip freeze.
   Keep the current dependency set exactly — do not upgrade anything.
3. Add .python-version pinning the single supported interpreter (3.12.x) and align README.md.
4. Add scripts/bootstrap.ps1 and scripts/bootstrap.sh per section A4.
5. Make start-planimeter.bat and start_planimeter.sh prefer ./.venv when it exists (section A5).
6. Fix .gitignore per section A6.
7. Rebuild the graph from scratch with /graphify . invoked from the repository root — NOT
   --update, because the stale absolute ids belong to unchanged files. Then re-stamp
   graphify-out/.graphify_python with this machine's interpreter, remove
   graphify-out/.graphify_chunk_*.json, and regenerate or delete graphify-out/wiki/ so that
   wiki/index.md, GRAPH_REPORT.md and graph.json all report the same node/edge counts.
8. Run scripts/check_portability.py until it prints PASS.

Report, for each item: the exact command run, the observed before/after, and anything you
could not do. Do not modify application code (server.py, src/**, planimeter.html) — this task
is packaging and portability only. Do not commit or push anything.
```

---

## 7. Acceptance checklist

Verify from **either** machine after the work above:

| # | Check | Expected |
|---|---|---|
| 1 | `scripts/check_portability.py` | `PASS`, exit 0 |
| 2 | `git status --porcelain` | no `.venv*`, no `.planimeter_*` entries |
| 3 | `ls -d .venv*` | only the git-ignored `.venv` created by `scripts/bootstrap.*`; no `.venv_pc/`/`.venv_notebook/` leftovers |
| 4 | `python -m pip install -r requirements-dev.txt` on a clean machine | succeeds without changing the resolved versions vs `requirements.lock.txt` |
| 5 | `graph.json` → distinct `node.id` starting with a drive letter | `0` |
| 6 | `graph.json` vs `GRAPH_REPORT.md` vs `wiki/index.md` node/edge counts | identical |
| 7 | `graphify-out/manifest.json` entries under `.venv*` | `0` (currently 5) |
| 8 | `start-planimeter.bat` after bootstrap | starts via `.venv\Scripts\python.exe`, not PATH `python` |
| 9 | `grep -rn "wiki/" CHANGELOG.md TODO_LIST.md` | links either resolve or are removed (§4) |

---

## 8. Deliberately out of scope for this hand-off

These were found during the same audit but are **not** portability issues; keep them separate so
they do not block the above. Full detail in `AUDIT_docs_graph_links.md`.

- README `## Architettura` omits `src/dsl/`, `domains/`, `scripts/`; README `## API backend`
  omits 4 live routes (`/request-quota-status`, `/local-history-load`, `/local-history-save`,
  `/agriculture-cultivars`).
- The English-only internal-docs convention is violated by `README.md` (78% Italian),
  `CHANGELOG.md` (70%), `TODO_LIST.md` (66%) and by `server.py`'s 10 CLI help strings.
- `styles.css` and `start-planimeter.bat` are tracked but absent from the graph;
  `app.js` is still tracked even though `CHANGELOG.md` states it was added to `.gitignore`.
- The graph is stale by one commit (`agriculture` feature, +1170 lines) — the `/graphify .`
  rebuild in §B1 resolves this as a side effect.
