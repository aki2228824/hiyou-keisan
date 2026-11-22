# backup-hiyou.ps1 -- nightly backup of the single SQLite file, with generations.
# ASCII only on purpose (Windows PowerShell 5.1 misreads UTF-8 files without BOM).
# Needs verify-db.js in the same folder as this script.
# Exit code: 0 = OK
#            1 = ERROR   (no verified backup was made, or the copy of the operation log / to the second device failed)
#            2 = WARNING (the data file is less than half the size of the last good backup;
#                         the copy is kept aside as SHRUNK_*.db and no generation is deleted.
#                         Also: an operation-log file was cut or changed after it had been backed up)
# The operation log (audit-YYYY-MM.jsonl) is copied to <LocalDir>\audit and, with it, to the second device.
param(
  [string]$DbPath      = 'C:\hiyou\data\hiyou.db',            # same file as DB_PATH in .env
  [string]$AppRoot     = 'C:\hiyou\app',                      # folder that contains node_modules\sql.js
  [string]$LocalDir    = 'C:\hiyou\backup',                   # 1st copy (another physical disk if you have one)
  [string]$RemoteDir   = '',                                  # 2nd copy on another device, e.g. \\NAS01\hiyou-backup ('' = skip)
  [string]$AuditDir    = '',                                  # operation-log folder (AUDIT_LOG_DIR in .env). '' = the "audit" folder next to $DbPath
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
function Get-SharedLength([string]$path) {
  # The app keeps the current month's log file open. While a file is open for writing, the size shown in a
  # folder listing can be out of date, so ask through a file handle instead.
  $in = Open-Shared $path
  try { return $in.Length } finally { $in.Close() }
}
function Get-PrefixHash([string]$path, [long]$length) {
  # SHA-256 of the first $length bytes of a file.
  $in = Open-Shared $path
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $buf  = New-Object byte[] 1048576
      $left = $length
      while ($left -gt 0) {
        $n = $in.Read($buf, 0, [int][Math]::Min([long]$buf.Length, $left))
        if ($n -le 0) { break }
        [void]$sha.TransformBlock($buf, 0, $n, $null, 0)
        $left -= $n
      }
      [void]$sha.TransformFinalBlock($buf, 0, 0)
      return [System.BitConverter]::ToString($sha.Hash)
    } finally { $sha.Dispose() }
  } finally { $in.Close() }
}
function Copy-OperationLog([string]$srcDir, [string]$dstDir, [bool]$explicit, [string]$stamp) {
  # Operation log = audit-YYYY-MM.jsonl, one file per month, written by the app next to the database.
  # These are append-only text files, so a healthy file only ever GROWS and always still starts with
  # the content that was backed up before. Anything else (smaller than its backup copy, or no longer
  # starting with it) means somebody cut or edited the log. In that case the old backup copy is kept under
  # the name <name>.before-<stamp>, the current file is copied, and the run ends with a WARNING (exit code 2)
  # - once, on the night it is noticed; the kept copy stays as evidence.
  # Nothing is ever deleted here. Returns 0 = OK, 1 = ERROR, 2 = WARNING.
  if (-not (Test-Path -LiteralPath $srcDir)) {
    if ($explicit) {
      Write-Log "ERROR operation log folder not found: $srcDir (given with -AuditDir)"
      return 1
    }
    Write-Log "operation log: folder not found, nothing copied: $srcDir (normal for an app version without the operation log. If AUDIT_LOG_DIR is set in .env, pass that folder with -AuditDir)"
    return 0
  }
  $result = 0
  $copied = 0
  $names  = @()
  New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
  foreach ($f in @(Get-ChildItem -LiteralPath $srcDir -Filter 'audit-*.jsonl' -File | Sort-Object Name)) {
    $names += $f.Name
    try {
      # One unreadable file must not stop the others (the current month matters most).
      $target = Join-Path $dstDir $f.Name
      $srcLen = Get-SharedLength $f.FullName
      if (Test-Path -LiteralPath $target) {
        $dstLen = (Get-Item -LiteralPath $target).Length
        $changed = ''
        if ($srcLen -lt $dstLen) { $changed = "is smaller ($srcLen bytes) than its backup copy ($dstLen bytes)" }
        elseif ((Get-PrefixHash $f.FullName $dstLen) -ne (Get-SharedHash $target)) {
          # Also checked when the size is unchanged (every past month): an edit that keeps the length,
          # such as one user ID replaced by another of the same length, must not go unnoticed.
          if ($srcLen -eq $dstLen) { $changed = 'has the same size as its backup copy but different content (lines were changed)' }
          else { $changed = 'no longer starts with the content of its backup copy (lines were changed or removed)' }
        }
        elseif ($srcLen -eq $dstLen) { continue }   # unchanged since the last backup: nothing to copy
        if ($changed) {
          $aside = "$($f.Name).before-$stamp"
          Rename-Item -LiteralPath $target -NewName $aside
          Write-Log "WARNING operation log $($f.Name) $changed. The old backup copy is kept as $aside. CHECK WHO CHANGED THE LOG."
          if ($result -eq 0) { $result = 2 }
        }
      }
      Copy-Shared $f.FullName $target
      $copied++
    } catch {
      Write-Log "ERROR operation log copy failed for $($f.Name): $($_.Exception.Message)"
      $result = 1
    }
  }
  $note = ''
  $onlyInBackup = @(Get-ChildItem -LiteralPath $dstDir -Filter 'audit-*.jsonl' -File | Where-Object { $names -notcontains $_.Name })
  if ($onlyInBackup.Count) { $note = " ($($onlyInBackup.Count) month file(s) exist only in the backup: moved away or deleted from the live folder)" }
  Write-Log "operation log: $copied file(s) copied to $dstDir$note"
  return $result
}
function Get-ExitCode([int]$a, [int]$b) {
  # Worst of two results: 1 (error) beats 2 (warning) beats 0.
  if ($a -eq 1 -or $b -eq 1) { return 1 }
  if ($a -eq 2 -or $b -eq 2) { return 2 }
  return 0
}

