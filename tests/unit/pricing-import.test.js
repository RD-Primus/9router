import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir, adapter, pricing;
beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-pricing-import-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  pricing = await import("@/lib/db/repos/pricingRepo.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
});
beforeEach(async () => {
  await pricing.resetAllPricing();
  adapter.run("DELETE FROM kv WHERE scope = 'importedPricing'");
  adapter.run("DELETE FROM providerNodes");
  adapter.run("DELETE FROM providerConnections");
});
afterAll(() => {
  vi.unstubAllGlobals();
  adapter?.close?.();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("OpenRouter price import", () => {
  it("accepts only POST provider IDs and reports upstream failures without leaking details", async () => {
    const { POST } = await import("@/app/api/pricing/import/route.js");
    const request = (body) => new Request("http://localhost/api/pricing/import", { method: "POST", body: JSON.stringify(body) });
    for (const body of [null, {}, [], { provider: "openrouter", url: "http://localhost/private" }, { provider: "__proto__" }, { provider: "huggingface" }]) {
      expect((await POST(request(body))).status).toBe(400);
    }
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("secret upstream detail"); }));
    const failure = await POST(request({ provider: "openrouter" }));
    expect(failure.status).toBe(502);
    expect(await failure.json()).toEqual({ error: "Failed to fetch OpenRouter pricing catalog" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }))));
    const success = await POST(request({ provider: "openrouter" }));
    expect(success.status).toBe(200);
    expect(await success.json()).toMatchObject({ provider: "openrouter", source: "openrouter", matched: 0, imported: 0, manualPreserved: 0 });
    expect((await POST(new Request("http://localhost/api/pricing/import", { method: "POST", body: "{" }))).status).toBe(400);
  });
  it("rejects failed, malformed, and oversized upstream catalogs before writing", async () => {
    const { importOpenRouterPricing } = await import("@/lib/openrouterPricing.js");
    for (const response of [new Response("down", { status: 503 }), new Response("{"), new Response('{}'), new Response("{}", { headers: { "content-length": "9000000" } }), new Response("x".repeat(8 * 1024 * 1024 + 1))]) {
      vi.stubGlobal("fetch", vi.fn(async () => response));
      await expect(importOpenRouterPricing("openrouter")).rejects.toMatchObject({ status: 502 });
    }
    expect(adapter.all("SELECT * FROM kv WHERE scope = 'importedPricing'")).toEqual([]);
  });
  it("imports only exact native matches for the selected OpenRouter runtime provider", async () => {
    const { createProviderNode } = await import("@/lib/db/repos/nodesRepo.js");
    const { createProviderConnection } = await import("@/lib/db/repos/connectionsRepo.js");
    await createProviderNode({ id: "openai-compatible-or", type: "openai-compatible", prefix: "or-local", baseUrl: "https://openrouter.ai/api/v1/" });
    await createProviderNode({ id: "openai-compatible-other", type: "openai-compatible", baseUrl: "https://api.nvidia.com/v1" });
    await createProviderConnection({ provider: "openai-compatible-or", authType: "apikey", providerSpecificData: { enabledModels: ["Vendor/Exact:free", "Vendor/exact:free", "not-listed", "bad-rate"] } });
    await pricing.updatePricing({ "openai-compatible-or": { "Vendor/Exact:free": { output: 7 } } });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: "Vendor/Exact:free", pricing: { prompt: "0", completion: "0.000001" } },
      { id: "bad-rate", pricing: { prompt: "-1" } },
      { id: "not-local", pricing: { prompt: "0.1" } },
    ] })));
    vi.stubGlobal("fetch", fetchMock);
    const { importOpenRouterPricing, getOpenRouterImportProviders } = await import("@/lib/openrouterPricing.js");
    expect(await getOpenRouterImportProviders()).toEqual(["openrouter", "openai-compatible-or"]);
    expect(await importOpenRouterPricing("openai-compatible-or")).toEqual({ provider: "openai-compatible-or", source: "openrouter", matched: 2, imported: 1, skipped: 3, manualPreserved: 1 });
    expect(await pricing.getPricingForModel("openai-compatible-or", "Vendor/Exact:free")).toEqual({ input: 0, output: 7 });
    expect(await (await import("@/lib/db/repos/importedPricingRepo.js")).getImportedPricing()).toEqual({ "openai-compatible-or": { "Vendor/Exact:free": { input: 0, output: 1 } } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/models");
    expect(options).toMatchObject({ redirect: "error", credentials: "omit", cache: "no-store", headers: { Accept: "application/json" } });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    await expect(importOpenRouterPricing("openai-compatible-other")).rejects.toThrow("not configured for OpenRouter");
    await expect(importOpenRouterPricing("nvidia")).rejects.toThrow("not configured for OpenRouter");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("rejects OpenRouter lookalike origins, wrong paths, credentials, and contradictory connection URLs", async () => {
    const { createProviderNode } = await import("@/lib/db/repos/nodesRepo.js");
    const { createProviderConnection } = await import("@/lib/db/repos/connectionsRepo.js");
    const urls = ["https://openrouter.ai.evil/api/v1", "http://openrouter.ai/api/v1", "https://openrouter.ai/other", "https://x@openrouter.ai/api/v1", "https://openrouter.ai/api/v1?x=1"];
    for (const [index, baseUrl] of urls.entries()) await createProviderNode({ id: `openai-compatible-bad-${index}`, type: "openai-compatible", baseUrl });
    await createProviderNode({ id: "openai-compatible-conflict", type: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1" });
    await createProviderConnection({ provider: "openai-compatible-conflict", authType: "apikey", providerSpecificData: { baseUrl: "https://elsewhere.test/v1" } });
    const { getOpenRouterImportProviders } = await import("@/lib/openrouterPricing.js");
    expect(await getOpenRouterImportProviders()).toEqual(["openrouter"]);
  });
  it("keeps imported prices below manual fields, including after reset, without filling missing prices", async () => {
    const { updateImportedPricing } = await import("@/lib/db/repos/importedPricingRepo.js");
    await pricing.updatePricing({ openrouter: { "openai/gpt-4o": { input: 0 } } });
    await pricing.getPricing(); // warm legacy cache
    await updateImportedPricing({ openrouter: { "openai/gpt-4o": { input: 2, output: 8 } } });
    expect(await pricing.getPricingForModel("openrouter", "openai/gpt-4o")).toEqual({ input: 0, output: 8 });
    expect((await pricing.getPricing()).openrouter["openai/gpt-4o"]).toEqual({ input: 0, output: 8 });
    await pricing.resetPricing("openrouter", "openai/gpt-4o");
    expect(await pricing.getPricingForModel("openrouter", "openai/gpt-4o")).toEqual({ input: 2, output: 8 });
    await updateImportedPricing({ openrouter: { "openai/gpt-4o": { output: 0 } } });
    expect(await pricing.getPricingForModel("openrouter", "openai/gpt-4o")).toEqual({ output: 0 });
    await pricing.resetAllPricing();
    const editor = await (await import("@/lib/pricingEditor.js")).getPricingEditor();
    expect(editor.rows).toContainEqual(expect.objectContaining({ provider: "openrouter", model: "openai/gpt-4o", importedPricing: { output: 0 }, pricing: { output: 0 }, source: "imported" }));
    await expect(updateImportedPricing({ openrouter: { bad: { input: -1 } } })).rejects.toThrow();
  });
  
  it("converts only finite nonnegative token prices and preserves explicit zero", async () => {
    const { convertOpenRouterPricing } = await import("@/lib/openrouterPricing.js");
    expect(convertOpenRouterPricing({ prompt: "0", completion: "0.000002", input_cache_read: "0.0000005", input_cache_write: "0.000001" }))
      .toEqual({ input: 0, output: 2, cached: 0.5, cache_creation: 1 });
    expect(convertOpenRouterPricing({ prompt: null, completion: "", input_cache_read: "-1", input_cache_write: "Infinity" })).toBeNull();
    expect(convertOpenRouterPricing({ prompt: true, completion: "garbage", input_cache_read: "1e309", input_cache_write: -1 })).toBeNull();
    expect(convertOpenRouterPricing({ prompt: "1e303" })).toBeNull();
    expect(convertOpenRouterPricing({ completion: "0" })).toEqual({ output: 0 });
  });
});
