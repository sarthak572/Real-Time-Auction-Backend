# Load test report 3: WebSockets + Redis pub/sub (Phase 4)

Raw output: `results/03-websockets/`. Script: `scripts/ws-load.ts`. Correctness checks: `scripts/ws-check.ts` (17/17 passed).
Same machine as before: Node server, Postgres, Redis and the load client (up to 5,000 sockets) all on one laptop,
so the client's own CPU is part of every latency number. Treat latencies as upper bounds.

## Correctness (two server instances, A:3000 and B:3001)
- A bid placed on instance A was delivered to viewers connected to instance B through Redis pub/sub.
- Events arrive in `seq` order 1..N; reconnect with `?lastSeq=2` replays exactly the missed bids.
- Dead client (never answers pings) is terminated by the heartbeat; healthy clients survive.
- Oversized client message closes the socket (1009); malformed JSON gets an error message, socket stays open.
- Unknown auction gets HTTP 404 on the upgrade request; 21st connection from one IP (limit 20) gets HTTP 429.
- Closed sockets are removed from the server (activeSockets back to 0).

## Load results (5,000 open sockets)

| | A. spread: 50 auctions, ~100 viewers each | B. hot: 1 auction, 5,000 viewers |
|---|---|---|
| Bids accepted (20 s) | 889 | 95 |
| Deliveries | 88,900 of 88,900 (100%) | 475,000 of 475,000 (100%) |
| Delivery rate | ~4,400/s | ~23,700/s |
| Delivery latency p50 / p95 / p99 | 19 / 29 / 434 ms | 181 / 311 / 547 ms |
| Bid POST p50 / p95 | 18.5 / 28.5 ms | 130 / 340 ms |
| Event-loop lag p99 (server) | 33 ms | 208 ms |
| Server RSS / heap at end | 166 / 52 MB | 198 / 100 MB |
| Slow clients dropped, errors | 0, 0 | 0, 0 |

## What this shows
1. **Memory per idle socket is about 8-9 KB** (RSS delta from 2,500 to 5,000 sockets: ~21 MB; first step is noisy because
   RSS also reflects warm-up). 10,000 sockets is roughly 90 MB, so memory is not the first limit at this scale. Per-socket
   buffers get bigger only when clients are slow (see `bufferedAmount` check in the hub).
2. **Fan-out is the new hot spot.** One bid on an auction with 5,000 viewers means 5,000 socket writes on the one Node thread.
   In scenario B the same server also handles the bid POST, and its latency rose from ~19 ms to ~130 ms p50, and the
   event loop lagged ~200 ms. The bid endpoint got slower *because* of the broadcast. That is why only 95 bids were accepted
   (the script keeps one bid in flight per auction) versus ~890 in scenario A.
3. **Spread viewers are cheap, concentrated viewers are expensive**, even though the total deliveries per second are in the same range.
4. No messages were lost in either scenario (100% delivery) and no client was dropped for being slow.

## Caveats
- Single machine, client shares CPU; p99 and max values (400-700 ms) probably include client-side pauses.
- Fan-out copies one JSON string per socket, so per-bid cost is O(viewers). I did not profile where the time goes (JSON framing vs syscalls).
- Not tested: slow-client dropping under load (only reasoned and implemented), Redis restart with live sockets,
  more than 5,000 sockets, running fan-out on a separate instance from the one taking bids.
- Delivery rate is limited to what the single client process could parse; the server may be able to do more.

## Fixes to consider later
- Coalesce updates for hot auctions (send at most N per second per auction, always the latest price). `seq` makes gaps visible.
- Run dedicated "gateway" instances that only hold sockets, so fan-out cannot slow down bid handling (scales with Phase 9).
- Batch writes per tick, or move to `uWebSockets.js` if raw fan-out becomes the limit.
