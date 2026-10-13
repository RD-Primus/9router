import { proxyAwareFetch } from "../../utils/proxyFetch.js";

const OPENROUTER_ORIGIN = "https://openrouter.ai";
const OPENROUTER_BASE_PATH = "/api/v1";

/** Custom LLM nodes have no common quota protocol. Never probe guessed URLs. */
export function isCustomQuotaProvider(provider) {
  return typeof provider === "string" && (
    provider.startsWith("openai-compatible-") || provider.startsWith("anthropic-compatible-")
  );
}

export function unsupportedCustomQuota() {
  return {
    supported: false,
    quotas: {},
    message: "Quota tracking unsupported (N/A): no documented quota API for this custom provider.",
  };
}

export function hasCustomQuotaAdapter(connection) {
  try {
    const url = new URL(connection.providerSpecificData?.baseUrl);
    return url.origin === OPENROUTER_ORIGIN
      && url.pathname.replace(/\/$/, "") === OPENROUTER_BASE_PATH
      && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export async function getCustomUsage(connection, proxyOptions = null) {
  if (!hasCustomQuotaAdapter(connection)) return unsupportedCustomQuota();
  // HTTP relays receive Authorization themselves, unlike a CONNECT proxy.
  // Do not disclose this key to any additional origin for quota tracking.
  if (proxyOptions?.vercelRelayUrl) {
    return { supported: true, quotas: {}, message: "OpenRouter quota N/A: HTTP relay forwarding is disabled for key inspection." };
  }
  if (typeof connection.apiKey !== "string" || !connection.apiKey.trim()) {
    return { supported: true, quotas: {}, message: "OpenRouter quota N/A: API key not available." };
  }
  try {
    // Inference keys can inspect themselves. /credits requires a management key;
    // never probe it or disclose key labels returned by /key.
    // Docs: https://openrouter.ai/docs/api-reference/limits
    const response = await proxyAwareFetch(`${OPENROUTER_ORIGIN}${OPENROUTER_BASE_PATH}/key`, {
      method: "GET",
      redirect: "error",
      headers: { Authorization: `Bearer ${connection.apiKey.trim()}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    }, proxyOptions);
    if (!response.ok) {
      return { supported: true, quotas: {}, message: `OpenRouter quota N/A: key API returned HTTP ${response.status}.` };
    }
    const { data } = await response.json();
    if (typeof data?.limit !== "number" || !Number.isFinite(data.limit)
      || typeof data.limit_remaining !== "number" || !Number.isFinite(data.limit_remaining)) {
      return { supported: true, quotas: {}, message: "OpenRouter key quota N/A: no finite key credit limit reported; account balance is not available with this API key." };
    }
    const total = Math.max(0, data.limit);
    const remaining = Math.max(0, Math.min(total, data.limit_remaining));
    return {
      supported: true,
      plan: "OpenRouter (key credits, not account balance)",
      quotas: {
        "Key credit limit (USD)": {
          used: total - remaining,
          total,
          remainingPercentage: total > 0 ? Math.round(remaining / total * 100) : 0,
          currency: "USD",
          resetAt: null,
        },
      },
    };
  } catch {
    // Upstream error text may echo credentials: only return a fixed safe message.
    return { supported: true, quotas: {}, message: "OpenRouter quota N/A: unable to read the key credit limit." };
  }
}
