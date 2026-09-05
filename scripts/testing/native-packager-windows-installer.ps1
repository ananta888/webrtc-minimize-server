param([Parameter(Mandatory=$true)][string]$FixtureDirectory)
$ErrorActionPreference = 'Stop'
$workspace = Join-Path ([IO.Path]::GetTempPath()) ('ananta-installer-gate ' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $workspace
$env:LOCALAPPDATA = Join-Path $workspace 'local app'
$env:APPDATA = Join-Path $workspace 'roaming app'
$startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$null = New-Item -ItemType Directory -Path $startup -Force
$ids = @('pkr_0123456789abcdef', 'pkr_fedcba9876543210')
$base = Join-Path $env:LOCALAPPDATA 'Ananta\NativePackager'
$artifact = Join-Path $FixtureDirectory 'native-broadcast-packager-windows-amd64.exe'

function Invoke-WebRequest { param([switch]$UseBasicParsing, $Uri, $OutFile)
    if ($env:ANANTA_INSTALLER_GATE_BAD_HASH -eq '1') { [IO.File]::WriteAllText($OutFile, 'invalid-hash'); return }
    Copy-Item -LiteralPath $artifact -Destination $OutFile
}
function Require([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Wait-Running([string]$Root) {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $marker = Join-Path $Root 'output\process.pid'
    while (-not (Test-Path -LiteralPath $marker)) {
        if ([DateTime]::UtcNow -gt $deadline) { throw 'Quoted launcher did not start the synthetic process' }
        Start-Sleep -Milliseconds 50
    }
    return [int][IO.File]::ReadAllText($marker)
}
function Expect-Failure([scriptblock]$Action) {
    $failed = $false
    try { & $Action } catch { $failed = $true }
    Require $failed 'Negative lifecycle case unexpectedly succeeded'
}

try {
    foreach ($id in $ids) {
        & (Join-Path $FixtureDirectory ($id + '.ps1'))
        Require (-not (Test-Path Env:NATIVE_PACKAGER_ENROLLMENT_TOKEN)) 'Enrollment token survived installation'
        $root = Join-Path $base $id
        $null = Wait-Running $root
        Require ([IO.File]::ReadAllText((Join-Path $root ('identity-' + $id + '.pem'))) -eq $id) 'Identity changed'
        $acl = Get-Acl -LiteralPath $root
        $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        Require $acl.AreAccessRulesProtected 'Installation inherited broad access'
        Require ($acl.Access.Count -eq 1) 'Installation has unexpected ACL entries'
        Require ($acl.Access[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $owner) 'ACL is not user bound'
        $identityAcl = Get-Acl -LiteralPath (Join-Path $root ('identity-' + $id + '.pem'))
        Require ($identityAcl.Access.Count -eq 1) 'Identity did not inherit the private ACL'
        Require (Test-Path -LiteralPath (Join-Path $startup ('ananta-native-packager-' + $id + '.cmd'))) 'Autostart fixture missing'
    }
    Write-Output 'PASS two real Windows script installations, quoted launch paths and private ACLs'
    $first = Join-Path $base $ids[0]
    $second = Join-Path $base $ids[1]
    $firstPID = Wait-Running $first
    $secondPID = Wait-Running $second
    Expect-Failure { & (Join-Path $FixtureDirectory 'duplicate.ps1') }
    $launcher = Join-Path $first ('run-' + $ids[0] + '.ps1')
    $duplicate = Start-Process powershell.exe -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File', ('"' + $launcher + '"'))
    Require ($duplicate.WaitForExit(5000)) 'Duplicate launcher did not respect the running lock'
    Require ((Wait-Running $first) -eq $firstPID) 'Duplicate launcher replaced the process'
    $duplicate.Dispose()

    $secondProcess = Get-Process -Id $secondPID
    $secondProcess.Kill(); Require ($secondProcess.WaitForExit(5000)) 'Synthetic restart stop failed'
    $secondProcess.Dispose()
    Start-Sleep -Milliseconds 300
    Remove-Item -LiteralPath (Join-Path $second 'output\process.pid')
    Push-Location $workspace
    try { & (Join-Path $startup ('ananta-native-packager-' + $ids[1] + '.cmd')) } finally { Pop-Location }
    $secondPID = Wait-Running $second
    Write-Output 'PASS generated Windows autostart command restarts the selected fixture'

    $env:ANANTA_INSTALLER_GATE_BAD_HASH = '1'
    Expect-Failure { & (Join-Path $FixtureDirectory 'bad-hash.ps1') }
    $env:ANANTA_INSTALLER_GATE_BAD_HASH = '0'
    $failedRoot = Join-Path $base 'pkr_aaaaaaaaaaaaaaaa'
    Require (-not (Test-Path -LiteralPath (Join-Path $failedRoot 'native-broadcast-packager.exe'))) 'Bad hash installed an executable'
    Require (-not (Test-Path -LiteralPath (Join-Path $failedRoot 'identity-pkr_aaaaaaaaaaaaaaaa.pem'))) 'Bad hash enrolled an identity'
    $originalLocal = $env:LOCALAPPDATA
    $env:LOCALAPPDATA = Join-Path $workspace 'junction app'
    $null = New-Item -ItemType Directory -Path (Join-Path $env:LOCALAPPDATA 'Ananta') -Force
    $alias = Join-Path $env:LOCALAPPDATA 'Ananta\NativePackager'
    $null = New-Item -ItemType Junction -Path $alias -Value $base
    Expect-Failure { & (Join-Path $FixtureDirectory 'bad-hash.ps1') }
    [IO.Directory]::Delete($alias)
    $env:LOCALAPPDATA = $originalLocal

    $uninstall = Join-Path $first ('uninstall-' + $ids[0] + '.ps1')
    $unknown = Join-Path $first 'user-file.txt'
    [IO.File]::WriteAllText($unknown, 'preserve')
    Expect-Failure { & $uninstall }
    Require ([IO.File]::ReadAllText($unknown) -eq 'preserve') 'Unknown file was removed'
    Remove-Item -LiteralPath $unknown
    $junction = Join-Path $first 'output\junction'
    $null = New-Item -ItemType Junction -Path $junction -Value $second
    Expect-Failure { & $uninstall }
    Require (Test-Path -LiteralPath (Join-Path $second ('identity-' + $ids[1] + '.pem'))) 'Uninstaller followed a junction'
    [IO.Directory]::Delete($junction)
    & $uninstall
    Require (-not (Test-Path -LiteralPath $first)) 'First installation survived uninstall'
    Require (Test-Path -LiteralPath $second) 'Second installation was removed'
    $other = Get-Process -Id $secondPID
    Require (-not $other.HasExited) 'Second process was stopped'
    $other.Dispose()
    Require (Test-Path -LiteralPath (Join-Path $startup ('ananta-native-packager-' + $ids[1] + '.cmd'))) 'Second autostart was removed'
    & (Join-Path $second ('uninstall-' + $ids[1] + '.ps1'))
    Require (-not (Test-Path -LiteralPath $second)) 'Second installation cleanup failed'
    Require (Test-Path -LiteralPath $base) 'Shared base was removed'
    Write-Output 'PASS duplicate/hash protection, unknown-file/junction rejection and per-device process/uninstall isolation'
} finally {
    # Only synthetic binaries under this exact GUID-scoped test directory.
    foreach ($candidate in @(Get-Process -Name 'native-broadcast-packager' -ErrorAction SilentlyContinue)) {
        try { if ($candidate.Path -and $candidate.Path.StartsWith($workspace + '\', [StringComparison]::OrdinalIgnoreCase)) { $candidate.Kill(); $null = $candidate.WaitForExit(5000) } }
        finally { $candidate.Dispose() }
    }
    $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(10)
    while (Test-Path -LiteralPath $workspace) {
        try { Remove-Item -LiteralPath $workspace -Recurse -Force }
        catch { if ([DateTime]::UtcNow -ge $cleanupDeadline) { throw }; Start-Sleep -Milliseconds 100 }
    }
}
