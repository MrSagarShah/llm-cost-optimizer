import { getPrice, cheapestInFamily, type ModelPrice } from "./pricing.js";
import type { UsageProfile } from "./profile.js";

/**
 * The three levers, plus baseline and combined. Every function here is pure:
 * (profile) -> dollars. No I/O, no rounding until display time.
 *
 * Mental model: your cost per request is
 *     input_tokens * input_rate  +  output_tokens * output_rate
 * Each lever attacks a different term:
 *   - caching   -> lowers the RATE on the repeated slice of input
 *   - trimming  -> lowers the COUNT of the non-repeated slice of input
 *   - routing   -> lowers BOTH RATES for the share of requests sent elsewhere
 * They compose without overlap because they touch disjoint pieces.
 */

const PER_M = 1_000_000;

/** Cost in USD for a batch of requests at one model's rates, given a token shape. */
function monthlyCost(
  requests: number,
  inputTokens: number,
  outputTokens: number,
  price: ModelPrice,
): number {
  const inputCost = (requests * inputTokens * price.inputPerM) / PER_M;
  const outputCost = (requests * outputTokens * price.outputPerM) / PER_M;
  return inputCost + outputCost;
}

/**
 * Cost of one month of requests where the input is split into a cached
 * (repeated) slice and a fresh slice billed at different rates.
 */
function monthlyCostCached(
  requests: number,
  cachedInputTokens: number,
  freshInputTokens: number,
  outputTokens: number,
  price: ModelPrice,
): number {
  const cachedCost = (requests * cachedInputTokens * price.cachedInputPerM) / PER_M;
  const freshCost = (requests * freshInputTokens * price.inputPerM) / PER_M;
  const outputCost = (requests * outputTokens * price.outputPerM) / PER_M;
  return cachedCost + freshCost + outputCost;
}

/** Current monthly spend, no optimization. */
export function baseline(profile: UsageProfile): number {
  const price = getPrice(profile.model);
  return monthlyCost(
    profile.requestsPerMonth,
    profile.avgInputTokens,
    profile.avgOutputTokens,
    price,
  );
}

/**
 * LEVER 1 — Prompt caching.
 * The repeated context (system prompt, docs, examples) is byte-identical every
 * call, so after the first request it is served from cache at cachedInputPerM
 * instead of inputPerM. We treat the whole month as cached: at real volume the
 * one-time write and periodic TTL refreshes are negligible against the read
 * savings. Output and the fresh (non-repeated) input are unchanged.
 */
export function withCaching(profile: UsageProfile): number {
  const price = getPrice(profile.model);
  const fresh = profile.avgInputTokens - profile.repeatedContextTokens;
  return monthlyCostCached(
    profile.requestsPerMonth,
    profile.repeatedContextTokens,
    fresh,
    profile.avgOutputTokens,
    price,
  );
}

/**
 * LEVER 2 — Model routing.
 * A share of requests is easy enough for a cheaper model. Those go to
 * cheapModel (or the cheapest same-family model); the rest stay on the main
 * model. We recompute a blended cost. Token shape is unchanged — only the
 * per-token rates differ for the routed share.
 */
export function withRouting(profile: UsageProfile): number {
  const main = getPrice(profile.model);
  const cheap = resolveCheapModel(profile);

  const easyRequests = profile.requestsPerMonth * profile.fractionOfRequestsThatAreEasy;
  const hardRequests = profile.requestsPerMonth - easyRequests;

  const easyCost = monthlyCost(easyRequests, profile.avgInputTokens, profile.avgOutputTokens, cheap);
  const hardCost = monthlyCost(hardRequests, profile.avgInputTokens, profile.avgOutputTokens, main);
  return easyCost + hardCost;
}

/**
 * LEVER 3 — Context trimming.
 * Cut trimmablePct of the NON-repeated input tokens (dead retrieval chunks,
 * verbose scaffolding, stale history). Repeated context is left intact — it is
 * the caching lever's job, and it is usually load-bearing. Fewer input tokens
 * is both cheaper AND often higher quality: less noise for the model to wade
 * through means sharper answers, so this lever frequently pays twice.
 */
export function withTrimming(profile: UsageProfile): number {
  const price = getPrice(profile.model);
  const fresh = profile.avgInputTokens - profile.repeatedContextTokens;
  const trimmedFresh = fresh * (1 - profile.trimmablePct);
  const newInput = profile.repeatedContextTokens + trimmedFresh;
  return monthlyCost(profile.requestsPerMonth, newInput, profile.avgOutputTokens, price);
}

/**
 * COMBINED — all three, without double-counting.
 * Token shape is built once: repeated context stays whole (cached), the fresh
 * slice is trimmed. Then requests are split by difficulty, and each share is
 * billed at its model's rates using that shared cached/fresh token shape.
 */
export function combined(profile: UsageProfile): number {
  const main = getPrice(profile.model);
  const cheap = resolveCheapModel(profile);

  const cachedTokens = profile.repeatedContextTokens;
  const fresh = profile.avgInputTokens - profile.repeatedContextTokens;
  const trimmedFresh = fresh * (1 - profile.trimmablePct);

  const easyRequests = profile.requestsPerMonth * profile.fractionOfRequestsThatAreEasy;
  const hardRequests = profile.requestsPerMonth - easyRequests;

  const easyCost = monthlyCostCached(
    easyRequests,
    cachedTokens,
    trimmedFresh,
    profile.avgOutputTokens,
    cheap,
  );
  const hardCost = monthlyCostCached(
    hardRequests,
    cachedTokens,
    trimmedFresh,
    profile.avgOutputTokens,
    main,
  );
  return easyCost + hardCost;
}

/** Resolve the routing target: explicit cheapModel, else cheapest same-family. */
export function resolveCheapModel(profile: UsageProfile): ModelPrice {
  if (profile.cheapModel) return getPrice(profile.cheapModel);
  const main = getPrice(profile.model);
  return cheapestInFamily(main.family);
}

export interface LeverResult {
  name: string;
  newCost: number;
  saved: number;
  savedPct: number;
}

export interface Analysis {
  model: string;
  cheapModel: string;
  baseline: number;
  levers: LeverResult[];
  combined: LeverResult;
}

/** Run the full analysis: baseline, each lever in isolation, and combined. */
export function analyze(profile: UsageProfile): Analysis {
  const base = baseline(profile);
  const cheap = resolveCheapModel(profile);

  const lever = (name: string, newCost: number): LeverResult => ({
    name,
    newCost,
    saved: base - newCost,
    savedPct: base === 0 ? 0 : ((base - newCost) / base) * 100,
  });

  return {
    model: profile.model,
    cheapModel: cheap.id,
    baseline: base,
    levers: [
      lever("Prompt caching", withCaching(profile)),
      lever("Model routing", withRouting(profile)),
      lever("Context trimming", withTrimming(profile)),
    ],
    combined: lever("Combined", combined(profile)),
  };
}
