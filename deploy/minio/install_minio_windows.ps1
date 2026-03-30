param(
    [string]$InstallDir = "C:\minio",
    [string]$DataDir = "C:\minio\data",
    [int]$ApiPort = 9000,
    [int]$ConsolePort = 9001,
    [string]$RootUser = "minioadmin",
    [string]$RootPassword = "minioadmin",
    [string]$ServiceName = "MinIO",
    [switch]$OpenFirewall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Test-IsAdmin {
    $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
    throw "Please run this script in an elevated PowerShell window (Run as Administrator)."
}

Write-Host "==> MinIO Windows installer"
Write-Host "InstallDir: $InstallDir"
Write-Host "DataDir   : $DataDir"
Write-Host "Service   : $ServiceName"

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null

$minioExe = Join-Path $InstallDir "minio.exe"
$mcExe = Join-Path $InstallDir "mc.exe"

$minioUrl = "https://dl.min.io/server/minio/release/windows-amd64/minio.exe"
$mcUrl = "https://dl.min.io/client/mc/release/windows-amd64/mc.exe"

Write-Host "==> Downloading minio.exe"
Invoke-WebRequest -Uri $minioUrl -OutFile $minioExe

Write-Host "==> Downloading mc.exe"
Invoke-WebRequest -Uri $mcUrl -OutFile $mcExe

Write-Host "==> Setting system environment variables"
[Environment]::SetEnvironmentVariable("MINIO_ROOT_USER", $RootUser, "Machine")
[Environment]::SetEnvironmentVariable("MINIO_ROOT_PASSWORD", $RootPassword, "Machine")

# Keep current process aligned so immediate health checks and manual runs work.
$env:MINIO_ROOT_USER = $RootUser
$env:MINIO_ROOT_PASSWORD = $RootPassword

$binPath = "`"$minioExe`" server `"$DataDir`" --address :$ApiPort --console-address :$ConsolePort"
$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue

if ($null -eq $existingService) {
    Write-Host "==> Creating Windows service: $ServiceName"
    sc.exe create $ServiceName binPath= $binPath start= auto DisplayName= "MinIO Object Storage" | Out-Null
} else {
    Write-Host "==> Service already exists, updating config: $ServiceName"
    sc.exe stop $ServiceName | Out-Null
    Start-Sleep -Seconds 2
    sc.exe config $ServiceName binPath= $binPath start= auto DisplayName= "MinIO Object Storage" | Out-Null
}

Write-Host "==> Configuring service restart policy"
sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null

if ($OpenFirewall) {
    Write-Host "==> Creating firewall rules"
    $apiRuleName = "MinIO API $ApiPort"
    $consoleRuleName = "MinIO Console $ConsolePort"

    if (-not (Get-NetFirewallRule -DisplayName $apiRuleName -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName $apiRuleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $ApiPort | Out-Null
    }
    if (-not (Get-NetFirewallRule -DisplayName $consoleRuleName -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName $consoleRuleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $ConsolePort | Out-Null
    }
}

Write-Host "==> Starting service"
sc.exe start $ServiceName | Out-Null
Start-Sleep -Seconds 2

$service = Get-Service -Name $ServiceName
Write-Host "Service status: $($service.Status)"

try {
    $healthUrl = "http://127.0.0.1:$ApiPort/minio/health/live"
    $resp = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 5
    Write-Host "Health check: $($resp.StatusCode) $healthUrl"
} catch {
    Write-Warning "Health check failed. Check logs with: Get-WinEvent -LogName Application | Select-Object -First 20"
}

Write-Host ""
Write-Host "MinIO installed successfully."
Write-Host "API endpoint    : http://<server-ip>:$ApiPort"
Write-Host "Console endpoint: http://<server-ip>:$ConsolePort"
Write-Host "Local console   : http://127.0.0.1:$ConsolePort"
Write-Host "Service control : sc.exe query $ServiceName / sc.exe stop $ServiceName / sc.exe start $ServiceName"
Write-Host "MC binary       : $mcExe"
