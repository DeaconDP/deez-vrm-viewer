#Requires -Version 5.1
param(
  [switch]$FromExe,
  # Exit 0 if release build matches sources; exit 2 if stale/missing. No splash/UI.
  [switch]$VerifyOnly,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$AppArgs
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$RunDir = Join-Path $Root '.run'
# #region agent log
$DebugLogFile = Join-Path $Root 'debug-b8de1c.log'
function Write-AgentLog {
  param(
    [string]$HypothesisId,
    [string]$Location,
    [string]$Message,
    [hashtable]$Data = @{}
  )
  try {
    $payload = [ordered]@{
      sessionId = 'b8de1c'
      runId = 'post-fix'
      hypothesisId = $HypothesisId
      location = $Location
      message = $Message
      data = $Data
      timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    $json = ($payload | ConvertTo-Json -Compress -Depth 6)
    [System.IO.File]::AppendAllText($DebugLogFile, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
  } catch { }
}
# #endregion
$StatusFile = Join-Path $RunDir 'status.txt'
$ProgressFile = Join-Path $RunDir 'progress.txt'
$FeedFile = Join-Path $RunDir 'feed.txt'
$LogFile = Join-Path $RunDir 'setup.log'
$StampFile = Join-Path $RunDir 'built-stamp'
$StampTmpFile = Join-Path $RunDir 'built-stamp.tmp'
$BuildLockFile = Join-Path $RunDir 'build.lock'
$SplashHtml = Join-Path $PSScriptRoot 'loading.hta'
$SplashPidFile = Join-Path $RunDir 'splash.pid'
$ReleaseExe = Join-Path $Root 'src-tauri\target\release\deez-vrm-viewer.exe'
$GitDir = Join-Path $Root '.git'
$LockFile = Join-Path $Root 'package-lock.json'
$FetchTimeoutSec = 8
$StampVersion = '2'
$MaxBuildSourceDriftAttempts = 2
$script:CurrentProgress = 0
$script:BuildLockStream = $null

function Write-Status([string]$Text) {
  [System.IO.File]::WriteAllText($StatusFile, $Text, [System.Text.UTF8Encoding]::new($false))
}

function Write-ProgressValue([int]$Value) {
  if ($Value -lt 0) { $Value = 0 }
  if ($Value -gt 100) { $Value = 100 }
  if ($Value -lt $script:CurrentProgress) { $Value = $script:CurrentProgress }
  $script:CurrentProgress = $Value
  [System.IO.File]::WriteAllText($ProgressFile, [string]$Value, [System.Text.UTF8Encoding]::new($false))
}

function Sanitize-FeedLine([string]$Line) {
  if ($null -eq $Line) { return '' }
  $clean = [regex]::Replace($Line, '\x1B\[[0-9;]*[A-Za-z]', '')
  $clean = [regex]::Replace($clean, '[^\x20-\x7E]', '')
  $clean = $clean.Trim()
  $clean = [regex]::Replace($clean, '\s{2,}', ' ')
  if ($clean.Length -gt 120) { $clean = $clean.Substring(0, 117) + '...' }
  if ($clean -match '^[\\|/_\-\.]+$') { return '' }
  if ($clean -match '^(?:[\|/\-\\]|[.\s])+$') { return '' }
  return $clean
}

function Write-Feed([string]$Line) {
  $clean = Sanitize-FeedLine $Line
  if (-not $clean) { return }
  [System.IO.File]::AppendAllText($FeedFile, $clean + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
}

function Set-LaunchStep {
  param(
    [string]$Status,
    [int]$Progress,
    [string]$Feed = $null
  )
  Write-ProgressValue $Progress
  Write-Status $Status
  if ($Feed) { Write-Feed $Feed }
  else { Write-Feed $Status }
}

function Show-ErrorDialog([string]$Message) {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue | Out-Null
  [System.Windows.Forms.MessageBox]::Show(
    $Message,
    'Deez VRM Viewer',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
}

function Stop-OwnedPid([string]$FilePath) {
  if (-not (Test-Path -LiteralPath $FilePath)) { return }
  $raw = (Get-Content -LiteralPath $FilePath -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($raw -match '^\d+$') {
    $procId = [int]$raw
    if (Get-Process -Id $procId -ErrorAction SilentlyContinue) {
      cmd /c "taskkill /PID $procId /T /F >nul 2>&1" | Out-Null
    }
  }
  Remove-Item -LiteralPath $FilePath -Force -ErrorAction SilentlyContinue
}

function Start-Splash {
  if (-not (Test-Path -LiteralPath $SplashHtml)) {
    throw "Missing splash file: $SplashHtml"
  }
  $proc = Start-Process -FilePath 'mshta.exe' -ArgumentList "`"$SplashHtml`"" -PassThru -WindowStyle Normal
  Set-Content -LiteralPath $SplashPidFile -Value $proc.Id -NoNewline
  return $proc
}

function Close-Splash {
  Write-ProgressValue 100
  Write-Feed 'Ready'
  Write-Status 'Ready'
  Start-Sleep -Milliseconds 450
  Stop-OwnedPid $SplashPidFile
}

function Fail-Launch([string]$Message) {
  Write-Feed 'ERROR'
  Write-Status 'ERROR'
  Start-Sleep -Milliseconds 200
  Release-BuildLock
  Stop-OwnedPid $SplashPidFile
  Show-ErrorDialog $Message
  exit 1
}

function Get-NpmPath {
  $npm = Join-Path $env:ProgramFiles 'nodejs\npm.cmd'
  if (Test-Path -LiteralPath $npm) { return $npm }
  $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npmCmd) {
    Fail-Launch "npm was not found after Node.js setup.`n`nReinstall Node.js 20+, then try again."
  }
  return $npmCmd.Source
}

function Get-FileSha256([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-GitHead {
  if (-not (Test-Path -LiteralPath $GitDir)) { return '' }
  try {
    $head = & git -C $Root rev-parse HEAD 2>$null
    if ($LASTEXITCODE -ne 0) { return '' }
    return ($head | Select-Object -First 1).ToString().Trim()
  } catch {
    return ''
  }
}

function ConvertTo-RepoRelative([string]$FullPath) {
  return $FullPath.Substring($Root.Length).TrimStart('\', '/').Replace('\', '/')
}

function Test-MetaOnlySourceFile([System.IO.FileInfo]$File) {
  if ($File.Length -gt 262144) { return $true }
  $ext = $File.Extension.ToLowerInvariant()
  return $ext -match '^\.(png|jpe?g|gif|webp|ico|icns|glb|gltf|woff2?|ttf|otf|mp3|wav|bin)$'
}

function Get-WatchedSourceFiles {
  $files = New-Object System.Collections.Generic.List[System.IO.FileInfo]
  $rootedFiles = @(
    'index.html',
    'package.json',
    'package-lock.json',
    'vite.config.ts',
    'tsconfig.json',
    'tsconfig.node.json',
    'src-tauri\Cargo.toml',
    'src-tauri\Cargo.lock',
    'src-tauri\tauri.conf.json',
    'src-tauri\build.rs'
  )
  foreach ($rel in $rootedFiles) {
    $full = Join-Path $Root $rel
    if (Test-Path -LiteralPath $full) {
      $files.Add((Get-Item -LiteralPath $full))
    }
  }

  $watchDirs = @(
    (Join-Path $Root 'src'),
    (Join-Path $Root 'public'),
    (Join-Path $Root 'src-tauri\src'),
    (Join-Path $Root 'src-tauri\capabilities'),
    (Join-Path $Root 'src-tauri\permissions'),
    (Join-Path $Root 'src-tauri\icons')
  )
  foreach ($dir in $watchDirs) {
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    Get-ChildItem -LiteralPath $dir -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
      $files.Add($_)
    }
  }
  return $files
}

function Get-SourceEntryFingerprint([System.IO.FileInfo]$File) {
  $rel = ConvertTo-RepoRelative $File.FullName
  if (Test-MetaOnlySourceFile $File) {
    return "$rel|meta|$($File.Length)|$($File.LastWriteTimeUtc.Ticks)"
  }
  $hash = Get-FileSha256 $File.FullName
  return "$rel|sha|$hash"
}

function Get-SourcesFingerprint {
  $parts = New-Object System.Collections.Generic.List[string]
  foreach ($file in (Get-WatchedSourceFiles | Sort-Object FullName)) {
    $parts.Add((Get-SourceEntryFingerprint $file))
  }
  if ($parts.Count -eq 0) { return 'empty' }
  $raw = [string]::Join("`n", $parts)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($raw)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha.ComputeHash($bytes)
  } finally {
    $sha.Dispose()
  }
  return ([System.BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
}

function Get-StampMap([string]$Text) {
  $map = @{}
  foreach ($line in (($Text -replace "`r", '').Trim() -split "`n")) {
    $trim = $line.Trim()
    if (-not $trim) { continue }
    $eq = $trim.IndexOf('=')
    if ($eq -lt 1) { continue }
    $key = $trim.Substring(0, $eq)
    $value = $trim.Substring($eq + 1)
    $map[$key] = $value
  }
  return $map
}

function Get-DesiredStamp {
  if (-not (Test-Path -LiteralPath $ReleaseExe)) {
    throw "Release binary missing while writing freshness stamp: $ReleaseExe"
  }
  $sources = Get-SourcesFingerprint
  $exeHash = Get-FileSha256 $ReleaseExe
  $head = Get-GitHead
  $lockHash = Get-FileSha256 $LockFile
  return @(
    "version=$StampVersion"
    "sources=$sources"
    "exe=$exeHash"
    "head=$head"
    "lock=$lockHash"
  ) -join "`n"
}

function Clear-BuildStamp {
  Remove-Item -LiteralPath $StampFile, $StampTmpFile -Force -ErrorAction SilentlyContinue
}

function Write-BuildStamp {
  $stamp = Get-DesiredStamp
  New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
  [System.IO.File]::WriteAllText($StampTmpFile, $stamp, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $StampTmpFile -Destination $StampFile -Force
}

function Test-BuildFresh {
  if (-not (Test-Path -LiteralPath $ReleaseExe)) { return $false }
  if (-not (Test-Path -LiteralPath $StampFile)) { return $false }

  try {
    $saved = Get-StampMap ([System.IO.File]::ReadAllText($StampFile))
  } catch {
    return $false
  }

  if ($saved['version'] -ne $StampVersion) { return $false }

  $exeHash = Get-FileSha256 $ReleaseExe
  if (-not $exeHash -or $saved['exe'] -ne $exeHash) { return $false }

  $sources = Get-SourcesFingerprint
  if (-not $sources -or $saved['sources'] -ne $sources) { return $false }

  return $true
}

function Assert-BuildFresh([string]$Context) {
  if (Test-BuildFresh) { return }
  Clear-BuildStamp
  Fail-Launch "Refusing to start a stale Deez VRM Viewer build ($Context).`n`nRun run.bat again so it can rebuild from your current sources.`nDetails: $LogFile"
}

function Release-BuildLock {
  if ($null -ne $script:BuildLockStream) {
    try { $script:BuildLockStream.Close() } catch { }
    try { $script:BuildLockStream.Dispose() } catch { }
    $script:BuildLockStream = $null
  }
  Remove-Item -LiteralPath $BuildLockFile -Force -ErrorAction SilentlyContinue
}

function Enter-BuildLock {
  New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
  $deadline = (Get-Date).AddMinutes(45)
  while ($true) {
    try {
      $stream = [System.IO.File]::Open(
        $BuildLockFile,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
      )
      $payload = [System.Text.Encoding]::UTF8.GetBytes("$PID $(Get-Date -Format o)")
      $stream.Write($payload, 0, $payload.Length)
      $script:BuildLockStream = $stream
      return
    } catch {
      if ((Test-Path -LiteralPath $BuildLockFile)) {
        $age = (Get-Date).ToUniversalTime() - (Get-Item -LiteralPath $BuildLockFile).LastWriteTimeUtc
        if ($age.TotalMinutes -gt 45) {
          Remove-Item -LiteralPath $BuildLockFile -Force -ErrorAction SilentlyContinue
          continue
        }
      }
      if ((Get-Date) -ge $deadline) {
        Fail-Launch "Another Deez VRM Viewer build is already running.`n`nWait for it to finish, then try again."
      }
      Write-Feed 'Waiting for another build to finish'
      Start-Sleep -Seconds 1
    }
  }
}

function Invoke-LoggedProcess {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory,
    [string]$OutLog,
    [string]$ErrLog,
    [int]$ProgressFloor,
    [int]$ProgressCeiling,
    [string]$FailMessage
  )

  if (Test-Path -LiteralPath $OutLog) { Remove-Item -LiteralPath $OutLog -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $ErrLog) { Remove-Item -LiteralPath $ErrLog -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType File -Force -Path $OutLog | Out-Null
  New-Item -ItemType File -Force -Path $ErrLog | Out-Null

  Write-ProgressValue $ProgressFloor
  # PowerShell Start-Process -RedirectStandard* leaves ExitCode $null for console/.cmd
  # hosts, and `$null -ne 0` falsely fails. Route through cmd.exe file redirects instead.
  $exePart = '"' + $FilePath + '"'
  $argsPart = @($ArgumentList | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $outPart = '"' + $OutLog + '"'
  $errPart = '"' + $ErrLog + '"'
  $cmdArguments = '/d /c "' + $exePart + ' ' + $argsPart + ' >' + $outPart + ' 2>' + $errPart + '"'
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'cmd.exe'
  $psi.Arguments = $cmdArguments
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  if (-not $proc) {
    Fail-Launch $FailMessage
  }

  $outPos = 0
  $errPos = 0
  $carryOut = ''
  $carryErr = ''
  $started = Get-Date

  function Read-NewChunk([string]$Path, [ref]$Pos, [ref]$Carry) {
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    $info = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
    if (-not $info -or $info.Length -le $Pos.Value) { return @() }

    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      $null = $stream.Seek($Pos.Value, [System.IO.SeekOrigin]::Begin)
      $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8, $true, 1024, $true)
      $chunk = $reader.ReadToEnd()
      $Pos.Value = $stream.Position
      $reader.Close()
    } finally {
      $stream.Close()
    }

    if (-not $chunk) { return @() }
    $text = $Carry.Value + $chunk
    $parts = $text -split "`r?`n", -1
    if ($text.EndsWith("`n") -or $text.EndsWith("`r")) {
      $Carry.Value = ''
      if ($parts.Count -gt 0 -and $parts[-1] -eq '') {
        return $parts[0..($parts.Count - 2)]
      }
      return $parts
    }
    $Carry.Value = $parts[-1]
    if ($parts.Count -le 1) { return @() }
    return $parts[0..($parts.Count - 2)]
  }

  function Add-FeedProgress([string]$Line) {
    $clean = Sanitize-FeedLine $Line
    if (-not $clean) { return }
    Write-Feed $clean
    $script:lineHits = $script:lineHits + 1
    $span = [Math]::Max(1, ($ProgressCeiling - $ProgressFloor - 1))
    $nudge = $ProgressFloor + [Math]::Min($span, [int]($script:lineHits * 0.35))
    Write-ProgressValue $nudge
  }

  $script:lineHits = 0
  while (-not $proc.HasExited) {
    foreach ($line in (Read-NewChunk $OutLog ([ref]$outPos) ([ref]$carryOut))) { Add-FeedProgress $line }
    foreach ($line in (Read-NewChunk $ErrLog ([ref]$errPos) ([ref]$carryErr))) { Add-FeedProgress $line }

    $elapsed = ((Get-Date) - $started).TotalSeconds
    $span = [Math]::Max(1, ($ProgressCeiling - $ProgressFloor - 1))
    $timeNudge = $ProgressFloor + [Math]::Min($span, [int]($elapsed / 4))
    Write-ProgressValue $timeNudge
    Start-Sleep -Milliseconds 250
  }

  Start-Sleep -Milliseconds 150
  $proc.WaitForExit() | Out-Null
  foreach ($line in (Read-NewChunk $OutLog ([ref]$outPos) ([ref]$carryOut))) { Write-Feed $line }
  foreach ($line in (Read-NewChunk $ErrLog ([ref]$errPos) ([ref]$carryErr))) { Write-Feed $line }
  if ($carryOut) { Write-Feed $carryOut }
  if ($carryErr) { Write-Feed $carryErr }

  # #region agent log
  $exitRaw = $proc.ExitCode
  $exitIsNull = $null -eq $exitRaw
  $neZero = $exitRaw -ne 0
  $outLen = if (Test-Path -LiteralPath $OutLog) { (Get-Item -LiteralPath $OutLog).Length } else { -1 }
  $errLen = if (Test-Path -LiteralPath $ErrLog) { (Get-Item -LiteralPath $ErrLog).Length } else { -1 }
  Write-AgentLog -HypothesisId 'A' -Location 'launch.ps1:Invoke-LoggedProcess' -Message 'process exit evaluated' -Data @{
    filePath = $FilePath
    argumentList = ($ArgumentList -join ' ')
    hasExited = [bool]$proc.HasExited
    exitCode = $exitRaw
    exitCodeIsNull = $exitIsNull
    treatsAsFailure = [bool]$neZero
    outLogBytes = $outLen
    errLogBytes = $errLen
    progressFloor = $ProgressFloor
    progressCeiling = $ProgressCeiling
    launchMode = 'cmd-file-redirect'
  }
  # #endregion

  if ($null -eq $proc.ExitCode -or $proc.ExitCode -ne 0) {
    # #region agent log
    Write-AgentLog -HypothesisId 'A' -Location 'launch.ps1:Invoke-LoggedProcess:fail' -Message 'Fail-Launch due to exit code check' -Data @{
      exitCode = $proc.ExitCode
      exitCodeIsNull = ($null -eq $proc.ExitCode)
      failMessage = $FailMessage
    }
    # #endregion
    Fail-Launch $FailMessage
  }
  Write-ProgressValue $ProgressCeiling
}

function Ensure-Node {
  Set-LaunchStep -Status 'Checking Node.js' -Progress 10 -Feed 'Checking Node.js'
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  $needsInstall = -not $node
  if (-not $needsInstall) {
    $major = 0
    try {
      $version = & node.exe -p "process.versions.node" 2>$null
      if ($version -match '^(\d+)') { $major = [int]$Matches[1] }
    } catch {
      $needsInstall = $true
    }
    if ($major -lt 20) { $needsInstall = $true }
  }

  if (-not $needsInstall) {
    Write-Feed 'Node.js ready'
    Write-ProgressValue 18
    return
  }

  Set-LaunchStep -Status 'Installing Node.js' -Progress 12 -Feed 'Installing Node.js via winget'
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) {
    Start-Process 'https://nodejs.org/en/download' | Out-Null
    Fail-Launch "Deez VRM Viewer needs Node.js 20 or newer.`n`nThe download page has been opened. Install Node.js, then run the launcher again."
  }

  $wingetArgs = @(
    'install', 'OpenJS.NodeJS.LTS',
    '--accept-package-agreements',
    '--accept-source-agreements'
  )
  $wingetProc = Start-Process -FilePath 'winget.exe' -ArgumentList $wingetArgs -Wait -PassThru -WindowStyle Hidden
  if ($wingetProc.ExitCode -ne 0) {
    Fail-Launch "Node.js setup could not finish.`n`nCheck your internet connection, then run Deez VRM Viewer again.`nDetails: $LogFile"
  }

  $env:Path = "$env:ProgramFiles\nodejs;" + $env:Path
  if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    Fail-Launch "Node.js was installed but is not on PATH yet.`n`nClose this dialog, open a new launcher run, and try again."
  }
  Write-Feed 'Node.js installed'
  Write-ProgressValue 18
}

function Ensure-Rust {
  Set-LaunchStep -Status 'Checking Rust' -Progress 20 -Feed 'Checking Rust toolchain'
  if ((Get-Command cargo.exe -ErrorAction SilentlyContinue) -and (Get-Command rustc.exe -ErrorAction SilentlyContinue)) {
    Write-Feed 'Rust toolchain ready'
    return
  }
  Start-Process 'https://rustup.rs/' | Out-Null
  Fail-Launch "Deez VRM Viewer needs the Rust toolchain (rustup).`n`nThe installer page has been opened. Install Rust, reopen your terminal session, then run the launcher again."
}

function Update-FromGit {
  if (-not (Test-Path -LiteralPath $GitDir)) {
    Write-Feed 'No git repo; skipping updates'
    Write-ProgressValue 32
    return
  }
  if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
    Write-Feed 'Git not found; skipping updates'
    Write-ProgressValue 32
    return
  }

  Set-LaunchStep -Status 'Checking updates' -Progress 25 -Feed 'Checking for updates'

  $fetchJob = Start-Job -ScriptBlock {
    param($RepoRoot)
    & git -C $RepoRoot fetch --quiet *> $null
    return [int]$LASTEXITCODE
  } -ArgumentList $Root

  $finished = Wait-Job -Job $fetchJob -Timeout $FetchTimeoutSec
  if (-not $finished) {
    Stop-Job -Job $fetchJob -ErrorAction SilentlyContinue
    Remove-Job -Job $fetchJob -Force -ErrorAction SilentlyContinue
    Write-Feed 'Update check timed out'
    Write-ProgressValue 32
    return
  }

  $fetchCode = @(Receive-Job -Job $fetchJob) | Select-Object -Last 1
  Remove-Job -Job $fetchJob -Force -ErrorAction SilentlyContinue
  if ($fetchCode -ne 0) {
    Write-Feed 'Update check skipped'
    Write-ProgressValue 32
    return
  }

  $porcelain = & git -C $Root status --porcelain 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-ProgressValue 32
    return
  }
  if ($porcelain) {
    Write-Feed 'Local changes present; skipping pull'
    Write-ProgressValue 32
    return
  }

  $upstream = & git -C $Root rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $upstream) {
    Write-Feed 'No upstream branch; skipping pull'
    Write-ProgressValue 32
    return
  }

  $counts = & git -C $Root rev-list --left-right --count 'HEAD...@{u}' 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $counts) {
    Write-ProgressValue 32
    return
  }
  $parts = ($counts | Select-Object -First 1).ToString().Trim() -split '\s+'
  if ($parts.Count -lt 2) {
    Write-ProgressValue 32
    return
  }
  $ahead = [int]$parts[0]
  $behind = [int]$parts[1]
  if ($behind -le 0 -or $ahead -gt 0) {
    Write-Feed 'Already up to date'
    Write-ProgressValue 32
    return
  }

  Set-LaunchStep -Status 'Updating' -Progress 28 -Feed 'Pulling updates'
  & git -C $Root pull --ff-only 2>&1 | ForEach-Object { Write-Feed ($_ | Out-String).Trim() } | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Feed 'Pull failed; continuing with local tree'
    Write-ProgressValue 32
    return
  }
  Write-Feed 'Repository updated'
  Write-ProgressValue 32
}

