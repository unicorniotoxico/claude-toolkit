# Diagnostico: engine, DB/FTS, latencia de hook, hooks registrados, agentes y aislamiento.
param([string]$ClaudeDir = (Join-Path $env:USERPROFILE ".claude"))
$EngineHome = $PSScriptRoot
$Py = Join-Path $EngineHome ".venv\Scripts\python.exe"
$fail = 0
function Check($name, $ok, $detail = "") {
  $tag = if ($ok) { "OK   " } else { "FALLA"; $script:fail++ }
  Write-Host "[$tag] $name $(if ($detail) { "- $detail" })"
}
Check "venv aislado" (Test-Path $Py) $Py
if (Test-Path $Py) { & $Py -I (Join-Path $EngineHome "app\cli.py") doctor; if ($LASTEXITCODE -ne 0) { $fail++ } }

$settingsPath = Join-Path $ClaudeDir "settings.json"
$raw = if (Test-Path $settingsPath) { Get-Content $settingsPath -Raw -Encoding utf8 } else { "{}" }
$s = $raw | ConvertFrom-Json
foreach ($ev in "UserPromptSubmit", "Stop") {
  $h = @($s.hooks.$ev | ForEach-Object { $_.hooks } | Where-Object { ($_.args -join " ") -like "*memory-engine*" })
  $exists = $h.Count -eq 1 -and (Test-Path $h[0].command) -and (Test-Path $h[0].args[1])
  Check "hook $ev registrado una vez y apuntando al venv" $exists
}
foreach ($a in @(@("evidencia-haiku", "haiku"), @("seguridad-revisor", "sonnet"))) {
  $f = Join-Path $ClaudeDir "agents\$($a[0]).md"
  $ok = (Test-Path $f) -and ((Get-Content $f -Raw -Encoding utf8) -match "(?m)^model:\s*$($a[1])\s*$")
  Check "agente $($a[0]) con model: $($a[1])" $ok
}
$cm = Join-Path $ClaudeDir "CLAUDE.md"
Check "seccion memory-engine en CLAUDE.md" ((Test-Path $cm) -and ((Get-Content $cm -Raw -Encoding utf8) -match "memory-engine:begin"))
Check "PATH de usuario sin memory-engine" (-not ([Environment]::GetEnvironmentVariable("Path", "User") -like "*memory-engine*"))
Check "PATH de maquina sin memory-engine" (-not ([Environment]::GetEnvironmentVariable("Path", "Machine") -like "*memory-engine*"))
$procs = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like "*memory-engine*" -and $_.CommandLine -notlike "*cli.py*doctor*" })
Check "sin procesos residentes del engine" ($procs.Count -eq 0) "$($procs.Count) procesos"
if ($fail) { Write-Host "$fail comprobaciones fallaron"; exit 1 } else { Write-Host "doctor: todo OK" }
