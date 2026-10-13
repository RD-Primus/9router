import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getCustomUsage } from "../../open-sse/services/usage/custom.js";

const connection = (baseUrl) => ({ provider: "openai-compatible-chat-test", apiKey: "test-key-only", providerSpecificData: { baseUrl, nodeName: "OpenRouter" } });
const success = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });

describe("custom OpenRouter key quota", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    "https://unrelated.example/api/v1", "https://openrouter.ai.evil.example/api/v1",
    "http://openrouter.ai/api/v1", "https://openrouter.ai:444/api/v1",
    "https://openrouter.ai/other/v1", "https://user:pass@openrouter.ai/api/v1",
    "https://openrouter.ai/api/v1?key=hidden", "https://api.meta.ai/v1",
    "https://api.tokenme.limited/v1", "not-a-url",
  ])("never sends a key for an unverified identity: %s", async (url) => {
    const result = await getCustomUsage(connection(url));
    expect(result).toMatchObject({ supported: false, quotas: {} });
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("does not forward an OpenRouter key to a separately configured HTTP relay", async () => {
    const result = await getCustomUsage(connection("https://openrouter.ai/api/v1"), { vercelRelayUrl: "https://unrelated.example/relay" });
    expect(result.message).toContain("N/A");
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it.each([null, undefined, Infinity, "20"])("does not manufacture percentages for a nonfinite/unlimited cap: %s", async (limit) => {
    proxyAwareFetch.mockResolvedValue(success({ limit, limit_remaining: null, usage: 2 }));
    const result = await getCustomUsage(connection("https://openrouter.ai/api/v1"));
    expect(result.quotas).toEqual({});
    expect(result.message).toContain("N/A");
    expect(JSON.stringify(result)).not.toContain("100");
  });

  it("preserves a zero-credit cap as zero, not unlimited", async () => {
    proxyAwareFetch.mockResolvedValue(success({ limit: 0, limit_remaining: 0, usage: 10 }));
    const result = await getCustomUsage(connection("https://openrouter.ai/api/v1"));
    expect(result.quotas["Key credit limit (USD)"]).toMatchObject({ total: 0, used: 0, remainingPercentage: 0 });
  });

  it("never exposes upstream errors or key material", async () => {
    proxyAwareFetch.mockRejectedValue(new Error("test-key-only secret upstream body"));
    const result = await getCustomUsage(connection("https://openrouter.ai/api/v1"));
    expect(result.message).toContain("N/A");
    expect(JSON.stringify(result)).not.toContain("test-key-only");
  });

  it.each([401, 403, 429, 500])("reports HTTP %s as unavailable without reading upstream error bodies", async (status) => {
    const text = vi.fn();
    proxyAwareFetch.mockResolvedValue({ ok: false, status, text });
    const result = await getCustomUsage(connection("https://openrouter.ai/api/v1"));
    expect(result.quotas).toEqual({});
    expect(result.message).toContain(`HTTP ${status}`);
    expect(text).not.toHaveBeenCalled();
  });
  it("uses only documented current-key endpoint for the configured official identity", async () => {
    proxyAwareFetch.mockResolvedValue(success({ limit: 20, limit_remaining: 15, usage: 200, limit_reset: "daily", label: "do-not-return-key-label" }));
    const result = await getCustomUsage(connection("https://openrouter.ai/api/v1/"), { strictProxy: false });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(proxyAwareFetch).toHaveBeenCalledWith("https://openrouter.ai/api/v1/key", expect.objectContaining({
      method: "GET", redirect: "error", headers: expect.objectContaining({ Authorization: "Bearer test-key-only" }),
    }), { strictProxy: false });
    expect(result).toMatchObject({ supported: true, quotas: { "Key credit limit (USD)": {
      used: 5, total: 20, remainingPercentage: 75, currency: "USD", resetAt: null,
    } } });
    expect(JSON.stringify(result)).not.toContain("do-not-return-key-label");
  });
});
