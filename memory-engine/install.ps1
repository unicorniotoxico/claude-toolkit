# Instala el memory engine y parchea Claude Code de forma reversible (Windows). La logica esta en engine.py,
# que tambien corre en macOS/Linux: python3 engine.py install. Idempotente.
param(
  [string]$ClaudeDir = (Join-Path $env:USERPROFILE ".claude"),
  [string]$BasePython = ""
)
$ErrorActionPreference = "Stop"
if (-not $BasePython) { $BasePython = (Get-Command python -ErrorAction Stop).Source }
& $BasePython -I (Join-Path $PSScriptRoot "engine.py") install --claude-dir $ClaudeDir --base-python $BasePython
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
