@echo off
setlocal
rem The service's own environment first (Setup-Wasla.ps1), then the Python launcher.
set "WASLA_PYTHONW=%~dp0.venv\Scripts\pythonw.exe"
if exist "%WASLA_PYTHONW%" (
  start "" /D "%~dp0" "%WASLA_PYTHONW%" "%~dp0companion.py"
  exit /b 0
)
where py >nul 2>nul
if errorlevel 1 (
  echo Python 3.11 or newer was not found. Run Setup-Wasla.ps1 first.
  pause
  exit /b 1
)
start "" /D "%~dp0" pyw -3 "%~dp0companion.py"
exit /b 0
