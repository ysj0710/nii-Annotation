# MinIO 远程安装说明

本目录现在支持两种系统：

- Linux: `install_minio.sh`（systemd）
- Windows PowerShell: `install_minio_windows.ps1`（Windows Service）
- Windows CMD: `install_minio_windows.cmd`（CMD 入口）

## Windows 安装（你当前用这个）

### 方式 A: PowerShell

用管理员权限打开 PowerShell，进入项目目录后执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\deploy\minio\install_minio_windows.ps1 `
  -RootUser "minio_admin_prod" `
  -RootPassword "replace-with-strong-password" `
  -ApiPort 9000 `
  -ConsolePort 9001 `
  -OpenFirewall
```

2) 验证：

```powershell
sc.exe query MinIO
Invoke-WebRequest http://127.0.0.1:9000/minio/health/live
```

### 方式 B: CMD（你要的）

用管理员权限打开 CMD，进入项目目录后执行：

```cmd
set MINIO_ROOT_USER=minio_admin_prod
set MINIO_ROOT_PASSWORD=replace-with-strong-password
set MINIO_API_PORT=9000
set MINIO_CONSOLE_PORT=9001
set MINIO_OPEN_FIREWALL=1
deploy\minio\install_minio_windows.cmd
```

### 控制服务

```powershell
sc.exe stop MinIO
sc.exe start MinIO
```

## Linux 安装

```bash
cd /path/to/Nii-Annotation
chmod +x deploy/minio/install_minio.sh
sudo bash deploy/minio/install_minio.sh
```

## 后端对接配置

后端连接 MinIO 的环境变量（Windows/Linux 含义一致）：

```bash
export ANNOTATION_MINIO_ENDPOINT='127.0.0.1:9000'
export ANNOTATION_MINIO_ACCESS_KEY='minio_admin_prod'
export ANNOTATION_MINIO_SECRET_KEY='replace-with-strong-password'
export ANNOTATION_MINIO_BUCKET='nii-annotation'
export ANNOTATION_MINIO_SECURE='false'
```
