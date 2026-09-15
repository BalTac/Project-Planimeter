#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

HOST="127.0.0.1"
PORT="8000"
FORWARD_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --host)
            if [[ $# -lt 2 ]]; then
                echo "Missing value for --host" >&2
                exit 1
            fi
            HOST="$2"
            shift 2
            ;;
        --port)
            if [[ $# -lt 2 ]]; then
                echo "Missing value for --port" >&2
                exit 1
            fi
            PORT="$2"
            shift 2
            ;;
        *)
            FORWARD_ARGS+=("$1")
            shift
            ;;
    esac
done

# Interpreter precedence: PLANIMETER_PYTHON, then a repo-local .venv you created, then the
# portable interpreter recommended by scripts/bootstrap.sh, then python3/python from PATH.
PORTABLE_CANDIDATES=()
if [ -n "${PLANIMETER_PYTHON:-}" ]; then PORTABLE_CANDIDATES+=("$PLANIMETER_PYTHON"); fi
PORTABLE_CANDIDATES+=("$SCRIPT_DIR/.venv")
if [ -n "${LOCALAPPDATA:-}" ]; then PORTABLE_CANDIDATES+=("$LOCALAPPDATA/planimeter/python"); fi
PORTABLE_CANDIDATES+=("${XDG_DATA_HOME:-$HOME/.local/share}/planimeter/python")

PYTHON_BIN=""
for candidate in "${PORTABLE_CANDIDATES[@]}"; do
    # POSIX venv layout, Windows venv layout, then a bare interpreter directory.
    for layout in bin/python3 bin/python Scripts/python.exe python.exe; do
        if [ -x "$candidate/$layout" ]; then
            PYTHON_BIN="$candidate/$layout"
            break 2
        fi
    done
done

if [ -z "$PYTHON_BIN" ]; then
    if command -v python3 >/dev/null 2>&1; then
        PYTHON_BIN="python3"
    elif command -v python >/dev/null 2>&1; then
        PYTHON_BIN="python"
    else
        echo "Python not found. Run scripts/bootstrap.ps1 (Windows) or scripts/bootstrap.sh for the recommended portable interpreter, create a .venv, or install Python." >&2
        exit 1
    fi
fi

# Ignore the per-user site-packages so the portable environment stays reproducible.
export PYTHONNOUSERSITE=1

echo "Starting Project Planimeter server requested on http://${HOST}:${PORT}/planimeter.html"
"$PYTHON_BIN" server.py --host "$HOST" --port "$PORT" "${FORWARD_ARGS[@]}" &
SERVER_PID=$!

cleanup() {
    if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
        kill "$SERVER_PID" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT INT TERM

echo "Press Ctrl+C to stop."
wait "$SERVER_PID"
