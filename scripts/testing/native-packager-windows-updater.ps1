param([Parameter(Mandatory=$true)][string]$FixtureDirectory,[string]$DownloadOrigin)
$ErrorActionPreference = 'Stop'
$workspace = Join-Path ([IO.Path]::GetTempPath()) ('ananta-updater-gate ' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $workspace
$env:LOCALAPPDATA = Join-Path $workspace 'local app'
$env:APPDATA = Join-Path $workspace 'roaming app'
$startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$null = New-Item -ItemType Directory -Path $startup -Force
$ids = @('pkr_0123456789abcdef','pkr_fedcba9876543210')
$base = Join-Path $env:LOCALAPPDATA 'Ananta\NativePackager'
$originalTls = [Net.ServicePointManager]::SecurityProtocol
Add-Type -Path (Join-Path $PSScriptRoot 'native-packager-windows-download.cs')
if (-not [Net.WebRequest]::RegisterPrefix('https://webrtc.example/downloads/native-packager/',(New-Object PackagerFixtureRequestCreator))) { throw 'Fixture prefix already registered.' }
function Invoke-WebRequest { param([switch]$UseBasicParsing,$Uri,$OutFile) Copy-Item -LiteralPath (Join-Path $FixtureDirectory 'old.exe') -Destination $OutFile }
function Require([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
function Expected([string]$Version) {
    $env:ANANTA_UPDATE_ARTIFACT = Join-Path $FixtureDirectory ($Version + '.exe')
    return (Get-FileHash -LiteralPath $env:ANANTA_UPDATE_ARTIFACT -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Expect-Failure([scriptblock]$Action) {
    $failed = $false; try { & $Action } catch { $failed = $true }
    Require $failed 'Negative updater case unexpectedly succeeded'
}
function Process-At([string]$Root) {
    $marker = Join-Path $Root 'output\process.pid'
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $marker)) { if ([DateTime]::UtcNow -gt $deadline) { throw 'Fixture did not start' }; Start-Sleep -Milliseconds 50 }
    return [int][IO.File]::ReadAllText($marker)
}
function Require-Version([string]$Root,[string]$Version) { Require ([IO.File]::ReadAllText((Join-Path $Root 'output\version.txt')) -ceq $Version) 'Unexpected running binary version' }
try {
    foreach ($id in $ids) { & (Join-Path $FixtureDirectory ($id + '.ps1')); $null = Process-At (Join-Path $base $id) }
    $first = Join-Path $base $ids[0]; $second = Join-Path $base $ids[1]
    $secondProcess = Get-Process -Id (Process-At $second)
    $null = $secondProcess.Handle
    $updater = Join-Path $first ('update-' + $ids[0] + '.ps1')
    $uninstaller = Join-Path $first ('uninstall-' + $ids[0] + '.ps1')
    & $updater update (Expected 'new'); Require-Version $first 'new'
    $firstBackup = [IO.File]::ReadAllText((Join-Path $first '.rollback-ref'))
    & $updater rollback; Require-Version $first 'old'
    Require (-not (Test-Path -LiteralPath (Join-Path $first $firstBackup))) 'Stale known backup not removed'
    foreach ($version in @('badstart','delayed')) {
        Expect-Failure { & $updater update (Expected $version) }
        Require-Version $first 'old'
        Require (-not (Test-Path -LiteralPath (Join-Path $first '.update-active'))) 'Automatic recovery left a journal'
    }
    Write-Output 'PASS Windows update, rollback and automatic failure recovery'
    $originalPID = Process-At $first
    Expect-Failure { & $updater update ('0' * 64) }
    Expect-Failure { & $updater update (Expected 'badpreflight') }
    foreach ($mode in @('redirect','oversize','stream-oversize')) {
        $env:ANANTA_UPDATE_DOWNLOAD_MODE = $mode
        Expect-Failure { & $updater update (Expected 'new') }
    }
    $env:ANANTA_UPDATE_DOWNLOAD_MODE = ''
    Require ([Net.ServicePointManager]::SecurityProtocol -eq $originalTls) 'Request changed the calling process TLS setting'
    Require ((Process-At $first) -eq $originalPID) 'Rejected candidate stopped the agent'
    $lock = [IO.File]::Open((Join-Path $first '.maintenance.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try { Expect-Failure { & $updater update (Expected 'new') }; Expect-Failure { & $uninstaller } } finally { $lock.Dispose() }

    # Construct the exact post-swap interrupted state on real NTFS. No fake claim of a power-loss test.
    $reference = [IO.File]::ReadAllText((Join-Path $first '.rollback-ref'))
    $work = Join-Path $first $reference
    [IO.File]::WriteAllText((Join-Path $first '.update-active'),$reference)
    $current = Get-Process -Id (Process-At $first)
    $current.Kill(); Require ($current.WaitForExit(5000)) 'Fixture stop failed'; $current.Dispose()
    Start-Sleep -Milliseconds 500
    $launcher = Join-Path $first ('run-' + $ids[0] + '.ps1')
    $blockedLauncher = Start-Process powershell.exe -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $launcher + '"'))
    Require ($blockedLauncher.WaitForExit(5000)) 'Default launcher bypassed interrupted transaction'; $blockedLauncher.Dispose()
    Expect-Failure { & $updater update (Expected 'new') }; Expect-Failure { & $uninstaller }
    [IO.File]::WriteAllText((Join-Path $work 'restore.exe'),'interrupted-copy')
    $heldRunning = [IO.File]::Open((Join-Path $first '.running.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try { Expect-Failure { & $updater recover }; Require (Test-Path -LiteralPath (Join-Path $first '.update-active')) 'Failed recovery discarded its marker' }
    finally { $heldRunning.Dispose() }
    & $updater recover; Require-Version $first 'new'
    Require (Test-Path -LiteralPath (Join-Path $work 'old.exe')) 'Published rollback backup disappeared during recovery'
    Write-Output 'PASS interrupted Windows transaction recovery and default launcher fence'

    if ($DownloadOrigin) {
        # Run the exact generated download function, but never the downloaded EXE.
        $tokens = $null; $parseErrors = $null
        $ast = [Management.Automation.Language.Parser]::ParseFile($updater,[ref]$tokens,[ref]$parseErrors)
        Require ($parseErrors.Count -eq 0) 'Generated updater parse failed'
        $downloadFunction = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Receive-Artifact'},$true)
        . ([scriptblock]::Create($downloadFunction.Extent.Text))
        $artifactUrl = $DownloadOrigin + '/downloads/native-packager/windows-amd64'
        $downloaded = Join-Path $workspace 'https-artifact.exe'
        Receive-Artifact $downloaded
        $stream = [IO.File]::OpenRead($downloaded)
        try { Require ($stream.Length -gt 1024 -and $stream.ReadByte() -eq 77 -and $stream.ReadByte() -eq 90) 'Windows PE download invalid' }
        finally { $stream.Dispose() }
        Require ([Net.ServicePointManager]::SecurityProtocol -eq $originalTls) 'Real download retained TLS setting'
        [IO.File]::Delete($downloaded)
        Write-Output 'PASS real Windows HTTPS artifact download without execution'
    } else { Write-Output 'SKIP real Windows HTTPS artifact: set WINDOWS_PACKAGER_DOWNLOAD_ORIGIN to an explicit HTTPS origin' }

    [IO.File]::WriteAllText((Join-Path $work 'old.exe'),'tampered')
    Expect-Failure { & $updater rollback }
    [IO.File]::WriteAllText((Join-Path $first '.rollback-ref'),'..\outside')
    Expect-Failure { & $updater rollback }
    $alias = Join-Path $first '.update-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    $null = New-Item -ItemType Junction -Path $alias -Value $second
    [IO.File]::WriteAllText((Join-Path $first '.rollback-ref'),'.update-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    Expect-Failure { & $updater rollback }; [IO.Directory]::Delete($alias)
    foreach ($id in $ids) { Require ([IO.File]::ReadAllText((Join-Path (Join-Path $base $id) ('identity-' + $id + '.pem'))) -ceq $id) 'Identity changed' }
    $binaryAcl = Get-Acl -LiteralPath (Join-Path $first 'native-broadcast-packager.exe')
    Require ($binaryAcl.Access.Count -eq 1) 'Updated binary has unexpected ACL entries'
    Require ($binaryAcl.Access[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) 'Updated binary lost private owner ACL'
    Require (-not $secondProcess.HasExited) 'Second process was stopped'
    Require ((Process-At $second) -eq $secondProcess.Id) 'Second process was replaced'
    $secondProcess.Dispose()
    & $uninstaller
    Require (-not (Test-Path -LiteralPath $first)) 'Updated installation survived uninstall'
    Require (Test-Path -LiteralPath $second) 'Other installation removed'
    & (Join-Path $second ('uninstall-' + $ids[1] + '.ps1'))
    Write-Output 'PASS Windows bounded downloads, preflight, locks, backup rejection and two-agent isolation'
} finally {
    # Only synthetic binaries inside the exact random NTFS fixture directory.
    foreach ($candidate in @(Get-Process -Name 'native-broadcast-packager' -ErrorAction SilentlyContinue)) {
        try { if ($candidate.Path -and $candidate.Path.StartsWith($workspace + '\',[StringComparison]::OrdinalIgnoreCase)) { $candidate.Kill(); $null = $candidate.WaitForExit(5000) } }
        finally { $candidate.Dispose() }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (Test-Path -LiteralPath $workspace) {
        try { Remove-Item -LiteralPath $workspace -Recurse -Force }
        catch { if ([DateTime]::UtcNow -ge $deadline) { throw }; Start-Sleep -Milliseconds 100 }
    }
}
