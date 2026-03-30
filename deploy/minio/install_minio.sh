#!/usr/bin/env bash
set -euo pipefail

# One-click MinIO installer for Linux (systemd).
# Usage:
#   bash deploy/minio/install_minio.sh
#
# Optional environment variables:
#   MINIO_ROOT_USER
#   MINIO_ROOT_PASSWORD
#   MINIO_API_PORT (default: 9000)
#   MINIO_CONSOLE_PORT (default: 9001)
#   MINIO_DATA_DIR (default: /var/lib/minio)
#   MINIO_WORKDIR (default: same as MINIO_DATA_DIR)
#   MINIO_USER (default: minio)
#   MINIO_GROUP (default: minio)
#   MINIO_BINARY_PATH (default: /usr/local/bin/minio)
#   MC_BINARY_PATH (default: /usr/local/bin/mc)
#   MINIO_CONFIG_DIR (default: /etc/minio)
#   MINIO_SERVICE_FILE (default: /etc/systemd/system/minio.service)
#   FORCE_OVERWRITE_ENV=1 to overwrite existing /etc/minio/minio.env

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ERROR: This installer currently supports Linux only."
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "ERROR: systemctl not found. This script requires systemd."
  exit 1
fi

ARCH="$(uname -m)"
case "${ARCH}" in
  x86_64|amd64) MINIO_ARCH="linux-amd64" ;;
  aarch64|arm64) MINIO_ARCH="linux-arm64" ;;
  *)
    echo "ERROR: Unsupported architecture: ${ARCH}"
    exit 1
    ;;
esac

if [[ "${EUID}" -eq 0 ]]; then
  SUDO=""
else
  if ! command -v sudo >/dev/null 2>&1; then
    echo "ERROR: sudo is required when not running as root."
    exit 1
  fi
  SUDO="sudo"
fi

MINIO_USER="${MINIO_USER:-minio}"
MINIO_GROUP="${MINIO_GROUP:-minio}"
MINIO_API_PORT="${MINIO_API_PORT:-9000}"
MINIO_CONSOLE_PORT="${MINIO_CONSOLE_PORT:-9001}"
MINIO_DATA_DIR="${MINIO_DATA_DIR:-/var/lib/minio}"
MINIO_WORKDIR="${MINIO_WORKDIR:-${MINIO_DATA_DIR}}"
MINIO_CONFIG_DIR="${MINIO_CONFIG_DIR:-/etc/minio}"
MINIO_ENV_FILE="${MINIO_CONFIG_DIR}/minio.env"
MINIO_SERVICE_FILE="${MINIO_SERVICE_FILE:-/etc/systemd/system/minio.service}"
MINIO_BINARY_PATH="${MINIO_BINARY_PATH:-/usr/local/bin/minio}"
MC_BINARY_PATH="${MC_BINARY_PATH:-/usr/local/bin/mc}"

MINIO_ROOT_USER="${MINIO_ROOT_USER:-minioadmin}"
MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-minioadmin}"

MINIO_SERVER_URL="https://dl.min.io/server/minio/release/${MINIO_ARCH}/minio"
MC_URL="https://dl.min.io/client/mc/release/${MINIO_ARCH}/mc"

echo "==> Installing dependencies"
if command -v apt-get >/dev/null 2>&1; then
  ${SUDO} apt-get update -y
  ${SUDO} apt-get install -y curl ca-certificates
elif command -v yum >/dev/null 2>&1; then
  ${SUDO} yum install -y curl ca-certificates
elif command -v dnf >/dev/null 2>&1; then
  ${SUDO} dnf install -y curl ca-certificates
else
  echo "WARN: Could not detect package manager. Please ensure curl is installed."
fi

echo "==> Creating minio user/group"
if ! getent group "${MINIO_GROUP}" >/dev/null; then
  ${SUDO} groupadd --system "${MINIO_GROUP}"
fi

