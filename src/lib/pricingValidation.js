export const PRICING_FIELDS = Object.freeze(["input", "output", "cached", "reasoning", "cache_creation"]);
const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);

export function isSafePricingKey(key) {
  return typeof key === "string" && key.length > 0 && !unsafeKeys.has(key);
}

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`Invalid pricing data: ${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!isSafePricingKey(key)) throw new TypeError(`Invalid pricing key: ${key}`);
  }
}

// Validate the complete payload before a transaction can write any override.
export function validatePricingData(data) {
  assertRecord(data, "body");
  for (const [provider, models] of Object.entries(data)) {
    assertRecord(models, `provider ${provider}`);
    for (const [model, rates] of Object.entries(models)) {
      assertRecord(rates, `model ${provider}/${model}`);
      for (const [field, value] of Object.entries(rates)) {
        if (!PRICING_FIELDS.includes(field)) throw new TypeError(`Invalid pricing field: ${field}`);
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          throw new TypeError(`Invalid pricing value for ${field} in ${provider}/${model}: must be a finite non-negative number`);
        }
      }
    }
  }
}
