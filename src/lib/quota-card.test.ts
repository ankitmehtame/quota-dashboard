import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { parseClaudeQuota, parseOllamaBalance, parseOllamaCreditBalance } from "./providers.js";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const renderer = app.slice(app.indexOf("function formatTokens("), app.indexOf("function renderQuotas("));

function renderOllama(payload: unknown): string {
  return runInNewContext(`${renderer}\nquotaCard("ollama", provider, quota);`, {
    provider: { id: "ollama", shortName: "Ollama", description: "Monthly cloud credits and balance", accent: "orange", configured: true, status: "ok" },
    quota: { windows: parseOllamaBalance(payload), creditBalance: parseOllamaCreditBalance(payload) },
    state: { hour12: false },
    money: (value: number) => `$${value.toFixed(2)}`,
    escapeHtml: (value: string) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
  });
}

test("Ollama balance card shows 17.3 percent used, credits, and the actual reset date", () => {
  const html = renderOllama({ included: { balance_usd: 2.06662, allowance_usd: 2.5,
    period: { from: "2026-09-19T00:50:25Z", until: "2026-10-19T00:50:25Z" } }, purchased: { balance_usd: 0 } });
  for (const text of ["connected", "monthly", "17.3%", "$2.07 remaining", "$0.43 used", "limit $2.50", "resets in", "Oct 19"]) {
    assert.ok(html.includes(text), `Missing ${text}`);
  }
  assert.match(html, /class="bar"/);
  assert.match(html, /quota-balance-primary">\$2\.07 balance/);
  assert.match(html, /quota-balance-secondary">\$0\.00 purchased/);
  assert.match(html, /quota-credit-balance-inline/);
  assert.doesNotMatch(html, /\$2\.07 included/);
  assert.ok(html.indexOf("provider-head") < html.indexOf("quota-credit-balance"));
  assert.ok(html.indexOf("quota-credit-balance") < html.indexOf("quota-window"));
  assert.match(html, /<div class="quota-foot"><span>resets in [\s\S]*?<\/span><span>\$2\.07 remaining · \$0\.43 used · limit \$2\.50<\/span><\/div>/);
  assert.doesNotMatch(html, /reset not reported|No balance reported|Not available|quota-error|approx|inferred/);
});

test("Ollama purchased balance does not introduce a second quota percentage", () => {
  const html = renderOllama({ included: { balance_usd: 2.06662, allowance_usd: 2.5 }, purchased: { balance_usd: 25 } });
  assert.match(html, /17.3%/);
  assert.match(html, /\$27.07 balance/);
  assert.match(html, /\$2.07 included · \$25.00 purchased/);
  assert.doesNotMatch(html, /quota-credit-balance-inline/);
  assert.equal([...html.matchAll(/class="bar"/g)].length, 1);
});

test("elapsed position uses the reported billing period and never a calendar approximation", () => {
  const from = "2026-09-19T00:50:25Z";
  const until = "2026-10-19T00:50:25Z";
  const position = runInNewContext(`${renderer}\nquotaNowPosition(window);`, {
    window: { windowStart: from, resetAt: until },
    Date: class extends Date { static now() { return Date.parse(from) + 15 * 86400 * 1000; } },
  });
  assert.equal(position, 50);
  assert.equal(runInNewContext(`${renderer}\nquotaNowPosition(window);`, { window: { name: "monthly" } }), null);
});

function renderClaude(quota: Record<string, unknown>, status = "ok"): string {
  return runInNewContext(`${renderer}\nquotaCard("claude", provider, quota);`, {
    provider: { id: "claude", shortName: "Claude", description: "Subscription quota", accent: "orange", configured: true, status },
    quota, state: { hour12: false },
    escapeHtml: (value: unknown) => String(value).replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
  });
}

test("Claude cards label even one window and do not invent a balance", () => {
  const html = renderClaude({ windows: parseClaudeQuota({ five_hour: { utilization: 12.5, resets_at: "2026-10-16T18:00:00Z" } }) });
  assert.match(html, /5-hour/);
  assert.match(html, /12\.5%/);
  assert.match(html, /resets in/);
  assert.doesNotMatch(html, /No balance reported|quota-credit-balance|limit /);
});

test("Claude stale quota keeps measurement time and error; auth errors have no quota bars", () => {
  const html = renderClaude({ windows: parseClaudeQuota({ seven_day: { utilization: 44 } }), stale: true,
    error: "Claude returned HTTP 429", fetchedAt: "2026-10-15T03:04:00Z", cooldownUntil: Date.now() + 300_000 }, "error");
  assert.match(html, /Stale · last known quota measured/);
  assert.match(html, /Oct 15/);
  assert.match(html, /44%/);
  assert.match(html, /Weekly/);
  assert.match(html, /HTTP 429/);
  assert.match(html, /Retry after/);
  assert.match(html, /provider-badge">error/);
  const auth = renderClaude({ windows: [], error: "Sign in again" }, "error");
  assert.doesNotMatch(auth, /class="bar"|Stale|0%/);
  assert.match(auth, /Sign in again/);
  assert.match(renderClaude({ windows: [], error: "<script>" }, "error"), /&lt;script&gt;/);
});

test("server clock estimate drives markers and countdowns despite wall-clock skew and jumps", () => {
  for (const skew of [-3_600_000, 3_600_000]) {
    let wall = Date.parse("2026-10-16T12:00:00Z") + skew;
    let monotonic = 100;
    const context = {
      state: { hour12: false }, performance: { now: () => monotonic },
      Date: class extends Date { static now() { return wall; } },
      window: { windowStart: "2026-10-16T10:00:00Z", resetAt: "2026-10-16T15:00:00Z" },
    };
    const run = (code: string) => runInNewContext(`${renderer}\n${code}`, context);
    run('sampleServerClock("2026-10-16T12:00:00Z");');
    assert.equal(run("quotaNowPosition(window, estimatedServerNow());"), 40);
    assert.match(run("timeUntil(window.resetAt);"), /resets in 3h 0m/);
    monotonic += 60_000;
    wall += 86_400_000;
    assert.equal(run("estimatedServerNow();"), Date.parse("2026-10-16T12:01:00Z"));
    assert.match(run("timeUntil(window.resetAt);"), /resets in 2h 59m/);
    run('sampleServerClock("2026-10-16T13:00:00Z");');
    assert.equal(run("quotaNowPosition(window, estimatedServerNow());"), 60);
    for (const sample of ["undefined", '"invalid"', '"1"', '"2026-10-16"', "null"]) {
      run(`sampleServerClock(${sample});`);
      assert.equal(run("estimatedServerNow();"), wall);
    }
  }
});
