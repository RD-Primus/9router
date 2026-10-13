import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let adapter;
let createProviderNode;
let addCustomModel;
let getPricingEditor;
let getModelInfo;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-prefix-priority-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  ({ createProviderNode } = await import("@/lib/db/repos/nodesRepo.js"));
  ({ addCustomModel } = await import("@/lib/db/repos/aliasRepo.js"));
  ({ getPricingEditor } = await import("@/lib/pricingEditor.js"));
  ({ getModelInfo } = await import("@/sse/services/model.js"));
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
});

afterAll(() => {
  adapter?.close?.();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("pricing catalog uses runtime custom-prefix precedence", () => {
  it.each([
    ["openai-wins", ["custom-embedding", "anthropic-compatible", "openai-compatible", "openai-compatible"], 2],
    ["anthropic-wins", ["custom-embedding", "anthropic-compatible", "anthropic-compatible"], 1],
    ["first-openai", ["openai-compatible", "openai-compatible"], 0],
    ["first-embedding", ["custom-embedding", "custom-embedding"], 0],
  ])("maps duplicate prefix %s to the same literal provider as routing", async (suffix, types, winner) => {
    const prefix = `audit-${suffix}`;
    const model = `unlisted-${suffix}`;
    const ids = [];
    for (const [index, type] of types.entries()) {
      const id = `${type}-${suffix}-${index}`;
      ids.push(id);
      await createProviderNode({ id, prefix, name: `Audit ${index}`, type });
    }
    await addCustomModel({ providerAlias: prefix, id: model, name: model });
    const routed = await getModelInfo(`${prefix}/${model}`);
    expect(routed).toEqual({ provider: ids[winner], model });
    const rows = (await getPricingEditor()).rows.filter((row) => row.model === model);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: routed.provider, providerAlias: prefix, providerName: `Audit ${winner}`,
      pricing: null, source: "unknown",
    });
  });
});
