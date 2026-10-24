# Retira hooks, seccion de CLAUDE.md, restaura agentes previos y quita el memory engine.
# Los datos se archivan en el respaldo salvo -DeleteData. No toca otros componentes de Claude.
param(
  [string]$ClaudeDir = "",
  [switch]$DeleteData
)
$ErrorActionPreference = "Stop"
$EngineHome = $PSScriptRoot
$Py = Join-Path $EngineHome ".venv\Scripts\python.exe"
$state = Join-Path $EngineHome "install-state.json"
if (-not (Test-Path $state)) { throw "no existe install-state.json; nada que desinstalar desde aqui" }
$st = Get-Content $state -Raw | ConvertFrom-Json
if (-not $ClaudeDir) { $ClaudeDir = $st.claude_dir }
$Backup = $st.backup

$runner = if (Test-Path $Py) { $Py } else { (Get-Command python).Source }
& $runner -I (Join-Path $EngineHome "app\installer.py") uninstall --claude-dir $ClaudeDir --backup $Backup
if ($LASTEXITCODE -ne 0) { throw "fallo al restaurar la configuracion; el engine NO se elimino" }

if (-not $DeleteData) {
  $arch = Join-Path $Backup "datos-archivados"
  New-Item -ItemType Directory -Force $arch | Out-Null
  foreach ($d in "data", "config.json") {
    $src = Join-Path $EngineHome $d
    if (Test-Path $src) { Copy-Item -Recurse -Force $src $arch }
  }
  Write-Host "datos archivados en $arch"
}

$prev = (Get-Location).Path
Set-Location $ClaudeDir
Remove-Item -Recurse -Force $EngineHome
if ((Test-Path $prev) -and -not $prev.StartsWith($EngineHome)) { Set-Location $prev }
Write-Host "memory engine eliminado. Respaldo de configuracion previa: $Backup"
