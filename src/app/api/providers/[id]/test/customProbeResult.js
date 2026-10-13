/** Status-only summaries: never expose upstream bodies, URLs, or error messages. */
export function classifyCustomProbeResult({ status = null, error } = {}, probe = "models") {
  if (error || status === null) {
    const timeoutCodes = ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"];
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError"
      || timeoutCodes.includes(error?.code) || timeoutCodes.includes(error?.cause?.code);
    return {
      valid: false,
      error: timeout
        ? "Connection probe timed out; credentials could not be verified."
        : "Connection probe failed due to a network or transport error; credentials could not be verified.",
      status: null,
      category: timeout ? "timeout" : "transport",
      probe,
      inferenceVerified: false,
    };
  }
  if (status >= 200 && status <= 299) {
    return {
      valid: true,
      error: null,
      status,
      category: "success",
      probe,
      // This status-only check does not validate a generated completion.
      inferenceVerified: false,
      message: probe === "models"
        ? "Models endpoint responded successfully; inference has not been verified."
        : "Messages endpoint responded successfully; completion content has not been verified.",
    };
  }
  if (status === 401 || status === 403) {
    return {
      valid: false,
      error: status === 401
        ? "Upstream authentication rejected (HTTP 401). Check the API key."
        : "Upstream access denied (HTTP 403). Check credentials, permissions, or access policy.",
      status,
      category: "auth",
      probe,
      inferenceVerified: false,
    };
  }
  const gateway = status >= 500 && status <= 599;
  return {
    valid: false,
    error: status === 404
      ? "Probe endpoint not found (HTTP 404). Check the base URL and supported endpoint."
      : gateway
        ? `Upstream gateway or service failure (HTTP ${status}); credentials could not be verified.`
        : `Probe failed (HTTP ${status}); credentials could not be verified.`,
    status,
    category: status === 404 ? "endpoint" : gateway ? "gateway" : "http",
    probe,
    inferenceVerified: false,
  };
}
