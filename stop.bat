@echo off
rem Windows: double-click to stop AtlasMotion AI. Projects, videos and prepared imagery are kept.
cd /d "%~dp0"
docker compose --profile app stop
pause
