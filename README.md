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
- `USAGE_TIMEZONE` (server-authoritative IANA timezone; defaults to the server timezone)
- `USAGE_DATA_DIR` (defaults to `~/.local/share/quota-dashboard/usage`)
- `QUOTA_LOG_DIR` (optional daily-log directory; see Logging below)
- `CCUSAGE_HOT_INTERVAL_MS` (local hot refresh interval; defaults to 600000)
- `CCUSAGE_HOT_TIMEOUT_MS` (local hot command timeout; defaults to 600000)
- `CCUSAGE_COLD_TIMEOUT_MS` (local cold command timeout; defaults to 1800000)
- `CCUSAGE_COLD_INTERVAL_MS` (local cold scheduler interval; defaults to 86400000)
- `CCUSAGE_COLD_MODE` (`offline` or `online`, defaults to `offline`)
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
- `QUOTA_CACHE_TTL_SECONDS` (defaults to `120` for existing providers; Claude uses `300`)
- `CODEX_AUTH_PATH` (defaults to `~/.codex/auth.json`)
- `CLAUDE_OAUTH_TOKEN` (Claude subscription OAuth access token, not an API key)
- `CLAUDE_AUTH_PATH` (explicit Claude credential file)
- `CLAUDE_CONFIG_DIR` (directory containing `.credentials.json`)
- `CLAUDE_USER_AGENT` (defaults to `claude-code/2.1.69`)
- `CONFIG_PATH` (defaults to `~/.config/quota-dashboard/config.json`)
- `HOST` and `PORT` (server bind address and port)

Ollama Cloud reads `OLLAMA_API_KEY` from the environment or from
`~/.config/quota-dashboard/.env`. Usage is fetched from
`https://ollama.com/api/balance`. Monthly quota usage is calculated as
`(allowance_usd - balance_usd) / allowance_usd * 100`. The card shows included
credits remaining, credits used, the monthly allowance, and the reported reset
date. Elapsed time uses the API's actual billing-period dates. A balance summary
above the quota bar shows total available credits with an included/purchased
breakdown, including zero purchased credits. Purchased credits do not affect the monthly percentage.
There is no fallback to `/api/usage` or its old limit response format.

### Claude subscription quota

Enable Claude in Manage providers. It defaults to disabled and does not add a usage
source. Credential lookup stops at the first selected source:

1. A non-empty `CLAUDE_OAUTH_TOKEN`.
2. `CLAUDE_AUTH_PATH`, if set.
3. `<CLAUDE_CONFIG_DIR>/.credentials.json`, if the directory override is set.
4. `~/.claude/.credentials.json`.

An invalid explicit source never falls back to another account. The supported file
format has a `claudeAiOauth` object with `accessToken` or `access_token`. Optional
`expiresAt` or `expires_at` accepts positive epoch seconds below `1e11`, epoch
milliseconds at or above that threshold, or an ISO timestamp with a timezone.
Camel-case keys take precedence when both forms are present. Optional `scopes`
accepts a string array or whitespace-separated string. Malformed metadata fails
locally; absent metadata is unknown and the upstream service validates the token.

A normal Claude Code subscription login is expected to work. The token needs
`user:profile`, a permission granted during login, not an extra header or secret.
An inference-only `claude setup-token` token may lack that permission. Anthropic
API keys and Admin usage/cost APIs do not provide subscription quota. macOS commonly
stores credentials in the `Claude Code-credentials` Keychain entry. This version
does not import Keychain entries; supply a quota-capable token or supported file.
Do not paste tokens or credential files into issues or chat.

The dashboard reads credentials again for each actual fetch and never changes the
file or refreshes OAuth tokens. Claude Code or the operator must renew credentials.
Direct-token deployments must replace expired tokens themselves. Tokens and private
cache fingerprints never go to the browser or logs. Account/source changes detected
on credential re-read clear previous measurements, including aggregate snapshots.
Settings also re-check credentials without requesting quota. Otherwise changes are
not detected immediately while a cached result or cooldown is active.

Quota comes from the undocumented `https://api.anthropic.com/api/oauth/usage`
endpoint using `anthropic-beta: oauth-2025-04-20`. Standard 5-hour, weekly, Sonnet,
and Opus weekly windows appear when reported. Missing utilization remains unavailable,
not zero. Window start dates are inferred from reset time and fixed duration.
Scoped `limits[]`, monetary extra usage, browser cookies, billing, and reset credits
are deferred until their schemas and units are verified.

