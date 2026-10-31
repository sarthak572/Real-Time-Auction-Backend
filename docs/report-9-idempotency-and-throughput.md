# Report 9: idempotency keys and a faster bid path

Raw output: `results/09-throughput/` (k6 summaries, CPU samples, two CPU profiles, a `discarded/` folder), `results/09-cluster-check*.txt`.
Method as before: one API instance run directly, hot-auction bids, k6 with 600 virtual users, everything on one laptop (4 cores / 8 threads, load generator included).

## Part 1: idempotency (`Idempotency-Key` header on `POST /auctions/:id/bids`)
**Promise:** a client that retries a request (timeout, dropped connection, double click) with the same key gets the same answer back and never causes a second bid.

How: the check lives inside the same atomic Redis script that decides the bid, so two copies of one request cannot both get through.
- Key = `idem:<bidderId>:<key>`; the stored value is a fingerprint of the request (auction and amount) plus the answer.
- Same key, same request: the stored answer is returned (HTTP 201 or the original 409/403) with `Idempotent-Replayed: true`. No second bid, no second live event.
- Same key, different request: 422 `IDEMPOTENCY_KEY_REUSED`.
- Temporary problems (backlog full, auction not loaded yet) are not remembered, so those can be retried with the same key.
- Keys expire after `IDEMPOTENCY_TTL_SECONDS` (600).
- Only the write-behind path honours keys; the older Postgres paths ignore the header.

Tests (`tests/idempotency.test.ts`, 9 tests, plus 2 in `idempotency-memory.test.ts`): same answer on retry, no event for a retry, different request refused, a remembered refusal replays as the same 409, **20 simultaneous copies produce exactly one bid**, keys belong to the bidder, no key means nothing is remembered, malformed keys get 400, keys expire. Mutation check: with the key lookup disabled, 4 of the tests fail, including the 20-copies test. One bug found by the tests: a fresh bid's response body leaked an internal `replayed: false` field, so a retry's body differed from the original; fixed.

**Memory is the real cost.** About 150 bytes per key (1.24 million keys used 199 MB). The state Redis never evicts and is capped at 512 MB; when it fills up, every bid fails, with or without a key. A client sending unique keys at a high rate could do that. Guard added: above 80% of the limit, requests that carry a key get 503 `IDEMPOTENCY_STORE_FULL` while plain bids keep working. The memory gauge and dashboard panel show the headroom. Not tested: actually filling the Redis for real (the test fakes the reading).

Measured cost: at a stable load of about 1,800 bids/s with 10% of them retried, median bid latency went from 1.6 ms to 2.1 ms and 3.1 ms in two runs (p95 5.1 ms to 7.8 ms and 33 ms). The retries are extra requests on top of the same bids, and the second run was noisier, so the key overhead itself cannot be separated precisely. At saturation (6,000 req/s offered) keyed runs served 3,815-3,908 req/s including the retries, the same band as unkeyed runs (3,333-3,613). Conclusion: small, not precisely measured.

## Part 2: throughput
### What the profile said (before)
A 28-second CPU profile of one instance at a steady 1,800 req/s: **91% busy**. About **28% of all time was socket writes** (HTTP responses and Redis commands), 8% the Redis client, 6% Fastify, 2% metrics, ~1.5% creating error objects (most bids in this test are refused as too low, and each refusal captured a stack trace). Each bid made **two** Redis writes: the decision script, then a separate `PUBLISH`.

### Changes
1. **Publish the live event inside the bid script.** One Redis round trip instead of two, and the event now exists exactly when the bid was accepted (before, a crash between the two left a bid with no event). Events now travel on the state Redis (`PUBSUB_URL`). Switch: `PUBLISH_IN_SCRIPT`.
2. **Batch the bid commands.** Bids that arrive in the same event-loop turn go out as one pipelined write; each script still runs atomically and in order. Switch: `BID_BATCH`.
3. **No stack traces for everyday refusals** (`AppError`).

### Results at the same offered load (peak 3,000 req/s, so k6 offers about 1,800/s on average; every run served about 1,820)
| Configuration | Median | p95 | Requests k6 had to drop |
|---|---|---|---|
| both switches off (2 runs) | 7.5 / 5.6 ms | 59 / 41 ms | 1,396 / 1,092 |
| publish in script only | 1.6 ms | 8.3 ms | 318 |
| batching only | 3.3 ms | 10.6 ms | 285 |
| **both on (3 runs)** | **1.6 / 1.6 / 1.6 ms** | **5.1 / 5.2 / 7.3 ms** | **247 / 177 / 576** |

Repeats of the same configuration agree closely, so these are real. Publishing inside the script is the larger share; batching adds on top.

### Where it saturates (peak 6,000 req/s offered)
| | Served (avg) | Median | p95 | Dropped by k6 |
|---|---|---|---|---|
| switches off | 2,661 and 2,466 req/s | 114 and 140 ms | 228 and 240 ms | 110k and 132k |
| **both on** | **3,613, 3,389, 3,333 req/s** | 4.8, 8.6, 43 ms | 51, 142, 136 ms | 5k, 30k, 36k |

About **34% more throughput** at saturation (2,564 to 3,445 req/s on average), with far lower latency. Saturated runs are noisy (the same configuration gave 4.8 to 43 ms medians), so trust the direction and the rough size, not the decimals.

### Profile after (same load as the "before" profile)
Process busy time fell from **91% to 66%**, leaving about a third of the process idle as headroom; socket-write time fell from 27.7% to 12.2%. The remaining top items are Fastify and Node internals (response writes, a `deprecate` wrapper inside Fastify's reply handling at ~2%), ioredis (7.5%), prom-client (2%). No single easy target is left.

## What went wrong on the way (so you can recognise it)
- **A leftover process answered for a new one.** My profiling runner started the API through `scripts/profile-server.mjs`, which `cluster.sh stop` did not recognise. The old process kept port 3001 with pre-change code, the new instance could not bind, and the health check passed because the old process answered. Symptom: viewers received only bids placed through their own instance. Fixed (`stop` now also kills the profiling wrapper); lesson: a health check proves *something* answers, not *which build*.
- **The whole laptop froze for about 4.7 minutes during one run** (k6's slowest request: 4 min 39 s, flusher lag 280 s, the CPU sampler logged 10 of ~40 samples). All data was still saved correctly afterwards. That run is excluded (`results/09-throughput/discarded/`).
- **Twice** a regex with `\d` lost its backslash when written through a shell or template, silently returning 0 for the memory reading. Caught by a test that reads the real Redis; the guard would otherwise never have triggered.
- A flaky check (expecting nginx to spread sequential bids over both instances) was replaced by a deterministic one.

## Limits
- One laptop, shared with the load generator, one or two runs per cell; the 3,000 req/s comparison is the reliable one, the 6,000 req/s ceiling is a rough range.
- Only the hot-auction bid scenario was benchmarked here. Reads and WebSocket fan-out were not re-measured after these changes.
- Two API instances behind nginx were not re-benchmarked; earlier they gave no gain on this machine because it was out of CPU.
- The effect of the switches on the *flusher* and Postgres load was not isolated.
