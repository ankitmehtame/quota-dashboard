import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const helpers = app.slice(app.indexOf("function calendarDate("), app.indexOf("function formatTokens("));

function evaluate(expression: string, intl: unknown = Intl): any {
  return runInNewContext(`${helpers}\n${expression}`, {
    Intl: intl,
    escapeHtml: (value: string) => value,
    shiftDate: (value: string, days: number) => {
      const date = new Date(`${value}T12:00:00Z`);
      date.setUTCDate(date.getUTCDate() + days);
      return date.toISOString().slice(0, 10);
    },
  });
}

const unavailableIntl = { DateTimeFormat: function () { throw new Error("Unavailable"); } };

test("missing calendar dates group across leap days and year boundaries", () => {
  const result = evaluate('missingUsageDateRanges(["2026-01-01", "2025-12-31", "2024-03-01", "2024-02-29", "2024-02-28", "2026-01-04", "2026-01-04"])', unavailableIntl);
  assert.deepEqual(Array.from(result), ["2024-02-28 to 2024-03-01", "2025-12-31 to 2026-01-01", "2026-01-04"]);
});

test("missing dates use default locale with year and stable UTC calendar labels", () => {
  const formatter = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC" });
  assert.deepEqual(Array.from(evaluate('missingUsageDateRanges(["2026-09-18"])')), [formatter.format(new Date("2026-09-18T12:00:00Z"))]);
});

test("details appear only for the incomplete-range branch", () => {
  const host = { complete: false, missingDates: ["2026-09-18"] };
  assert.match(evaluate(`missingUsageDetails(${JSON.stringify(host)})`), /Missing usage dates:/);
  for (const override of [{ error: "Failed" }, { disabledReason: "Unavailable" }, { included: false }, { complete: true }]) {
    assert.equal(evaluate(`missingUsageDetails(${JSON.stringify({ ...host, ...override })})`), "");
  }
});

test("unknown or empty missing-date metadata does not invent gaps", () => {
  assert.equal(evaluate('missingUsageDetails({complete: false})'), "");
  assert.equal(evaluate('missingUsageDetails({complete: false, missingDates: []})'), "");
});

test("entirely missing offline warnings retain their date details despite disabled selection", () => {
  assert.match(evaluate('missingUsageDetails({severity: "warning", complete: false, disabledReason: "No usable usage data", missingDates: ["2026-09-18"]})'), /Missing usage dates:/);
});
