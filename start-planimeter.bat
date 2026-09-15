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
set "PYTHON_BIN=%~dp0.venv\Scripts\python.exe"
if exist "%PYTHON_BIN%" goto python_ready

where python >nul 2>&1
if errorlevel 1 goto python_missing
set "PYTHON_BIN=python"
goto python_ready

:python_missing
echo Python non trovato nel PATH.
echo Installa Python e riprova (oppure esegui scripts\bootstrap.ps1 per creare .venv).
pause
exit /b 1

:python_ready
start "Project Planimeter Server" cmd /k "cd /d ""%CD%"" && %PYTHON_BIN% server.py --host %HOST% --port %PORT%%EXTRA_ARGS%"

echo Avvio completato.
echo Il browser verra aperto dal server dopo aver risolto la porta effettiva.

exit /b 0