function Ensure-Dependencies {
  $marker = Join-Path $Root 'node_modules\.package-lock.json'
  $needsInstall = -not (Test-Path -LiteralPath $marker)
  if (-not $needsInstall -and (Test-Path -LiteralPath $LockFile)) {
    $lockTime = (Get-Item -LiteralPath $LockFile).LastWriteTimeUtc
    $markerTime = (Get-Item -LiteralPath $marker).LastWriteTimeUtc
    if ($lockTime -gt $markerTime) { $needsInstall = $true }
  }
  if (-not $needsInstall) {
    Set-LaunchStep -Status 'Dependencies ready' -Progress 55 -Feed 'Dependencies already installed'
    return
  }

  Set-LaunchStep -Status 'Installing dependencies' -Progress 35 -Feed 'Installing npm packages'
  $npm = Get-NpmPath
  $errLog = Join-Path $RunDir 'setup.err.log'
  Invoke-LoggedProcess `
    -FilePath $npm `
    -ArgumentList @('install') `
    -WorkingDirectory $Root `
    -OutLog $LogFile `
    -ErrLog $errLog `
    -ProgressFloor 35 `
    -ProgressCeiling 55 `
    -FailMessage "Setup could not finish.`n`nCheck your internet connection, then run Deez VRM Viewer again.`nDetails: $LogFile"
  Write-Feed 'Dependencies installed'
}

