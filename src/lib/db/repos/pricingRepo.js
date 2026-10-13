import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";
import { validatePricingData } from "../../pricingValidation.js";
import { getImportedPricing, importedPricingRevision } from "./importedPricingRepo.js";

const pricingKv = makeKv("pricing");
const CACHE_TTL_MS = 5000;

let cache = { value: null, expiresAt: 0 };

function invalidate() {
  cache = { value: null, expiresAt: 0 };
}

export async function getUserPricing() {
  return await pricingKv.getAll();
}

export async function getPricing() {
  const now = Date.now();
  if (cache.value && cache.expiresAt > now && cache.importedRevision === importedPricingRevision) return cache.value;

  const [userPricing, imported] = await Promise.all([getUserPricing(), getImportedPricing()]);
  const { PROVIDER_PRICING, getPricingForModel: resolveConst } = await import("open-sse/providers/pricing.js");
  const merged = {};

  for (const [provider, models] of Object.entries(PROVIDER_PRICING)) {
    merged[provider] = { ...models };
  }

  for (const [provider, models] of Object.entries(imported)) {
    merged[provider] ||= {};
    for (const [model, pricing] of Object.entries(models)) merged[provider][model] = pricing;
  }

  for (const [provider, models] of Object.entries(userPricing)) {
    merged[provider] ||= {};
    for (const [model, pricing] of Object.entries(models)) {
      merged[provider][model] = { ...(imported[provider]?.[model] ?? resolveConst(provider, model)), ...pricing };
    }
  }

  cache = { value: merged, expiresAt: now + CACHE_TTL_MS, importedRevision: importedPricingRevision };
  return merged;
}

export async function getPricingForModel(provider, model) {
  if (!model) return null;
  const [userPricing, imported] = await Promise.all([getUserPricing(), getImportedPricing()]);
  const { getPricingForModel: resolveConst } = await import("open-sse/providers/pricing.js");
  const fallback = imported[provider]?.[model] ?? resolveConst(provider, model);
  const manual = provider && userPricing[provider]?.[model];
  return manual && Object.keys(manual).length ? { ...fallback, ...manual } : fallback;
}

// Atomic merge inside transaction (per-provider read-modify-write)
export async function updatePricing(pricingData) {
  validatePricingData(pricingData);
  const db = await getAdapter();
  db.transaction(() => {
    for (const [provider, models] of Object.entries(pricingData)) {
      const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      const current = row ? (parseJson(row.value, {}) || {}) : {};
      const merged = { ...current };
      for (const [model, pricing] of Object.entries(models)) {
        merged[model] = { ...current[model], ...pricing };
      }
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(merged)]
      );
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetPricing(provider, model) {
  if (!provider) return await getUserPricing();
  const db = await getAdapter();
  db.transaction(() => {
    if (!model) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      return;
    }
    const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    const current = row ? (parseJson(row.value, {}) || {}) : {};
    delete current[model];
    if (Object.keys(current).length === 0) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    } else {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(current)]
      );
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetAllPricing() {
  await pricingKv.clear();
  invalidate();
  return {};
}
