# Appended to a validated per-device updater. No enrollment or policy authority.
if ($args.Count -ne 0 -or $Action -cnotin @('update','rollback','recover')) { throw 'Use update <verified-sha256>, rollback, or recover.' }
if ($Action -eq 'update') {
    if ($ExpectedSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Expected SHA-256 is invalid.' }
} elseif ($ExpectedSha256) { throw 'Unexpected checksum argument.' }
$base = Join-Path $env:LOCALAPPDATA 'Ananta\NativePackager'
$root = Join-Path $base $packagerId
$binary = Join-Path $root 'native-broadcast-packager.exe'
$launcher = Join-Path $root ('run-' + $packagerId + '.ps1')
$identity = Join-Path $root ('identity-' + $packagerId + '.pem')
$active = Join-Path $root '.update-active'
$rollback = Join-Path $root '.rollback-ref'
$env:NATIVE_PACKAGER_IDENTITY_FILE = $identity
$env:NATIVE_PACKAGER_OUTPUT_ROOT = Join-Path $root 'output'

function Require-File([string]$File) {
    $entry = Get-Item -LiteralPath $File -Force
    if ($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe maintenance file.' }
}
function Get-Hash([string]$File) { return (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() }
foreach ($scope in @((Split-Path -Parent $base),$base,$root)) {
    $entry = Get-Item -LiteralPath $scope -Force
    if (-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe installation directory.' }
}
foreach ($file in @($binary,$launcher,$identity)) { Require-File $file }
foreach ($name in @('.maintenance.lock','.running.lock','.update-active','.rollback-ref')) {
    $file = Join-Path $root $name
    if (Test-Path -LiteralPath $file) { Require-File $file }
}
if (Test-Path -LiteralPath (Join-Path $root '.uninstalling')) { throw 'Uninstall in progress; files preserved.' }
try { $maintenance = [IO.File]::Open((Join-Path $root '.maintenance.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
catch [IO.IOException] { throw 'Another maintenance operation is active.' }

function Get-Work([string]$Reference) {
    if ($Reference -cnotmatch '^\.update-[0-9a-f]{32}$') { throw 'Invalid transaction reference.' }
    $directory = Join-Path $root $Reference
    $entry = Get-Item -LiteralPath $directory -Force
    if (-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe transaction directory.' }
    $old = Join-Path $directory 'old.exe'
    $hashFile = Join-Path $directory 'old.sha256'
    Require-File $old; Require-File $hashFile
    if ((Get-Item -LiteralPath $old).Length -gt 134217728 -or (Get-Item -LiteralPath $hashFile).Length -gt 66) { throw 'Oversized backup.' }
    $expected = [IO.File]::ReadAllText($hashFile).TrimEnd("`r","`n")
    if ($expected -cnotmatch '^[a-f0-9]{64}$' -or (Get-Hash $old) -cne $expected) { throw 'Backup SHA-256 mismatch.' }
    return $directory
}
function Read-Reference([string]$File) {
    Require-File $File
    if ((Get-Item -LiteralPath $File).Length -gt 48) { throw 'Oversized transaction reference.' }
    $reference = [IO.File]::ReadAllText($File).TrimEnd("`r","`n")
    $null = Get-Work $reference
    return $reference
}
function Write-Reference([string]$File, [string]$Reference, [string]$Directory) {
    $temporary = Join-Path $Directory 'ref'
    if (Test-Path -LiteralPath $temporary) { throw 'Unexpected transaction scratch file.' }
    $stream = [IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $bytes = [Text.Encoding]::ASCII.GetBytes($Reference); $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
    if (Test-Path -LiteralPath $File) { Require-File $File; [IO.File]::Replace($temporary,$File,[NullString]::Value) }
    else { [IO.File]::Move($temporary,$File) }
}
function Invoke-Preflight([string]$Executable) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $Executable; $info.Arguments = 'preflight'; $info.UseShellExecute = $false
    $info.CreateNoWindow = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    try {
        $null = $process.Start(); $process.BeginOutputReadLine(); $process.BeginErrorReadLine()
        if (-not $process.WaitForExit(15000)) { $process.Kill(); $null = $process.WaitForExit(5000); throw 'Preflight timed out.' }
        if ($process.ExitCode -ne 0) { throw 'Preflight failed.' }
    } finally { $process.Dispose() }
}
function Get-AgentProcesses {
    foreach ($candidate in @(Get-Process -Name 'native-broadcast-packager' -ErrorAction SilentlyContinue)) {
        if ([String]::Equals($candidate.Path,$binary,[StringComparison]::OrdinalIgnoreCase)) { $candidate }
        else { $candidate.Dispose() }
    }
}
function Stop-Agent {
    foreach ($candidate in @(Get-AgentProcesses)) {
        try { $null = $candidate.Handle; if (-not $candidate.HasExited) { $candidate.Kill(); if (-not $candidate.WaitForExit(5000)) { throw 'Agent stop not confirmed.' } } }
        finally { $candidate.Dispose() }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ($true) {
        try { $held = [IO.File]::Open((Join-Path $root '.running.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); $held.Dispose(); return }
        catch [IO.IOException] { if ([DateTime]::UtcNow -ge $deadline) { throw 'Launcher stop not confirmed.' }; Start-Sleep -Milliseconds 100 }
    }
}
function Start-Agent([string]$Reference) {
    $started = Start-Process powershell.exe -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $launcher + '"'),'-MaintenanceTransaction',$Reference)
    $observed = $null
    try {
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        while ($null -eq $observed) {
            if ($started.HasExited) { throw 'Candidate launcher exited.' }
            $candidates = @(Get-AgentProcesses)
            if ($candidates.Count -gt 1) { foreach ($candidate in $candidates) { $candidate.Dispose() }; throw 'Unexpected duplicate agent.' }
            if ($candidates.Count -eq 1) { $observed = $candidates[0]; $null = $observed.Handle; break }
            if ([DateTime]::UtcNow -ge $deadline) { throw 'Candidate did not start.' }
            Start-Sleep -Milliseconds 100
        }
        if ($observed.WaitForExit(10000)) { throw 'Candidate did not remain active.' }
        if ($started.HasExited) { throw 'Candidate launcher exited.' }
    } finally { if ($null -ne $observed) { $observed.Dispose() }; $started.Dispose() }
}
function Receive-Artifact([string]$Destination) {
    # No redirects, credentials or platform-global TLS-validation changes.
    if (([Uri]$artifactUrl).Scheme -cne 'https') { throw 'HTTPS artifact URL required.' }
    $request = [Net.WebRequest]::Create($artifactUrl)
    $request.AllowAutoRedirect = $false; $request.Timeout = 15000; $request.ReadWriteTimeout = 15000
    $response = $null; $inputStream = $null; $outputStream = $null
    $previousTls = [Net.ServicePointManager]::SecurityProtocol
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $response = $request.GetResponse()
        if ([int]$response.StatusCode -ne 200 -or $response.ResponseUri.AbsoluteUri -cne $artifactUrl) { throw 'Artifact redirect or HTTP failure.' }
        if ($response.ContentLength -gt 134217728) { throw 'Artifact exceeds download budget.' }
        $inputStream = $response.GetResponseStream()
        $outputStream = [IO.File]::Open($Destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        $buffer = New-Object byte[] 65536; $total = 0
        while ($true) {
            $count = $inputStream.Read($buffer,0,$buffer.Length)
            if ([DateTime]::UtcNow -gt $deadline) { throw 'Artifact exceeds download budget.' }
            if ($count -eq 0) { break }
            $total += $count
            if ($total -gt 134217728) { throw 'Artifact exceeds download budget.' }
            $outputStream.Write($buffer,0,$count)
        }
        $outputStream.Flush($true)
    } finally {
        [Net.ServicePointManager]::SecurityProtocol = $previousTls
        if ($null -ne $outputStream) { $outputStream.Dispose() }
        if ($null -ne $inputStream) { $inputStream.Dispose() }
        if ($null -ne $response) { $response.Dispose() }
        $request.Abort()
    }
}
function Remove-Work([string]$Directory) {
    foreach ($entry in @(Get-ChildItem -LiteralPath $Directory -Force)) {
        if ($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $entry.Name -cnotin @('candidate.exe','old.exe','old.sha256','ref','restore.exe')) { throw 'Unexpected staging files; inspect locally.' }
    }
    foreach ($entry in @(Get-ChildItem -LiteralPath $Directory -Force)) { [IO.File]::Delete($entry.FullName) }
    [IO.Directory]::Delete($Directory)
}
function Restore-Work([string]$Reference) {
    $directory = Get-Work $Reference
    $old = Join-Path $directory 'old.exe'
    Invoke-Preflight $old
    if (Test-Path -LiteralPath $active) {
        if ((Read-Reference $active) -cne $Reference) { throw 'Transaction changed; files preserved.' }
    } else {
        $scratch = Join-Path $directory 'ref'
        if (Test-Path -LiteralPath $scratch) { Require-File $scratch; [IO.File]::Delete($scratch) }
        Write-Reference $active $Reference $directory
    }
    $restore = Join-Path $directory 'restore.exe'
    if (Test-Path -LiteralPath $restore) { Require-File $restore; [IO.File]::Delete($restore) }
    Stop-Agent
    [IO.File]::Copy($old,$restore)
    [IO.File]::Replace($restore,$binary,[NullString]::Value)
    Start-Agent $Reference
    [IO.File]::Delete($active)
    if (-not (Test-Path -LiteralPath $rollback) -or (Read-Reference $rollback) -cne $Reference) { Remove-Work $directory }
}

$work = $null; $reference = $null; $pending = $false; $committed = $false
try {
    if (Test-Path -LiteralPath (Join-Path $root '.uninstalling')) { throw 'Uninstall in progress; files preserved.' }
    if ($Action -eq 'recover') { Restore-Work (Read-Reference $active); Write-Output 'Previous binary recovered; identity unchanged. Verify account connectivity in the app.'; return }
    if (Test-Path -LiteralPath $active) { throw 'Interrupted transaction exists; use recover.' }
    $running = @(Get-AgentProcesses)
    $runningCount = $running.Count
    foreach ($candidate in $running) { $candidate.Dispose() }
    if ($runningCount -ne 1) { throw 'Exactly one installed agent must be running before maintenance.' }
    $oldReference = $null
    if (Test-Path -LiteralPath $rollback) { $oldReference = Read-Reference $rollback }
    if ($Action -eq 'rollback' -and -not $oldReference) { throw 'No rollback backup available.' }
    $reference = '.update-' + [Guid]::NewGuid().ToString('N')
    $work = Join-Path $root $reference
    $null = New-Item -ItemType Directory -Path $work
    $candidateFile = Join-Path $work 'candidate.exe'
    if ($Action -eq 'update') {
        Receive-Artifact $candidateFile
        if ((Get-Hash $candidateFile) -cne $ExpectedSha256) { throw 'SHA-256 mismatch; agent unchanged.' }
    } else { [IO.File]::Copy((Join-Path (Get-Work $oldReference) 'old.exe'),$candidateFile) }
    Invoke-Preflight $candidateFile
    [IO.File]::Copy($binary,(Join-Path $work 'old.exe'))
    [IO.File]::WriteAllText((Join-Path $work 'old.sha256'),(Get-Hash (Join-Path $work 'old.exe')))
    $null = Get-Work $reference; Invoke-Preflight (Join-Path $work 'old.exe')
    $pending = $true
    Write-Reference $active $reference $work
    Stop-Agent
    [IO.File]::Replace($candidateFile,$binary,[NullString]::Value)
    Start-Agent $reference
    Write-Reference $rollback $reference $work
    $committed = $true
    [IO.File]::Delete($active)
    if ($oldReference) { Remove-Work (Join-Path $root $oldReference) }
    Write-Output 'Binary switched; previous version retained and identity unchanged. Verify account connectivity in the app.'
} catch {
    if ($pending -and -not $committed) {
        try { Restore-Work $reference; Write-Warning 'Update failed; previous binary restored.' }
        catch { Write-Warning 'Automatic recovery failed; use recover. Files preserved.' }
    } elseif ($null -ne $work -and -not $committed) { Remove-Work $work }
    throw
} finally { $maintenance.Dispose() }
