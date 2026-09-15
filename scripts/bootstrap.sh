#!/usr/bin/env bash
# Installs a portable, relocatable CPython (python-build-standalone) for this machine and
# the pinned dependencies into it. No virtualenv is created: the interpreter directory is
# self-contained, so it can be copied to another machine/user/drive unchanged.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

required_version="$(cat .python-version)"
# Pinned python-build-standalone release. Keep in sync with scripts/bootstrap.ps1.
pbs_release="20240814"

case "$(uname -s)-$(uname -m)" in
    MINGW*|MSYS*|CYGWIN*)
        echo "Windows detected: run scripts/bootstrap.ps1 from PowerShell to install the portable interpreter." >&2
        exit 1
        ;;
    Linux-x86_64)  target="x86_64-unknown-linux-gnu" ;;
    Linux-aarch64) target="aarch64-unknown-linux-gnu" ;;
    Darwin-arm64)  target="aarch64-apple-darwin" ;;
    Darwin-x86_64) target="x86_64-apple-darwin" ;;
    *)
        echo "No portable CPython build mapped for $(uname -s)-$(uname -m)." >&2
        echo "Install Python ${required_version} manually and retry." >&2
        exit 1
        ;;
esac

asset="cpython-${required_version}+${pbs_release}-${target}-install_only_stripped.tar.gz"
url="https://releases.astral.sh/github/python-build-standalone/releases/download/${pbs_release}/${asset//+/%2B}"

portable_dir="${PLANIMETER_PYTHON:-${XDG_DATA_HOME:-$HOME/.local/share}/planimeter/python}"
portable_python="$portable_dir/bin/python3"
[ -x "$portable_python" ] || portable_python="$portable_dir/python.exe"

installed_version=""
if [ -x "$portable_python" ]; then
    installed_version="$("$portable_python" -c 'import sys; print("{}.{}.{}".format(*sys.version_info[:3]))')"
fi

if [ "$installed_version" != "$required_version" ]; then
    echo "Installing portable CPython ${required_version} (found: ${installed_version:-none}) from ${url}"
    archive="$(mktemp -t planimeter-python-XXXXXX.tar.gz)"
    curl -fsSL "$url" -o "$archive"
    rm -rf "$portable_dir"
    mkdir -p "$portable_dir"
    tar -xzf "$archive" -C "$portable_dir" --strip-components=1
    rm -f "$archive"
    # The upstream build ships the PEP 668 marker; this interpreter is ours to fill.
    find "$portable_dir/lib" -name EXTERNALLY-MANAGED -delete 2>/dev/null || true
fi

installed_version="$("$portable_python" -c 'import sys; print("{}.{}.{}".format(*sys.version_info[:3]))')"
if [ "$installed_version" != "$required_version" ]; then
    echo "Portable interpreter at $portable_python reports $installed_version, expected $required_version." >&2
    exit 1
fi

# Keep the environment self-contained: never pick up the per-user site-packages.
export PYTHONNOUSERSITE=1

"$portable_python" -m pip install --upgrade pip
"$portable_python" -m pip install -r requirements-dev.txt
"$portable_python" -m playwright install chromium

echo "Ready. Start with: $portable_python server.py  (or ./start_planimeter.sh)"
echo "Interpreter: $portable_python - the folder '$portable_dir' is relocatable and can be copied as-is."
