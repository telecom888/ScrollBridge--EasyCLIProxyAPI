param([Parameter(Mandatory=$true)][string]$JobFile)
$ErrorActionPreference = 'Stop'
# PowerShell 7 parents can pass a PSModulePath that omits Windows PowerShell's
# built-in script modules. This helper only uses the Windows system modules.
$env:PSModulePath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\Modules;$env:ProgramFiles\WindowsPowerShell\Modules"
$job = Get-Content -LiteralPath $JobFile -Raw -Encoding UTF8 | ConvertFrom-Json
$work = [IO.Path]::GetFullPath((Split-Path -Parent $JobFile))
$target = [IO.Path]::GetFullPath($job.targetDirectory).TrimEnd('\')
$backup = Join-Path $work 'backup'
$stage = Join-Path $work 'stage'
$configBackup = Join-Path $work 'configuration.saved'
$changed = $false
$started = $null
$newFiles = @()
$savedFiles = @()
$validated = $false
$oldStopped = $false

function AppPath([string]$relative) {
  if ([IO.Path]::IsPathRooted($relative) -or $relative.Contains(':') -or ($relative -split '[\\/]' | Where-Object { $_ -eq '..' -or $_ -eq '.' -or $_ -eq '' })) { throw 'Invalid update path' }
  $full = [IO.Path]::GetFullPath((Join-Path $target $relative))
  if (!$full.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Update path escaped application directory' }
  return $full
}
function WorkPath([string]$directory,[string]$relative) {
  $null = AppPath $relative
  return Join-Path $directory $relative
}
function CopyFile([string]$source,[string]$destination) {
  [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
  [IO.File]::Copy($source,$destination,$true)
}
function RestoreConfig {
  if (Test-Path -LiteralPath $configBackup) { CopyFile $configBackup $job.configFile }
}
function WaitOldProcess {
  $old = Get-Process -Id $job.parentPid -ErrorAction SilentlyContinue
  if ($old -and !$old.WaitForExit(60000)) { throw 'The old application did not exit' }
}
function StartApplication([bool]$updated) {
  foreach ($name in @('PORTABLE_EXECUTABLE_FILE','PORTABLE_EXECUTABLE_DIR','PORTABLE_EXECUTABLE_APP_FILENAME')) { [Environment]::SetEnvironmentVariable($name,$null,'Process') }
  if ($updated) { $env:SCROLLBRIDGE_UPDATE_ID = $job.id } else { Remove-Item Env:SCROLLBRIDGE_UPDATE_ID -ErrorAction SilentlyContinue }
  # Preserve the profile used by the old process, also for isolated tests.
  $env:SCROLLBRIDGE_TEST_PROFILE = $job.profileDirectory
  # The helper stays hidden; the restarted desktop is an interactive window.
  $script:started = Start-Process -FilePath $job.executable -WorkingDirectory $target -WindowStyle Normal -PassThru
}
function WriteResult([string]$status,[string]$message) {
  @{status=$status;message=$message;version=$job.version;time=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $work 'result.json') -Encoding UTF8
}
try {
  if ($job.schemaVersion -ne 1 -or $job.id -notmatch '^[a-f0-9-]{36}$' -or @('zip','installer','portable') -notcontains $job.kind) { throw 'Invalid update job' }
  if ((Split-Path -Parent ([IO.Path]::GetFullPath($job.executable))).TrimEnd('\') -ne $target) { throw 'Executable does not belong to update directory' }
  $asset = [IO.Path]::GetFullPath($job.filename)
  if (!$asset.StartsWith($work+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Update file is outside the job directory' }
  $validated = $true
  [IO.File]::WriteAllText((Join-Path $work 'worker-ready.json'),'{"ready":true}')
  if ((Get-Item -LiteralPath $asset).Length -ne $job.size -or (Get-FileHash -LiteralPath $asset -Algorithm SHA256).Hash -ine $job.sha256) { throw 'Update checksum mismatch' }
  foreach ($relative in $job.oldFiles) { $null = AppPath $relative }
  if ($job.kind -eq 'zip') {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    $archive = [IO.Compression.ZipFile]::OpenRead($asset)
    try {
      $total = 0L
      $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
      if ($archive.Entries.Count -gt 10000) { throw 'Too many update files' }
      foreach ($entry in $archive.Entries) {
        $relative = $entry.FullName.TrimEnd('/')
        if (!$relative) { continue }
        $null = AppPath $relative
        if (!$seen.Add($relative) -or $relative -ieq 'scrollbridge.json' -or (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw 'Unsafe update archive' }
        $total += $entry.Length
        if ($total -gt 2GB) { throw 'Update archive is too large' }
        $destination = WorkPath $stage $relative
        if (!$entry.Name) { [IO.Directory]::CreateDirectory($destination) | Out-Null; continue }
        [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$destination,$false)
        $newFiles += $relative
      }
    } finally { $archive.Dispose() }
    if (!(Test-Path -LiteralPath (Join-Path $stage 'resources/app.asar')) -or !(Test-Path -LiteralPath (Join-Path $stage (Split-Path -Leaf $job.executable)))) { throw 'Incomplete application archive' }
  } elseif ($job.kind -eq 'portable') { $newFiles = @((Split-Path -Leaf $job.executable)) }

  WaitOldProcess
  $oldStopped = $true
  if (Test-Path -LiteralPath $job.configFile) { CopyFile $job.configFile $configBackup }
  foreach ($relative in $job.oldFiles) {
    $source = AppPath $relative
    if (Test-Path -LiteralPath $source -PathType Leaf) { CopyFile $source (WorkPath $backup $relative); $savedFiles += $relative }
  }
  $changed = $true
  if ($job.kind -eq 'installer') {
    $installer = Start-Process -FilePath $asset -ArgumentList ('/S /currentuser /D='+$target) -WindowStyle Hidden -Wait -PassThru
    if ($installer.ExitCode -ne 0) { throw 'Installer failed' }
  } elseif ($job.kind -eq 'portable') {
    CopyFile $asset $job.executable
  } else {
    foreach ($relative in $newFiles) { CopyFile (WorkPath $stage $relative) (AppPath $relative) }
    foreach ($relative in $job.oldFiles) {
      if ($newFiles -notcontains $relative) { $oldFile = AppPath $relative; if (Test-Path -LiteralPath $oldFile -PathType Leaf) { Remove-Item -LiteralPath $oldFile } }
    }
  }
  RestoreConfig
  StartApplication $true
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  $readyFile = Join-Path $work 'ready.json'
  $ready = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $readyFile) {
      $ack = Get-Content -LiteralPath $readyFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($ack.id -eq $job.id -and $ack.version -eq $job.version) { $ready = $true; break }
    }
    if ($started.HasExited) { break }
    Start-Sleep -Milliseconds 200
  }
  if (!$ready) { throw 'Updated application did not become ready' }
  WriteResult 'success' ''
  # All cleanup stays in this uniquely owned job directory, never the app folder.
  foreach ($item in @('backup','stage','configuration.saved',(Split-Path -Leaf $asset))) {
    $cleanup = [IO.Path]::GetFullPath((Join-Path $work $item))
    if (!$cleanup.StartsWith($work+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid cleanup path' }
    if (Test-Path -LiteralPath $cleanup) { try { Remove-Item -LiteralPath $cleanup -Recurse } catch {} }
  }
} catch {
  $failure = $_.Exception.Message
  if ($started -and !$started.HasExited) { $started.Kill(); $started.WaitForExit(10000) | Out-Null }
  try {
    if ($changed) {
      foreach ($relative in $newFiles) { if ($savedFiles -notcontains $relative) { $created = AppPath $relative; if (Test-Path -LiteralPath $created -PathType Leaf) { Remove-Item -LiteralPath $created } } }
      foreach ($relative in $savedFiles) { CopyFile (WorkPath $backup $relative) (AppPath $relative) }
      RestoreConfig
    }
    WriteResult 'rolled-back' $failure
    if ($validated) { if (!$oldStopped) { WaitOldProcess }; StartApplication $false }
  } catch { WriteResult 'rollback-failed' ($failure+'; '+$_.Exception.Message) }
  exit 1
}
