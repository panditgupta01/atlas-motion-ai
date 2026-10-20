@echo off
rem Windows: double-click to start AtlasMotion AI. Needs only Docker Desktop.
setlocal
cd /d "%~dp0"

where docker >nul 2>nul
if errorlevel 1 (
  echo Docker Desktop is not installed. Get it from https://www.docker.com/products/docker-desktop/ and run this again.
  pause
  exit /b 1
)
docker info >nul 2>nul
if errorlevel 1 (
  echo Docker Desktop is not running. Start it, wait until it says it is running, then run this again.
  pause
  exit /b 1
)

if not exist .env (
  powershell -NoProfile -Command "$b = New-Object byte[] 32; (New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($b); $s = -join ($b | ForEach-Object { $_.ToString('x2') }); (Get-Content .env.example) -replace '^JWT_SECRET=.*', ('JWT_SECRET=' + $s) | Set-Content .env"
  echo Created .env with a new random JWT_SECRET.
)

echo Building and starting AtlasMotion AI. The first run downloads and builds everything, which takes a while.
docker compose --profile app up -d --build
if errorlevel 1 (
  pause
  exit /b 1
)

echo Waiting for the app to answer...
powershell -NoProfile -Command "for ($i = 0; $i -lt 240; $i++) { try { Invoke-WebRequest -UseBasicParsing http://localhost:4000/api/v1/health -TimeoutSec 3 | Out-Null; exit 0 } catch { Start-Sleep 5 } }; exit 1"
if errorlevel 1 (
  echo The app did not start. Its last log lines:
  docker compose --profile app logs --tail 40 api worker
  pause
  exit /b 1
)

echo.
echo AtlasMotion AI is running at http://localhost:4000
echo Sharp Sentinel-2 imagery for Nepal is prepared in the background on the first run.
echo Videos made before it finishes use coarser imagery. Progress: docker compose logs -f imagery
echo To stop the app, double-click stop.bat.
start "" http://localhost:4000
pause
