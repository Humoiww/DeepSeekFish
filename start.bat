@echo off
setlocal
cd /d "%~dp0"
if exist "runtime\tools\node\node.exe" set "PATH=%CD%\runtime\tools\node;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24.9+ is required. Install it or place portable Node in runtime\tools\node.
  goto fail
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>24||a===24&&b>=9?0:1)"
if errorlevel 1 goto fail
if not exist "runtime\tmp" mkdir "runtime\tmp"
if not exist "runtime\cache\npm" mkdir "runtime\cache\npm"
set "TEMP=%CD%\runtime\tmp"
set "TMP=%TEMP%"
set "XDG_CACHE_HOME=%CD%\runtime\cache"
set "npm_config_cache=%CD%\runtime\cache\npm"
if not exist "node_modules\typescript\bin\tsc" (
  call npm.cmd ci --ignore-scripts
  if errorlevel 1 goto fail
)
call npm.cmd run build
if errorlevel 1 goto fail
node dist\src\cli.js webui %*
if errorlevel 1 goto fail
exit /b 0
:fail
echo DeepSeekFish could not start. Check the error above.
if not defined FISH_NO_PAUSE pause
exit /b 1
