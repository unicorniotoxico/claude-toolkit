# Retira hooks, seccion de CLAUDE.md, restaura agentes previos y quita el memory engine (Windows; en macOS/Linux:
# python3 engine.py uninstall). Los datos se archivan en el respaldo salvo -DeleteData.
param(
  [string]$ClaudeDir = "",
  [switch]$DeleteData
)
$ErrorActionPreference = "Stop"
# con el Python base: el venv del engine se borra
$py = (Get-Command python -ErrorAction Stop).Source
$a = @("-I", (Join-Path $PSScriptRoot "engine.py"), "uninstall")
if ($ClaudeDir) { $a += @("--claude-dir", $ClaudeDir) }
if ($DeleteData) { $a += "--delete-data" }
& $py @a
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
