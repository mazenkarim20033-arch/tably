@echo off
rem Double-click to start the TABLY server on this PC. Keep this window open while people use the app.
rem Your permanent address is printed once it is running. Close the window to stop the server.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-server.ps1
pause
