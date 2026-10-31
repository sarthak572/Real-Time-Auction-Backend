# Report 5: write-behind bidding (Redis decides, a flusher saves to Postgres)

Raw output: `results/05-write-behind/`. Code: `src/state.ts` (Lua script, live state), `src/flusher.ts` + `src/worker.ts` (flusher), `src/modules/bids.ts` (`BID_IMPL=redis`).
Same k6 script, laptop and rates as reports 1-4 (k6, Node, Postgres and both Redis instances share one machine).

## How it works
```
POST /bids ─▶ Redis Lua script (atomic): check rules against live state, seq+1, update price, XADD to bids:stream
          ─▶ 201 immediately (no Postgres on the request path)
flusher (own process, every 200 ms or when a batch fills):
   XREADGROUP up to 1000 entries ─▶ ONE SQL statement: INSERT bids ON CONFLICT DO NOTHING + UPDATE auctions (only forward)
   ─▶ XACK + XDEL.   Crash before XACK = the entries are re-read; the SQL is safe to repeat.
reads: cached static row + live price/bidder/seq overlaid from Redis (so reads are fresh, Postgres may be ~200 ms behind)
```
Bids never fall back to Postgres when Redis is down: that would create two competing authorities. They get HTTP 503.

Required infrastructure change: a separate `redis-state` container (AOF `everysec`, `noeviction`, 512 MB). The cache Redis (LRU eviction, no persistence) would lose acknowledged bids.

## Correctness evidence
- `npm test`: 18 tests pass with `BID_IMPL=redis` (11 shared bid/concurrency tests + 7 write-behind tests); the 11 shared tests still pass for `single` and `legacy`.
- Mutation checks: removing the "only move forward" guard fails the late-batch test; removing `ON CONFLICT` fails five tests.
- Failure drill (`scripts/wb-drill.ts`, output in `results/05-write-behind/drill-output.txt`): traffic from 30 concurrent clients while the flusher was SIGKILLed and restarted, then the state Redis container was `docker kill`ed and restarted.

| Drill result (clean run) | |
|---|---|
| Bids answered 201 | 7,637 |
| Saved in Postgres | 7,637 |
| Acknowledged but missing / different / duplicated | 0 / 0 / 0 |
| Auctions with a seq gap, or bid_count wrong | 0 / 0 |
| Bids refused with 503 while Redis was down | 2,253 (correct: fail closed) |
| Flush lag in steady state | ~200-300 ms; max 4.7 s (while the flusher was dead and Redis was down) |

## Load results

| 1,000 req/s peak | single (report 4) | **redis write-behind** |
|---|---|---|
| Hot auction: failed requests | 15.7% | **0%** |
| Hot auction: k6 median / p95 | 4.9 s / 9.95 s | **2.9 ms / 60 ms** |
| Hot auction: bids accepted | 18,464 | **64,762** |
| Hot auction: bid time in server p50 / p95 / p99 | 1.3 s / 5.0 s / 5.1 s | **2 ms / 21 ms / 158 ms** |
| Spread over 100 auctions: failed requests | 0% | **0%** |
| Spread: k6 median / p95 | 1.65 s / 4.05 s | **2.7 ms / 13 ms** |
| Spread: bids accepted | 58,416 | **67,963** |
| Postgres CPU, max sample (hot / spread) | ~77% / ~201% | **~16% / ~44%** |
| Flusher keeps up | n/a | stream length back to 0 immediately after k6 ended; max flush lag 1.7 s (hot), 0.6 s (spread) |

At this rate both implementations served what was offered in the "spread" case, but only write-behind did in the hot case. 1,000 req/s is no longer a stress level for it.

### Finding the new limit: hot auction, 4,000 req/s peak
- Served ~1,825 req/s on average; 134,378 bids accepted; 0 server errors; all responses were 200, 201 or 409.
- 15.5% of requests failed **inside k6**: `dial tcp 127.0.0.1:3000: connectex: No connection could be made`. This is the client/OS side of one laptop running the load generator and the server, not an API error.
- Event-loop lag p99 rose from ~35 ms to ~600 ms and k6 median latency to 205 ms, so the single Node API process (one core, JSON logging of every request) is the likely next limit. Not profiled.
- The flusher kept up: max stream length 826, flush lag stayed under 1 s, nothing failed. Postgres CPU reached ~100% (batch inserts of ~3,000 rows/s); the reason was not investigated.

## What it costs (read before relying on it)
1. **Durability is Redis's job.** A 201 means the bid is in Redis (AOF, fsync every second), not yet in Postgres. `docker kill` (process crash) lost nothing in the drill, but a power cut or losing the VM disk can lose up to ~1 s of acknowledged bids, which was NOT simulated. Options: `appendfsync always` (slower), a replica, or accepting the risk for this system.
2. **Silent-loss hazard, now detected.** If Redis loses recent writes while Postgres keeps them, a new bid can reuse a seq Postgres already holds. The flusher counts such different-content conflicts (`conflictTotal`, log event `flush.conflict`) instead of silently dropping them. It does not repair them; that would need a reconciliation step.
3. **Two sources of truth for ~200 ms.** Reads overlay Redis, so users see the right price. Anything reading Postgres directly (reports, the auction list, WebSocket history replay) lags by about one flush. The list is cached for 2 s anyway.
4. **Operationally there is one more process to run and watch** (`npm run flusher`). If it stops, Postgres falls behind and the backlog grows; bids are refused with 503 once `WB_MAX_BACKLOG` (100,000) entries wait. `/health/stats` shows `flusherAlive`, `streamLength` and lag.
5. **Phase 5 must respect this:** closing an auction has to drain the flusher for that auction and mark it ended in Redis, otherwise Postgres can end an auction while bids are still in flight.

## Caveats
- One run per cell; one laptop; the load generator shares the CPU.
- Failure drill uses a 3-second Redis outage and 3-second flusher outage, not a long outage or a backlog near the 100,000 limit.
- `BID_IMPL=single` and `legacy` remain for comparison. The hot-auction gap (about 3.5x more accepted bids, p95 60 ms vs 9.95 s) is large enough to trust from one run; smaller differences, such as the spread-case accepted counts, would need repeated runs.

## Update after report 6
The 4,000 req/s section above guessed that the single Node process was the next limit. Later runs did not support that: with k6 limited to 600 virtual users the failures disappeared (they came from k6 opening too many connections), and a second API instance behind nginx did not raise throughput because whole-machine CPU was already 88-90%. The limit on this laptop is total CPU, not one Node process. See `docs/loadtest-report-6-nginx-two-instances.md`.
