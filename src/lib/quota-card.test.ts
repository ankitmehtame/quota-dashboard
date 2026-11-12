import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { parseClaudeQuota, parseClaudeResetCredits, parseCodexQuota, parseCodexRenewalDate, parseOllamaBalance, parseOllamaCreditBalance } from "./providers.js";
import { parseOpenRouterUsage } from "./openrouter.js";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const icons = app.slice(app.indexOf("const usageSourceNames ="), app.indexOf("const HOT_USAGE_POLL_INTERVAL_MS"));
const renderer = app.slice(app.indexOf("function formatTokens("), app.indexOf("function renderQuotas("));

test("OpenRouter renders labeled independent cards, UTC USD usage, limits and separate BYOK with escaped labels", () => {
  const usage = parseOpenRouterUsage({ data: { usage: 100, usage_daily: 0, usage_weekly: 4, usage_monthly: 8,
    limit: 20, limit_remaining: 9, limit_reset: "monthly", include_byok_in_limit: true, byok_usage: 10 } });
  const html = runInNewContext(`${icons}\n${renderer}\nquotaCard("openrouter", provider, quota);`, {
    provider: { id: "openrouter", shortName: "OpenRouter", description: "Per-key usage", configured: true, status: "partial" },
    quota: { openrouterKeys: [
      { id: "key-1", label: "Home <Assistant>", configured: true, status: "ok", ...usage },
      { id: "key-2", label: "Automations", configured: true, status: "error", windows: [], error: "OpenRouter authentication failed (HTTP 401)" },
      { id: "key-3", label: "Key 3", configured: false, status: "error", windows: [], error: "OPENROUTER_KEY_3_LABEL is missing or empty" },
    ] },
    state: { hour12: false },
    money: (value: number) => `$${value.toFixed(2)}`,
    escapeHtml: (value: unknown) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
  });
  assert.equal([...html.matchAll(/<article/g)].length, 3);
  for (const text of ["Home &lt;Assistant&gt;", "OpenRouter · Automations", "connected", "error", "total", "daily (UTC)", "weekly (UTC)", "monthly (UTC)",
    "$100.00 spent", "$0.00 spent", "$4.00 spent", "$8.00 spent", "$20.00", "$9.00 remaining", "includes BYOK", "BYOK usage · separate from credits", "$10.00 spent", "HTTP 401", "OPENROUTER_KEY_3_LABEL is missing"]) {
    assert.ok(html.includes(text), `Missing ${text}`);
  }
  assert.doesNotMatch(html, /Home <Assistant>|500%|No balance reported|type="password"|type="text"/);
  assert.equal([...html.matchAll(/\$100\.00 spent/g)].length, 1);
});

test("OpenRouter shows unavailable periods and no reported limit without invented zeros or BYOK totals", () => {
  const html = runInNewContext(`${icons}\n${renderer}\nquotaCard("openrouter", provider, quota);`, {
    provider: { id: "openrouter", shortName: "OpenRouter", description: "Per-key usage", configured: true, status: "ok" },
    quota: parseOpenRouterUsage({ data: { usage: 1 } }), state: { hour12: false }, escapeHtml: String,
  });
  assert.equal([...html.matchAll(/Not reported/g)].length, 3);
  assert.match(html, /No key spending limit reported/);
  assert.doesNotMatch(html, /BYOK usage|\$0\.00|class="bar"/);
});

test("OpenRouter renders effective budget and sub-cent credit and BYOK usage", () => {
  const html = runInNewContext(`${icons}\n${renderer}\nquotaCard("openrouter", provider, quota);`, {
    provider: { id: "openrouter", shortName: "OpenRouter", description: "Per-key usage", configured: true, status: "ok" },
    quota: parseOpenRouterUsage({ data: { usage: 0.004, byok_usage: 0.001, limit: null,
      effective_budget: { scope: "member", limit_usd: 50, remaining_usd: 0 } } }),
    state: { hour12: false }, money: (value: number) => `$${value.toFixed(2)}`, escapeHtml: String,
  });
  assert.equal([...html.matchAll(/<\$0\.01 spent/g)].length, 2);
  assert.match(html, /Effective budget/);
  assert.match(html, /member · \$50\.00 · \$0\.00 remaining/);
  assert.match(html, /No key spending limit reported/);
});

