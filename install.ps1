# Instala o actualiza el toolkit en Windows (en macOS/Linux: install.sh). La logica esta en toolkit.py.
# Para actualizar, volve a ejecutarlo: conserva datos, configuracion y las opciones de la instalacion anterior.
param(
  [string]$ClaudeDir = (Join-Path $env:USERPROFILE ".claude"),
  [string]$ToolkitDir = (Join-Path $env:USERPROFILE "claude-toolkit"),
  [string]$BasePython = "",
  [switch]$NoDevAgents,
  [switch]$NoTablero
)
$ErrorActionPreference = "Stop"
if (-not $BasePython) { $BasePython = (Get-Command python -ErrorAction Stop).Source }
$a = @("-I", (Join-Path $PSScriptRoot "toolkit.py"), "install", "--claude-dir", $ClaudeDir, "--toolkit-dir", $ToolkitDir,
       "--base-python", $BasePython)
# opciones no indicadas: toolkit.py usa las de la instalacion anterior
if ($PSBoundParameters.ContainsKey("NoDevAgents")) { $a += $(if ($NoDevAgents) { "--no-dev-agents" } else { "--dev-agents" }) }
if ($PSBoundParameters.ContainsKey("NoTablero")) { $a += $(if ($NoTablero) { "--no-tablero" } else { "--tablero" }) }
& $BasePython @a
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