function Invoke-ReleaseBuildOnce {
  $npm = Get-NpmPath
  $errLog = Join-Path $RunDir 'setup.err.log'
  Clear-BuildStamp
  Invoke-LoggedProcess `
    -FilePath $npm `
    -ArgumentList @('run', 'tauri:build') `
    -WorkingDirectory $Root `
    -OutLog $LogFile `
    -ErrLog $errLog `
    -ProgressFloor 55 `
    -ProgressCeiling 90 `
    -FailMessage "Could not build Deez VRM Viewer.`n`nDetails: $LogFile"

  if (-not (Test-Path -LiteralPath $ReleaseExe)) {
    # #region agent log
    Write-AgentLog -HypothesisId 'B' -Location 'launch.ps1:Invoke-ReleaseBuildOnce' -Message 'ReleaseExe missing after build' -Data @{
      releaseExe = $ReleaseExe
      exists = $false
    }
    # #endregion
    Fail-Launch "Could not build Deez VRM Viewer.`n`nDetails: $LogFile"
  }
  # #region agent log
  Write-AgentLog -HypothesisId 'B' -Location 'launch.ps1:Invoke-ReleaseBuildOnce' -Message 'ReleaseExe present after build' -Data @{
    releaseExe = $ReleaseExe
    exists = $true
  }
  # #endregion
}

