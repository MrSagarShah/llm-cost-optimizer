import { readFileSync } from "node:fs";

/**
 * A usage profile describes how one application calls one model over a month.
 * All token figures are per-request averages. Everything the optimizer needs
 * to project savings is derived from these numbers — no network, no logs.
 */
export interface UsageProfile {
  /** Model id the app currently uses (must exist in PRICING). */
  model: string;
  /** Total billable requests per month. */
  requestsPerMonth: number;
  /** Average input tokens per request (INCLUDING repeated context). */
  avgInputTokens: number;
  /** Average output tokens per request. */
  avgOutputTokens: number;
  /**
   * The portion of avgInputTokens that is byte-identical on every call:
   * system prompt, retrieved docs that rarely change, few-shot examples.
   * This is what prompt caching turns cheap.
   */
  repeatedContextTokens: number;
  /**
   * Fraction (0-1) of requests simple enough to route to a cheaper model
   * without hurting quality (FAQ answers, classification, short replies).
   */
  fractionOfRequestsThatAreEasy: number;
  /**
   * Fraction (0-1) of the NON-repeated input tokens that are unnecessary —
   * dead retrieval chunks, verbose formatting, stale history — and can be
   * trimmed. Applies only to the non-repeated remainder.
   */
  trimmablePct: number;
  /**
   * Optional explicit routing target. If omitted, the optimizer defaults to
   * the cheapest model in the same provider family.
   */
  cheapModel?: string;
}

/** Validate a parsed object as a UsageProfile, throwing on any bad field. */
export function validateProfile(raw: unknown): UsageProfile {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Profile must be a JSON object.");
  }
  const p = raw as Record<string, unknown>;

  const num = (key: string, min: number, max: number): number => {
    const v = p[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`Profile field "${key}" must be a number.`);
    }
    if (v < min || v > max) {
      throw new Error(`Profile field "${key}" must be between ${min} and ${max}.`);
    }
    return v;
  };

  const str = (key: string): string => {
    const v = p[key];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`Profile field "${key}" must be a non-empty string.`);
    }
    return v;
  };

  const model = str("model");
  const avgInputTokens = num("avgInputTokens", 0, Number.MAX_SAFE_INTEGER);
  const repeatedContextTokens = num("repeatedContextTokens", 0, Number.MAX_SAFE_INTEGER);

  if (repeatedContextTokens > avgInputTokens) {
    throw new Error(
      "repeatedContextTokens cannot exceed avgInputTokens (repeated context is part of the input).",
    );
  }

  const profile: UsageProfile = {
    model,
    requestsPerMonth: num("requestsPerMonth", 0, Number.MAX_SAFE_INTEGER),
    avgInputTokens,
    avgOutputTokens: num("avgOutputTokens", 0, Number.MAX_SAFE_INTEGER),
    repeatedContextTokens,
    fractionOfRequestsThatAreEasy: num("fractionOfRequestsThatAreEasy", 0, 1),
    trimmablePct: num("trimmablePct", 0, 1),
  };

  if (p.cheapModel !== undefined) {
    profile.cheapModel = str("cheapModel");
  }

  return profile;
}

/** Read and validate a profile from a JSON file path. */
export function loadProfile(path: string): UsageProfile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Could not read profile file: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Profile file is not valid JSON: ${path}`);
  }
  return validateProfile(parsed);
}
