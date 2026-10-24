# Instala el memory engine y parchea Claude Code de forma reversible.
# No toca PATH, Python global, npm global ni proyectos. Idempotente.
param(
  [string]$ClaudeDir = (Join-Path $env:USERPROFILE ".claude"),
  [string]$BasePython = ""
)
$ErrorActionPreference = "Stop"
$EngineHome = $PSScriptRoot
$Venv = Join-Path $EngineHome ".venv"
$Py = Join-Path $Venv "Scripts\python.exe"

if (-not $BasePython) { $BasePython = (Get-Command python -ErrorAction Stop).Source }
$probe = & $BasePython -c "import sys,sqlite3;c=sqlite3.connect(':memory:');c.execute('create virtual table t using fts5(a)');print(sys.version_info>=(3,10))"
if ($probe -ne "True") { throw "Se requiere Python >= 3.10 con SQLite FTS5 ($BasePython)" }

if (-not (Test-Path $Py)) {
  Write-Host "creando venv aislado (sin pip, sin paquetes): $Venv"
  & $BasePython -m venv --without-pip $Venv
  if ($LASTEXITCODE -ne 0) { throw "fallo al crear el venv" }
}
$prefix = & $Py -I -c "import sys;print(sys.prefix)"
if ($prefix -notlike "*memory-engine*") { throw "el venv no resolvio a memory-engine: $prefix" }

foreach ($d in "data", "data\session", "logs", "logs\runs") { New-Item -ItemType Directory -Force (Join-Path $EngineHome $d) | Out-Null }
# datos y logs: solo el usuario actual (por SID: el nombre puede coincidir con el del equipo) y SYSTEM
$Sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($d in "data", "logs") {
  icacls (Join-Path $EngineHome $d) /inheritance:r /grant:r "*${Sid}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" | Out-Null
}

$cfg = Join-Path $EngineHome "config.json"
if (-not (Test-Path $cfg)) {
  & $Py -I -c "import json,sys;sys.path.insert(0,r'$EngineHome');from app.config import DEFAULTS;open(r'$cfg','w',encoding='utf-8').write(json.dumps(DEFAULTS,indent=2))"
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$Backup = Join-Path $ClaudeDir "backups\memory-engine-$stamp"
$statePath = Join-Path $EngineHome "install-state.json"
if (Test-Path $statePath) {
  # reinstalacion: conservar el respaldo de la primera instalacion (estado original)
  $prevState = Get-Content $statePath -Raw | ConvertFrom-Json
  if ($prevState.backup -and (Test-Path (Join-Path $prevState.backup "manifest.json"))) { $Backup = $prevState.backup; $stamp = $prevState.installed }
}
& $Py -I (Join-Path $EngineHome "app\installer.py") install --claude-dir $ClaudeDir --home $EngineHome --python $Py --backup $Backup
if ($LASTEXITCODE -ne 0) { throw "fallo al parchear la configuracion; respaldo en $Backup" }

@{ backup = $Backup; claude_dir = $ClaudeDir; installed = $stamp } | ConvertTo-Json | Set-Content -Encoding ascii (Join-Path $EngineHome "install-state.json")

& $Py -I (Join-Path $EngineHome "app\cli.py") stats | Out-Null
& (Join-Path $EngineHome "doctor.ps1") -ClaudeDir $ClaudeDir
Write-Host "Instalado. Abre una sesion nueva de Claude Code para cargar hooks y agentes."