function Ensure-ReleaseBuild {
  if (Test-BuildFresh) {
    Set-LaunchStep -Status 'Build ready' -Progress 90 -Feed 'Build is up to date'
    return
  }

  Enter-BuildLock
  try {
    # Another launcher may have finished while we waited for the lock.
    if (Test-BuildFresh) {
      Set-LaunchStep -Status 'Build ready' -Progress 90 -Feed 'Build is up to date'
      return
    }

    Set-LaunchStep -Status 'Building' -Progress 55 -Feed 'Building desktop app'

    for ($attempt = 1; $attempt -le $MaxBuildSourceDriftAttempts; $attempt++) {
      $sourcesBefore = Get-SourcesFingerprint
      Invoke-ReleaseBuildOnce
      $sourcesAfter = Get-SourcesFingerprint
      # #region agent log
      Write-AgentLog -HypothesisId 'C' -Location 'launch.ps1:Ensure-ReleaseBuild' -Message 'source fingerprint compare' -Data @{
        attempt = $attempt
        sourcesMatch = ($sourcesBefore -eq $sourcesAfter)
        sourcesBefore = $sourcesBefore
        sourcesAfter = $sourcesAfter
      }
      # #endregion
      if ($sourcesBefore -eq $sourcesAfter) {
        Write-BuildStamp
        $fresh = Test-BuildFresh
        # #region agent log
        Write-AgentLog -HypothesisId 'D' -Location 'launch.ps1:Ensure-ReleaseBuild' -Message 'post-stamp freshness' -Data @{
          fresh = [bool]$fresh
          stampExists = (Test-Path -LiteralPath $StampFile)
        }
        # #endregion
        if (-not $fresh) {
          Clear-BuildStamp
          Fail-Launch "Build finished but freshness checks still failed.`n`nDetails: $LogFile"
        }
        Write-Feed 'Desktop build complete'
        Write-ProgressValue 90
        return
      }

      Clear-BuildStamp
      if ($attempt -ge $MaxBuildSourceDriftAttempts) {
        Fail-Launch "Sources changed while building, so the release binary would be stale.`n`nSave your edits, then run Deez VRM Viewer again."
      }
      Write-Feed 'Sources changed during build; rebuilding'
      Set-LaunchStep -Status 'Rebuilding' -Progress 55 -Feed 'Sources changed during build; rebuilding'
    }
  } finally {
    Release-BuildLock
  }
}

