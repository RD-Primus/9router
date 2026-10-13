import { getAdapter } from "../driver.js";
import { makeKv } from "../helpers/kvStore.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { validatePricingData } from "../../pricingValidation.js";

const importedKv = makeKv("importedPricing");
export let importedPricingRevision = 0;

export async function getImportedPricing() {
  return await importedKv.getAll();
}

// Replace each imported model's fields, not manual overrides. A newly missing
// upstream rate must remain unknown instead of retaining a stale imported rate.
export async function updateImportedPricing(pricingData) {
  validatePricingData(pricingData);
  const db = await getAdapter();
  db.transaction(() => {
    for (const [provider, models] of Object.entries(pricingData)) {
      const row = db.get("SELECT value FROM kv WHERE scope = 'importedPricing' AND key = ?", [provider]);
      const current = row ? (parseJson(row.value, {}) || {}) : {};
      db.run("INSERT INTO kv(scope, key, value) VALUES('importedPricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value",
        [provider, stringifyJson({ ...current, ...models })]);
    }
  });
  importedPricingRevision++;
  return await getImportedPricing();
}