The default User-Agent version above comes from a reported compatibility test, not
an authenticated test by this project. Override it with printable ASCII text if
needed. The API and accepted client identities can change. This is not a published
API contract or a guarantee against throttling or Cloudflare challenges. The
dashboard does not rotate identities or bypass challenges.

Claude has a five-minute cache TTL. Concurrent refreshes share one request, and
forced refresh and provider-test actions cannot bypass cooldowns. Valid
`Retry-After` delay-seconds or IMF-fixdate values apply even to authentication errors.
HTTP 429 without a future deadline backs off from five minutes to a one-hour cap;
a longer server deadline is never shortened. Success resets fallback backoff.
These are application polling policies, not a published safe API polling rate.
Cooldowns are in memory and do not survive server restarts.

Network errors, timeouts, HTTP 5xx, and HTTP 429 retain clearly marked stale quota
with its original measurement time. Authentication, configuration, and schema errors
clear retained data. The provider-test response includes `verified: true` only for
a successful live request, never for stale or cached results. Quota markers and reset
countdowns use a monotonic estimate from fresh dashboard/usage server timestamps,
subject to network delay and server clock error. Measurement age stays separate.

Local usage is collected in the background for one date at a time. The parsed result is separated into Codex, OpenCode, Hermes, and Antigravity groups using its provider/source fields; those groups are independently toggleable in the Providers dialog. Antigravity usage appears when the installed `ccusage` release supports that source. The dashboard reads normalized records from `USAGE_DATA_DIR` immediately and never waits for a `ccusage` process. Each host/date directory also keeps the exact current document in `raw.json` plus timestamped raw backups when a later complete result omits a previously present tool. The dashboard does not read provider-local databases directly. Codex/ChatGPT quota is fetched directly from `https://chatgpt.com/backend-api/wham/usage` using the Codex OAuth credentials in `~/.codex/auth.json`; an expired access token is refreshed automatically when the endpoint returns `401`. OpenCode Go supports rolling, weekly, and monthly windows when its dashboard returns them.

## Remote usage

Each remote publisher runs a hot collection for today and yesterday at startup and every
10 minutes. Cold history is collected one date at a time, starting with the newest stale
date, once per day or when requested by the dashboard. Hot jobs use a 10-minute timeout;
cold jobs use a 30-minute timeout and default to `--offline`. The original parsed ccusage
document remains unchanged under the envelope's `data` field:

```json
{
  "schemaVersion": 2,
  "publisherId": "1bb29fb4-f8c6-4fb8-a656-18ab4e06e7ac",
  "connectionId": "b954f2a3-86d8-4dd7-a152-f2ce3f83b06f",
  "sequence": 42,
  "hostId": "macbook",
  "generatedAt": "2026-09-13T15:30:00.000Z",
  "ccusageVersion": "ccusage 20.0.20",
  "timezone": "Asia/Singapore",
  "date": "2026-09-13",
  "category": "hot",
  "runId": "run-42",
  "data": { "daily": [], "totals": {} }
}
```

The default MQTT topics are:

```text
quota-dashboard/v1/hosts/<host-id>/usage/<YYYY-MM-DD>
quota-dashboard/v1/hosts/<host-id>/status
quota-dashboard/v1/hosts/<host-id>/error
quota-dashboard/v1/hosts/<host-id>/command
```

Usage, status, and error messages use QoS 1; usage/status/error messages are retained,
while commands are non-retained. Each usage message contains exactly one date. A failed
ccusage query does not replace the last successful date snapshot. The publisher reports
the error separately, and the dashboard continues to include stored data while marking
the host as unhealthy. Older or duplicate deliveries are ignored. Cold requests use a
command containing `requestId`, `category`, `from`, `to`, and `mode`; the remote agent
splits a range into one-day jobs.

