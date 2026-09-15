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

# 6. Virtualenvs are not relocatable, so none may be tracked by git. A venv inside the
# working tree is allowed only as a deliberate local choice, i.e. it must be git-ignored
# (the recommended setup is the portable interpreter installed by scripts/bootstrap.*).
report("virtualenvs tracked by git", sorted(p for p in tracked if "/.venv" in p.replace("\\", "/")))
not_ignored_venvs = [
    path.name
    for path in ROOT.glob(".venv*")
    if path.is_dir()
    and subprocess.run(["git", "check-ignore", "-q", path.name], cwd=ROOT, capture_output=True).returncode != 0
]
report("virtualenvs inside the repository that are not git-ignored", not_ignored_venvs)

print("\nFAIL: portability problems remain." if fail else "\nPASS: workspace is portable.")
sys.exit(1 if fail else 0)
