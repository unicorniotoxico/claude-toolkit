# Retira el toolkit: restaura guias/agentes previos, quita la seccion de CLAUDE.md y el panel, y desinstala
# el memory-engine (sus datos se archivan en el respaldo salvo -DeleteData).
param(
  [string]$ClaudeDir = (Join-Path $env:USERPROFILE ".claude"),
  [switch]$DeleteData
)
$ErrorActionPreference = "Stop"
$statePath = Join-Path $ClaudeDir "claude-toolkit-state.json"
$EngineHome = Join-Path $ClaudeDir "memory-engine"
$Py = Join-Path $EngineHome ".venv\Scripts\python.exe"
$runner = if (Test-Path $Py) { $Py } else { (Get-Command python).Source }

if (Test-Path $statePath) {
  $st = Get-Content $statePath -Raw | ConvertFrom-Json
  & $runner -I (Join-Path $PSScriptRoot "install.py") uninstall --claude-dir $ClaudeDir --backup $st.backup
  if ($LASTEXITCODE -ne 0) { throw "fallo al retirar el toolkit; el memory-engine NO se toco" }
  Remove-Item -Force $statePath
} else {
  Write-Host "sin claude-toolkit-state.json: se omiten guias, agentes dev/appsec y panel"
}

if (Test-Path (Join-Path $EngineHome "uninstall.ps1")) {
  $engineArgs = @{ ClaudeDir = $ClaudeDir }
  if ($DeleteData) { $engineArgs.DeleteData = $true }
  & (Join-Path $EngineHome "uninstall.ps1") @engineArgs
}
