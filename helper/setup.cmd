@echo off
rem Sets up the dsh-perf-hud temperature helper with one UAC prompt.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
pause
