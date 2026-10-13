import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ NextResponse: { json: (body, init) => Response.json(body, init) } }));
vi.mock("@/lib/localDb", () => ({ getProviderConnections: vi.fn(), getProviderNodes: vi.fn() }));
vi.mock("@/lib/oauth/providers", () => ({ backfillCodexEmails: vi.fn() }));

import { getProviderConnections, getProviderNodes } from "@/lib/localDb";
import { GET } from "@/app/api/providers/client/route.js";

const openai = "openai-compatible-chat-custom";
const anthropic = "anthropic-compatible-custom";
const request = (query = "") => new Request(`http://localhost/api/providers/client?${query}`);

describe("custom quota client listing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProviderNodes.mockResolvedValue([
      { id: openai, name: "OpenRouter Custom", type: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1" },
      { id: anthropic, name: "Meta Custom", type: "anthropic-compatible", baseUrl: "https://api.meta.ai/v1" },
    ]);
    getProviderConnections.mockResolvedValue([
      { id: "a", provider: openai, authType: "apikey", priority: 1, apiKey: "test-secret", providerSpecificData: { nodeName: "old name", baseUrl: "https://old.example/v1", secret: "hidden" } },
      { id: "b", provider: anthropic, authType: "apikey", priority: 2, isActive: false },
      { id: "c", provider: "codex", authType: "oauth", priority: 3 },
      { id: "d", provider: "custom-embedding-excluded", authType: "apikey" },
    ]);
  });

  it("includes custom LLM connections with safe node names but no credentials", async () => {
    const data = await (await GET(request())).json();
    expect(data.connections.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(data.connections[0].providerName).toBe("OpenRouter Custom");
    expect(data.providerNames[anthropic]).toBe("Meta Custom");
    expect(JSON.stringify(data)).not.toContain("test-secret");
    expect(JSON.stringify(data)).not.toContain("hidden");
  });

  it("preserves active/inactive filtering and pagination after adding custom nodes", async () => {
    const active = await (await GET(request("accountStatus=active&pageSize=1&page=2"))).json();
    expect(active.connections.map((c) => c.id)).toEqual(["c"]);
    expect(active.pagination).toEqual({ page: 2, pageSize: 1, total: 2, totalPages: 2 });
    const inactive = await (await GET(request(`provider=${anthropic}&accountStatus=inactive&page=99`))).json();
    expect(inactive.connections.map((c) => c.id)).toEqual(["b"]);
    expect(inactive.pagination.page).toBe(1);
    expect(inactive.totals).toEqual({ eligibleConnections: 3, providerFilteredConnections: 1 });
    expect(inactive.providerOptions).toContain(openai);
  });
});
