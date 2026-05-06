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
set "URL=http://%HOST%:%PORT%/planimeter.html"

where python >nul 2>&1
if errorlevel 1 (
    echo Python non trovato nel PATH.
    echo Installa Python e riprova.
    pause
    exit /b 1
)

start "Project Planimeter Server" cmd /k "cd /d ""%CD%"" && python server.py --host %HOST% --port %PORT%%EXTRA_ARGS%"
start "Project Planimeter" "%URL%"

echo Avvio completato.
echo Se la pagina non risponde subito, aggiorna il browser dopo qualche secondo.

exit /b 0
