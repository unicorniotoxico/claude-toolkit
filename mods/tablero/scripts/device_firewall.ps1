# Ejecutar desde PowerShell elevado en el equipo que recibe conexiones.
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][ValidateRange(1024,65535)][int]$Port,
    [Parameter(Mandatory)][string]$BindAddress,
    [Parameter(Mandatory)][string[]]$AllowedAddress,
    [ValidateSet('Private','Domain')][string]$Profile = 'Private'
)
$ErrorActionPreference = 'Stop'
$bind = [Net.IPAddress]::Parse($BindAddress)
if ($bind.AddressFamily -ne 'InterNetwork' -or $bind.Equals([Net.IPAddress]::Any)) {
    throw 'Indicá la IPv4 concreta de la interfaz que escucha.'
}
$peers = foreach ($address in $AllowedAddress) {
    $ip = [Net.IPAddress]::Parse($address)
    if ($ip.AddressFamily -ne 'InterNetwork' -or $ip.Equals([Net.IPAddress]::Any)) {
        throw 'Indicá una IPv4 concreta por dispositivo.'
    }
    $ip.ToString()
}
$name = "claude-toolkit-devices-$Port"
if (Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue) {
    throw "Ya existe $name. Revisá la regla antes de cambiarla."
}
if ($PSCmdlet.ShouldProcess("${BindAddress}:$Port", 'Habilitar acceso al gateway desde las IP indicadas')) {
    New-NetFirewallRule -Name $name -DisplayName "Claude Toolkit Devices TCP $Port" -Direction Inbound `
        -Action Allow -Protocol TCP -LocalAddress $BindAddress -LocalPort $Port `
        -RemoteAddress $peers -Profile $Profile
}
