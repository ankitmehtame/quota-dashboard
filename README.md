# Quota / usage

A Node service and installable PWA for AI usage across multiple machines and provider
quota status. Local and remote usage reporting requires the external `ccusage`
command-line tool. Remote snapshots are transported through MQTT.

## Run

```sh
cd src
npm start
```

The server requires Node.js 22 or newer. `npm start` compiles the TypeScript source
to `src/dist/` before starting the server. Install and configure `ccusage` separately
if you want local usage statistics; the dashboard reports an error when the command
is unavailable.

For development and verification, run `npm run build` or `npm test` from `src/`.

Open `http://127.0.0.1:4173`. To expose it on your local network, run:

```sh
HOST=0.0.0.0 npm start
```

Application TypeScript source lives in `src/`; generated runtime JavaScript is written
to `src/dist/` and is ignored by git. GitHub Actions uploads the contents of `src/dist/`
as the `quota-dashboard-node` artifact. Each build also writes a deterministic Git-derived
version to `src/dist/version.json`, which is shown in the dashboard footer. Tagged commits
use their `vX.Y.Z` tag; other commits use a version such as `0.1.0-dev.3+gba87213`.
Extract it on a Node.js 22+ host and run
`node server.js` from the extracted directory.

## Releases

Every push to `main` automatically creates the next minor version tag (`vX.Y.0`)
and GitHub Release. The release is created after the build, tests, and runtime
smoke test pass. Tags whose commits are on `main` create regular releases; tags
from other branches create pre-releases. Each release includes separate compressed
dashboard and remote-agent Node.js archives. Manual tag pushes are intended for branch pre-releases;
normal releases should be produced by merging to `main`.

Extract `quota-dashboard-node-vX.Y.Z.tar.gz` on a Node.js 22+ host and run
`node server.js` from the extracted directory. To install only a remote publisher,
extract `quota-dashboard-remote-agent-vX.Y.Z.tar.gz` and run its bundled installer:

```sh
REMOTE_AGENT_DIR="${HOME}/.local/share/quota-dashboard/remote-agent"
mkdir -p "${REMOTE_AGENT_DIR}"
tar -xzf quota-dashboard-remote-agent-vX.Y.Z.tar.gz --strip-components=1 -C "${REMOTE_AGENT_DIR}"
"${REMOTE_AGENT_DIR}/setup.sh"
```

The remote-agent archive includes its production dependencies, so installation does
not need npm or network access. Install Node.js 22+ and `ccusage` separately first.
Keep `${HOME}/.local/share/quota-dashboard/remote-agent` in place after installation;
`setup.sh` records the absolute path to its `index.js`. Host upgrades remain manual:
replace that directory with a newer archive, then rerun its `setup.sh`:

```sh
REMOTE_AGENT_DIR="${HOME}/.local/share/quota-dashboard/remote-agent"
rm -rf "${REMOTE_AGENT_DIR}"
mkdir -p "${REMOTE_AGENT_DIR}"
tar -xzf quota-dashboard-remote-agent-vX.Y.Z.tar.gz --strip-components=1 -C "${REMOTE_AGENT_DIR}"
"${REMOTE_AGENT_DIR}/setup.sh"
```

## Configuration

Provider enablement and dashboard order are stored in `~/.config/quota-dashboard/config.json` with mode `0600`. No machine-specific absolute paths or identifiers are stored in the application. Provider credentials and machine-specific overrides remain server-side and can be supplied through environment variables:

- `CCUSAGE_BIN` (defaults to `ccusage`)
- `LOCAL_HOST_ID` (defaults to the sanitized system hostname)
- `MQTT_URL` or `MQTT_BROKER_URL` (enables remote usage, for example `mqtt://homeassistant.local:1883`)
- `MQTT_USERNAME` and `MQTT_PASSWORD`
- `MQTT_PREFIX` (defaults to `quota-dashboard/v1`)
- `MQTT_STALE_AFTER_SECONDS` (defaults to `900`)
- `MQTT_MAX_PAYLOAD_BYTES` (defaults to 32 MiB)
- `OPENROUTER_API_KEY`
- `OLLAMA_API_KEY` (reserved for Ollama Cloud API requests)
- `OPENCODE_GO_WORKSPACE_ID`
- `OPENCODE_GO_AUTH_COOKIE`
- `OPENCODE_AUTH_PATH` (defaults to `~/.local/share/opencode/auth.json`)
- `QUOTA_CACHE_TTL_SECONDS` (defaults to `120`)
- `CODEX_AUTH_PATH` (defaults to `~/.codex/auth.json`)
- `CONFIG_PATH` (defaults to `~/.config/quota-dashboard/config.json`)
- `HOST` and `PORT` (server bind address and port)