# 0) Operation log first, so that it is copied even on a night when the database backup below fails.
#    A problem here is reported through the exit code, but it never stops the database backup.
$auditCode = 0
try {
  $auditGiven = [bool]$AuditDir
  if (-not $auditGiven) { $AuditDir = Join-Path (Split-Path -Parent $DbPath) 'audit' }
  $auditCode = Copy-OperationLog $AuditDir (Join-Path $LocalDir 'audit') $auditGiven (Get-Date -Format 'yyyyMMdd_HHmmss')
} catch {
  Write-Log "ERROR operation log copy failed: $($_.Exception.Message). The database backup is not affected."
  $auditCode = 1
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
  #    by silently creating a new folder somewhere else. The "audit" folder (operation log) goes with it.
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
  exit (Get-ExitCode $code $auditCode)
} catch {
  Write-Log "ERROR $($_.Exception.Message)"
  # The database backup failed. The operation log was already copied to the local backup folder in step 0;
  # send that folder to the second device anyway, so that the second copy of the log does not fall behind
  # for as long as the database problem lasts. (Database files are not sent: none was verified tonight.)
  try {
    $localAudit = Join-Path $LocalDir 'audit'
    if ($RemoteDir -and (Test-Path -LiteralPath $RemoteDir) -and (Test-Path -LiteralPath $localAudit)) {
      robocopy $localAudit (Join-Path $RemoteDir 'audit') /E /R:2 /W:5 /NP /NJH /NJS /NFL /NDL | Out-Null
      if ($LASTEXITCODE -ge 8) { Write-Log "ERROR operation log copy to $RemoteDir failed (robocopy exit code $LASTEXITCODE)." }
      else { Write-Log "operation log: sent to the second device ($RemoteDir) although the database backup failed" }
    }
  } catch {
    Write-Log "ERROR operation log copy to the second device failed: $($_.Exception.Message)"
  }
  exit 1
}
