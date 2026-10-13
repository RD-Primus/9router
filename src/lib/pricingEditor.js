import REGISTRY from "open-sse/providers/registry/index.js";
import { PROVIDER_MODELS, getModelUpstreamId } from "open-sse/config/providerModels.js";
import { PROVIDER_PRICING, getPricingForModel as getDefaultPricingForModel } from "open-sse/providers/pricing.js";
import { getUserPricing } from "./db/repos/pricingRepo.js";
import { getImportedPricing } from "./db/repos/importedPricingRepo.js";
import { getCustomModels } from "./db/repos/aliasRepo.js";
import { getProviderNodes } from "./db/repos/nodesRepo.js";
import { getProviderConnections } from "./db/repos/connectionsRepo.js";
import { isSafePricingKey } from "./pricingValidation.js";

// Read the local routing catalog, not remote discovery endpoints (which can
// refresh credentials). Pricing is always keyed by the literal runtime pair.
export async function getPricingEditor() {
  const [manual, customModels, nodes, connections, imported] = await Promise.all([
    getUserPricing(), getCustomModels(), getProviderNodes(), getProviderConnections(), getImportedPricing(),
  ]);
  const providers = new Map();
  const register = (key, value) => { if (isSafePricingKey(key)) providers.set(key, value); };
  for (const entry of REGISTRY) {
    const info = { id: entry.id, alias: entry.alias || entry.id, name: entry.display?.name || entry.id };
    register(entry.id, info);
    if (entry.alias) register(entry.alias, info);
    for (const alias of entry.aliases || []) register(alias, info);
  }
  for (const node of nodes) {
    register(node.id, { id: node.id, alias: node.prefix || node.id, name: node.name || node.id });
  }
  // Match getModelInfo's routing order, preserving first-node order per type.
  // Register literal ids first; custom prefixes cannot shadow built-in aliases.
  for (const type of ["openai-compatible", "anthropic-compatible", "custom-embedding"]) {
    for (const node of nodes.filter((entry) => entry.type === type)) {
      if (node.prefix && !providers.has(node.prefix)) {
        register(node.prefix, { id: node.id, alias: node.prefix, name: node.name || node.id });
      }
    }
  }
  const rows = new Map();
  const add = (providerKey, model, displayName, nativeModel, literal = false) => {
    if (!isSafePricingKey(providerKey) || !isSafePricingKey(model)) return;
    const info = providers.get(providerKey) || { id: providerKey, alias: providerKey, name: providerKey };
    const provider = literal ? providerKey : info.id;
    const key = JSON.stringify([provider, model]);
    const previous = rows.get(key);
    if (previous) {
      if (displayName) previous.displayName = displayName;
      return;
    }
    const manualPricing = Object.hasOwn(manual, provider) && Object.hasOwn(manual[provider], model)
      && Object.keys(manual[provider][model]).length ? manual[provider][model] : null;
    const defaultPricing = getDefaultPricingForModel(provider, model);
    const importedPricing = imported[provider]?.[model] ?? null;
    const baseline = importedPricing ?? defaultPricing;
    rows.set(key, {
      provider, providerAlias: info.alias, providerName: info.name,
      model, nativeModel: nativeModel || model, displayName: displayName || model,
      pricing: manualPricing ? { ...baseline, ...manualPricing } : baseline,
      defaultPricing, manualPricing, importedPricing,
      source: manualPricing ? "manual" : importedPricing ? "imported" : defaultPricing ? "default" : "unknown",
    });
  };
  for (const [alias, models] of Object.entries(PROVIDER_MODELS)) {
    for (const model of models) add(alias, model.id, model.name, getModelUpstreamId(alias, model.id));
  }
  for (const model of customModels) add(model.providerAlias, model.id, model.name, model.upstreamModelId);
  for (const connection of connections) {
    const data = connection.providerSpecificData || {};
    for (const model of [...(Array.isArray(data.enabledModels) ? data.enabledModels : []), ...(Array.isArray(data.customModels) ? data.customModels : [])]) {
      if (typeof model === "string") add(connection.provider, model);
      else if (model && typeof model === "object") add(connection.provider, model.id, model.name, model.upstreamModelId);
    }
  }
  // Include saved overrides even after a model is removed from the catalog so
  // stale overrides can still be inspected/reset without a second data store.
  for (const [provider, models] of Object.entries(PROVIDER_PRICING)) {
    for (const model of Object.keys(models)) add(provider, model);
  }
  for (const [provider, models] of Object.entries(manual)) {
    for (const model of Object.keys(models)) add(provider, model, null, null, true);
  }
  for (const [provider, models] of Object.entries(imported)) {
    for (const model of Object.keys(models)) add(provider, model, null, null, true);
  }
  return {
    currency: "USD", unit: "per_million_tokens",
    rows: [...rows.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)),
  };
}
