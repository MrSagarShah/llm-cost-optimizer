/**
 * Per-million-token pricing table.
 *
 * Anthropic prices are first-party API rates (source: Anthropic API docs,
 * verified 2026-09). `cachedInputPerM` is the prompt-caching READ price — what
 * you pay for tokens served from cache instead of re-processed fresh. For
 * Anthropic this is ~0.1x the base input rate, which is exactly why caching a
 * large, stable prefix (system prompt, docs, examples) is the single biggest
 * lever on a context-heavy workload.
 *
 * Cache WRITE (first call, or after the 5-min TTL expires) costs ~1.25x the
 * base input rate. We do not model write cost here: at meaningful request
 * volume it is a rounding error against the read savings. See optimize.ts.
 */

export interface ModelPrice {
  /** Canonical model id you would pass to the provider API. */
  id: string;
  /** USD per 1M fresh (uncached) input tokens. */
  inputPerM: number;
  /** USD per 1M cached-read input tokens (prompt caching hit). */
  cachedInputPerM: number;
  /** USD per 1M output tokens. */
  outputPerM: number;
  /** Provider + family, used to auto-pick a cheaper same-family model for routing. */
  family: "anthropic" | "openai";
}

export const PRICING: Record<string, ModelPrice> = {
  // --- Anthropic (first-party API rates, verified 2026-09) ---
  // Cache-read price is 0.1x the base input rate.
  "claude-opus-4-8": {
    id: "claude-opus-4-8",
    inputPerM: 5.0,
    cachedInputPerM: 0.5,
    outputPerM: 25.0,
    family: "anthropic",
  },
  "claude-sonnet-5": {
    id: "claude-sonnet-5",
    inputPerM: 2.0,
    cachedInputPerM: 0.2,
    outputPerM: 10.0,
    family: "anthropic",
  },
  "claude-haiku-4-5": {
    id: "claude-haiku-4-5",
    inputPerM: 1.0,
    cachedInputPerM: 0.1,
    outputPerM: 5.0,
    family: "anthropic",
  },

  // --- OpenAI ---
  // prices as of 2026-09, verify before relying.
  // OpenAI cached-input is ~0.5x the base input rate (a weaker caching
  // discount than Anthropic's 0.1x — worth knowing when the caching lever
  // is your main play).
  "gpt-4o": {
    id: "gpt-4o",
    inputPerM: 2.5,
    cachedInputPerM: 1.25,
    outputPerM: 10.0,
    family: "openai",
  },
  "gpt-4o-mini": {
    id: "gpt-4o-mini",
    inputPerM: 0.15,
    cachedInputPerM: 0.075,
    outputPerM: 0.6,
    family: "openai",
  },
};

/** Look up a model or throw a helpful error listing the known ids. */
export function getPrice(id: string): ModelPrice {
  const p = PRICING[id];
  if (!p) {
    const known = Object.keys(PRICING).join(", ");
    throw new Error(`Unknown model "${id}". Known models: ${known}`);
  }
  return p;
}

/**
 * Pick the cheapest model in the same provider family, ranked by blended
 * input+output rate. Used as the default routing target when the profile
 * does not name a `cheapModel`.
 */
export function cheapestInFamily(family: ModelPrice["family"]): ModelPrice {
  const candidates = Object.values(PRICING).filter((m) => m.family === family);
  const blended = (m: ModelPrice) => m.inputPerM + m.outputPerM;
  return candidates.reduce((best, m) => (blended(m) < blended(best) ? m : best));
}
