#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

required_version="$(cat .python-version)"
required_major_minor="$(printf '%s' "$required_version" | cut -d. -f1-2)"

if [ ! -d .venv ]; then
    if ! command -v python3 >/dev/null 2>&1; then
        echo "python3 not found in PATH. Install Python and retry." >&2
        exit 1
    fi
    actual_version="$(python3 -c 'import sys; print("{}.{}".format(sys.version_info[0], sys.version_info[1]))')"
    if [ "$actual_version" != "$required_major_minor" ]; then
        echo "Python $required_major_minor required (see .python-version), but python3 is Python $actual_version." >&2
        exit 1
    fi
    python3 -m venv .venv
fi

./.venv/bin/python -m pip install --upgrade pip
./.venv/bin/python -m pip install -r requirements-dev.txt
./.venv/bin/python -m playwright install chromium
echo "Ready. Start with: ./.venv/bin/python server.py"
