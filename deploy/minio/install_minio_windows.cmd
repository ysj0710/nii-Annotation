@echo off
setlocal

REM MinIO installer launcher for Windows CMD.
REM Run in elevated CMD (Run as Administrator).
REM Optional env vars:
REM   MINIO_INSTALL_DIR (default: C:\minio)
REM   MINIO_DATA_DIR (default: C:\minio\data)
REM   MINIO_API_PORT (default: 9000)
REM   MINIO_CONSOLE_PORT (default: 9001)
REM   MINIO_ROOT_USER (default: minioadmin)
REM   MINIO_ROOT_PASSWORD (default: minioadmin)
REM   MINIO_SERVICE_NAME (default: MinIO)
REM   MINIO_OPEN_FIREWALL=1 to open inbound ports

set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%install_minio_windows.ps1"

if not exist "%PS_SCRIPT%" (
  echo [ERROR] PowerShell script not found: %PS_SCRIPT%
  exit /b 1
)

if "%MINIO_INSTALL_DIR%"=="" set "MINIO_INSTALL_DIR=C:\minio"
if "%MINIO_DATA_DIR%"=="" set "MINIO_DATA_DIR=C:\minio\data"
if "%MINIO_API_PORT%"=="" set "MINIO_API_PORT=9000"
if "%MINIO_CONSOLE_PORT%"=="" set "MINIO_CONSOLE_PORT=9001"
if "%MINIO_ROOT_USER%"=="" set "MINIO_ROOT_USER=minioadmin"
if "%MINIO_ROOT_PASSWORD%"=="" set "MINIO_ROOT_PASSWORD=minioadmin"
if "%MINIO_SERVICE_NAME%"=="" set "MINIO_SERVICE_NAME=MinIO"

set "FIREWALL_ARG="
if /I "%MINIO_OPEN_FIREWALL%"=="1" set "FIREWALL_ARG=-OpenFirewall"

echo [INFO] Launching MinIO installer via PowerShell...
echo [INFO] InstallDir=%MINIO_INSTALL_DIR%
echo [INFO] DataDir=%MINIO_DATA_DIR%
echo [INFO] ApiPort=%MINIO_API_PORT% ConsolePort=%MINIO_CONSOLE_PORT%
echo [INFO] ServiceName=%MINIO_SERVICE_NAME%

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" ^
  -InstallDir "%MINIO_INSTALL_DIR%" ^
  -DataDir "%MINIO_DATA_DIR%" ^
  -ApiPort %MINIO_API_PORT% ^
  -ConsolePort %MINIO_CONSOLE_PORT% ^
  -RootUser "%MINIO_ROOT_USER%" ^
  -RootPassword "%MINIO_ROOT_PASSWORD%" ^
  -ServiceName "%MINIO_SERVICE_NAME%" ^
  %FIREWALL_ARG%

if errorlevel 1 (
  echo [ERROR] MinIO install failed.
  exit /b 1
)

echo [OK] MinIO install completed.
exit /b 0
