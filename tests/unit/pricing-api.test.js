import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({
  getPricing: vi.fn(async () => ({ p: { m: { input: 2 } } })),
  updatePricing: vi.fn(async (data) => data),
  resetPricing: vi.fn(async () => ({})), resetAllPricing: vi.fn(async () => ({})),
}));
vi.mock("@/lib/localDb.js", () => db);
import { GET, PATCH, DELETE } from "@/app/api/pricing/route.js";
beforeEach(() => vi.clearAllMocks());
describe("pricing API compatibility and validation", () => {
  it.each(['[]', '{"p":[]}', '{"p":{"m":[]}}', '{"p":{"m":{"input":1e400}}}',
    '{"__proto__":{"m":{"input":1}}}', '{"p":{"prototype":{"input":1}}}', '{bad json',
  ])("returns 400 without writes for invalid JSON pricing: %s", async (body) => {
    const response = await PATCH(new Request("http://localhost/api/pricing", { method: "PATCH", body }));
    expect(response.status).toBe(400);
    expect(db.updatePricing).not.toHaveBeenCalled();
  });
  it("keeps the provider-keyed legacy GET and PATCH response", async () => {
    expect(await (await GET()).json()).toEqual({ p: { m: { input: 2 } } });
    const payload = { p: { m: { input: 0 } } };
    const response = await PATCH(new Request("http://localhost/api/pricing", { method: "PATCH", body: JSON.stringify(payload) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);
  });
  it("keeps model/provider/all reset scopes", async () => {
    await DELETE(new Request("http://localhost/api/pricing?provider=p&model=m"));
    expect(db.resetPricing).toHaveBeenCalledWith("p", "m");
    await DELETE(new Request("http://localhost/api/pricing?provider=p"));
    expect(db.resetPricing).toHaveBeenCalledWith("p");
    await DELETE(new Request("http://localhost/api/pricing"));
    expect(db.resetAllPricing).toHaveBeenCalledOnce();
  });
});
