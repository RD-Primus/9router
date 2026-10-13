import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js", import.meta.url), "utf8");
const table = readFileSync(new URL("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/QuotaTable.js", import.meta.url), "utf8");
import * as utils from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

describe("custom quota dashboard data", () => {
  it("does not classify unknown, unsupported or errored quota as available", () => {
    expect(utils.isQuotaAvailableForBulkEnable(undefined)).toBe(false);
    expect(utils.isQuotaAvailableForBulkEnable({ supported: false, quotas: [] })).toBe(false);
    expect(utils.isQuotaAvailableForBulkEnable({ quotas: [{ used: 1, total: 10 }] }, true)).toBe(false);
    expect(utils.isQuotaAvailableForBulkEnable({ quotas: [{ used: 1, total: 10 }] })).toBe(true);
    expect(utils.isQuotaAvailableForBulkEnable({ quotas: [{ used: 0, total: 0, remainingPercentage: 0 }] })).toBe(false);
    expect(source).toContain("isQuotaAvailableForBulkEnable(quotaData[c.id]");
  });

  it("renders custom node names, explicit N/A and zero limits without infinity", () => {
    expect(source).toContain("conn.providerName || providerLabel(conn.provider)");
    expect(source).toContain("data.providerNames");
    expect(source).toContain("supported: data.supported");
    expect(source).toContain("N/A — Quota unsupported");
    expect(table).toContain("quota.total >= 0");
    expect(source).not.toContain("Got quota for");
  });
  it("preserves genuine key USD limits and reported remaining percentage", () => {
    const rows = utils.parseQuotaData("openai-compatible-chat-router", { supported: true, quotas: {
      "Key credit limit (USD)": { used: 5, total: 20, remainingPercentage: 75, currency: "USD", resetAt: null },
    } });
    expect(rows).toEqual([{ name: "Key credit limit (USD)", used: 5, total: 20, remainingPercentage: 75, currency: "USD", resetAt: null }]);
    expect(utils.getRemainingPercentage(rows[0])).toBe(75);
  });
});