The server's `USAGE_TIMEZONE` is authoritative. Remote messages must carry the same
IANA timezone or they are rejected. Each machine also owns distinct persisted usage
files. Publishing synchronized copies of the same coding-agent data will duplicate usage.

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
`MQTT_RECONNECT_TIMEOUT_MS`, `CCUSAGE_TIMEZONE`, `CCUSAGE_DAYS`, `MQTT_INTERVAL_MS`, `CCUSAGE_HOT_TIMEOUT_MS`,
`CCUSAGE_COLD_TIMEOUT_MS`, `CCUSAGE_COLD_INTERVAL_MS`, `CCUSAGE_COLD_MODE`,
`CCUSAGE_BIN`, `CCUSAGE_MAX_BUFFER`, optional `CCUSAGE_VERSION`, and optional
`QUOTA_LOG_DIR`. Set `QUOTA_LOG_DIR` when running setup to preserve an override in
`remote.env`; setup does not require it or prompt for it. Rerunning setup preserves
an existing override. Set `QUOTA_LOG_DIR` to an empty string during setup to remove it.

The remote publisher exits with code 1 if MQTT stays disconnected for 90 seconds,
including at startup. Set `MQTT_RECONNECT_TIMEOUT_MS` to a positive duration in
milliseconds to change this limit. A successful connection resets the watchdog.
The installed launchd and systemd services restart the process automatically.
On connection, the publisher finishes the initial hot collection before scheduling
cold history collection.

## Logging

The server and remote publisher write separate daily files named
`server-info-YYYY-MM-DD.log` and `remote-info-YYYY-MM-DD.log`. The default directory is
`~/Library/Logs/quota-dashboard` on macOS and
`~/.local/state/quota-dashboard/logs` on Linux. Both accept `QUOTA_LOG_DIR` and create
the directory automatically. Server overrides can also be set in
`~/.config/quota-dashboard/.env`.

Dates and timestamps use the process host's local timezone, not `USAGE_TIMEZONE`
or `CCUSAGE_TIMEZONE`. Retention keeps today's file and the previous six calendar
dates. Cleanup runs at startup and rollover and only removes that process's matching
daily files. Future-dated files are preserved if the host clock moves backwards.
Queued entries delayed beyond the retention window go into the current file with their
original timestamp. Existing macOS stdout/stderr files and Linux journal logging are unchanged.

Daily files trace on-demand and scheduled jobs, MQTT application traffic, and HTTP
request arrival and completion. HTTP completion records also go to stdout. Correlation
IDs connect requests and jobs where the existing protocol provides them. Skipped or
deduplicated jobs are logged without changing scheduling behavior. Accepted background
refreshes continue if an HTTP client disconnects.

Routine scheduled job progress and success stay out of main logs. Errors and the
first successful hot or cold run after a failure remain visible there. Recovery is
tracked separately for hot and cold jobs and resets when the process restarts.

Logs omit credentials, HTTP query strings, raw MQTT payloads, and usage contents.
File logging is asynchronous and does not stop usage collection or HTTP handling if
the disk fails. A queue of at most 1,000 pending entries drops new info entries under
overload; stderr reports failures and dropped-entry counts. File logging retries and announces
recovery, and records lost-entry gaps in the daily file. Each message is limited to
8,192 characters, with control characters replaced to prevent forged log lines.
Shutdown allows up to two seconds to flush pending entries.

## Remote transport security

The first version intentionally uses ordinary MQTT username/password authentication.
Credentials and usage metadata are unencrypted with an `mqtt://` URL. Keep the broker
on a trusted private network and do not expose it to the internet. The MQTT library can
connect to an `mqtts://` broker that uses a certificate trusted by the operating system,
but custom CA configuration is not currently exposed. Configure broker ACLs so each
publisher account can write only to its own `quota-dashboard/v1/hosts/<host-id>/#`
topics and the dashboard account can read the shared host prefix.

## Future clients

The normalized, versioned API is designed for native clients and widgets:

- `GET /api/v1/dashboard`
- `GET /api/v1/usage`
- `POST /api/v1/usage/refresh`
- `POST /api/v1/usage/cold`
- `GET /api/v1/providers`
- `GET /api/v1/quotas`
- `GET /api/v1/widget-summary`
- `PUT /api/v1/providers/:id/enabled`

The widget endpoint deliberately returns a compact provider snapshot, separate from the web dashboard response.

The dashboard usage response retains its existing aggregate fields and also includes normalized `usage.records`
with a `hostId` on each record. The browser uses those records to filter totals, charts, model rankings, and
daily details immediately when usage hosts are toggled.
