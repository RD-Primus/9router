// Pure editor behavior; blank inputs are not free token rates.
export function preparePricingSave(provider, model, draft, manual = {}) {
  const parsed = parseRateDraft(draft);
  const rates = Object.fromEntries(Object.entries(parsed.rates).filter(([, value]) => value !== null));
  for (const field of PRICING_FIELDS) {
    if (parsed.rates[field] === null && manual[field] != null) {
      parsed.errors[field] = "Use Reset this model to remove saved manual rates, then enter new overrides.";
    }
  }
  return { payload: { [provider]: { [model]: rates } }, rates, errors: parsed.errors };
}

export function isPricingWriteVerified(rows, provider, model, rates, reset) {
  const updated = rows.find((row) => row.provider === provider && row.model === model);
  if (!updated) return reset;
  const expected = reset ? {} : rates;
  return PRICING_FIELDS.every((field) => (updated.manual?.[field] ?? null) === (expected[field] ?? null));
}

export function normalizePricingCatalog(data) {
  if (!Array.isArray(data.rows)) throw new Error("The pricing catalog is unavailable. Please retry.");
  return data.rows.map((row) => ({ ...row, modelName: row.displayName || row.model, defaults: row.defaultPricing || {}, manual: row.manualPricing || {}, custom: row.custom === true }));
}
// This is only a UI affordance; the import endpoint validates the real origin.
export function isOpenRouterProvider(row) {
  if (!row || row.importSupported === false) return false;
  return [row.provider, row.providerAlias, row.providerName].some((value) => typeof value === "string" && value.trim().toLowerCase() === "openrouter");
}

export function filterPricingModels(models, query = "", provider = "all") {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return models.filter((row) => (provider === "all" || row.provider === provider)
    && terms.every((term) => [row.provider, row.providerName, row.model, row.modelName].join(" ").toLowerCase().includes(term)));
}

export function createRateDraft(rates = {}) {
  return Object.fromEntries(PRICING_FIELDS.map((field) => [field, rates[field] == null ? "" : String(rates[field])]));
}

export function formatRate(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? `$${value.toLocaleString("en-US", { maximumSignificantDigits: 12 })}` : "Unknown";
}

export function getPricingSource(row) {
  const hasRate = (rates) => PRICING_FIELDS.some((field) => typeof rates?.[field] === "number" && Number.isFinite(rates[field]) && rates[field] >= 0);
  if (hasRate(row.manual)) return "manual";
  if (row.source === "imported" || hasRate(row.importedPricing)) return "imported";
  if (hasRate(row.defaults)) return "default";
  return "unknown";
}
export const PRICING_FIELDS = ["input", "output", "cached", "reasoning", "cache_creation"];

export function parseRateDraft(draft) {
  const rates = {};
  const errors = {};
  for (const field of PRICING_FIELDS) {
    const raw = String(draft[field] ?? "").trim();
    if (raw === "") rates[field] = null;
    else {
      const value = Number(raw);
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) || !Number.isFinite(value) || value < 0) errors[field] = "Enter a finite, non-negative rate.";
      else rates[field] = value;
    }
  }
  return { rates, errors };
}
