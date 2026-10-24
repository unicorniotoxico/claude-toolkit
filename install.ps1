# Instala o actualiza el toolkit: memory-engine (hooks, CLI, evidencia-haiku, seguridad-revisor), guias de
# seguridad, agentes dev/appsec, seccion de CLAUDE.md y el panel /tablero. Reversible con uninstall.ps1.
# Para actualizar, volve a ejecutarlo: conserva datos, configuracion y las opciones de la instalacion anterior.
param(
  [string]$ClaudeDir = (Join-Path $env:USERPROFILE ".claude"),
  [string]$ToolkitDir = (Join-Path $env:USERPROFILE "claude-toolkit"),
  [string]$BasePython = "",
  [switch]$NoDevAgents,
  [switch]$NoTablero
)
$ErrorActionPreference = "Stop"
$EngineHome = Join-Path $ClaudeDir "memory-engine"

# 0. el toolkit vive en una carpeta fija ($ToolkitDir): se ejecute desde donde se ejecute (un zip descomprimido,
#    un clon), se copia ahi y se instala desde esa copia. Las actualizaciones se hacen editando esa carpeta (o
#    reemplazandola por una version nueva) y volviendo a ejecutar su install.ps1.
$Items = "agents", "memory-engine", "mods", "security", "templates", "install.ps1", "install.py", "uninstall.ps1",
         "README.md", "CHANGELOG.md", "VERSION", ".gitignore"
$here = $PSScriptRoot
$target = $ToolkitDir.TrimEnd("\")
# misma carpeta? se compara por contenido, no por texto: una ruta puede llegar corta (DECRED~1) o larga
$sameDir = $false
if (Test-Path $target) {
  $probe = ".toolkit-probe-" + [guid]::NewGuid().ToString("N")
  New-Item -ItemType File (Join-Path $here $probe) | Out-Null
  $sameDir = Test-Path (Join-Path $target $probe)
  Remove-Item -Force (Join-Path $here $probe)
}
if (-not $sameDir) {
  if ((Test-Path $target) -and (Get-ChildItem -Force $target | Select-Object -First 1) -and
      -not (Test-Path (Join-Path $target "install.py"))) {
    throw "$target existe y no es una copia del toolkit; elegi otra con -ToolkitDir"
  }
  New-Item -ItemType Directory -Force $target | Out-Null
  foreach ($item in $Items) {
    $from_ = Join-Path $here $item
    if (-not (Test-Path $from_)) { continue }
    $to = Join-Path $target $item
    if (Test-Path $to) { Remove-Item -Recurse -Force $to }
    Copy-Item -Recurse -Force $from_ $to
  }
  Write-Host "toolkit copiado en $target"
}
$Src = $target
$Version = (Get-Content (Join-Path $Src "VERSION") -Raw).Trim()
$statePath = Join-Path $ClaudeDir "claude-toolkit-state.json"
$prev = if (Test-Path $statePath) { Get-Content $statePath -Raw | ConvertFrom-Json } else { $null }

# opciones no indicadas: las de la instalacion anterior
if ($prev -and -not $PSBoundParameters.ContainsKey("NoDevAgents")) { $NoDevAgents = [bool]$prev.no_dev_agents }
if ($prev -and -not $PSBoundParameters.ContainsKey("NoTablero")) { $NoTablero = [bool]$prev.no_tablero }
$from = if ($prev -and $prev.version) { $prev.version } else { $null }
if ($from) { Write-Host "actualizando claude-toolkit $from -> $Version" } else { Write-Host "instalando claude-toolkit $Version" }

# 1. memory-engine: copia el codigo; conserva data, logs, config.json y .venv de una instalacion previa
New-Item -ItemType Directory -Force $EngineHome | Out-Null
foreach ($item in "app", "templates", "tests", "bench", "install.ps1", "uninstall.ps1", "doctor.ps1",
                  "memory.cmd", "run.cmd", "requirements.txt", "README.md") {
  $from_ = Join-Path $Src "memory-engine\$item"
  $to = Join-Path $EngineHome $item
  if ($item -eq "bench" -and (Test-Path (Join-Path $to "recall_cases.json"))) {
    # bench conserva tus casos de recall locales
    Copy-Item -Force (Join-Path $from_ "*") $to
    continue
  }
  if (Test-Path $to -PathType Container) { Remove-Item -Recurse -Force $to }
  Copy-Item -Recurse -Force $from_ $to
}
$engineArgs = @{ ClaudeDir = $ClaudeDir }
if ($BasePython) { $engineArgs.BasePython = $BasePython }
& (Join-Path $EngineHome "install.ps1") @engineArgs

# 2. resto del toolkit, con el Python aislado del engine
$Py = Join-Path $EngineHome ".venv\Scripts\python.exe"
$Backup = Join-Path $ClaudeDir ("backups\claude-toolkit-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
if ($prev -and $prev.backup -and (Test-Path (Join-Path $prev.backup "manifest.json"))) { $Backup = $prev.backup }
$toolArgs = @("-I", (Join-Path $Src "install.py"), "install", "--claude-dir", $ClaudeDir, "--src", $Src, "--backup", $Backup)
if ($NoDevAgents) { $toolArgs += "--no-dev-agents" }
if ($NoTablero) { $toolArgs += "--no-tablero" }
& $Py @toolArgs
if ($LASTEXITCODE -ne 0) { throw "fallo al instalar el toolkit; respaldo en $Backup" }

@{
  version = $Version; backup = $Backup; claude_dir = $ClaudeDir; source = $Src
  no_dev_agents = [bool]$NoDevAgents; no_tablero = [bool]$NoTablero
  updated = (Get-Date -Format "yyyy-MM-dd HH:mm")
} | ConvertTo-Json | Set-Content -Encoding ascii $statePath
Write-Host "claude-toolkit $Version listo. Abre una sesion nueva de Claude Code; el panel se abre solo."
