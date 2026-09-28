#!/usr/bin/env node
import { loadProfile } from "./profile.js";
import { analyze, type Analysis } from "./optimize.js";

/**
 * CLI entry point.
 *   npm run analyze -- profile.example.json          # formatted table
 *   npm run analyze -- profile.example.json --json    # machine-readable JSON
 */

function usd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function printTable(a: Analysis): void {
  const rows = [
    { label: "Baseline", cost: a.baseline, saved: "", savedPct: "" },
    ...a.levers.map((l) => ({
      label: l.name,
      cost: l.newCost,
      saved: usd(l.saved),
      savedPct: pct(l.savedPct),
    })),
    {
      label: a.combined.name,
      cost: a.combined.newCost,
      saved: usd(a.combined.saved),
      savedPct: pct(a.combined.savedPct),
    },
  ];

  const headers = { label: "Lever", cost: "Monthly cost", saved: "Saved", savedPct: "% saved" };
  const col = (key: keyof typeof headers, get: (r: (typeof rows)[number]) => string) =>
    Math.max(headers[key].length, ...rows.map((r) => get(r).length));

  const costStr = (c: number) => usd(c);
  const wLabel = col("label", (r) => r.label);
  const wCost = col("cost", (r) => costStr(r.cost));
  const wSaved = col("saved", (r) => r.saved);
  const wPct = col("savedPct", (r) => r.savedPct);

  const pad = (s: string, w: number) => s.padEnd(w);
  const padL = (s: string, w: number) => s.padStart(w);

  const line = (label: string, cost: string, saved: string, savedPct: string) =>
    `  ${pad(label, wLabel)}   ${padL(cost, wCost)}   ${padL(saved, wSaved)}   ${padL(savedPct, wPct)}`;

  console.log();
  console.log(`  LLM cost analysis  —  ${a.model}  (routing target: ${a.cheapModel})`);
  console.log();
  console.log(line(headers.label, headers.cost, headers.saved, headers.savedPct));
  console.log(
    `  ${"-".repeat(wLabel)}   ${"-".repeat(wCost)}   ${"-".repeat(wSaved)}   ${"-".repeat(wPct)}`,
  );
  for (const r of rows) {
    console.log(line(r.label, costStr(r.cost), r.saved, r.savedPct));
  }
  console.log();
  console.log(
    `  Applying all three levers cuts spend by ${pct(a.combined.savedPct)} ` +
      `(${usd(a.combined.saved)}/mo, ${usd(a.combined.saved * 12)}/yr).`,
  );
  console.log();
}

function main(): void {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const path = args.find((a) => !a.startsWith("--"));

  if (!path) {
    console.error("Usage: npm run analyze -- <profile.json> [--json]");
    process.exit(1);
  }

  let analysis: Analysis;
  try {
    const profile = loadProfile(path);
    analysis = analyze(profile);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (jsonMode) {
    console.log(JSON.stringify(analysis, null, 2));
  } else {
    printTable(analysis);
  }
}

main();
