import { describe, expect, it, vi } from "vitest";
const helper = vi.hoisted(() => ({ getPricingEditor: vi.fn() }));
vi.mock("@/lib/pricingEditor.js", () => helper);
describe("GET /api/pricing/editor", () => {
  it("returns the editor contract with no-store headers", async () => {
    helper.getPricingEditor.mockResolvedValue({ rows: [{ provider: "runtime-id", model: "literal/model", source: "unknown", pricing: null }], currency: "USD", unit: "per_million_tokens" });
    const { GET } = await import("@/app/api/pricing/editor/route.js");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(await helper.getPricingEditor());
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("returns a generic error if catalog storage fails", async () => {
    helper.getPricingEditor.mockRejectedValue(new Error("private database detail"));
    const { GET } = await import("@/app/api/pricing/editor/route.js");
    const response = await GET();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to fetch pricing editor" });
  });
});
