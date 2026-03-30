# MinIO 远程安装说明

本目录提供了 Linux（systemd）一键安装脚本：

- `install_minio.sh`

## 1) 远程机器执行

```bash
cd /path/to/Nii-Annotation
chmod +x deploy/minio/install_minio.sh
sudo bash deploy/minio/install_minio.sh
```

## 2) 自定义参数（推荐生产环境改默认账号密码）

```bash
export MINIO_ROOT_USER='minio_admin_prod'
export MINIO_ROOT_PASSWORD='replace-with-strong-password'
export MINIO_API_PORT='9000'
export MINIO_CONSOLE_PORT='9001'
export MINIO_DATA_DIR='/var/lib/minio'
export FORCE_OVERWRITE_ENV='1'   # 覆盖 /etc/minio/minio.env
sudo -E bash deploy/minio/install_minio.sh
```

可选变量还包括：

- `MINIO_WORKDIR`（默认同 `MINIO_DATA_DIR`）
- `MINIO_USER` / `MINIO_GROUP`
- `MINIO_BINARY_PATH` / `MC_BINARY_PATH`
- `MINIO_CONFIG_DIR`
- `MINIO_SERVICE_FILE`

## 3) 验证服务

```bash
curl -fsS http://127.0.0.1:9000/minio/health/live
sudo systemctl status minio
```

## 4) 后端对接配置

在后端启动前设置：

```bash
export ANNOTATION_MINIO_ENDPOINT='127.0.0.1:9000'
export ANNOTATION_MINIO_ACCESS_KEY='minio_admin_prod'
export ANNOTATION_MINIO_SECRET_KEY='replace-with-strong-password'
export ANNOTATION_MINIO_BUCKET='nii-annotation'
export ANNOTATION_MINIO_SECURE='false'
```
