// Isolated UI demo. No credentials, usage files, MQTT, or upstream APIs are read.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';

const publicDir = resolve(fileURLToPath(new URL('../src/dist/public/', import.meta.url)));
const port = Number(process.env.DEMO_PORT || 4174);
const host = process.env.DEMO_HOST || '127.0.0.1';
const dayMs = 86_400_000;
const now = () => new Date().toISOString();
const date = (offset = 0) => new Date(Date.now() + offset * dayMs).toISOString().slice(0, 10);
const at = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString();
const providers = Object.fromEntries([
  ['claude', 'Claude', 'Claude', 'orange', 'Max subscription'],
  ['codex', 'ChatGPT / Codex', 'Codex', 'mint', 'Plus subscription'],
  ['opencode-go', 'OpenCode Go', 'OpenCode Go', 'violet', 'Coding subscription'],
  ['ollama', 'Ollama Cloud', 'Ollama', 'blue', 'Cloud credits'],
].map(([id, name, shortName, accent, description]) => [id, { id, name, shortName, accent, description, enabled: true, configured: true, status: 'connected' }]));
let providerOrder = Object.keys(providers);
const usageSources = { codex: { enabled: true }, opencode: { enabled: true }, hermes: { enabled: true } };
const window = (name, usedPercent, hours, elapsed) => ({ name, usedPercent, resetAt: at(hours), windowStart: at(-elapsed), windowEnd: at(hours), windowSeconds: (hours + elapsed) * 3600 });
const quotas = {
  claude: { windows: [window('5-hour', 24, 3, 2), window('weekly', 42, 70, 98)], planType: 'Max' },
  codex: { windows: [window('5-hour', 67, 1, 4), window('weekly', 31, 102, 66)], planType: 'Plus', resetCredits: [{ id: 'demo-reset', title: 'Full reset', expiresAt: at(168) }] },
  'opencode-go': { windows: [window('weekly', 83, 30, 138), window('monthly', 56, 240, 480)] },
  ollama: { windows: [{ ...window('monthly', 36, 240, 480), valueLabel: '$7.20 used', limitValue: 20, unit: 'USD' }], creditBalance: { includedUsd: 12.8, purchasedUsd: 5 } },
};
const models = [['codex', 'gpt-5.4'], ['opencode', 'claude-sonnet-4-6'], ['hermes', 'gemini-3.1-pro']];

function usage(url) {
  const preset = url.searchParams.get('range');
  const today = new Date(`${date()}T00:00:00Z`);
  let days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 1));
  if (preset === 'calendar-week') days = (today.getUTCDay() + 6) % 7 + 1;
  if (preset === 'calendar-month') days = today.getUTCDate();
  if (preset === 'calendar-year') days = Math.round((today - new Date(`${today.getUTCFullYear()}-01-01T00:00:00Z`)) / dayMs) + 1;
  const records = [];
  for (let offset = 1 - days; offset <= 0; offset++) {
    for (const [hostIndex, hostId] of ['workstation', 'macbook-pro'].entries()) {
      for (const [index, [provider, model]] of models.entries()) {
        if (!usageSources[provider].enabled) continue;
        const seed = Math.floor(today.getTime() / dayMs) + offset;
        const costUsd = Number(((2.4 + Math.sin(seed * .83 + index) * 1.7 + ((seed + index) % 5) * .45) * (hostIndex ? .46 : 1)).toFixed(2));
        records.push({ hostId, date: date(offset), provider, model, inputTokens: Math.round(costUsd * 22000), cachedInputTokens: Math.round(costUsd * 8000), cacheCreationTokens: 0, outputTokens: Math.round(costUsd * 3000), reasoningTokens: 0, costUsd });
      }
    }
  }
  const totalTokens = (record) => record.inputTokens + record.cachedInputTokens + record.outputTokens;
  return {
    from: date(1 - days), to: date(), providers: Object.keys(usageSources).filter((id) => usageSources[id].enabled), records,
    totalCostUsd: records.reduce((sum, record) => sum + record.costUsd, 0),
    totalTokens: records.reduce((sum, record) => sum + totalTokens(record), 0),
    hosts: [
      { hostId: 'workstation', status: 'ok', local: true, active: true, usable: true, included: true, complete: true, generatedAt: now() },
      { hostId: 'macbook-pro', status: 'offline', severity: 'warning', error: 'Publisher offline. Stored usage is complete for this period.', active: false, usable: true, included: true, complete: true, generatedAt: at(-2) },
    ],
    mqtt: { configured: true, connection: 'connected' },
  };
}

async function body(request) {
  let value = '';
  for await (const chunk of request) {
    value += chunk;
    if (value.length > 16_384) throw new Error('Request too large');
  }
  return value ? JSON.parse(value) : {};
}

const server = createServer(async (request, response) => {
  const json = (value, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  };
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    const path = url.pathname;
    if (path.startsWith('/api/')) {
      if (request.method === 'PUT') {
        const data = await body(request);
        if (path === '/api/v1/providers/order') {
          if (!Array.isArray(data.order) || data.order.length !== providerOrder.length || new Set(data.order).size !== providerOrder.length || data.order.some((id) => !providers[id])) return json({ error: 'Invalid provider order' }, 400);
          providerOrder = data.order;
        } else {
          const match = path.match(/^\/api\/v1\/(providers|usage-sources)\/([^/]+)\/enabled$/);
          const source = match && (match[1] === 'providers' ? providers : usageSources)[decodeURIComponent(match[2])];
          if (!source || typeof data.enabled !== 'boolean') return json({ error: 'Unknown demo setting' }, 400);
          source.enabled = data.enabled;
        }
        return json({ ok: true });
      }
      if (path === '/api/v1/providers') return json({ providerOrder, providers, usageSources });
      if (path === '/api/v1/icons/refresh') return json({ icons: {} });
      if (path === '/api/v1/usage/cold') return json({ error: 'Demo only. No historical collection is started.' }, 409);
      if (path === '/api/v1/usage/refresh') return json({ accepted: true });
      if (path === '/api/v1/usage') return json({ version: 'demo', apiVersion: 1, serverNow: now(), timezone: 'UTC', usage: usage(url) });
      if (path === '/api/v1/dashboard') return json({ version: 'demo', providerOrder, providers, quotas: Object.fromEntries(Object.entries(quotas).map(([id, quota]) => [id, { ...quota, fetchedAt: now() }])), serverNow: now(), cache: { fetchedAt: now() }, usage: usage(url) });
      return json({ error: 'Unknown demo endpoint' }, 404);
    }
    // This worker never caches or intercepts requests. The demo has its own origin.
    if (path === '/sw.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      return response.end('// Demo: no offline caching.');
    }
    const file = resolve(publicDir, path === '/' ? 'index.html' : `.${decodeURIComponent(path)}`);
    if (!file.startsWith(publicDir + sep)) return json({ error: 'Not found' }, 404);
    let content = await readFile(file);
    if (file.endsWith('index.html')) content = Buffer.from(content.toString().replace('<body>', '<body><div class="demo-banner"><strong>Sample data.</strong> No accounts connected. Settings changes last until this demo restarts.</div>'));
    if (file.endsWith('app.js')) content = Buffer.from(content.toString().replace('days: 1, range: "today"', 'days: 30, range: "relative-30"'));
    const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/json';
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    response.end(content);
  } catch (error) {
    json({ error: error.code === 'ENOENT' ? 'Build the application first with npm run build in src/.' : 'Demo request failed' }, error.code === 'ENOENT' ? 404 : 400);
  }
});
server.listen(port, host, () => console.log(`UI demo: http://${host}:${server.address().port} (sample data only)`));