NOLOGIN_BIN="$(command -v nologin || true)"
if [[ -z "${NOLOGIN_BIN}" ]]; then
  if [[ -x /usr/sbin/nologin ]]; then
    NOLOGIN_BIN="/usr/sbin/nologin"
  elif [[ -x /sbin/nologin ]]; then
    NOLOGIN_BIN="/sbin/nologin"
  else
    NOLOGIN_BIN="/bin/false"
  fi
fi

if ! id -u "${MINIO_USER}" >/dev/null 2>&1; then
  ${SUDO} useradd --system --no-create-home --shell "${NOLOGIN_BIN}" \
    --gid "${MINIO_GROUP}" "${MINIO_USER}"
fi

echo "==> Downloading binaries"
${SUDO} curl -fsSL "${MINIO_SERVER_URL}" -o "${MINIO_BINARY_PATH}"
${SUDO} chmod +x "${MINIO_BINARY_PATH}"

${SUDO} curl -fsSL "${MC_URL}" -o "${MC_BINARY_PATH}"
${SUDO} chmod +x "${MC_BINARY_PATH}"

echo "==> Creating directories"
${SUDO} mkdir -p "${MINIO_DATA_DIR}" "${MINIO_WORKDIR}" "${MINIO_CONFIG_DIR}"
${SUDO} chown -R "${MINIO_USER}:${MINIO_GROUP}" "${MINIO_DATA_DIR}" "${MINIO_WORKDIR}" "${MINIO_CONFIG_DIR}"

echo "==> Writing env file: ${MINIO_ENV_FILE}"
if [[ -f "${MINIO_ENV_FILE}" && "${FORCE_OVERWRITE_ENV:-0}" != "1" ]]; then
  echo "INFO: ${MINIO_ENV_FILE} already exists. Keep existing file."
  echo "      Set FORCE_OVERWRITE_ENV=1 to overwrite."
else
  ${SUDO} tee "${MINIO_ENV_FILE}" >/dev/null <<EOF
MINIO_ROOT_USER=${MINIO_ROOT_USER}
MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}
MINIO_VOLUMES=${MINIO_DATA_DIR}
MINIO_OPTS=--address :${MINIO_API_PORT} --console-address :${MINIO_CONSOLE_PORT}
EOF
  ${SUDO} chown "${MINIO_USER}:${MINIO_GROUP}" "${MINIO_ENV_FILE}"
  ${SUDO} chmod 600 "${MINIO_ENV_FILE}"
fi

echo "==> Writing systemd service: ${MINIO_SERVICE_FILE}"
${SUDO} tee "${MINIO_SERVICE_FILE}" >/dev/null <<EOF
[Unit]
Description=MinIO
Documentation=https://docs.min.io
Wants=network-online.target
After=network-online.target

[Service]
WorkingDirectory=${MINIO_WORKDIR}
User=${MINIO_USER}
Group=${MINIO_GROUP}
EnvironmentFile=-${MINIO_ENV_FILE}
ExecStart=${MINIO_BINARY_PATH} server \$MINIO_VOLUMES \$MINIO_OPTS
Restart=always
RestartSec=5
LimitNOFILE=65536
TasksMax=infinity
TimeoutStopSec=infinity
SendSIGKILL=no

[Install]
WantedBy=multi-user.target
EOF

echo "==> Enabling and starting service"
${SUDO} systemctl daemon-reload
${SUDO} systemctl enable minio
${SUDO} systemctl restart minio

echo "==> Service status"
${SUDO} systemctl --no-pager --full status minio | sed -n '1,25p'

echo
echo "MinIO install finished."
echo "API endpoint   : http://<server-ip>:${MINIO_API_PORT}"
echo "Console endpoint: http://<server-ip>:${MINIO_CONSOLE_PORT}"
echo "Health check    : curl -fsS http://127.0.0.1:${MINIO_API_PORT}/minio/health/live"
echo "Manage service  : sudo systemctl restart|status|stop minio"
echo "CLI test        : ${MC_BINARY_PATH} alias set local http://127.0.0.1:${MINIO_API_PORT} ${MINIO_ROOT_USER} '***'"
