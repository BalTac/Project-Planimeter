@echo off
setlocal

cd /d "%~dp0"

set "HOST=127.0.0.1"
set "PORT=8000"
set "EXTRA_ARGS="

rem Parse optional CLI args and forward them to server.py.
:parse_args
if "%~1"=="" goto args_done
if /I "%~1"=="--host" (
    if not "%~2"=="" (
        set "HOST=%~2"
        shift
    )
    shift
    goto parse_args
)
if /I "%~1"=="--port" (
    if not "%~2"=="" (
        set "PORT=%~2"
        shift
    )
    shift
    goto parse_args
)
set "EXTRA_ARGS=%EXTRA_ARGS% %~1"
shift
goto parse_args

:args_done
rem Prefer the portable interpreter installed per-machine by scripts\bootstrap.ps1.
rem Override the location with the PLANIMETER_PYTHON environment variable.
if defined PLANIMETER_PYTHON set "PYTHON_BIN=%PLANIMETER_PYTHON%\python.exe"
if not defined PYTHON_BIN set "PYTHON_BIN=%LOCALAPPDATA%\planimeter\python\python.exe"
if exist "%PYTHON_BIN%" goto python_ready

where python >nul 2>&1
if errorlevel 1 goto python_missing
set "PYTHON_BIN=python"
goto python_ready

:python_missing
echo Python non trovato nel PATH.
echo Esegui scripts\bootstrap.ps1 per installare l'interprete portable, oppure installa Python e riprova.
pause
exit /b 1

:python_ready
rem Ignore the per-user site-packages so the portable environment stays reproducible.
set "PYTHONNOUSERSITE=1"
start "Project Planimeter Server" cmd /k "cd /d ""%CD%"" && ""%PYTHON_BIN%"" server.py --host %HOST% --port %PORT%%EXTRA_ARGS%"

echo Avvio completato.
echo Il browser verra aperto dal server dopo aver risolto la porta effettiva.

exit /b 0
