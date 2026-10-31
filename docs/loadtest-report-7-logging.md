# Report 7: lean logging

Raw output: `results/07-logging-ab/`. Code: `src/logger.ts`, `src/config.ts` (LOG_* settings), `src/app.ts`, `src/modules/auctions.ts`, `src/state.ts`.
Test: one API instance run directly (no nginx), hot-auction bids, 4,000 req/s peak, 600 virtual users, same laptop as before.
Four runs in the order verbose, lean, lean, verbose (so slow drift in the machine cannot favour one side).

## What changed
Before (now selectable as `LOG_REQUESTS=true LOG_SAMPLE_RATE=1 LOG_ASYNC=false`): Fastify wrote `incoming request` and `request completed` for every request, plus a `bid.accepted`/`bid.rejected` line for every bid, each written synchronously.

After, the production default:
- No automatic request lines. Instead one line (`request.error` / `request.slow`) only for responses with status 5xx or slower than `LOG_SLOW_MS` (500 ms).
- `bid.accepted` and the routine rejections (`BID_TOO_LOW`, `AUCTION_CLOSED`) are logged for 1% of occurrences (`LOG_SAMPLE_RATE`), and carry `sampleRate` so a reader multiplies counts back up. Every other rejection (self-bid, not found, 503, ...) is always logged. Business events with low volume are unchanged.
- Log writes are buffered (`pino.destination` with `sync: false`, flushed at 4 KB or once a second, and on clean shutdown).
- The Redis-outage error now logs at most once per second with a `suppressed` count; before, every refused bid wrote a line.
- Development keeps everything and stays synchronous and pretty.

## Results (single instance, 4,000 req/s peak)

| Run | Served req/s | Median | p95 | Log lines | Log size | CPU avg: total / k6 / Node (of 8 logical) |
|---|---|---|---|---|---|---|
| verbose-1 | 2,259 | 84 ms | 199 ms | 750,729 | 176 MB | 82% / 15% / 13% |
| **lean-1** | **2,336** | **35 ms** | **175 ms** | **2,839** | **0.7 MB** | 79% / 16% / 12% |
| **lean-2** | **2,184** | **50 ms** | **224 ms** | **2,628** | **0.7 MB** | 77% / 14% / 11% |
| verbose-2 | 1,991 | 140 ms | 269 ms | 662,277 | 156 MB | 71% / 15% / 13% |

- **Log volume: about 250 times smaller** (roughly 160-180 MB down to 0.7 MB per 2-minute run), all four runs consistent.
- **Latency:** median fell from 84-140 ms to 35-50 ms in both pairs; p95 improved in both pairs (199 to 175 ms, 269 to 224 ms).
- **Throughput:** +3% in the first pair, +10% in the second, about +6% on average (2,125 to 2,260 req/s). The spread across all four runs (1,991 to 2,336) is as large as the effect, so treat the throughput gain as probably real but small, and not proven by four runs.
- **Node CPU** barely moved (about 13% down to about 11-12% of the machine, roughly one logical processor either way): logging was a modest share of the work, not the main cost. The latency improvement is larger than the CPU saving, which fits the synchronous writes having been blocking the event loop.
- All requests succeeded in every run (0% failed).

## Do sampled logs still tell the truth?
Bid counts reconstructed from the sampled log (`bid.accepted` lines divided by 0.01) against the flusher's exact count of accepted bids: lean-1 216,700 vs 210,744 (2.8% high), lean-2 197,400 vs 197,378 (0.0%). Sampling at 1% over about 200,000 events is accurate to a few percent. It would not be accurate for rare events, which is why only the two high-volume ones are sampled.

## Not verified
- `request.slow` fires (checked with `LOG_SLOW_MS=0`) but no request crossed 500 ms server-side in these runs, so it was not exercised under load.
- With buffered writes a hard kill can lose up to about one second of log lines. The failure drill (SIGKILL) was not repeated with lean logging, so I have not seen what the last second of a crash looks like.
- nginx logs were already reduced earlier (only unexpected statuses).
- Single machine, four runs, CPU shared with the load generator.

## Practical effect for this laptop
Logging was not the main limit (CPU stayed at 70-80% and Node used about one logical processor), but lean logging gives lower latency, about 250x less disk, and logs that stay readable for the future AI log assistant: errors and slow requests stand out instead of being buried in 750,000 routine lines.
