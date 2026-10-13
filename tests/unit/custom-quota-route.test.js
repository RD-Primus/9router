import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({ getProviderConnectionById: vi.fn(), getProviderNodeById: vi.fn(), updateProviderConnection: vi.fn() }));
vi.mock("open-sse/services/tokenRefresh.js", () => ({ isUnrecoverableRefreshError: vi.fn() }));
vi.mock("open-sse/executors/index.js", () => ({ getExecutor: vi.fn() }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn(async () => ({})) }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
import { getProviderConnectionById, getProviderNodeById } from "@/lib/localDb";
import { getExecutor } from "open-sse/executors/index.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { GET } from "@/app/api/usage/[connectionId]/route.js";

const provider = "openai-compatible-chat-custom";
const read = async () => (await GET(new Request("http://localhost/api/usage/test"), { params: Promise.resolve({ connectionId: "test" }) })).json();
describe("custom quota HTTP route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProviderConnectionById.mockResolvedValue({ id: "test", provider, authType: "apikey", apiKey: "test-only", providerSpecificData: { baseUrl: "https://openrouter.ai/api/v1" } });
    getProviderNodeById.mockResolvedValue({ id: provider, type: "openai-compatible", baseUrl: "https://api.meta.ai/v1" });
  });
  it("uses the current node identity, not stale connection metadata; unsupported skips proxy and refresh", async () => {
    const data = await read();
    expect(data).toMatchObject({ supported: false, quotas: {} });
    expect(data.message).toContain("N/A");
    expect(resolveConnectionProxyConfig).not.toHaveBeenCalled();
    expect(getExecutor).not.toHaveBeenCalled();
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });
  it("does not refresh custom credentials even if an imported connection is marked OAuth", async () => {
    getProviderConnectionById.mockResolvedValue({ id: "test", provider, authType: "oauth", apiKey: "test-only" });
    getProviderNodeById.mockResolvedValue({ id: provider, type: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1" });
    proxyAwareFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { limit: 10, limit_remaining: 2 } }) });
    const data = await read();
    expect(data.supported).toBe(true);
    expect(getExecutor).not.toHaveBeenCalled();
  });

  it("allows official custom OpenRouter API-key connections through usage dispatch", async () => {
    getProviderNodeById.mockResolvedValue({ id: provider, type: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1" });
    proxyAwareFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { limit: 10, limit_remaining: 2 } }) });
    const data = await read();
    expect(data.quotas["Key credit limit (USD)"].remainingPercentage).toBe(20);
    expect(getExecutor).not.toHaveBeenCalled();
  });
});
