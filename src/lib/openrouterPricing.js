import { getProviderNodes } from "./db/repos/nodesRepo.js";
import { getProviderConnections } from "./db/repos/connectionsRepo.js";
import { updateImportedPricing } from "./db/repos/importedPricingRepo.js";
import { isSafePricingKey } from "./pricingValidation.js";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

export class PricingImportError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function isOpenRouterBaseUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === "https://openrouter.ai" && /^\/api\/v1\/?$/.test(url.pathname)
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

// Use runtime IDs only: neither model names nor a provider's display name prove
// gateway identity. Reject conflicting configured connection origins as well.
export async function getOpenRouterImportProviders() {
  const [nodes, connections] = await Promise.all([getProviderNodes(), getProviderConnections()]);
  const candidates = ["openrouter", ...nodes.filter((node) =>
    node.type === "openai-compatible" && node.id.startsWith("openai-compatible-") && isOpenRouterBaseUrl(node.baseUrl)
  ).map((node) => node.id)];
  return candidates.filter((provider) => connections.filter((entry) => entry.provider === provider)
    .every((entry) => !entry.providerSpecificData?.baseUrl || isOpenRouterBaseUrl(entry.providerSpecificData.baseUrl)));
}

// OpenRouter publishes USD per token; the pricing editor uses USD per million.
export function convertOpenRouterPricing(pricing) {
  const result = {};
  for (const [remote, local] of Object.entries({
    prompt: "input", completion: "output", input_cache_read: "cached", input_cache_write: "cache_creation",
  })) {
    const value = pricing?.[remote];
    if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) continue;
    const amount = Number(value) * 1_000_000;
    if (Number.isFinite(amount) && amount >= 0) result[local] = amount;
  }
  return Object.keys(result).length ? result : null;
}

async function fetchCatalog() {
  try {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      headers: { Accept: "application/json" }, credentials: "omit", redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("Upstream HTTP failure");
    if (Number(response.headers.get("content-length")) > MAX_CATALOG_BYTES) throw new Error("Catalog too large");
    const reader = response.body.getReader();
    let size = 0;
    const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_CATALOG_BYTES) throw new Error("Catalog too large");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const catalog = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!Array.isArray(catalog.data)) throw new Error("Invalid catalog");
    return new Map(catalog.data.filter((entry) => isSafePricingKey(entry?.id)).map((entry) => [entry.id, entry]));
  } catch {
    throw new PricingImportError("Failed to fetch OpenRouter pricing catalog", 502);
  }
}

export async function importOpenRouterPricing(provider) {
  if (!isSafePricingKey(provider) || !(await getOpenRouterImportProviders()).includes(provider)) {
    throw new PricingImportError("Provider is not configured for OpenRouter");
  }
  const { getPricingEditor } = await import("./pricingEditor.js");
  const rows = (await getPricingEditor()).rows.filter((row) => row.provider === provider);
  const catalog = await fetchCatalog();
  const models = {};
  let matched = 0, imported = 0, manualPreserved = 0;
  for (const row of rows) {
    const model = catalog.get(row.nativeModel);
    if (!model) continue;
    matched++;
    const rates = convertOpenRouterPricing(model.pricing);
    if (!rates) continue;
    models[row.model] = rates;
    imported++;
    if (row.manualPricing && Object.keys(row.manualPricing).length) manualPreserved++;
  }
  if (imported) await updateImportedPricing({ [provider]: models });
  return { provider, source: "openrouter", matched, imported, skipped: rows.length - imported, manualPreserved };
}
