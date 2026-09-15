# Installs a portable, relocatable CPython (python-build-standalone) for this machine and
# the pinned dependencies into it. No virtualenv is created: the interpreter directory is
# self-contained, so it can be copied to another machine/user/drive unchanged.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$requiredVersion = (Get-Content .python-version -Raw).Trim()

# Pinned python-build-standalone release. Keep in sync with scripts/bootstrap.sh.
$pbsRelease = '20240814'
$pbsAsset = "cpython-$requiredVersion+$pbsRelease-x86_64-pc-windows-msvc-install_only_stripped.tar.gz"
$pbsUrl = "https://releases.astral.sh/github/python-build-standalone/releases/download/$pbsRelease/$($pbsAsset.Replace('+', '%2B'))"

$portableDir = if ($env:PLANIMETER_PYTHON) { $env:PLANIMETER_PYTHON } else { Join-Path $env:LOCALAPPDATA 'planimeter\python' }
$portablePython = Join-Path $portableDir 'python.exe'

function Get-PythonVersion([string] $exe) {
    if (-not (Test-Path $exe)) { return '' }
    try {
        # No double quotes inside -c: PowerShell strips them from native arguments.
        $output = & $exe -c 'import sys; print(sys.version.split()[0])'
        if ($LASTEXITCODE -ne 0) { return '' }
        return "$output".Trim()
    } catch {
        return ''
    }
}

$installedVersion = Get-PythonVersion $portablePython
if ($installedVersion -ne $requiredVersion) {
    $found = if ($installedVersion) { $installedVersion } else { 'none' }
    Write-Host "Installing portable CPython $requiredVersion (found: $found)"

    # Prefer the Windows tar: a GNU tar inherited from an MSYS/Git Bash PATH cannot read C:\ paths.
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (-not (Test-Path $tar)) { $tar = 'tar' }

    $archive = Join-Path $env:TEMP "planimeter-python-$requiredVersion.tar.gz"
    $staging = Join-Path $env:TEMP "planimeter-python-$requiredVersion-staging"
    Write-Host "Downloading $pbsUrl"
    Invoke-WebRequest -Uri $pbsUrl -OutFile $archive
    if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    & $tar -xzf $archive -C $staging --strip-components=1
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Extracting $archive failed with exit code $LASTEXITCODE. Existing install left untouched."
        exit 1
    }

    # The upstream build ships the PEP 668 marker; this interpreter is ours to fill.
    Get-ChildItem -Path (Join-Path $staging 'Lib') -Filter 'EXTERNALLY-MANAGED' -Recurse -ErrorAction SilentlyContinue |
        Remove-Item -Force

    $stagedVersion = Get-PythonVersion (Join-Path $staging 'python.exe')
    if ($stagedVersion -ne $requiredVersion) {
        Write-Error "Staged interpreter reports '$stagedVersion' instead of $requiredVersion. Existing install left untouched; staging kept at $staging."
        exit 1
    }

    # Swap only now that the downloaded interpreter is proven good.
    if (Test-Path $portableDir) { Remove-Item -Recurse -Force $portableDir }
    Move-Item -Path $staging -Destination $portableDir
    Remove-Item -Force $archive
    Write-Host "Installed $portablePython"
}

$installedVersion = Get-PythonVersion $portablePython
if ($installedVersion -ne $requiredVersion) {
    Write-Error "Portable interpreter at $portablePython reports '$installedVersion', expected $requiredVersion."
    exit 1
}

# Keep the environment self-contained: never pick up the per-user site-packages.
$env:PYTHONNOUSERSITE = '1'

& $portablePython -m pip install --upgrade pip
& $portablePython -m pip install -r requirements-dev.txt
& $portablePython -m playwright install chromium

Write-Host "Ready. Start with: $portablePython server.py  (or start-planimeter.bat)"
Write-Host "Interpreter: $portablePython - the folder '$portableDir' is relocatable and can be copied as-is."
