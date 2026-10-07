import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { parseOllamaBalance, parseOllamaCreditBalance } from "./providers.js";

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
