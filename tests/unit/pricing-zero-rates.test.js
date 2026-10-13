import { describe, it, expect } from "vitest";
import { calculateCostFromTokens } from "../../open-sse/providers/pricing.js";

describe("calculateCostFromTokens explicit zero rates", () => {
  it("keeps cached tokens free without charging them again as input", () => {
    const cost = calculateCostFromTokens(
      { prompt_tokens: 300, cached_tokens: 200, completion_tokens: 50 },
      { input: 3, output: 15, cached: 0 }
    );

    // Canonical prompt tokens include the cached subset.
    expect(cost).toBeCloseTo((100 * 3 + 50 * 15) / 1_000_000, 12);
  });

  it("keeps a zero reasoning rate without removing the existing output charge", () => {
    const cost = calculateCostFromTokens(
      { prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 20 },
      { input: 3, output: 15, reasoning: 0 }
    );

    // Preserve the calculator's additive reasoning convention; do not subtract
    // reasoning from completion_tokens or charge the fallback output rate again.
    expect(cost).toBeCloseTo((100 * 3 + 50 * 15) / 1_000_000, 12);
  });

  it("keeps cache creation free without charging its input subset again", () => {
    const cost = calculateCostFromTokens(
      { prompt_tokens: 130, cache_creation_input_tokens: 30, completion_tokens: 50 },
      { input: 3, output: 15, cache_creation: 0 }
    );

    expect(cost).toBeCloseTo((100 * 3 + 50 * 15) / 1_000_000, 12);
  });

  it.each([undefined, null])("falls back to base rates for nullish optional rates (%s)", (rate) => {
    const cost = calculateCostFromTokens(
      {
        prompt_tokens: 330,
        cached_tokens: 200,
        cache_creation_input_tokens: 30,
        completion_tokens: 50,
        reasoning_tokens: 20,
      },
      { input: 3, output: 15, cached: rate, cache_creation: rate, reasoning: rate }
    );

    expect(cost).toBeCloseTo((330 * 3 + 50 * 15 + 20 * 15) / 1_000_000, 12);
  });

  it("preserves nonzero optional rates and the existing additive reasoning convention", () => {
    const cost = calculateCostFromTokens(
      {
        prompt_tokens: 330,
        cached_tokens: 200,
        cache_creation_input_tokens: 30,
        completion_tokens: 50,
        reasoning_tokens: 20,
      },
      { input: 3, output: 15, cached: 0.3, cache_creation: 3.75, reasoning: 18 }
    );

    expect(cost).toBeCloseTo(
      (100 * 3 + 200 * 0.3 + 30 * 3.75 + 50 * 15 + 20 * 18) / 1_000_000,
      12
    );
  });
});