Ollama Cloud reads `OLLAMA_API_KEY` from the environment or from
`~/.config/quota-dashboard/.env`. Usage is fetched from
`https://ollama.com/api/usage`. Newer accounts report a monthly window; legacy
accounts may report session and weekly windows instead. Reset timestamps are
shown when Ollama reports them, while legacy windows use their known schedules.

Local usage is read exclusively with one shared `ccusage daily --json` command. The response is separated into Codex, OpenCode, Hermes, and Antigravity groups using its provider/source fields; those groups are independently toggleable in the Providers dialog. Antigravity usage appears when the installed `ccusage` release supports that source. The dashboard does not read provider-local databases directly. Codex/ChatGPT quota is fetched directly from `https://chatgpt.com/backend-api/wham/usage` using the Codex OAuth credentials in `~/.codex/auth.json`; an expired access token is refreshed automatically when the endpoint returns `401`. OpenCode Go supports rolling, weekly, and monthly windows when its dashboard returns them.

## Remote usage

Each remote publisher runs `ccusage daily --json --by-agent` at startup and every five
minutes. It publishes a retained snapshot for the previous 370 days. The original
parsed ccusage document remains unchanged under the envelope's `data` field:

```json
{
  "schemaVersion": 1,
  "publisherId": "1bb29fb4-f8c6-4fb8-a656-18ab4e06e7ac",
  "connectionId": "b954f2a3-86d8-4dd7-a152-f2ce3f83b06f",
  "sequence": 42,
  "hostId": "macbook",
  "generatedAt": "2026-09-13T15:30:00.000Z",
  "ccusageVersion": "ccusage 20.0.20",
  "timezone": "Asia/Singapore",
  "range": { "from": "2025-09-09", "to": "2026-09-13" },
  "data": { "daily": [], "totals": {} }
}
```

The default MQTT topics are:

```text
quota-dashboard/v1/hosts/<host-id>/usage
quota-dashboard/v1/hosts/<host-id>/status
quota-dashboard/v1/hosts/<host-id>/error
```

Usage, status, and error messages use QoS 1 and retained delivery. A failed ccusage
query does not replace the last successful usage snapshot. The publisher reports the
error separately, and the dashboard continues to include the stale data while marking
the host as unhealthy. Older or duplicate deliveries from a prior publisher process are
ignored. A snapshot whose published range does not cover the selected dashboard range
still contributes its available records but is explicitly marked incomplete.

All publishers and the dashboard must use the same IANA timezone. ccusage produces
date buckets rather than individual timestamps, so the dashboard rejects a remote
snapshot whose timezone differs from the dashboard query timezone. Each machine must
also own distinct usage files. Publishing synchronized copies of the same coding-agent
data will duplicate usage.

### Install a publisher

The setup script supports per-user services on Debian with systemd and on macOS with
launchd. Install Node.js 22+ and ccusage first. Keep the extracted release or repository
directory in place because the service launcher refers to its absolute path.

From a source checkout:

```sh
cd src
npm install
npm run build
./dist/remote/setup.sh
```

From an extracted remote-agent release archive installed at the durable path above:

```sh
"${HOME}/.local/share/quota-dashboard/remote-agent/setup.sh"
```

The script asks for the MQTT broker, credentials, host ID, and canonical timezone. It
writes `~/.config/quota-dashboard/remote.env` with mode `0600`, then installs and starts
`quota-dashboard-remote.service` on Debian or `local.quota-dashboard.remote` on macOS.
On Debian, enable user lingering separately if the publisher must run while the user is
logged out:

```sh
loginctl enable-linger "$USER"
```

The remote publisher accepts these environment variables when run without the setup
script: `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`, `MQTT_PREFIX`, `MQTT_HOST_ID`,
`CCUSAGE_TIMEZONE`, `CCUSAGE_DAYS`, `MQTT_INTERVAL_MS`, `CCUSAGE_BIN`,
`CCUSAGE_TIMEOUT_MS`, `CCUSAGE_MAX_BUFFER`, and optional `CCUSAGE_VERSION`.

The first version intentionally uses ordinary MQTT username/password authentication.
Credentials and usage metadata are unencrypted with an `mqtt://` URL. Keep the broker
on a trusted private network and do not expose it to the internet. The MQTT library can
connect to an `mqtts://` broker that uses a certificate trusted by the operating system,
but custom CA configuration is not currently exposed. Configure broker ACLs so each
publisher account can write only to its own `quota-dashboard/v1/hosts/<host-id>/#`
topics and the dashboard account can read the shared host prefix.

## Future clients

The normalized, versioned API is designed for later native clients and widgets:

- `GET /api/v1/dashboard`
- `GET /api/v1/providers`
- `GET /api/v1/quotas`
- `GET /api/v1/widget-summary`
- `PUT /api/v1/providers/:id/enabled`

The widget endpoint deliberately returns a compact provider snapshot, separate from the web dashboard response.
