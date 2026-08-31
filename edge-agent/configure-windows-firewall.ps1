#Requires -RunAsAdministrator

[CmdletBinding()]
param(
    [ValidateNotNullOrEmpty()]
    [string]$InterfaceAlias = "WLAN",
    [ValidateRange(1024, 65535)]
    [int]$Port = 3478,
    [ValidateRange(1024, 65535)]
    [int]$RelayMinPort = 49160,
    [ValidateRange(1024, 65535)]
    [int]$RelayMaxPort = 49259
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($RelayMaxPort -lt $RelayMinPort -or ($Port -ge $RelayMinPort -and $Port -le $RelayMaxPort)) {
    throw "Listener and relay port ranges are invalid"
}
$binary = Join-Path $PSScriptRoot "edge-agent.exe"
if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
    throw "Edge agent binary is missing"
}

$rules = @(
    @{ Name = "Ananta WebRTC Edge TURN UDP"; Protocol = "UDP"; Port = [string]$Port },
    @{ Name = "Ananta WebRTC Edge TURN TCP"; Protocol = "TCP"; Port = [string]$Port },
    @{ Name = "Ananta WebRTC Edge Relay UDP"; Protocol = "UDP"; Port = "$RelayMinPort-$RelayMaxPort" }
)
foreach ($rule in $rules) {
    Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule `
        -DisplayName $rule.Name `
        -Group "Ananta WebRTC Edge" `
        -Direction Inbound `
        -Action Allow `
        -Enabled True `
        -Profile Private,Public `
        -InterfaceAlias $InterfaceAlias `
        -Program $binary `
        -Protocol $rule.Protocol `
        -LocalPort $rule.Port `
        -EdgeTraversalPolicy Block | Out-Null
}

Write-Output "Windows firewall rules configured for the bounded Edge ports"
