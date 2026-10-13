import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { calculateCostFromTokens } from "../../open-sse/providers/pricing.js";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let adapter;
let pricing;
let usage;
let editor;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-sparse-usage-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  pricing = await import("@/lib/db/repos/pricingRepo.js");
  usage = await import("@/lib/db/repos/usageRepo.js");
  editor = await import("@/lib/pricingEditor.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
});

beforeEach(async () => {
  await pricing.resetAllPricing();
  adapter.run("DELETE FROM usageHistory");
});

afterAll(() => {
  adapter?.close?.();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("sparse unknown-model pricing in persisted usage", () => {
  const mixedTokens = {
    prompt_tokens: 1_000_000, cached_tokens: 200_000, cache_creation_input_tokens: 100_000,
    completion_tokens: 500_000, reasoning_tokens: 50_000,
  };

  it.each([
    ["input", { input: 2 }, 2],
    ["output", { output: 4 }, 2.2],
    ["cached", { cached: 3 }, 0.6],
    ["reasoning", { reasoning: 5 }, 0.25],
    ["cache-creation", { cache_creation: 6 }, 0.6],
    ["optional-only", { cached: 3, reasoning: 5, cache_creation: 6 }, 1.45],
    ["zero-optional", { input: 2, cached: 0, cache_creation: 0 }, 1.4],
  ])("persists only known contributions for %s rates on an unknown model", async (suffix, rates, expected) => {
    const provider = "sparse-audit";
    const model = `unlisted-audit-${suffix}`;
    await pricing.updatePricing({ [provider]: { [model]: rates } });
    const effective = await pricing.getPricingForModel(provider, model);
    // Missing rates remain unknown; a partial numeric cost is not a free price.
    expect(effective).toEqual(rates);
    expect(calculateCostFromTokens(mixedTokens, effective)).toBeCloseTo(expected, 12);
    await usage.saveRequestUsage({ provider, model, tokens: mixedTokens, status: "ok" });
    expect((await usage.getUsageHistory({ provider }))[0].cost).toBeCloseTo(expected, 12);
    const row = (await editor.getPricingEditor()).rows.find((entry) => entry.provider === provider && entry.model === model);
    expect(row.pricing).toEqual(rates);
    expect(row.defaultPricing).toBeNull();
  });

  it("keeps a wholly unknown catalog price null despite the numeric usage fallback", async () => {
    const provider = "sparse-audit";
    const model = "unlisted-audit-no-price";
    const { addCustomModel } = await import("@/lib/db/repos/aliasRepo.js");
    await addCustomModel({ providerAlias: provider, id: model, name: model });
    expect(await pricing.getPricingForModel(provider, model)).toBeNull();
    await usage.saveRequestUsage({ provider, model, tokens: mixedTokens, status: "ok" });
    expect((await usage.getUsageHistory({ provider }))[0].cost).toBe(0);
    expect((await editor.getPricingEditor()).rows.find((row) => row.provider === provider && row.model === model))
      .toMatchObject({ pricing: null, defaultPricing: null, manualPricing: null, source: "unknown" });
  });
  it("persists a known input contribution even when the output rate is unknown", async () => {
    const provider = "sparse-audit";
    const model = "unlisted-audit-input";
    const rates = { input: 2 };
    const tokens = { prompt_tokens: 1_000_000, completion_tokens: 0 };
    await pricing.updatePricing({ [provider]: { [model]: rates } });
    const effective = await pricing.getPricingForModel(provider, model);
    expect(effective).toEqual(rates);
    await usage.saveRequestUsage({ provider, model, tokens, status: "ok" });
    expect((await usage.getUsageHistory({ provider }))[0].cost).toBe(2);
    expect(calculateCostFromTokens(tokens, effective)).toBe(2);
    expect((await editor.getPricingEditor()).rows.find((row) => row.provider === provider && row.model === model))
      .toMatchObject({ pricing: rates, defaultPricing: null, manualPricing: rates, source: "manual" });
  });
});
