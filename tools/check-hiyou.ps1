# check-hiyou.ps1 -- "is it alive?" check for a tiny team. ASCII only (Windows PowerShell 5.1 safe).
# Run it from a PC OTHER than the server if possible (it then also notices "server PC is off / asleep / unplugged").
# Exit code 0 = everything OK, 1 = something needs attention. One line per run is appended to -Log.
param(
  [string]$Url               = 'http://192.168.1.10:3000/',   # the address staff use
  [string]$BackupDir         = '',                            # e.g. \\NAS01\hiyou-backup\daily  ('' = skip)
  [int]$MaxBackupAgeHours    = 26,
  [string]$DbPath            = '',                            # server only: live DB file ('' = skip)
  [string]$Drive             = '',                            # server only: e.g. 'C' -> free space check ('' = skip)
  [int]$MinFreeGB            = 5,
  [string]$Log               = "$env:LOCALAPPDATA\hiyou-check.log",
  [switch]$Popup                                              # show a message box to the logged-on user when NG
)
$problems = @()

# 1) Does the app answer? (the app starts listening only after the database was loaded)
try {
  $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 15
  if ($r.StatusCode -ne 200) { $problems += "HTTP status $($r.StatusCode)" }
} catch { $problems += "app does not answer at $Url ($($_.Exception.Message))" }

# 2) Is there a fresh, verified backup? (backup-hiyou.ps1 only leaves hiyou_*.db files that passed verification;
#    copies it did not trust are named BAD_*.db / SHRUNK_*.db)
#    The date is taken from the file NAME (hiyou_yyyyMMdd_HHmmss.db), not from the file time,
#    so it stays correct even if a copy tool changed the file times.
function Get-Stamp([string]$name) { if ($name -match '(\d{8}_\d{6})') { return $Matches[1] } else { return '' } }
$newest = $null
if ($BackupDir) {
  try {
    $files  = @(Get-ChildItem -LiteralPath $BackupDir -File -ErrorAction Stop)
    $newest = $files | Where-Object { $_.Name -like 'hiyou_*.db' } | Sort-Object Name -Descending | Select-Object -First 1
    $aside  = $files | Where-Object { $_.Name -match '^(BAD|SHRUNK)_hiyou_' } | Sort-Object { Get-Stamp $_.Name } -Descending | Select-Object -First 1
    if (-not $newest) { $problems += "no backup files in $BackupDir" }
    else {
      $taken = $newest.LastWriteTime
      try { $taken = [datetime]::ParseExact((Get-Stamp $newest.Name), 'yyyyMMdd_HHmmss', $null) } catch { }
      if (((Get-Date) - $taken).TotalHours -gt $MaxBackupAgeHours) { $problems += "newest backup is too old: $($newest.Name)" }
    }
    if ($aside -and (-not $newest -or (Get-Stamp $aside.Name) -gt (Get-Stamp $newest.Name))) {
      $problems += "the last backup run set its copy aside: $($aside.Name) (see backup.log)"
    }
  } catch { $problems += "cannot read backup folder $BackupDir ($($_.Exception.Message))" }
}

# 3) Server only: did the live DB suddenly become tiny? (an emptied file makes the app start over with a blank database)
if ($DbPath) {
  $live = Get-Item -LiteralPath $DbPath -ErrorAction SilentlyContinue
  if (-not $live) { $problems += "DB file not found: $DbPath" }
  elseif ($newest -and ($live.Length -lt ($newest.Length / 2))) { $problems += "DB file shrank: $($live.Length) bytes (last backup $($newest.Length))" }
}

# 4) Server only: free disk space (a full disk makes saving fail)
if ($Drive) {
  $free = [math]::Round((Get-PSDrive -Name $Drive).Free / 1GB, 1)
  if ($free -lt $MinFreeGB) { $problems += "low disk space on ${Drive}: ${free} GB" }
}

$line = if ($problems.Count) { 'NG ' + ($problems -join ' / ') } else { 'OK' }
Add-Content -LiteralPath $Log -Encoding UTF8 -Value ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $line)
Write-Output $line
if ($problems.Count -and $Popup) { & msg.exe $env:USERNAME /TIME:0 "hiyou-keisan check: $line" }
if ($problems.Count) { exit 1 } else { exit 0 }