function Start-ReleaseApp {
  Set-LaunchStep -Status 'Starting viewer' -Progress 92 -Feed 'Starting Deez VRM Viewer'
  Assert-BuildFresh 'pre-start'

  $env:DEEZ_VRM_SKIP_UPDATE = '1'
  $startInfo = @{
    FilePath = $ReleaseExe
    WorkingDirectory = $Root
    PassThru = $true
  }
  if ($AppArgs -and $AppArgs.Count -gt 0) {
    $startInfo['ArgumentList'] = $AppArgs
  }

  $proc = Start-Process @startInfo
  if (-not $proc) {
    Fail-Launch "Could not start Deez VRM Viewer.`n`n$ReleaseExe"
  }

  Start-Sleep -Milliseconds 800
  if ($proc.HasExited) {
    Fail-Launch "Deez VRM Viewer exited immediately.`n`nDetails: $LogFile"
  }
  Write-Feed 'Viewer process started'
  Write-ProgressValue 98
}

New-Item -ItemType Directory -Force -Path $RunDir | Out-Null

if ($VerifyOnly) {
  try {
    if (Test-BuildFresh) { exit 0 }
    exit 2
  } catch {
    exit 1
  }
}

Set-Location -LiteralPath $Root
Remove-Item -LiteralPath $StatusFile, $ProgressFile, $FeedFile -Force -ErrorAction SilentlyContinue
New-Item -ItemType File -Force -Path $FeedFile | Out-Null
Write-ProgressValue 0
Set-LaunchStep -Status 'Starting...' -Progress 5 -Feed 'Launcher started'

try {
  Start-Splash | Out-Null
} catch {
  Show-ErrorDialog "Could not open the loading screen.`n`n$($_.Exception.Message)"
  exit 1
}

try {
  Ensure-Node
  Ensure-Rust
  Update-FromGit
  Ensure-Dependencies
  Ensure-ReleaseBuild
  Assert-BuildFresh 'post-build'
  Start-ReleaseApp
  Set-LaunchStep -Status 'Opening...' -Progress 99 -Feed 'Opening viewer'
  Close-Splash
  exit 0
} catch {
  Fail-Launch "Setup could not finish.`n`n$($_.Exception.Message)`nDetails: $LogFile"
}
