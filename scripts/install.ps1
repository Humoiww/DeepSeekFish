$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path $PSScriptRoot -Parent
Push-Location $ProjectRoot
try {
  New-Item -ItemType Directory -Force runtime/tmp, runtime/cache/npm | Out-Null
  $env:TEMP = Join-Path $ProjectRoot 'runtime/tmp'
  $env:TMP = $env:TEMP
  $env:npm_config_cache = Join-Path $ProjectRoot 'runtime/cache/npm'
  & npm.cmd ci --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw 'build failed' }
} finally { Pop-Location }
