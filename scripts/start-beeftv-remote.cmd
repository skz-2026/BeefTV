@echo off
rem Start BeefTV and open the phone QR page. Logs live in .local\logs.
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0start-beeftv-remote.ps1"
