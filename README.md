# llm-cost-optimizer

A small CLI + library that takes a description of how your app calls an LLM and tells you, in dollars, how much you'd save by applying the three levers that actually move an LLM bill: **prompt caching**, **model routing**, and **context trimming**.

It's pure math — no API keys, no network calls. Feed it a usage profile, get a before/after breakdown per lever and combined.

## The mental model

> The model isn't your cost problem. How you use it is.

Every request costs `input_tokens × input_rate + output_tokens × output_rate`. That's the whole bill. Teams reach for "switch to a cheaper model" first, but that's usually the crudest lever and the one most likely to cost you quality. The bigger wins are structural, and they compose because each one attacks a different part of that formula:

| Lever | What it changes | Why it works |
|---|---|---|
| **Prompt caching** | the *rate* on the repeated slice of input | Your system prompt, retrieved docs, and few-shot examples are byte-identical on every call. Cached reads cost ~10% of fresh input on Anthropic (~50% on OpenAI). If most of your input is a stable prefix, this is your biggest lever. |
| **Context trimming** | the *count* of the non-repeated input | Dead retrieval chunks, verbose scaffolding, and stale history are tokens you pay for and the model has to wade through. Cutting them is cheaper *and* often higher quality — less noise, sharper answers. It pays twice. |
| **Model routing** | *both rates*, for the share of requests that are easy | Not every request needs your best model. Route the easy ones (classification, FAQ, short replies) to a cheaper model and keep the hard ones where they are. Blend the cost. |

They don't overlap: caching touches the repeated context, trimming touches the non-repeated remainder, routing touches the request share. So you can stack all three.

## When each applies

- **Caching** wins when a large fraction of your input is repeated context. RAG apps, agents with big system prompts, anything with fixed few-shot examples. If your input is all unique per call, caching does nothing — check `repeatedContextTokens` honestly.
- **Trimming** wins when your non-repeated input is bloated — over-fetched RAG chunks, whole chat histories resent every turn, redundant instructions. If you're already lean, this lever is small (see the example: 5%).
- **Routing** wins when a real fraction of traffic is genuinely easy *and* a cheaper model holds quality on it. Measure quality before you route — this is the lever most likely to backfire. Prefer routing to the strongest cheaper model that still passes (e.g. Sonnet), not the absolute cheapest.

## Run it

```bash
npm install
npm run analyze -- profile.example.json      # formatted table
npm run analyze -- profile.example.json --json   # machine-readable
npm run typecheck                             # tsc --noEmit, strict
```

Requires Node 18+. Runs via [`tsx`](https://github.com/privatenumber/tsx) — no build step.

## The usage profile

A profile is one JSON object describing one app calling one model. All token counts are per-request averages.

```json
{
  "model": "claude-opus-4-8",
  "requestsPerMonth": 500000,
  "avgInputTokens": 4000,
  "avgOutputTokens": 400,
  "repeatedContextTokens": 3000,
  "fractionOfRequestsThatAreEasy": 0.6,
  "trimmablePct": 0.3,
  "cheapModel": "claude-sonnet-5"
}
```

| Field | Meaning |
|---|---|
| `model` | Model id the app uses today (must exist in the pricing table). |
| `requestsPerMonth` | Total billable requests/month. |
| `avgInputTokens` | Average input tokens per request, **including** repeated context. |
| `avgOutputTokens` | Average output tokens per request. |
| `repeatedContextTokens` | The slice of input that's identical every call — system prompt, docs, examples. This is what caching turns cheap. |
| `fractionOfRequestsThatAreEasy` | 0–1. Share of requests a cheaper model can handle without hurting quality. |
| `trimmablePct` | 0–1. Fraction of the **non-repeated** input that's unnecessary and can be cut. |
| `cheapModel` | *(optional)* Routing target. Defaults to the cheapest model in the same provider family. |

## Example output

The sample profile models a RAG chatbot on Claude Opus 4.8: 500k requests/month, 4,000 input tokens of which 3,000 are a stable prefix, 400 output tokens, 60% of requests easy enough for Sonnet 5, 30% of the non-repeated input trimmable.

```
  LLM cost analysis  —  claude-opus-4-8  (routing target: claude-sonnet-5)

  Lever              Monthly cost        Saved   % saved
  ----------------   ------------   ----------   -------
  Baseline             $15,000.00
  Prompt caching        $8,250.00    $6,750.00     45.0%
  Model routing         $9,600.00    $5,400.00     36.0%
  Context trimming     $14,250.00      $750.00      5.0%
  Combined              $4,800.00   $10,200.00     68.0%

  Applying all three levers cuts spend by 68.0% ($10,200.00/mo, $122,400.00/yr).
```

**$15k/mo → $4.8k/mo, a 68% cut**, without leaving the Anthropic family for the hard requests. Caching does most of the work here because the workload is context-heavy (75% of every prompt is the repeated prefix) — which is exactly the point of instrumenting before you optimize: the biggest lever is workload-specific.

Note the levers don't sum: 45% + 36% + 5% ≠ 68%, because each lever shrinks the base the next one operates on. Trust the combined figure, not the sum.

## How I'd apply this to your codebase

1. **Instrument real usage first — don't guess.** Log `usage` on every response (input, output, `cache_read_input_tokens`). A week of real traffic beats any estimate. This tool turns those measured averages into a dollar projection.
2. **Find the biggest lever before touching code.** In the example, caching is 9x the trimming lever — trimming first would be wasted effort. Every workload is different; a chat app with tiny prompts and long outputs has almost no caching headroom and should look at routing and output length instead.
3. **Measure, don't assume — especially for routing.** Caching and trimming are close to free wins (caching is a config change; trimming usually *improves* quality). Routing trades against quality, so gate it behind an eval on real requests before you ship it, and route to the strongest cheaper model that passes.
4. **Verify the caching actually hits.** The number one silent failure is a `Date.now()`, a request id, or unsorted JSON in the cached prefix — any byte change invalidates the whole cache. If `cache_read_input_tokens` is zero across repeated calls, your projected savings are fiction.
5. **Re-run monthly.** Traffic shape drifts. The lever ranking today isn't the ranking in six months.

## Layout

```
src/
  pricing.ts    per-million-token rates incl. cached-read price
  profile.ts    UsageProfile type, JSON load + validation
  optimize.ts   the three levers + combined, as pure functions
  index.ts      CLI (table + --json)
```

The optimizer functions are pure `(profile) → dollars` and exported from `optimize.ts`, so you can import them into a dashboard or a test as easily as running the CLI.

## Pricing data

Anthropic rates (Opus 4.8, Sonnet 5, Haiku 4.5) are first-party API prices verified 2026-09, including the prompt-caching read rate. Two OpenAI models (gpt-4o, gpt-4o-mini) are included for cross-provider comparison and are marked in-code as *"prices as of 2026-09, verify before relying."* Prices change — confirm against the provider's current pricing page before making a real decision.

## License

MIT — see [LICENSE](./LICENSE).