function renderOllama(payload: unknown): string {
  return runInNewContext(`${icons}\n${renderer}\nquotaCard("ollama", provider, quota);`, {
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
  assert.ok(html.indexOf("quota-window") < html.indexOf("quota-credit-balance"));
  assert.match(html, /class="quota-reset-label" title="resets in [^"]*Oct 19[^"]*">Resets in/);
  assert.match(html, /<div class="quota-foot"><span>\$2\.07 remaining · \$0\.43 used · limit \$2\.50<\/span><\/div>/);
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

test("quota pacing labels consumption and elapsed time separately without a ratio", () => {
  const from = new Date(Date.now() - 15 * 86_400_000).toISOString();
  const until = new Date(Date.now() + 15 * 86_400_000).toISOString();
  const html = renderOllama({ included: { balance_usd: 5, allowance_usd: 10,
    period: { from, until } } });
  assert.match(html, /class="quota-pacing"><span>50% used<\/span><span>[\d.]+% of window elapsed<\/span>/);
  assert.doesNotMatch(html, /quota-expected-percent|\/ [\d.]+% elapsed/);
});

test("known window times do not turn missing utilization into zero", () => {
  const html = renderClaude({ windows: [{ name: "weekly", usedPercent: null,
    windowStart: new Date(Date.now() - 86_400_000).toISOString(), resetAt: new Date(Date.now() + 86_400_000).toISOString() }] });
  assert.match(html, /Not available/);
  assert.doesNotMatch(html, /class="bar"|quota-pacing|0% used/);
});

function renderCodex(quota: Record<string, unknown>, hour12 = false, timeZone = "America/Los_Angeles"): string {
  return runInNewContext(`${icons}\n${renderer}\nquotaCard("codex", provider, quota);`, {
    provider: { id: "codex", shortName: "Codex", description: "Subscription quota", accent: "mint", configured: true, status: "ok" },
    quota, state: { hour12 }, escapeHtml: String,
    Intl: { DateTimeFormat: class extends Intl.DateTimeFormat {
      constructor(_locales: Intl.LocalesArgument, options: Intl.DateTimeFormatOptions) {
        super("en-US", { ...options, timeZone });
      }
    } },
  });
}

test("Codex renewal shows browser-local date and time in the preferred hour format", () => {
  const renewal = "2026-08-25T01:45:22.000Z";
  for (const timeZone of ["America/Los_Angeles", "Asia/Kolkata", "UTC"]) {
    for (const hour12 of [true, false]) {
      const expected = new Intl.DateTimeFormat("en-US", {
        year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12, timeZone,
      }).format(new Date(renewal));
      const html = renderCodex({ planType: "plus", subscriptionActiveUntil: renewal }, hour12, timeZone);
      assert.ok(html.includes(`Renews ${expected}`), html);
      assert.match(html, /plus subscription/);
      assert.equal((html.match(/plus subscription/g) || []).length, 1);
      assert.doesNotMatch(html, /plus plan/);
    }
  }
});

test("Codex hides unavailable renewal data without empty plan rows", () => {
  for (const value of [undefined, null, "invalid", "2026-08-25", "2026-02-29T00:00:00Z"]) {
    const quota = { subscriptionActiveUntil: parseCodexRenewalDate(value) };
    assert.doesNotMatch(renderCodex(quota), /Renews|quota-plan|quota-renewal|Invalid Date/);
    const html = renderCodex({ ...quota, planType: "plus" });
    assert.match(html, /plus subscription/);
    assert.doesNotMatch(html, /Renews|quota-plan|quota-renewal|Invalid Date/);
  }
  assert.doesNotMatch(renderCodex({ subscriptionActiveUntil: "invalid" }), /Renews|quota-plan|Invalid Date/);
});

test("Codex renewal preserves stale data, quota resets, and credit expiration date and time", () => {
  const quota = {
    windows: parseCodexQuota({ rate_limit: {
      primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: 1787012669 },
      secondary_window: { used_percent: 34, limit_window_seconds: 604_800, reset_at: 1787617469 },
    } }),
    resetCredits: [{ title: "Full reset", expiresAt: "2026-09-21T13:34:22Z" }],
    stale: true, fetchedAt: "2026-08-15T13:04:00Z",
  };
  for (const hour12 of [true, false]) {
    const withoutRenewal = renderCodex(quota, hour12);
    const html = renderCodex({ ...quota, subscriptionActiveUntil: parseCodexRenewalDate("2024-02-29T01:45:00") }, hour12);
    assert.match(html, /Renews Feb 28, 2024/);
    assert.match(html, /Stale · last known quota measured/);
    assert.match(html, /5-hour/);
    assert.match(html, /weekly/);
    assert.match(html, /resets in/);
    const expiry = new Intl.DateTimeFormat("en-US", {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12, timeZone: "America/Los_Angeles",
    }).format(new Date("2026-09-21T13:34:22Z"));
    assert.ok(html.includes(`quota-reset-expiry">Expires ${expiry}</span>`));
    assert.equal(html.slice(html.indexOf('<div class="quota-main">')), withoutRenewal.slice(withoutRenewal.indexOf('<div class="quota-main">')));
  }
});

test("reset expiry time follows browser timezone and 12/24-hour preference", () => {
  const expiresAt = "2026-09-21T01:34:22Z";
  for (const timeZone of ["America/Los_Angeles", "Asia/Kolkata", "UTC"]) {
    for (const hour12 of [true, false]) {
      const expected = new Intl.DateTimeFormat("en-US", {
        year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12, timeZone,
      }).format(new Date(expiresAt));
      const html = renderCodex({ resetCredits: [{ title: "Full reset", expiresAt }] }, hour12, timeZone);
      assert.ok(html.includes(`Expires ${expected}`), html);
    }
  }
});

function renderClaude(quota: Record<string, unknown>, status = "ok"): string {
  return runInNewContext(`${icons}\n${renderer}\nquotaCard("claude", provider, quota);`, {
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

test("Claude cards render available reset grants in the existing usage limit resets block", () => {
  const quota = { windows: parseClaudeQuota({ five_hour: { utilization: 12.5 } }),
    resetCredits: parseClaudeResetCredits({ cedar_ember: { eligible: true, grants: [
      { id: "launch", label: "Launch <reset>", resets_left: 2, ends_at: "2026-11-17T07:59:00+00:00" },
    ] } }, Date.parse("2026-11-12T00:00:00Z")) };
  for (const stale of [false, true]) {
    const html = renderClaude({ ...quota, stale }, stale ? "error" : "ok");
    assert.match(html, /Usage limit resets/);
    assert.match(html, /Launch &lt;reset&gt; \(2 resets remaining\)/);
    assert.match(html, /quota-reset-expiry">Expires /);
    assert.match(html, /Nov 17, 2026/);
    assert.match(html, /12\.5%/);
    assert.doesNotMatch(html, /<button|redeem|quota-credit-balance/);
  }
  for (const resetCredits of [undefined, []]) assert.doesNotMatch(renderClaude({ resetCredits }), /Usage limit resets/);
});

test("quota cards use 20px decorative icons for every provider, including Go", () => {
  for (const [id, icon] of Object.entries({ claude: "claude", codex: "openai", openrouter: "openrouter", ollama: "ollama", "opencode-go": "opencode" })) {
    const html = runInNewContext(`${icons}\n${renderer}\nquotaCard(id, provider, { windows: [] });`, {
      id, provider: { shortName: id === "opencode-go" ? "Go" : id, accent: "mint", description: "", configured: false, status: "unconfigured" },
      state: { hour12: false }, escapeHtml: String,
    });
    assert.match(html, new RegExp(`data-icon="${icon}"[^>]*width="20" height="20" alt=""`));
    assert.match(html, /source-icon-large" aria-hidden="true"/);
  }
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
