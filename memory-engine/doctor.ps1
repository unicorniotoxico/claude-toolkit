# Diagnostico (Windows; en macOS/Linux: .venv/bin/python engine.py doctor): engine, DB/FTS, latencia de hook,
# hooks registrados, agentes y aislamiento.
param([string]$ClaudeDir = (Join-Path $env:USERPROFILE ".claude"))
$py = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) { $py = (Get-Command python).Source }
& $py -I (Join-Path $PSScriptRoot "engine.py") doctor --claude-dir $ClaudeDir
exit $LASTEXITCODE
