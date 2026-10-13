import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";

it("exposes a dedicated Pricing route inside the dashboard layout and navigation", () => {
  const page = new URL("../../src/app/(dashboard)/dashboard/pricing/page.js", import.meta.url);
  expect(existsSync(page)).toBe(true);
  const legacy = readFileSync(new URL("../../src/app/dashboard/settings/pricing/page.js", import.meta.url), "utf8");
  expect(legacy).toContain('redirect("/dashboard/pricing")');
  expect(readFileSync(new URL("../../src/shared/components/Sidebar.js", import.meta.url), "utf8")).toContain('href: "/dashboard/pricing"');
});
import * as pricing from "@/shared/utils/pricingEditor.js";

it("builds sparse legacy writes preserving zero and preventing accidental blank erasure", () => {
  expect(pricing.preparePricingSave("p", "m", { input: "0", output: "2" }, {})).toEqual({ payload: { p: { m: { input: 0, output: 2 } } }, rates: { input: 0, output: 2 }, errors: {} });
  expect(pricing.preparePricingSave("p", "m", { input: "" }, { input: 7 }).errors.input).toContain("Reset this model");
  expect(pricing.preparePricingSave("p", "m", { input: "1" }, { output: 2 }).errors.output).toContain("Reset this model");
});

it("verifies exact model writes including zero and reset removal of orphaned rows", () => {
  const rows = [{ provider: "p", model: "m", manual: { input: 0, output: 2 } }];
  expect(pricing.isPricingWriteVerified(rows, "p", "m", { input: 0, output: 2 }, false)).toBe(true);
  expect(pricing.isPricingWriteVerified(rows, "p", "m", { output: 2 }, false)).toBe(false);
  expect(pricing.isPricingWriteVerified(rows, "p", "other", { input: 0 }, false)).toBe(false);
  expect(pricing.isPricingWriteVerified(rows, "p", "m", {}, true)).toBe(false);
  expect(pricing.isPricingWriteVerified([], "p", "m", {}, true)).toBe(true);
  expect(pricing.isPricingWriteVerified([{ provider: "p", model: "m", manual: {} }], "p", "m", {}, true)).toBe(true);
});

it("normalizes the local editor API without inventing prices or losing literal IDs", () => {
  const row = { provider: "custom-provider", model: "custom/id", displayName: "Custom display", defaultPricing: null, manualPricing: { input: 0 }, pricing: { input: 0 }, source: "manual" };
  expect(pricing.normalizePricingCatalog({ rows: [row] })).toEqual([{ ...row, modelName: "Custom display", defaults: {}, manual: { input: 0 }, custom: false }]);
  expect(() => pricing.normalizePricingCatalog({ error: "Unavailable" })).toThrow();
});

it("searches custom model IDs and provider display names without dropping unknown rates", () => {
  const rows = [
    { provider: "openai-compatible-private", providerName: "Private gateway", model: "custom/zero", modelName: "My model", custom: true, pricing: {} },
    { provider: "openai", providerName: "OpenAI", model: "gpt", pricing: { input: 1 } },
  ];
  expect(pricing.filterPricingModels(rows, "PRIVATE", "all")).toEqual([rows[0]]);
  expect(pricing.filterPricingModels(rows, "custom/zero", "openai-compatible-private")).toEqual([rows[0]]);
  expect(pricing.filterPricingModels(rows, "gpt", "openai-compatible-private")).toEqual([]);
});

it("creates editable strings without replacing absent rates with zero", () => {
  expect(pricing.createRateDraft({ input: 0, output: 2, cached: null })).toEqual({ input: "0", output: "2", cached: "", reasoning: "", cache_creation: "" });
  expect(pricing.formatRate(null)).toBe("Unknown");
  expect(pricing.formatRate(0)).toBe("$0");
  expect(pricing.formatRate(0.000001)).toBe("$0.000001");
});

it("derives manual/default/unknown status and never treats zero as unknown", () => {
  expect(pricing.getPricingSource({ manual: { input: 0 }, defaults: { input: 3 }, pricing: { input: 0 } })).toBe("manual");
  expect(pricing.getPricingSource({ defaults: { input: 0 }, pricing: { input: 0 } })).toBe("default");
  expect(pricing.getPricingSource({ defaults: {}, pricing: {} })).toBe("unknown");
});

it("offers imports only for an exact OpenRouter provider selection", () => {
  expect(pricing.isOpenRouterProvider({ provider: "openrouter" })).toBe(true);
  expect(pricing.isOpenRouterProvider({ provider: "openai-compatible-123", providerAlias: "openrouter" })).toBe(true);
  expect(pricing.isOpenRouterProvider({ provider: "custom-id", providerName: "OpenRouter" })).toBe(true);
  expect(pricing.isOpenRouterProvider({ provider: "openrouter", importSupported: false })).toBe(false);
  expect(pricing.isOpenRouterProvider({ provider: "huggingface", providerName: "Hugging Face" })).toBe(false);
  expect(pricing.isOpenRouterProvider({ provider: "custom-id", providerName: "Not OpenRouter" })).toBe(false);
  expect(pricing.isOpenRouterProvider({ provider: "all" })).toBe(false);
});

it("shows imported prices without hiding manual overrides or zero", () => {
  expect(pricing.getPricingSource({ source: "imported", pricing: { input: 0 } })).toBe("imported");
  expect(pricing.getPricingSource({ source: "imported", importedPricing: { input: 0 }, defaults: { input: 2 } })).toBe("imported");
  expect(pricing.getPricingSource({ source: "imported", manual: { reasoning: 0 }, pricing: { input: 2 } })).toBe("manual");
  const manual = { input: 0, output: 1, cached: 0, reasoning: 3, cache_creation: 4 };
  expect(pricing.createRateDraft(pricing.normalizePricingCatalog({ rows: [{ source: "manual", manualPricing: manual, importedPricing: { input: 5 } }] })[0].manual))
    .toEqual({ input: "0", output: "1", cached: "0", reasoning: "3", cache_creation: "4" });
});

describe("pricing editor rate drafts", () => {
  it.each(["-1", "Infinity", "NaN", "1e309", "2oops", "0x10", "0b10"])("rejects invalid decimal rate %s", (value) => {
    expect(pricing.parseRateDraft({ input: value }).errors.input).toBeTruthy();
  });
  it("keeps blank rates unknown and preserves explicit zero", () => {
    expect(pricing.parseRateDraft({ input: "", output: "0", cached: "  ", reasoning: "2.5", cache_creation: "0.125" })).toEqual({
      rates: { input: null, output: 0, cached: null, reasoning: 2.5, cache_creation: 0.125 }, errors: {},
    });
  });
});
