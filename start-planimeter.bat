@echo off
setlocal

cd /d "%~dp0"

set "HOST=127.0.0.1"
set "PORT=8000"
set "URL=http://%HOST%:%PORT%/planimeter.html"

where python >nul 2>&1
if errorlevel 1 (
    echo Python non trovato nel PATH.
    echo Installa Python e riprova.
    pause
    exit /b 1
)

start "Project Planimeter Server" cmd /k "cd /d ""%CD%"" && python server.py --host %HOST% --port %PORT%"
start "Project Planimeter" "%URL%"

echo Avvio completato.
echo Se la pagina non risponde subito, aggiorna il browser dopo qualche secondo.

exit /b 0
