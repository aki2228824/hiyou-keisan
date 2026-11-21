# backup-hiyou.ps1 -- nightly backup of the single SQLite file, with generations.
# ASCII only on purpose (Windows PowerShell 5.1 misreads UTF-8 files without BOM).
# Needs verify-db.js in the same folder as this script.
# Exit code: 0 = OK
#            1 = ERROR   (no verified backup was made, or the copy to the second device failed)
#            2 = WARNING (the data file is less than half the size of the last good backup;
#                         the copy is kept aside as SHRUNK_*.db and no generation is deleted)
param(
  [string]$DbPath      = 'C:\hiyou\data\hiyou.db',            # same file as DB_PATH in .env
  [string]$AppRoot     = 'C:\hiyou\app',                      # folder that contains node_modules\sql.js
  [string]$LocalDir    = 'C:\hiyou\backup',                   # 1st copy (another physical disk if you have one)
  [string]$RemoteDir   = '',                                  # 2nd copy on another device, e.g. \\NAS01\hiyou-backup ('' = skip)
  [string]$Node        = 'C:\Program Files\nodejs\node.exe',
  [int]$KeepDaily      = 30,                                  # daily generations kept in $LocalDir
  [int]$KeepMonthly    = 24,                                  # monthly generations kept in $LocalDir
  [int]$KeepRemoteDaily = 180,                                # daily generations kept in $RemoteDir (monthly ones are never deleted there)
  [int]$MaxTries       = 6,
  [int]$RetrySeconds   = 10,
  [switch]$AllowShrink                                        # use ONCE, by hand, when a big shrink is really intended
)
$ErrorActionPreference = 'Stop'
$daily   = Join-Path $LocalDir 'daily'
$monthly = Join-Path $LocalDir 'monthly'
New-Item -ItemType Directory -Force -Path $daily, $monthly | Out-Null
$log = Join-Path $LocalDir 'backup.log'
function Write-Log([string]$m) {
  Add-Content -LiteralPath $log -Encoding UTF8 -Value ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
}
function Open-Shared([string]$path) {
  # Full sharing: the app's own save must never fail ("EBUSY") because this backup holds the file.
  return [System.IO.File]::Open($path, 'Open', 'Read', 'ReadWrite, Delete')
}
function Copy-Shared([string]$src, [string]$dst) {
  $in = Open-Shared $src
  try {
    $out = [System.IO.File]::Create($dst)
    try { $in.CopyTo($out) } finally { $out.Close() }
  } finally { $in.Close() }
}
function Get-SharedHash([string]$path) {
  $in = Open-Shared $path
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return [System.BitConverter]::ToString($sha.ComputeHash($in)) } finally { $sha.Dispose() }
  } finally { $in.Close() }
}

try {
  $verify = Join-Path $PSScriptRoot 'verify-db.js'
  foreach ($p in @($DbPath, $Node, $verify, (Join-Path $AppRoot 'node_modules\sql.js'))) {
    if (-not (Test-Path -LiteralPath $p)) { throw "not found: $p" }
  }
  $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
  $dest  = Join-Path $daily "hiyou_$stamp.db"

  # 1) Copy. The copy counts only if (a) the live file is still byte-identical to it afterwards
  #    (= the app did not save in the middle of the copy) and (b) it passes verify-db.js. Otherwise retry.
  $ok = $false; $detail = ''
  for ($try = 1; $try -le $MaxTries -and -not $ok; $try++) {
    try {
      Copy-Shared $DbPath $dest
      if ((Get-SharedHash $DbPath) -ne (Get-SharedHash $dest)) {
        $detail = 'the app saved while the file was being copied'
      } else {
        $detail = (& $Node $verify $dest $AppRoot | Out-String).Trim()
        $ok = ($LASTEXITCODE -eq 0)
      }
    } catch { $detail = $_.Exception.Message }
    if (-not $ok) { Write-Log "try $try failed: $detail"; if ($try -lt $MaxTries) { Start-Sleep -Seconds $RetrySeconds } }
  }
  if (-not $ok) {
    if (Test-Path -LiteralPath $dest) { Rename-Item -LiteralPath $dest -NewName "BAD_hiyou_$stamp.db" }
    throw "no verified backup after $MaxTries tries: $detail"
  }

  # 2) Shrink guard: a file less than half of the last good backup usually means "the app started with an
  #    empty database". Keep the copy aside, delete nothing, and keep warning every night until a human decides.
  $prev = Get-ChildItem -LiteralPath $daily -Filter 'hiyou_*.db' | Where-Object { $_.FullName -ne $dest } |
          Sort-Object Name -Descending | Select-Object -First 1
  $shrunk = [bool]($prev -and -not $AllowShrink -and ((Get-Item -LiteralPath $dest).Length -lt ($prev.Length / 2)))
  $code = 0
  if ($shrunk) {
    Rename-Item -LiteralPath $dest -NewName "SHRUNK_hiyou_$stamp.db"
    Write-Log "WARNING $detail -- less than half the size of the last good backup $($prev.Name). Kept as SHRUNK_hiyou_$stamp.db; generations untouched. CHECK THE DATA."
    $code = 2
  } else {
    # 3) Monthly generation: the first verified backup of each month is kept separately.
    $m = Join-Path $monthly ('hiyou_{0}.db' -f (Get-Date -Format 'yyyyMM'))
    if (-not (Test-Path -LiteralPath $m)) { Copy-Item -LiteralPath $dest -Destination $m }

    # 4) Prune by COUNT (not by age): the newest N always survive even if backups stop for a while.
    Get-ChildItem -LiteralPath $daily   -Filter 'hiyou_*.db' | Sort-Object Name -Descending | Select-Object -Skip $KeepDaily   | Remove-Item -Force
    Get-ChildItem -LiteralPath $monthly -Filter 'hiyou_*.db' | Sort-Object Name -Descending | Select-Object -Skip $KeepMonthly | Remove-Item -Force
    Write-Log "$detail -> $dest"
  }

  # 5) Second device: copy the already-verified backup folder (never the live file) to the NAS / other PC.
  #    /E without /PURGE: files deleted locally are NOT deleted on the second device; it keeps its own, longer history.
  #    The folder must already exist: a mistyped path or a NAS that is switched off is reported, never "repaired"
  #    by silently creating a new folder somewhere else.
  if ($RemoteDir) {
    if (-not (Test-Path -LiteralPath $RemoteDir)) {
      Write-Log "ERROR second device folder not found: $RemoteDir (it is never created automatically). The local backup is not affected."
      exit 1
    }
    robocopy $LocalDir $RemoteDir /E /R:2 /W:5 /NP /NJH /NJS /NFL /NDL /XF backup.log | Out-Null
    if ($LASTEXITCODE -ge 8) {
      Write-Log "ERROR second copy to $RemoteDir failed (robocopy exit code $LASTEXITCODE). The local backup is not affected."
      exit 1
    }
    $remoteDaily = Join-Path $RemoteDir 'daily'
    if (-not $shrunk -and $KeepRemoteDaily -ge $KeepDaily -and (Test-Path -LiteralPath $remoteDaily)) {
      Get-ChildItem -LiteralPath $remoteDaily -Filter 'hiyou_*.db' | Sort-Object Name -Descending | Select-Object -Skip $KeepRemoteDaily | Remove-Item -Force
    }
  }
  exit $code
} catch {
  Write-Log "ERROR $($_.Exception.Message)"
  exit 1
}
