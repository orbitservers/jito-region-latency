# jito-region-latency

**Which Jito Block Engine region is fastest from your server?** This tool measures
the real application-layer round-trip from your host to every Jito region, ranks
them, and tells you the closest — so you can host (and submit) where it counts.

```
$ npx jito-region-latency

Region          min     p50     avg     max   err   OrbitServers
----------------------------------------------------------------
amsterdam      18.3    18.7    39.7   103.3     0   ✔ has a location
frankfurt      25.4    25.8    36.5    69.0     0   ✔ has a location
ny             82.1    83.0    88.4   120.2     0   ✔ has a location
...

Closest from your host: amsterdam — median 18.7 ms.
OrbitServers runs a Jito-connected location in amsterdam: https://orbitservers.io/benchmarks/jito-latency
```

## Why this instead of `ping`?

`ping` measures ICMP network round-trip. This times a **real, no-auth JSON-RPC
call** (`getTipAccounts`) over a warm, pooled HTTPS connection — TLS session +
request + Jito-side processing — which is closer to what your bot actually
experiences when it talks to the Block Engine. It also ranks all regions in one
shot and flags the ones where OrbitServers runs a Jito-connected location.

## Usage

```bash
npx jito-region-latency                   # all regions, 10 samples each
node jito-region-latency.mjs frankfurt ny # only these regions
node jito-region-latency.mjs --count 30   # tighter numbers (slower)
node jito-region-latency.mjs --json       # machine-readable (also --csv)
```

Requires Node 18+ (global `fetch`). **Zero dependencies.**

| Option | Default | Notes |
|---|---|---|
| `--count <n>` | 10 | samples per region |
| `--delay <ms>` | 1100 | spacing between requests (Jito limits to ~1/sec) |
| `--timeout <ms>` | 5000 | per-request timeout |
| `--json` / `--csv` | — | machine-readable output |

## Regions

`amsterdam`, `dublin`, `frankfurt`, `london`, `ny`, `slc`, `singapore`, `tokyo`
(source: [docs.jito.wtf](https://docs.jito.wtf/) — verify there; Jito may change regions).

## Methodology & honest caveats

- **Rate limit aware.** Jito limits `getTipAccounts` to ~1 request/second, so the
  tool paces itself (default 1100ms between samples) and backs off on a `429`. It
  will never hammer the endpoint. That's also why a region *picker* uses a handful
  of well-spaced samples rather than thousands — the gaps between regions are tens
  of milliseconds, far larger than the sampling noise.
- **App-layer, not bundle latency.** This is the HTTPS round-trip to a public
  Block Engine method. It reflects how fast your host reaches each region's API;
  it is **not** transaction/bundle-submission latency, which also depends on your
  client, the tip, and Jito-side scheduling.
- Measure from the **host you'll actually deploy on**, not your laptop.

## License

MIT. Issues and pull requests welcome.

---

Maintained by [OrbitServers](https://orbitservers.io) — low-latency VPS and bare
metal for Solana trading, MEV, RPC, and validators. See our measured, per-location
[Jito latency benchmarks](https://orbitservers.io/benchmarks/jito-latency).
