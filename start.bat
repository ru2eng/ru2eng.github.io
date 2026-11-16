@echo off
rem Starts a static HTTP server on http://localhost:8000
rem for the Tatoeba trainer and opens it in the default browser.
rem Required: Python. Alternative if Python is unavailable: run "npx serve" in this folder.
setlocal
cd /d "%~dp0"
where python >nul 2>nul
if %errorlevel%==0 (
    start "Tatoeba trainer server" cmd /k "python -m http.server 8000"
    goto server_started
)
where py >nul 2>nul
if %errorlevel%==0 (
    start "Tatoeba trainer server" cmd /k "py -m http.server 8000"
    goto server_started
)
echo Python not found. Install Python or run the alternative server: npx serve
pause
exit /b 1

:server_started
timeout /t 1 /nobreak >nul
start "" http://localhost:8000