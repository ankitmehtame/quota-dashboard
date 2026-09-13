#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${HOME}/.config/quota-dashboard"
ENV_FILE="${CONFIG_DIR}/remote.env"
BIN_DIR="${HOME}/.local/bin"
LAUNCHER="${BIN_DIR}/quota-dashboard-remote"

if ! command -v node >/dev/null 2>&1; then
  printf 'Node.js 22 or newer is required.\n' >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR}" -lt 22 ]; then
  printf 'Node.js 22 or newer is required; found %s.\n' "$(node --version)" >&2
  exit 1
fi

if ! command -v ccusage >/dev/null 2>&1; then
  printf 'ccusage is required. Install it before running setup.\n' >&2
  exit 1
fi

REMOTE_ENTRY="${SCRIPT_DIR}/index.js"
if [ ! -f "${REMOTE_ENTRY}" ]; then
  PACKAGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
  if [ ! -f "${PACKAGE_DIR}/package.json" ]; then
    printf 'Built remote publisher not found at %s.\n' "${REMOTE_ENTRY}" >&2
    exit 1
  fi
  printf 'Building quota-dashboard remote publisher...\n'
  npm install --prefix "${PACKAGE_DIR}"
  npm run build --prefix "${PACKAGE_DIR}"
  REMOTE_ENTRY="${PACKAGE_DIR}/dist/remote/index.js"
fi

DEFAULT_HOST_ID="$(node -e 'const os=require("node:os"); console.log(os.hostname().trim().replace(/[^A-Za-z0-9._~-]+/g,"-").replace(/^[.-]+|[.-]+$/g,"") || "host")')"
DEFAULT_TIMEZONE="$(node -e 'console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)')"

printf 'MQTT broker URL [mqtt://homeassistant.local:1883]: '
read -r MQTT_URL
MQTT_URL="${MQTT_URL:-mqtt://homeassistant.local:1883}"
printf 'MQTT username: '
read -r MQTT_USERNAME
printf 'MQTT password: '
read -rs MQTT_PASSWORD
printf '\nHost ID [%s]: ' "${DEFAULT_HOST_ID}"
read -r MQTT_HOST_ID
MQTT_HOST_ID="${MQTT_HOST_ID:-${DEFAULT_HOST_ID}}"
printf 'Canonical timezone [%s]: ' "${DEFAULT_TIMEZONE}"
read -r CCUSAGE_TIMEZONE
CCUSAGE_TIMEZONE="${CCUSAGE_TIMEZONE:-${DEFAULT_TIMEZONE}}"

quote_env() {
  local value="${1//\'/\'\\\'\'}"
  printf "'%s'" "${value}"
}

xml_escape() {
  node -e 'process.stdout.write(process.argv[1].replace(/[&<>"\x27]/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","\x27":"&apos;"})[character]))' "$1"
}

mkdir -p "${CONFIG_DIR}" "${BIN_DIR}"
umask 077
{
  printf 'MQTT_URL=%s\n' "$(quote_env "${MQTT_URL}")"
  printf 'MQTT_USERNAME=%s\n' "$(quote_env "${MQTT_USERNAME}")"
  printf 'MQTT_PASSWORD=%s\n' "$(quote_env "${MQTT_PASSWORD}")"
  printf 'MQTT_HOST_ID=%s\n' "$(quote_env "${MQTT_HOST_ID}")"
  printf 'MQTT_PREFIX=%s\n' "$(quote_env "quota-dashboard/v1")"
  printf 'CCUSAGE_TIMEZONE=%s\n' "$(quote_env "${CCUSAGE_TIMEZONE}")"
  printf 'CCUSAGE_DAYS=%s\n' "$(quote_env "370")"
  printf 'MQTT_INTERVAL_MS=%s\n' "$(quote_env "300000")"
  printf 'CCUSAGE_BIN=%s\n' "$(quote_env "$(command -v ccusage)")"
  printf 'CCUSAGE_VERSION=%s\n' "$(quote_env "$(ccusage --version 2>/dev/null || true)")"
} > "${ENV_FILE}"
chmod 600 "${ENV_FILE}"

NODE_BIN="$(command -v node)"
{
  printf '#!/usr/bin/env bash\n'
  printf 'set -a\n'
  printf 'source %q\n' "${ENV_FILE}"
  printf 'set +a\n'
  printf 'exec %q %q\n' "${NODE_BIN}" "${REMOTE_ENTRY}"
} > "${LAUNCHER}"
chmod 700 "${LAUNCHER}"

case "$(uname -s)" in
  Linux)
    if ! command -v systemctl >/dev/null 2>&1; then
      printf 'systemd is required for automatic Debian startup. Run %s manually instead.\n' "${LAUNCHER}" >&2
      exit 1
    fi
    UNIT_DIR="${HOME}/.config/systemd/user"
    UNIT_FILE="${UNIT_DIR}/quota-dashboard-remote.service"
    mkdir -p "${UNIT_DIR}"
    cat > "${UNIT_FILE}" <<EOF
[Unit]
Description=Quota Dashboard remote usage publisher
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart="%h/.local/bin/quota-dashboard-remote"
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable quota-dashboard-remote.service
    systemctl --user restart quota-dashboard-remote.service
    printf 'Installed and started quota-dashboard-remote.service.\n'
    printf 'Inspect it with: systemctl --user status quota-dashboard-remote.service\n'
    ;;
  Darwin)
    PLIST_DIR="${HOME}/Library/LaunchAgents"
    PLIST_FILE="${PLIST_DIR}/local.quota-dashboard.remote.plist"
    LOG_DIR="${HOME}/Library/Logs/quota-dashboard"
    mkdir -p "${PLIST_DIR}" "${LOG_DIR}"
    cat > "${PLIST_FILE}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.quota-dashboard.remote</string>
  <key>ProgramArguments</key><array><string>$(xml_escape "${LAUNCHER}")</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml_escape "${LOG_DIR}/remote.log")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "${LOG_DIR}/remote-error.log")</string>
</dict>
</plist>
EOF
    launchctl bootout "gui/${UID}/local.quota-dashboard.remote" >/dev/null 2>&1 || true
    if ! launchctl bootstrap "gui/${UID}" "${PLIST_FILE}"; then
      launchctl load "${PLIST_FILE}"
    fi
    printf 'Installed and started local.quota-dashboard.remote.\n'
    printf 'Logs: %s\n' "${LOG_DIR}"
    ;;
  *)
    printf 'Unsupported operating system. Run %s manually.\n' "${LAUNCHER}" >&2
    exit 1
    ;;
esac

printf 'Configuration: %s\n' "${ENV_FILE}"
