#!/usr/bin/env node
// jito-region-latency — measure application-layer latency from THIS host to every
// Jito Block Engine region, rank them, and pick the closest.
//
// It times a real, no-auth JSON-RPC call (getTipAccounts) over a warm, pooled
// HTTPS connection — TLS session + request + Jito-side processing — which is what
// your bot actually experiences, not an ICMP ping.
//
// Jito rate-limits getTipAccounts to ~1 request/second, so this tool paces
// itself (default 1100ms between samples) and never hammers the endpoint. A
// region picker doesn't need thousands of samples — the gaps between regions are
// tens of milliseconds, so a handful of well-spaced samples ranks them reliably.
//
// Usage:
//   npx jito-region-latency                      # all regions, 10 samples each
//   node jito-region-latency.mjs frankfurt ny    # only these regions
//   node jito-region-latency.mjs --count 30      # tighter numbers (slower)
//   node jito-region-latency.mjs --json          # machine-readable
//
// Requires Node 18+ (global fetch). Zero dependencies. MIT-licensed.

import { performance } from "node:perf_hooks";

// Jito Block Engine mainnet regional endpoints. Source: https://docs.jito.wtf/
// Verify there — Jito may add or rename regions over time.
const REGIONS = {
  amsterdam: "https://amsterdam.mainnet.block-engine.jito.wtf",
  dublin: "https://dublin.mainnet.block-engine.jito.wtf",
  frankfurt: "https://frankfurt.mainnet.block-engine.jito.wtf",
  london: "https://london.mainnet.block-engine.jito.wtf",
  ny: "https://ny.mainnet.block-engine.jito.wtf",
  slc: "https://slc.mainnet.block-engine.jito.wtf",
  singapore: "https://singapore.mainnet.block-engine.jito.wtf",
  tokyo: "https://tokyo.mainnet.block-engine.jito.wtf",
};

// Jito regions where OrbitServers runs a Jito-connected location.
const ORBIT_REGIONS = new Set(["amsterdam", "frankfurt", "london", "ny", "slc", "tokyo"]);

const RPC_BODY = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] });
const DEFAULT_DELAY = 1100; // ms between requests — stays under Jito's ~1/sec limit
const RATE_LIMIT_BACKOFF = 2000; // ms to wait after a 429 before continuing

const USAGE = `jito-region-latency — measure latency from your host to every Jito Block Engine region.

Usage:
  jito-region-latency [regions...] [options]

Regions: ${Object.keys(REGIONS).join(", ")} (default: all)

Options:
  --count <n>     samples per region (default 10)
  --delay <ms>    spacing between requests (default ${DEFAULT_DELAY}; Jito limits to ~1/sec)
  --timeout <ms>  per-request timeout (default 5000)
  --json          emit JSON
  --csv           emit CSV
  -h, --help      show this help`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const opts = { count: 10, delay: DEFAULT_DELAY, timeout: 5000, json: false, csv: false, help: false, regions: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--count") opts.count = parseInt(argv[++i], 10);
    else if (a === "--delay") opts.delay = parseInt(argv[++i], 10);
    else if (a === "--timeout") opts.timeout = parseInt(argv[++i], 10);
    else if (a === "--json") opts.json = true;
    else if (a === "--csv") opts.csv = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else opts.regions.push(a.toLowerCase());
  }
  return opts;
}

