# Creates / updates "Deadlock Tweaker.lnk" on the user Desktop (same folder OneDrive uses when Desktop is redirected).
$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Desktop = [Environment]::GetFolderPath('Desktop')
if (-not $Desktop -or -not (Test-Path -LiteralPath $Desktop)) {
  Write-Host "Desktop folder not found; skip shortcut."
  exit 0
}

$npmCmd = $null
try {
  $npmCmd = (Get-Command npm.cmd -ErrorAction Stop).Source
} catch {
  $fallback = Join-Path ${env:ProgramFiles} 'nodejs\npm.cmd'
  if (Test-Path -LiteralPath $fallback) { $npmCmd = $fallback }
}
if (-not $npmCmd -or -not (Test-Path -LiteralPath $npmCmd)) {
  Write-Warning "npm.cmd not found; skip desktop shortcut."
  exit 0
}

$LnkPath = Join-Path $Desktop 'Deadlock Tweaker.lnk'
$IconPath = Join-Path $ProjectRoot 'assets\logo.png'

$W = New-Object -ComObject WScript.Shell
$S = $W.CreateShortcut($LnkPath)
$S.TargetPath = $npmCmd
$S.Arguments = 'run dev'
$S.WorkingDirectory = $ProjectRoot
$S.WindowStyle = 7
$S.Description = 'Deadlock Tweaker — dev (electronmon, auto-reload)'
if (Test-Path -LiteralPath $IconPath) {
  $S.IconLocation = "$IconPath,0"
}
$S.Save()

Write-Host "Shortcut updated: $LnkPath"
