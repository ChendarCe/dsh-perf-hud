# dsh-perf-hud — remove the temperature helper.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File helper\uninstall.ps1
#   powershell ... -File helper\uninstall.ps1 -RemoveFiles
#
# Stops the scheduled task, ends the sensor process and uninstalls the PawnIO
# driver. -RemoveFiles also deletes <Root>\DSHTools contents.

param(
  [string]$Root = '',
  [switch]$RemoveFiles
)

$ErrorActionPreference = 'Stop'

if (-not $Root) {
  if (Test-Path 'D:\') { $Root = 'D:\DSHTools' } else { $Root = Join-Path $env:LOCALAPPDATA 'DSHTools' }
}

$TaskName = 'DSH Perf Sensor'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Root', "`"$Root`"")
  if ($RemoveFiles) { $arguments += '-RemoveFiles' }
  $elevated = Start-Process -FilePath 'powershell.exe' -Verb RunAs -PassThru -Wait -ArgumentList $arguments
  exit $elevated.ExitCode
}

Write-Host '· stopping the scheduled task…'
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Write-Host '· ending the sensor process…'
$self = $PID
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessId -ne $self -and $_.CommandLine -like '*sensor-helper.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

if (Get-Service -Name 'PawnIO' -ErrorAction SilentlyContinue) {
  Write-Host '· uninstalling the PawnIO driver…'
  $installer = Join-Path $Root 'PawnIO_setup.exe'
  if (Test-Path $installer) {
    $proc = Start-Process -FilePath $installer -ArgumentList '-uninstall', '-silent' -PassThru -Wait
    Write-Host "  installer exited with $($proc.ExitCode)"
  } else {
    Write-Host '  PawnIO_setup.exe not found — remove PawnIO from Apps & Features instead.'
  }
}

if ($RemoveFiles -and (Test-Path $Root)) {
  Write-Host "· deleting $Root…"
  Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'Done. The plugin keeps working; its temperature column now shows "—".'