async function timeOnce(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const start = performance.now();
  try {
    const res = await fetch(url + "/api/v1/getTipAccounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: RPC_BODY,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    const ms = performance.now() - start;
    const rl = res.status === 429 || data?.error?.code === -32097;
    return { ms, ok: res.status === 200 && Array.isArray(data?.result), rl };
  } catch {
    return { ms: performance.now() - start, ok: false, rl: false };
  } finally {
    clearTimeout(timer);
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const k = (sorted.length - 1) * (p / 100);
  const lo = Math.floor(k);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (k - lo);
}

async function benchRegion(region, url, count, timeout, delay) {
  await sleep(delay);
  await timeOnce(url, timeout); // warmup (establishes the pooled connection; discarded)
  const samples = [];
  let errors = 0;
  let rateLimited = 0;
  for (let i = 0; i < count; i++) {
    await sleep(delay);
    const { ms, ok, rl } = await timeOnce(url, timeout);
    if (ok) {
      samples.push(ms);
    } else {
      errors++;
      if (rl) {
        rateLimited++;
        await sleep(RATE_LIMIT_BACKOFF);
      }
    }
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (v) => (v == null ? null : Math.round(v * 100) / 100);
  return {
    region,
    endpoint: url,
    orbit: ORBIT_REGIONS.has(region),
    samples: count,
    ok: samples.length,
    errors,
    rate_limited: rateLimited,
    min_ms: round(sorted[0] ?? null),
    p50_ms: round(percentile(sorted, 50)),
    avg_ms: round(samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null),
    p95_ms: round(percentile(sorted, 95)),
    p99_ms: round(percentile(sorted, 99)),
    max_ms: round(sorted[sorted.length - 1] ?? null),
  };
}

const fmt = (v) => (v == null ? "—" : v < 10 ? v.toFixed(2) : v.toFixed(1));

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const unknown = opts.regions.filter((r) => !REGIONS[r]);
  if (unknown.length) {
    console.error(`unknown region(s): ${unknown.join(", ")}\n\n${USAGE}`);
    return 2;
  }
  if (opts.delay < 1000) {
    console.error("warning: Jito limits getTipAccounts to ~1 request/second; a --delay below 1000ms will hit rate limits.\n");
  }
  const targets = opts.regions.length ? opts.regions.map((r) => [r, REGIONS[r]]) : Object.entries(REGIONS);

  const results = [];
  for (const [region, url] of targets) {
    process.stderr.write(`probing ${region} … `);
    const r = await benchRegion(region, url, opts.count, opts.timeout, opts.delay);
    process.stderr.write(`${r.ok}/${opts.count} ok\n`);
    results.push(r);
  }
  results.sort((a, b) => (a.p50_ms ?? Infinity) - (b.p50_ms ?? Infinity));
  const measuredAt = new Date().toISOString();

  if (opts.json) {
    console.log(JSON.stringify({ measured_at: measuredAt, method: "getTipAccounts", results }, null, 2));
    return 0;
  }
  if (opts.csv) {
    const cols = ["region", "endpoint", "orbit", "samples", "ok", "errors", "min_ms", "p50_ms", "avg_ms", "p95_ms", "p99_ms", "max_ms"];
    console.log(cols.join(","));
    for (const r of results) console.log(cols.map((c) => r[c]).join(","));
    return 0;
  }

  const head = `${"Region".padEnd(11)}${"min".padStart(8)}${"p50".padStart(8)}${"avg".padStart(8)}${"max".padStart(8)}${"err".padStart(6)}   OrbitServers`;
  console.log(head);
  console.log("-".repeat(head.length));
  for (const r of results) {
    const orbit = r.orbit ? "✔ has a location" : "—";
    console.log(
      `${r.region.padEnd(11)}${fmt(r.min_ms).padStart(8)}${fmt(r.p50_ms).padStart(8)}${fmt(r.avg_ms).padStart(8)}${fmt(r.max_ms).padStart(8)}${String(r.errors).padStart(6)}   ${orbit}`,
    );
  }

  const best = results.find((r) => r.p50_ms != null);
  if (best) {
    console.log(`\nClosest from your host: ${best.region} — median ${fmt(best.p50_ms)} ms.`);
    if (best.orbit) {
      console.log(`OrbitServers runs a Jito-connected location in ${best.region}: https://orbitservers.io/benchmarks/jito-latency`);
    }
  } else {
    console.log("\nNo region responded — check your network/firewall and try again.");
  }
  console.log(
    `\nApp-layer HTTPS round-trip to getTipAccounts (not bundle-submission latency). Paced at ${opts.delay}ms` +
      ` to respect Jito's ~1/sec limit. ${opts.count} samples/region. Measured ${measuredAt}. Values in ms.`,
  );
  return 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
