# Quota / usage

A Node service and installable PWA for local AI usage and provider quota status. The
application has no npm package dependencies, but local usage reporting requires the
external `ccusage` command-line tool.

## Run

```sh
cd src
npm start
```

The server requires Node.js 20 or newer. `npm start` compiles the TypeScript source
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
as the `quota-dashboard-node` artifact. Extract it on a Node.js 20+ host and run
`node server.js` from the extracted directory.

## Configuration

Provider enablement is stored in `~/.config/quota-dashboard/config.json` with mode `0600`. No machine-specific absolute paths or identifiers are stored in the application. Provider credentials and machine-specific overrides remain server-side and can be supplied through environment variables:

- `CCUSAGE_BIN` (defaults to `ccusage`)
- `OPENROUTER_API_KEY`
- `TOGETHER_API_KEY`
- `TOGETHER_ORGANIZATION_ID` (optional; otherwise discovered from Together's API)
- `OPENCODE_GO_WORKSPACE_ID`
- `OPENCODE_GO_AUTH_COOKIE`
- `OPENCODE_AUTH_PATH` (defaults to `~/.local/share/opencode/auth.json`)
- `QUOTA_CACHE_TTL_SECONDS` (defaults to `120`)
- `CODEX_AUTH_PATH` (defaults to `~/.codex/auth.json`)
- `CONFIG_PATH` (defaults to `~/.config/quota-dashboard/config.json`)
- `HOST` and `PORT` (server bind address and port)

Local usage is read exclusively with one shared `ccusage daily --json` command. The response is separated into Codex, OpenCode, and Hermes groups using its provider/source fields; those groups are independently toggleable in the Providers dialog. The dashboard does not read provider-local databases directly. Codex/ChatGPT quota is fetched directly from `https://chatgpt.com/backend-api/wham/usage` using the Codex OAuth access token and account ID in `~/.codex/auth.json`; CLIProxyAPI is not required. OpenCode Go supports rolling, weekly, and monthly windows when its dashboard returns them, while Together AI currently reports balance and spent credits without a reset or total limit.

## Future clients

The normalized, versioned API is designed for later native clients and widgets:

- `GET /api/v1/dashboard`
- `GET /api/v1/providers`
- `GET /api/v1/quotas`
- `GET /api/v1/widget-summary`
- `PUT /api/v1/providers/:id/enabled`

The widget endpoint deliberately returns a compact provider snapshot, separate from the web dashboard response.
