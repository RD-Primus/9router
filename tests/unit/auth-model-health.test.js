import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the real connection repository (including activation normalization)
// without opening a user database or reading credentials.
const state = vi.hoisted(() => ({ row: null }));
vi.mock("@/lib/db/driver.js", () => ({
  getAdapter: async () => ({
    all: () => state.row ? [state.row] : [],
    get: () => state.row,
    transaction: (fn) => fn(),
    run: (_sql, values) => {
      const [id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt] = values;
      state.row = { id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt };
    },
  }),
}));
vi.mock("@/lib/localDb", async () => {
  const repo = await import("@/lib/db/repos/connectionsRepo.js");
  return { ...repo, getSettings: async () => ({}), getProxyPools: async () => [], validateApiKey: vi.fn() };
});
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: async () => ({}),
}));
vi.mock("@/sse/services/antigravityQuota.js", () => ({
  getAntigravityQuotaCache: () => new Map(),
  getAntigravityModelQuota: () => null,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { getProviderConnectionById, updateProviderConnection } = await import("@/lib/db/repos/connectionsRepo.js");
const { markAccountUnavailable, clearAccountError, getProviderCredentials } = await import("@/sse/services/auth.js");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T00:00:00.000Z"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.row = {
    id: "connection-a", provider: "nvidia", authType: "apikey", name: "test connection",
    priority: 1, isActive: 1, data: JSON.stringify({ testStatus: "active", backoffLevel: 0 }),
  };
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const read = () => getProviderConnectionById("connection-a");

describe("model routing errors versus connection health", () => {
  it.each([[401, "Invalid API key"], [403, "Access denied"], [402, "Payment required"], [429, "Insufficient balance"], [503, "Service unavailable"]])
    ("preserves connection-wide health for %s errors", async (status, message) => {
      const result = await markAccountUnavailable("connection-a", status, message, "nvidia", "text");
      expect(result.shouldFallback).toBe(true);
      const failed = await read();
      expect(failed).toMatchObject({ testStatus: "unavailable", errorCode: status, lastError: message });
      expect(failed.modelLock_text).toBeTruthy();
      await markAccountUnavailable("connection-a", 404, "Model not found", "nvidia", "audio");
      expect(await read()).toMatchObject({ testStatus: "unavailable", errorCode: status, lastError: message });
    });

  it("a successful text model cannot erase an unrelated active audio model lock", async () => {
    await markAccountUnavailable("connection-a", 404, "Audio model not found", "nvidia", "audio");
    const failed = await read();
    await clearAccountError("connection-a", failed, "text");
    const connection = await read();
    expect(connection.modelLock_audio).toBe(failed.modelLock_audio);
    expect(connection.modelError_audio).toEqual(failed.modelError_audio);
    expect(connection.testStatus).toBe("active");
  });

  it("manual validation still explicitly resets connection health and all locks", async () => {
    await markAccountUnavailable("connection-a", 404, "Model not found", "nvidia", "audio");
    await updateProviderConnection("connection-a", { testStatus: "active" }, { resetHealth: true });
    expect(await read()).toMatchObject({ testStatus: "active", modelLock_audio: null, errorCode: null });
  });

  it("success clears only that model diagnostic while unrelated diagnostics remain", async () => {
    await markAccountUnavailable("connection-a", 404, "Audio model not found", "nvidia", "audio");
    await markAccountUnavailable("connection-a", 410, "Text model retired", "nvidia", "text");
    await clearAccountError("connection-a", await read(), "text");
    const connection = await read();
    expect(connection.modelError_text).toBeNull();
    expect(connection.modelError_audio).toMatchObject({ errorCode: 404 });
    expect(connection.modelLock_audio).toBeTruthy();
  });
  it("success reads fresh health so a concurrent auth failure is not erased by a stale snapshot", async () => {
    await markAccountUnavailable("connection-a", 503, "Service unavailable", "nvidia", "text");
    const stale = await read();
    await markAccountUnavailable("connection-a", 401, "Invalid API key", "nvidia", "audio");
    const failed = await read();
    await clearAccountError("connection-a", { _connection: stale }, "text");
    const connection = await read();
    expect(connection.testStatus).toBe("unavailable");
    expect(connection.errorCode).toBe(401);
    expect(connection.modelLock_audio).toBe(failed.modelLock_audio);
  });
  it("a successful text request repairs legacy model-only health without clearing the audio lock", async () => {
    await updateProviderConnection("connection-a", {
      testStatus: "unavailable", lastError: "Audio model not found", errorCode: 404,
      modelLock_audio: "2026-10-13T00:02:00.000Z",
    });
    await clearAccountError("connection-a", await read(), "text");
    const connection = await read();
    expect(["active", "success"]).toContain(connection.testStatus);
    expect(connection.lastError).toBeNull();
    expect(connection.modelLock_audio).toBe("2026-10-13T00:02:00.000Z");
  });
  it("records retired model 410 without changing its existing no-fallback behavior", async () => {
    expect(await markAccountUnavailable("connection-a", 410, "Model is EOL", "nvidia", "retired-model"))
      .toEqual({ shouldFallback: false, cooldownMs: 0 });
    const connection = await read();
    expect(connection.testStatus).toBe("active");
    expect(connection["modelError_retired-model"]).toMatchObject({ errorCode: 410, lastError: "Model is EOL" });
    expect(connection["modelLock_retired-model"]).toBeUndefined();
  });
  it("records a model 404 without invalidating a working connection or changing fallback", async () => {
    const result = await markAccountUnavailable("connection-a", 404, "Model not found", "nvidia", "missing-model");
    expect(result).toEqual({ shouldFallback: true, cooldownMs: 120000 });
    const connection = await read();
    expect(connection.testStatus).toBe("active");
    expect(connection["modelLock_missing-model"]).toBe("2026-10-13T00:02:00.000Z");
    expect(connection["modelError_missing-model"]).toEqual({
      errorCode: 404, lastError: "Model not found", lastErrorAt: "2026-10-13T00:00:00.000Z",
    });
    expect(connection.lastError).toBeUndefined();
    expect(connection.errorCode).toBeUndefined();
    expect((await getProviderCredentials("nvidia", null, "working-model")).connectionId).toBe("connection-a");
    expect(await getProviderCredentials("nvidia", null, "missing-model")).toMatchObject({
      allRateLimited: true, lastError: "Model not found", lastErrorCode: 404,
    });
  });
});
