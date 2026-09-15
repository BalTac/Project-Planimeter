$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$requiredVersion = (Get-Content .python-version -Raw).Trim()
$requiredMajorMinor = ($requiredVersion -split '\.')[0..1] -join '.'

$venvPython = Join-Path $root '.venv\Scripts\python.exe'

if (-not (Test-Path .venv)) {
    $systemPython = (Get-Command python -ErrorAction Stop).Source
    $actualVersion = & $systemPython -c 'import sys; print("{}.{}".format(sys.version_info[0], sys.version_info[1]))'
    if ($actualVersion -ne $requiredMajorMinor) {
        Write-Error "Python $requiredMajorMinor required (see .python-version), but 'python' is Python $actualVersion. Create the venv with Python $requiredVersion."
        exit 1
    }
    python -m venv .venv
}

& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install -r requirements-dev.txt
& $venvPython -m playwright install chromium
Write-Host "Ready. Start with: .\.venv\Scripts\python.exe server.py"
