import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));

import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { POST } from "../../src/app/api/providers/[id]/test/route.js";
import { classifyCustomProbeResult } from "../../src/app/api/providers/[id]/test/customProbeResult.js";

const connection = (provider = "openai-compatible-test") => ({
  id: "custom-probe-test",
  provider,
  authType: "apikey",
  apiKey: "test-key-not-a-secret",
  providerSpecificData: { baseUrl: "https://provider.invalid/v1" },
});

async function probe() {
  return POST(new Request("https://router.invalid/api/providers/custom-probe-test/test", { method: "POST" }), {
    params: Promise.resolve({ id: "custom-probe-test" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getProviderConnectionById.mockResolvedValue(connection());
  updateProviderConnection.mockResolvedValue({});
});
afterEach(() => vi.unstubAllGlobals());

describe("custom probe status classifier", () => {
  it("recognizes a fetch timeout wrapped as an Undici cause without exposing details", () => {
    const result = classifyCustomProbeResult({ error: Object.assign(new TypeError("private"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }) });
    expect(result).toMatchObject({ valid: false, status: null, category: "timeout" });
    expect(result.error).not.toContain("private");
  });

  it.each([
    [404, "endpoint", /endpoint.*not found/i],
    [400, "http", /HTTP 400/],
    [429, "http", /HTTP 429/],
    [500, "gateway", /upstream|gateway/i],
    [503, "gateway", /upstream|gateway/i],
    [529, "gateway", /upstream|gateway/i],
  ])("preserves HTTP %s without guessing invalid credentials", (status, category, message) => {
    const result = classifyCustomProbeResult({ status });
    expect(result).toMatchObject({ valid: false, status, category });
    expect(result.error).toMatch(message);
    expect(result.error).not.toMatch(/invalid API key/i);
  });

  it.each([401, 403])("classifies HTTP %s as authentication/access rejection", (status) => {
    expect(classifyCustomProbeResult({ status })).toMatchObject({
      valid: false, status, category: "auth", inferenceVerified: false,
    });
    expect(classifyCustomProbeResult({ status }).error).toMatch(/authentication|access/i);
  });
});

describe("custom provider connection-test API", () => {
  it.each(["openai-compatible-test", "anthropic-compatible-test"])("preserves auth and endpoint statuses through the %s API", async (provider) => {
    getProviderConnectionById.mockResolvedValue(connection(provider));
    for (const [status, category] of [[401, "auth"], [403, "auth"], [404, "endpoint"]]) {
      const fetch = vi.fn().mockResolvedValue(new Response("private body", { status }));
      vi.stubGlobal("fetch", fetch);
      const response = await probe();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ valid: false, refreshed: false, status, category });
      expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("preserves the native-provider response shape", async () => {
    getProviderConnectionById.mockResolvedValue(connection("openai"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    expect(await (await probe()).json()).toEqual({ valid: true, error: null, refreshed: false });
  });

  it("preserves the missing-connection 404 response", async () => {
    getProviderConnectionById.mockResolvedValue(null);
    const response = await probe();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Connection not found" });
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not log raw unexpected failures at the API boundary", async () => {
    getProviderConnectionById.mockRejectedValue(new Error("secret-token <html>private diagnostic</html>"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const response = await probe();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Test failed" });
      expect(log).toHaveBeenCalledWith("Error testing connection: unexpected internal failure");
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    ["openai-compatible-test", "TimeoutError", "timeout"],
    ["anthropic-compatible-test", "TimeoutError", "timeout"],
    ["openai-compatible-test", "AbortError", "timeout"],
    ["anthropic-compatible-test", "TypeError", "transport"],
  ])("safely classifies %s %s without leaking transport details", async (provider, name, category) => {
    getProviderConnectionById.mockResolvedValue(connection(provider));
    const error = Object.assign(new Error("secret-token https://user:password@private.invalid <html>"), { name });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
      const response = await probe();
      const result = await response.json();
      expect(response.status).toBe(200);
      expect(result).toMatchObject({ valid: false, status: null, category, inferenceVerified: false });
      expect(result.error).toMatch(category === "timeout" ? /timed out/i : /network|transport/i);
      expect(JSON.stringify(result)).not.toMatch(/secret-token|password|private.invalid|<html>/);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    ["openai-compatible-test", "models"],
    ["anthropic-compatible-test", "messages"],
  ])("keeps successful %s probes valid without overstating inference verification", async (provider, endpoint) => {
    getProviderConnectionById.mockResolvedValue(connection(provider));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    const result = await (await probe()).json();
    expect(result).toMatchObject({ valid: true, error: null, refreshed: false, status: 200, category: "success", probe: endpoint, inferenceVerified: false });
    if (endpoint === "models") expect(result.message).toMatch(/inference.*not.*verified/i);
    expect(updateProviderConnection).toHaveBeenCalledWith("custom-probe-test", expect.objectContaining({ testStatus: "active", lastError: null }));
  });
  it.each([400, 404, 500, 529])("does not treat Anthropic-compatible HTTP %s as valid", async (status) => {
    getProviderConnectionById.mockResolvedValue(connection("anthropic-compatible-test"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private upstream body", { status })));
    const result = await (await probe()).json();
    expect(result).toMatchObject({ valid: false, status, probe: "messages", inferenceVerified: false });
    expect(updateProviderConnection).toHaveBeenCalledWith("custom-probe-test", expect.objectContaining({ testStatus: "error" }));
  });
  it("preserves a Cloudflare 502 as a safe gateway failure, not an invalid-key diagnosis", async () => {
    const upstream = new Response("<html>Cloudflare private upstream diagnostic test-key-not-a-secret</html>", { status: 502 });
    const readBody = vi.spyOn(upstream, "text");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(upstream));
    const response = await probe();
    const result = await response.json();
    expect(response.status).toBe(200); // Existing API envelope is unchanged.
    expect(result).toMatchObject({ valid: false, refreshed: false, status: 502, category: "gateway", probe: "models", inferenceVerified: false });
    expect(result.error).toMatch(/upstream|gateway/i);
    expect(result.error).not.toMatch(/invalid API key/i);
    expect(JSON.stringify(result)).not.toMatch(/<html>|private upstream|test-key-not-a-secret/);
    expect(readBody).not.toHaveBeenCalled();
    expect(updateProviderConnection).toHaveBeenCalledWith("custom-probe-test", expect.objectContaining({ testStatus: "error", lastError: result.error }));
  });
});
