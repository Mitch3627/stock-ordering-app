@echo off
cd /d "%~dp0"
title Stock ^& Ordering
if "%PORT%"=="" set PORT=3000
rem An older copy still running would keep the port, and the browser would show old code: stop it first.
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $p.Id -Force } }"
rem Open the browser once the app is answering (checks every second for up to 30 seconds).
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for ($i = 0; $i -lt 30; $i++) { try { Invoke-WebRequest -UseBasicParsing http://localhost:%PORT%/login.html | Out-Null; Start-Process 'http://localhost:%PORT%'; break } catch { Start-Sleep 1 } }"
rem To use it from tablets on the restaurant Wi-Fi, remove "rem " from the next line.
rem set HOST=0.0.0.0
npm start
