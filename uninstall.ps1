# Retira el toolkit en Windows (en macOS/Linux: uninstall.sh): restaura guias/agentes previos, quita la seccion
# de CLAUDE.md y el panel, y desinstala el memory-engine (sus datos se archivan en el respaldo salvo -DeleteData).
param(
  [string]$ClaudeDir = (Join-Path $env:USERPROFILE ".claude"),
  [switch]$DeleteData
)
$ErrorActionPreference = "Stop"
$py = (Get-Command python -ErrorAction Stop).Source
$a = @("-I", (Join-Path $PSScriptRoot "toolkit.py"), "uninstall", "--claude-dir", $ClaudeDir)
if ($DeleteData) { $a += "--delete-data" }
& $py @a
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
