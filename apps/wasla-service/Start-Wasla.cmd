@echo off
setlocal
set "WASLA_PYTHONW=C:\Users\Administrator\Documents\Codex\2026-11-01\local-browser-agent\work\local-image-engine\venv\Scripts\pythonw.exe"
if not exist "%WASLA_PYTHONW%" (
  echo The existing Wasla Python runtime was not found.
  echo No software was installed or changed.
  pause
  exit /b 1
)
start "" /D "%~dp0" "%WASLA_PYTHONW%" "%~dp0companion.py"
exit /b 0
