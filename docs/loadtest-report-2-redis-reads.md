# Load test report 2: Redis cache on auction reads

Same test as report 1 (`SCENARIO=reads`, peak 2000 rps, same machine, `NODE_ENV=production`).
Change: cache-aside Redis for `GET /auctions/:id` (TTL 30s, invalidated on accepted bid) and `GET /auctions` (TTL 2s).
Raw output: `results/02-redis-reads-2026-10-26/`.

| Metric | 01 baseline | 02 with Redis |
|---|---|---|
| Requests served | 97,244 (~870 rps avg) | 133,076 (~1,160 rps avg) |
| Dropped by k6 (could not even be sent) | 38,556 (28%) | 2,724 (2%) |
| p95 latency | 2.91 s | 284 ms |
| Median latency | 2.16 s | 14 ms |
| Pool `waiting` (peak) | ~2,980 | 0 |
| Peak RSS | ~220 MB | ~188 MB |
| Threshold p95 < 500 ms | FAIL | PASS |
| Cache hit ratio | n/a | 98.7% (131,081 hits / 1,694 misses) |
| Misses that did NOT hit Postgres (coalesced) | n/a | 1,321 of 1,694 |

## What this shows
- Reads no longer touch the DB pool (waiting 0, Postgres CPU max ~14%). The earlier bottleneck is gone for this traffic.
- Request coalescing worked: 78% of cache misses reused an already running Postgres query (cold start of 100 keys under heavy parallel load).
- Redis down test (manual): the endpoint still returned correct data from Postgres, and cache errors are counted (`cache.errors`).

## Caveats
- This is a best case: only 100 distinct auctions, read-only traffic, no bids invalidating keys. Mixed read and bid traffic will lower the hit ratio.
- Latency tail: max was 2.0 s (likely the cold start and the ramp). p95 284 ms is still above the ~15 ms median, so the machine (k6 + Node + Docker on one laptop) is probably near its limit. I did not find the new ceiling; try `PEAK=4000` next.
- Bids are unchanged and still limited by the pool and the row lock (see report 1).
- 404s are not cached (negative caching not implemented), so a flood of requests for missing ids still reaches Postgres.
