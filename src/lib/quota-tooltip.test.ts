import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

test("quota tooltips are portaled above the sticky header and restored on close", () => {
  const close = app.slice(app.indexOf("function closeActiveQuotaTooltip()"), app.indexOf("function bindQuotaTooltipTrigger("));
  const bind = app.slice(app.indexOf("function bindQuotaTooltipTrigger("), app.indexOf("function bindQuotaTooltipDismissal("));

  assert.match(bind, /document\.body\.appendChild\(tooltip\)/);
  assert.match(close, /tooltip\.parentElement === document\.body\)[\s\S]*anchor\.appendChild\(tooltip\)/);
  assert.match(styles, /\.quota-now-tooltip\.is-positioned\s*\{[^}]*z-index:\s*40/s);
  assert.match(styles, /\.quota-now-tooltip\.is-positioned\s*\{[^}]*font-family:\s*var\(--mono\)/s);
});

test("quota rerenders close active card tooltips without closing the header tooltip", () => {
  const render = app.slice(app.indexOf("function renderQuotas("), app.indexOf("function recordTokens("));

  assert.match(render, /activeQuotaTooltip\?\.anchor\.closest\("#quota-grid"\)/);
  assert.match(render, /closeActiveQuotaTooltip\(\)/);
  assert.match(render, /\.innerHTML\s*=/);
  assert.match(render, /bindQuotaTooltips\(\)/);
});
