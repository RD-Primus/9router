import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPricingForModel as defaultPricing } from "../../open-sse/providers/pricing.js";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let pricing;
let adapter;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-pricing-editor-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  pricing = await import("@/lib/db/repos/pricingRepo.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
});

beforeEach(async () => {
  await pricing.resetAllPricing();
});

afterAll(() => {
  adapter?.close?.();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("pricing editor catalog", () => {
  it("lists literal runtime ids from registry, custom nodes and configured models with effective provenance", async () => {
    const { createProviderNode } = await import("@/lib/db/repos/nodesRepo.js");
    const { addCustomModel } = await import("@/lib/db/repos/aliasRepo.js");
    const { createProviderConnection } = await import("@/lib/db/repos/connectionsRepo.js");
    await createProviderNode({ id: "openai-compatible-scratch", prefix: "scratch", name: "Scratch Node", type: "openai-compatible" });
    await addCustomModel({ providerAlias: "scratch", id: "vendor/Unknown-V1", name: "Literal Display" });
    await createProviderConnection({ provider: "openai-compatible-scratch", authType: "apikey", providerSpecificData: { enabledModels: ["gpt-4o", "New Model"] } });
    await pricing.updatePricing({ "openai-compatible-scratch": { "gpt-4o": { input: 0 } } });
    const editor = await import("@/lib/pricingEditor.js");
    const result = await editor.getPricingEditor();
    expect(result).toMatchObject({ currency: "USD", unit: "per_million_tokens" });
    expect(result.rows).toContainEqual(expect.objectContaining({
      provider: "openai-compatible-scratch", providerName: "Scratch Node", providerAlias: "scratch",
      model: "vendor/Unknown-V1", nativeModel: "vendor/Unknown-V1", displayName: "Literal Display",
      pricing: null, manualPricing: null, source: "unknown",
    }));
    expect(result.rows).toContainEqual(expect.objectContaining({
      provider: "openai-compatible-scratch", model: "gpt-4o", source: "manual", manualPricing: { input: 0 },
      pricing: { ...defaultPricing("openai-compatible-scratch", "gpt-4o"), input: 0 },
    }));
    expect(result.rows).toContainEqual(expect.objectContaining({ provider: "openai-compatible-scratch", model: "New Model", source: "unknown" }));
    // Upstream v0.5.104 retires GPT-5.5; verify a current literal/review pair.
    expect(result.rows).toContainEqual(expect.objectContaining({ provider: "codex", model: "gpt-5.6-sol", nativeModel: "gpt-5.6-sol", source: "default" }));
    expect(result.rows).toContainEqual(expect.objectContaining({ provider: "codex", model: "gpt-5.6-sol-review", nativeModel: "gpt-5.6-sol" }));
    expect(result.rows.some((row) => row.provider === "codex" && row.model === "gpt-5.5")).toBe(false);
    expect(new Set(result.rows.map((row) => JSON.stringify([row.provider, row.model]))).size).toBe(result.rows.length);
    const writesBefore = adapter.all("SELECT * FROM kv ORDER BY scope, key");
    await editor.getPricingEditor();
    expect(adapter.all("SELECT * FROM kv ORDER BY scope, key")).toEqual(writesBefore);
    expect(JSON.stringify(result)).not.toContain("baseUrl");
    await pricing.resetPricing("openai-compatible-scratch", "gpt-4o");
    const resetRow = (await editor.getPricingEditor()).rows.find((row) => row.provider === "openai-compatible-scratch" && row.model === "gpt-4o");
    expect(resetRow).toMatchObject({ source: "default", manualPricing: null, pricing: defaultPricing("openai-compatible-scratch", "gpt-4o") });
    await pricing.updatePricing({ "literal-old-alias": { "Unknown ID / Exact": { input: 3 } } });
    expect((await editor.getPricingEditor()).rows).toContainEqual(expect.objectContaining({ provider: "literal-old-alias", model: "Unknown ID / Exact", source: "manual", pricing: { input: 3 } }));
  });
});

describe("pricing overrides", () => {
  it("does not turn an empty override into a known zero price", async () => {
    await pricing.updatePricing({ scratch: { "unknown-no-rate": {} } });
    expect(await pricing.getPricingForModel("scratch", "unknown-no-rate")).toBeNull();
  });
  it("applies saved overrides to future usage without recalculating history", async () => {
    const { saveRequestUsage, getUsageHistory } = await import("@/lib/db/repos/usageRepo.js");
    const provider = "usage-scratch";
    const model = "gpt-4o";
    const tokens = { prompt_tokens: 1000000, completion_tokens: 1000000 };
    await saveRequestUsage({ provider, model, tokens, status: "ok", timestamp: "2026-01-01T00:00:00.000Z" });
    const before = (await getUsageHistory({ provider }))[0].cost;
    await pricing.updatePricing({ [provider]: { [model]: { input: 0, output: 1 } } });
    await saveRequestUsage({ provider, model, tokens, status: "ok" });
    const history = await getUsageHistory({ provider });
    expect(history.map((entry) => entry.cost).sort((a, b) => a - b)).toEqual([1, before]);
    expect(before).toBe(defaultPricing(provider, model).input + defaultPricing(provider, model).output);
    await pricing.resetPricing(provider, model);
    expect(await pricing.getPricingForModel(provider, model)).toEqual(defaultPricing(provider, model));
    expect((await getUsageHistory({ provider })).map((entry) => entry.cost).sort((a, b) => a - b)).toEqual([1, before]);
  });
  it("resets just one model, then one provider, then all, invalidating merged pricing", async () => {
    await pricing.updatePricing({ p: { "gpt-4o": { input: 0 }, second: { input: 1 } }, q: { third: { input: 2 } } });
    expect((await pricing.getPricing()).p["gpt-4o"].input).toBe(0);
    await pricing.resetPricing("p", "gpt-4o");
    expect(await pricing.getPricingForModel("p", "gpt-4o")).toEqual(defaultPricing("p", "gpt-4o"));
    expect((await pricing.getPricing()).p).toEqual({ second: { input: 1 } });
    await pricing.resetPricing("p");
    expect((await pricing.getPricing()).p).toBeUndefined();
    expect((await pricing.getPricing()).q).toEqual({ third: { input: 2 } });
    await pricing.resetAllPricing();
    expect((await pricing.getPricing()).q).toBeUndefined();
  });
  it.each([
    [], { p: [] }, { p: { m: [] } }, null, { p: null }, { p: { m: null } },
    Object.create({ inherited: { m: { input: 1 } } }),
    { good: { valid: { input: 1 } }, bad: { invalid: { input: -1 } } },
    { p: { m: { input: Infinity } } }, { p: { m: { input: NaN } } },
    { p: { m: { input: -1 } } }, { p: { m: { input: "1" } } },
    { p: { m: { currency: 1 } } },
    JSON.parse('{"__proto__":{"m":{"input":1}}}'),
    JSON.parse('{"p":{"constructor":{"input":1}}}'),
    JSON.parse('{"p":{"m":{"prototype":1}}}'),
  ].map((payload) => [payload]))("rejects unsafe/invalid pricing without touching kv: %j", async (payload) => {
    await expect(pricing.updatePricing(payload)).rejects.toThrow();
    expect(adapter.all("SELECT * FROM kv WHERE scope = 'pricing'")).toEqual([]);
  });
  it("accepts all five finite nonnegative rates including zero", async () => {
    const rates = { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 };
    expect(await pricing.updatePricing({ p: { m: rates } })).toEqual({ p: { m: rates } });
  });
  it("preserves previously edited manual fields on sparse PATCH", async () => {
    await pricing.updatePricing({ "scratch-provider": { "gpt-4o": { input: 7, cached: 0 } } });
    const saved = await pricing.updatePricing({ "scratch-provider": { "gpt-4o": { output: 9 } } });
    expect(saved["scratch-provider"]["gpt-4o"]).toEqual({ input: 7, cached: 0, output: 9 });
  });
  it("merges sparse manual fields onto canonical/pattern fallback for runtime billing and legacy GET", async () => {
    const fallback = defaultPricing("scratch-provider", "gpt-4o");
    expect(fallback.output).toBeGreaterThan(0);
    await pricing.updatePricing({ "scratch-provider": { "gpt-4o": { input: 0 } } });
    const effective = { ...fallback, input: 0 };
    expect(await pricing.getPricingForModel("scratch-provider", "gpt-4o")).toEqual(effective);
    expect((await pricing.getPricing())["scratch-provider"]["gpt-4o"]).toEqual(effective);
  });
});
