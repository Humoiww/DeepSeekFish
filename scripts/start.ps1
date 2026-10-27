param([switch]$Mock)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path $PSScriptRoot -Parent
Push-Location $ProjectRoot
try {
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw 'build failed' }
  if ($Mock) { & node dist/src/cli.js start --mock }
  else { & node dist/src/cli.js start }
} finally { Pop-Location }
