$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$allowed = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
@(
    "EDGE_AGENT_PUBLIC_HOST",
    "EDGE_AGENT_PUBLIC_IP",
    "EDGE_AGENT_LISTEN_IP",
    "EDGE_AGENT_PORT",
    "EDGE_AGENT_RELAY_MIN_PORT",
    "EDGE_AGENT_RELAY_MAX_PORT",
    "EDGE_AGENT_REALM",
    "EDGE_AGENT_SHARED_SECRET",
    "EDGE_AGENT_MAX_CREDENTIAL_TTL_SECONDS",
    "EDGE_AGENT_ALLOCATION_TTL_SECONDS",
    "EDGE_AGENT_MAX_ALLOCATIONS",
    "EDGE_AGENT_MAX_USER_ALLOCATIONS",
    "EDGE_AGENT_ENABLE_TCP",
    "EDGE_AGENT_ALLOW_PRIVATE_PEERS",
    "EDGE_AGENT_PCP_GATEWAY",
    "EDGE_AGENT_PCP_LIFETIME_SECONDS"
) | ForEach-Object { [void]$allowed.Add($_) }

$configPath = if ($env:EDGE_AGENT_CONFIG) {
    $env:EDGE_AGENT_CONFIG
} else {
    Join-Path $PSScriptRoot "edge-agent.env"
}
$binaryPath = Join-Path $PSScriptRoot "edge-agent.exe"
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "Edge configuration file is missing"
}
if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) {
    throw "Edge agent binary is missing"
}

$seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
foreach ($rawLine in Get-Content -LiteralPath $configPath) {
    $line = $rawLine.Trim()
    if (-not $line -or $line.StartsWith("#")) { continue }
    $parts = $line.Split("=", 2)
    if ($parts.Count -ne 2) { throw "Invalid Edge configuration line" }
    $name = $parts[0].Trim()
    if (-not $allowed.Contains($name) -or -not $seen.Add($name)) {
        throw "Unknown or duplicate Edge configuration field"
    }
    [Environment]::SetEnvironmentVariable($name, $parts[1], "Process")
}

if ($env:EDGE_AGENT_PUBLIC_HOST) {
    $addresses = @([Net.Dns]::GetHostAddresses($env:EDGE_AGENT_PUBLIC_HOST) |
        Where-Object { $_.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork } |
        Select-Object -Unique)
    if ($addresses.Count -ne 1) {
        throw "EDGE_AGENT_PUBLIC_HOST must resolve to exactly one public IPv4 address"
    }
    [Environment]::SetEnvironmentVariable("EDGE_AGENT_PUBLIC_IP", $addresses[0].ToString(), "Process")
}

& $binaryPath
exit $LASTEXITCODE
