# dsh-perf-hud — one-time elevated setup for CPU/GPU temperatures.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File helper\setup.ps1
#   (or double-click helper\setup.cmd)
#
# What it does:
#   1. downloads LibreHardwareMonitor (library only) and the PawnIO signed driver
#      into <Root> (D:\DSHTools when that drive exists, otherwise
#      %LOCALAPPDATA%\DSHTools);
#   2. installs the PawnIO driver when it is missing — this is what lets
#      LibreHardwareMonitor read MSRs while Windows "Memory integrity" stays on;
#   3. registers the "DSH Perf Sensor" scheduled task (at logon, highest
#      privileges, no window) and starts it.
#
# The plugin works without this; the temperature columns simply show "—".
# Remove everything again with helper\uninstall.ps1.

param(
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'

if (-not $Root) {
  if (Test-Path 'D:\') { $Root = 'D:\DSHTools' } else { $Root = Join-Path $env:LOCALAPPDATA 'DSHTools' }
}

$LhmVersion = 'v0.9.6'
$PawnIoVersion = '2.2.0'
$LhmUrl = "https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/download/$LhmVersion/LibreHardwareMonitor.zip"
$PawnIoUrl = "https://github.com/namazso/PawnIO.Setup/releases/download/$PawnIoVersion/PawnIO_setup.exe"
$TaskName = 'DSH Perf Sensor'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host 'Elevation required — confirming with Windows UAC…'
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Root', "`"$Root`"")
  $elevated = Start-Process -FilePath 'powershell.exe' -Verb RunAs -PassThru -Wait -ArgumentList $arguments
  exit $elevated.ExitCode
}

$perfDir = Join-Path $Root 'perf-sensor'
$lhmDir = Join-Path $Root 'LibreHardwareMonitor'
$lhmZip = Join-Path $Root 'LibreHardwareMonitor.zip'
$pawnInstaller = Join-Path $Root 'PawnIO_setup.exe'
New-Item -ItemType Directory -Force -Path $perfDir | Out-Null

Write-Host "Installing into $Root"

if (-not (Test-Path (Join-Path $lhmDir 'LibreHardwareMonitorLib.dll'))) {
  Write-Host '· downloading LibreHardwareMonitor…'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest $LhmUrl -OutFile $lhmZip -UseBasicParsing
  Expand-Archive -LiteralPath $lhmZip -DestinationPath $lhmDir -Force
}

$driver = Get-Service -Name 'PawnIO' -ErrorAction SilentlyContinue
if (-not $driver) {
  Write-Host '· downloading and installing the PawnIO driver…'
  if (-not (Test-Path $pawnInstaller)) { Invoke-WebRequest $PawnIoUrl -OutFile $pawnInstaller -UseBasicParsing }
  $install = Start-Process -FilePath $pawnInstaller -ArgumentList '-install', '-silent' -PassThru -Wait
  if ($install.ExitCode -ne 0) { throw "PawnIO installer exited with $($install.ExitCode)" }
}

Write-Host '· installing the sensor helper script…'
Copy-Item (Join-Path $PSScriptRoot 'sensor-helper.ps1') (Join-Path $perfDir 'sensor-helper.ps1') -Force

Write-Host '· registering the scheduled task…'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Root "{1}"' -f (Join-Path $perfDir 'sensor-helper.ps1'), $Root)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Start-Sleep -Seconds 4
$sensors = Join-Path $perfDir 'sensors.json'
if (Test-Path $sensors) {
  Write-Host ''
  Write-Host 'Done. First reading:'
  Get-Content $sensors -Raw
  Write-Host ''
  Write-Host 'The plugin picks it up within a couple of seconds. If the temperature'
  Write-Host 'column still shows "—", reload the interface once.'
} else {
  Write-Host ''
  Write-Host "Done, but no reading yet. Check $perfDir\status.json and the task state."
}
