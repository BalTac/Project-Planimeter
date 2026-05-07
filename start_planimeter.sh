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

PYTHON_BIN=""
if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
    PYTHON_BIN="python"
else
    echo "Python not found in PATH. Install Python and retry." >&2
    exit 1
fi

URL="http://${HOST}:${PORT}/planimeter.html"

echo "Starting Project Planimeter server on ${URL}"
"$PYTHON_BIN" server.py --host "$HOST" --port "$PORT" "${FORWARD_ARGS[@]}" &
SERVER_PID=$!

cleanup() {
    if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
        kill "$SERVER_PID" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT INT TERM

if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1 || true
elif command -v open >/dev/null 2>&1; then
    open "$URL" >/dev/null 2>&1 || true
else
    echo "Open ${URL} in your browser."
fi

echo "Press Ctrl+C to stop."
wait "$SERVER_PID"
