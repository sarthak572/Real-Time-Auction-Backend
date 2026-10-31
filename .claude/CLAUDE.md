# Auction Backend: Project Guide for Claude

Real-time auction backend, built in phases as a **learning project**. The user is new to backend engineering.

## How to work with the user
- Build ONE phase at a time. Never scaffold future phases early.
- Explain the "why" of each concept (bottlenecks, trade-offs), not just the code.
- Keep code simple and readable. Add short comments only where a concept is non-obvious.
- Keep the structured logging conventions below in every new feature (a future AI assistant will read the logs).
- When a phase is finished, update the **Current status** section below.
- Ask before starting the next phase.

## Stack
Node 22, TypeScript (ESM, NodeNext), Fastify, PostgreSQL 16 (Docker), pino, zod, `pg` (raw SQL, no ORM).
Added so far: Redis (ioredis), @fastify/websocket (ws).
Planned: Vitest, BullMQ, prom-client, Prometheus, Grafana, k6.
Platform: Windows 11, Docker Desktop. Prefer PowerShell/Bash commands that work on Windows.

## Current status
**Current phase: Phase 4 done; after it the user added nginx, lean logging, observability, idempotency and a faster bid path (all DONE). Next: Phase 5 (ending auctions). Earlier note: (0) nginx + 2 instances (DONE, see end of file), (1) the one-statement bid, then (2) Redis WRITE-BEHIND bidding (BID_IMPL=redis, default): DONE, tested (18 tests), failure-drilled and load tested. Next: Phase 5 (queues; auction ending MUST drain the flusher, see below). Phase 2 still lacks a separate test DB.**
Done so far in Phase 2 (user chose to do load testing first): baseline k6 load test and bottleneck report
(`docs/loadtest-report-1-baseline.md`, scripts in `loadtest/`, raw results in `results/01-baseline-2026-10-26/`, `/health/stats` endpoint for memory, event-loop lag, pool).
Still to do in Phase 2: Vitest unit tests, integration tests (real Postgres, `app.inject()`), bid concurrency test.

| # | Phase | Status |
|---|-------|--------|
| 1 | REST API + Postgres + logging | DONE |
| 2 | Testing foundation | IN PROGRESS (Vitest + 11 bid integration/concurrency tests done; load tests done; separate test DB, more tests TODO) |
| 3 | Caching (Redis) | IN PROGRESS (cache-aside for GET /auctions and /auctions/:id done and load tested) |
| 4 | Real-time (WebSockets + Redis pub/sub) | DONE (17/17 checks, load tested to 5000 sockets) |
| 5 | Queues (BullMQ) | TODO |
| 6 | Protection (rate limit, idempotency, auth) | TODO |
| 7 | Observability (Prometheus + Grafana) | TODO |
| 8 | Load testing (k6) and bottleneck hunting | TODO |
| 9 | Scaling (multi-instance, nginx, replicas, indexes) | TODO |
| 10 | AI log assistant | TODO |

## Phase details

### Phase 1: REST API + Postgres + logging (DONE)
- Endpoints: `POST /users`, `POST /auctions`, `GET /auctions`, `GET /auctions/:id`, `POST /auctions/:id/bids`, `GET /health/live`, `GET /health/ready`.
- Bids use a transaction with `SELECT ... FOR UPDATE` on the auction row, so concurrent bids stay correct. Verified by hand: 20 concurrent bids gave a consistent final price. This row lock is the known "hot row" bottleneck.
- Zod-validated config (fail fast), pg Pool (`DB_POOL_MAX`), `withTx()` helper, simple SQL migration runner, graceful shutdown, request IDs.
- Money is stored as BIGINT minor units. The `pg` driver returns BIGINT as strings.
- Known gaps (intentional, for later phases): no auth (bidderId is passed in the body), no tests, no caching, no metrics, auctions never auto-end.

### Phase 2: Testing foundation (IN PROGRESS)
- Load test baseline result (see `docs/loadtest-report-1-baseline.md`): reads cap ~870 rps, bids ~440 rps (spread) and ~415 rps (one hot auction).
  First failure is DB pool exhaustion (`pool.waiting` ~2990, 5s timeout, HTTP 500s). Hot auction = lock contention (Postgres CPU only ~40%);
  spread bids = Postgres CPU-bound (~140%). Event loop was not the bottleneck. Fixes are not applied yet (cache, pool tuning, fewer round trips, backpressure).
- Run load tests with the server in `NODE_ENV=production` (pretty logging distorts results). Do not kill processes with a pattern that matches your own shell command line.
- Vitest set up. Unit tests for pure logic (extract bid-rule validation into a testable function).
- Integration tests against a real Postgres (separate test DB via docker compose), using Fastify `app.inject()`.
- Concurrency test: N parallel bids on one auction, assert exactly the right winner and no lost updates.
- Test DB reset/cleanup strategy.

### Phase 3: Caching (Redis) (IN PROGRESS)
- Done: `src/cache.ts` (cache-aside `cached()`, request coalescing, fail-open if Redis is down, `invalidate()`), Redis in docker-compose (128mb, allkeys-lru), `/health/stats` shows cache hits/misses/hitRatio. GET /auctions/:id TTL 30s, invalidated after an accepted bid; list TTL 2s.
- Result (docs/loadtest-report-2-redis-reads.md): read p95 2.9s to 284ms, pool waiting 2980 to 0, hit ratio 98.7%.
- Still TODO here: cache hit/miss in a mixed read+bid load test, negative caching for 404s, stale-write race discussion, cache for bid history if added, log-volume reduction.
- Add Redis to docker-compose. Cache-aside for `GET /auctions/:id` and the list.
- Cache invalidation on bid. TTLs. Hot-key and stampede concepts.
- Log cache hit/miss events.

### Phase 4: Real-time (DONE)
- `WS /auctions/:id/live[?lastSeq=N]` (`src/realtime/routes.ts`): preValidation does 404/429/503 on the upgrade request; then snapshot, then optional replay of missed bids from Postgres (max `WS_CATCHUP_MAX`).
- `src/realtime/hub.ts`: local rooms per auction, one Redis subscriber connection (subscribe on first local viewer, unsubscribe on last), `publishBid()` after commit (falls back to local delivery if Redis publish fails), heartbeat ping every `WS_HEARTBEAT_MS`, backpressure drop when `bufferedAmount > WS_MAX_BUFFERED_BYTES`, per-IP and global connection limits, counters in `/health/stats` under `realtime`.
- Migration 002: `auctions.bid_count` and `bids.seq` give a gapless per-auction sequence (assigned under the row lock). Client rule: apply event only if seq > last seq; a jump over +1 means reconnect with lastSeq.
- Bid route order after commit: invalidate cache, then publish to Redis.
- Dev demo page: `GET /demo` (not registered when NODE_ENV=production). Check script: `scripts/ws-check.ts` (needs two instances, see header). Load script: `scripts/ws-load.ts`.
- Result (`docs/loadtest-report-3-websockets.md`): ~8-9 KB per idle socket; 5000 sockets, 100% delivery; one hot auction with 5000 viewers slowed bid POST p50 from ~19 ms to ~130 ms because fan-out blocks the event loop.
- Not done / ideas: coalescing updates for hot auctions, gateway-only instances, auth on sockets (Phase 6), Redis-restart test, slow-client test under load.

### Phase 5: Queues
- BullMQ worker to end auctions at `ends_at`, determine the winner, and send notifications.
- Retries, backoff, dead-letter queue, idempotent jobs.

### Phase 6: Protection
- Rate limiting, idempotency keys on bids, JWT auth (replace `bidderId` in the body), backpressure and timeouts.

### Phase 7: Observability
- `/metrics` via prom-client: HTTP latency histograms, event-loop lag, heap memory, pool waiting count, bid accepted/rejected counters.
- Prometheus and Grafana in docker-compose, with dashboards.

### Phase 8: Load testing
- k6 scripts: many users and auctions, plus one hot auction.
- Find and document bottlenecks (pool exhaustion, lock contention, memory, event loop), then fix them. Record results in `docs/`.

### Phase 9: Scaling
- Run multiple instances behind nginx, DB indexes review, read replicas, connection pooling (pgbouncer).

### Phase 10: AI log assistant
- A tool that reads the JSON logs and evaluates system health and anomalies.

## Logging conventions
- pino, JSON in production and pretty in development. Every line has `service` and `reqId`.
- Business events use a stable `event` name in `domain.action` form, with relevant IDs and `durationMs` where timing matters.
- Existing events: `user.created`, `auction.created`, `bid.accepted`, `bid.rejected` (with `reason`), `validation.failed`, `unhandled.error`, `server.started`, `shutdown.start`, `shutdown.done`, `migration applied`.
- Never log secrets. Log rejections at `warn` and unexpected failures at `error`.

## Commands
```
docker compose up -d      # start infrastructure
npm run migrate           # apply migrations
npm run dev               # dev server on :3000 (tsx watch)
npm run typecheck
```

## Layout
```
src/server.ts    entry, graceful shutdown
src/app.ts       Fastify setup, error handler, health routes
src/config.ts    env validation (zod)
src/logger.ts    pino
src/db.ts        pool and withTx()
src/errors.ts    AppError
src/migrate.ts   migration runner
src/modules/     users.ts, auctions.ts
migrations/      numbered .sql files
```

## Running two instances (real-time check)
```
PORT=3000 npm run dev
PORT=3001 WS_HEARTBEAT_MS=1000 WS_MAX_CONNECTIONS_PER_IP=20 npm run dev
npx tsx scripts/ws-check.ts
```
Load test: `WS_MAX_CONNECTIONS_PER_IP=100000 NODE_ENV=production npx tsx src/server.ts`, then `npx tsx scripts/ws-load.ts 5000 50 50 20`.

## Bid lock optimization (done after Phase 4)
- `src/modules/bids.ts`: `placeBid()` uses ONE SQL statement (CTE UPDATE that takes the row lock and checks all rules, INSERT only if the UPDATE changed a row, rejection reason found by a second query). `BID_IMPL=legacy` keeps the old 5-round-trip transaction for A/B tests only and can be deleted later.
- Tests: `npm test` runs `tests/bids.test.ts` (Vitest, real Postgres + Redis, 11 tests incl. 3 concurrency tests). Mutation-checked: removing FOR UPDATE from legacy makes them fail.
- Result (`docs/loadtest-report-4-bid-lock.md`, `results/04-bid-lock-ab/`): hot auction at 300 rps failures 12.5% to 0%, p95 5.1s to 1.5s; at 1000 rps accepted bids +58% (hot) and +81% (spread). Still overloaded at 1000 rps: no lock/statement timeout, pool still fills.
- Open ideas: `lock_timeout` + fast 503 (Phase 6), pool size experiment, per-auction bid queue only if still needed.
- Windows note: large bash heredocs get truncated; write files with the Write tool.

## Write-behind bidding (BID_IMPL=redis, the default) - decided by the user, implemented after Phase 4
- Flow: `POST /bids` runs a Lua script on the STATE Redis (`redis-state`, port 6380, AOF everysec, noeviction): atomic rule check, `seq+1`, price update, XADD to `bids:stream`; replies 201 without touching Postgres. `src/flusher.ts` (run with `npm run flusher`, own process, also `FLUSHER_IN_PROCESS=true` for dev) writes batches every 200 ms with ONE idempotent SQL statement (INSERT ... ON CONFLICT DO NOTHING + UPDATE auctions only when bid_count < seq), then XACK+XDEL. Entries read by a dead flusher are reclaimed (XAUTOCLAIM).
- Files: `src/state.ts` (scripts, loader, stats), `src/flusher.ts`, `src/worker.ts`, `src/modules/bids.ts`, `src/modules/auction-queries.ts` (reads overlay live price/bidder/seq/status from Redis), `tests/write-behind.test.ts`, `scripts/wb-drill.ts`, `loadtest/run-wb.sh`.
- Rules to keep: never fall back to writing Postgres while Redis is the authority (bids get 503). Reads fail open to the (possibly ~200 ms old) Postgres row. The bid response has `id: null` (Postgres assigns ids at flush); WS events have no `bidId` until saved. Postgres lags Redis by ~one flush: WS history replay and the 2 s list cache can be slightly behind.
- Phase 5 MUST: drain pending bids of an auction before closing it, and set `status` to 'ended' in the Redis state hash (the Lua script rejects bids only via status/ends). Otherwise Postgres can close an auction while bids are in flight.
- Known risks (see docs/loadtest-report-5-write-behind.md): power loss can lose ~1 s of acknowledged bids (not simulated); if Redis loses writes Postgres kept, seqs can collide: the flusher counts them in `conflictTotal` and logs `flush.conflict`, it does not repair. Monitor `/health/stats` -> `writeBehind` (flusherAlive, streamLength, lastLagMs, conflictTotal).
- Results: hot auction at 1000 rps 0% failures, p95 60 ms (vs 9.95 s with BID_IMPL=single), Postgres CPU 16%. At 4000 rps k6 hit OS connection errors on the shared laptop and the Node process looked like the next limit (event-loop lag ~600 ms; not profiled).
- Run everything: `docker compose up -d`, `npm run migrate`, `npm run dev` and `npm run flusher` (two terminals). Tests: `BID_IMPL=redis npm test` (default), `BID_IMPL=single npm test`, `BID_IMPL=legacy npm test`. Failure drill: `npx tsx scripts/wb-drill.ts results/05-write-behind`.

## nginx + two API instances (done after write-behind)
- `npm run cluster:start` (= `scripts/cluster.sh start`): builds, then runs the flusher, `api-3001`, `api-3002` (compiled `node dist/...`, `TRUST_PROXY=true`) and the nginx container which listens on **http://localhost:3000** and balances with `least_conn`. `INSTANCES="3001"` starts just one. Do not run another server on 3000. Check: `npx tsx scripts/cluster-check.ts` (passed twice, includes killing an instance mid-traffic: 146 bids, 0 failures).
- Config files: `nginx/nginx.conf`, `docker-compose.yml` (nginx service, `apihost` alias must be IPv4: `API_HOST_IP`, default 192.168.65.254), `app.ts` (`trustProxy`, `keepAliveTimeout: 65000` must stay above nginx's 60 s upstream keepalive, `x-instance` header).
- Lessons: host.docker.internal/host-gateway add an IPv6 address that caused 502s; nginx request id becomes the API `reqId`; the per-IP WS limit is per instance and, locally, all clients look like one Docker gateway IP.
- Result (`docs/loadtest-report-6-nginx-two-instances.md`): balancing/failover/fan-out work, but 2 instances did NOT raise req/s on this laptop (about 2,000 req/s either way) because whole-machine CPU was 88-90% (4 cores/8 threads shared with k6, Docker VM, Postgres, Redis). A second instance only helps with spare CPU.
- Machine facts: 7.8 GB RAM (often <1 GB free), 4 cores. For load tests use `MAXVUS=600`, close browsers, prefer compiled run (`cluster.sh`) over `tsx`.

## Lean logging (done after the nginx work)
- Production default (`NODE_ENV=production`): no automatic request lines; `request.error` (5xx) and `request.slow` (>`LOG_SLOW_MS`, 500) only; `bid.accepted` and routine rejections (`BID_TOO_LOW`, `AUCTION_CLOSED`) sampled at `LOG_SAMPLE_RATE` (0.01) with a `sampleRate` field; other rejections and all errors always logged; buffered writes (`LOG_ASYNC`), flushed on clean shutdown via `flushLogs()`; Redis-outage error throttled to 1/s with `suppressed`. Development logs everything. Override with `LOG_REQUESTS=true LOG_SAMPLE_RATE=1 LOG_ASYNC=false` to get the old verbose behaviour.
- When analysing logs (including the future AI assistant): multiply counts of events that have `sampleRate` by `1/sampleRate`; do not treat missing routine lines as missing traffic. Use `/health/stats` and the flusher counters for exact totals.
- Result (`docs/loadtest-report-7-logging.md`): ~250x less log volume (176 MB to 0.7 MB per 2-minute run), median latency 84-140 ms down to 35-50 ms, throughput about +6% (within run-to-run noise); sampled counts matched the true counts within 3%. Logging was not the main CPU cost.
- Known limit: a hard kill can lose up to ~1 s of buffered log lines.

## Observability, idempotency and throughput (done after lean logging; user asked for all three "for learning")
- **Observability** (`docs/report-8-observability.md`): prom-client in `src/metrics.ts` + `src/metrics-collectors.ts`; API `GET /metrics` per instance (nginx returns 404 for it), flusher serves `/metrics` on :9101. Prometheus + Grafana are an OPTIONAL compose profile (`npm run obs:up` / `obs:down`; Grafana http://localhost:3030, Prometheus :9090, bound to localhost). Dashboard JSON is generated: edit `scripts/gen-dashboard.mjs`, run `node scripts/gen-dashboard.mjs`. Dashboard was never seen rendered (browser extension not connected); its 28 queries were verified through the Prometheus API. Keep metric label values low-cardinality (route PATTERN, never raw URL).
- **Idempotency** (`docs/report-9-idempotency-and-throughput.md`): optional `Idempotency-Key` header on `POST /auctions/:id/bids`, honoured only by `BID_IMPL=redis`; the check lives INSIDE the atomic Lua script in `src/state.ts` (key `idem:<bidderId>:<key>`, fingerprint auction:amount, TTL `IDEMPOTENCY_TTL_SECONDS`=600). Replays return the original answer + `Idempotent-Replayed: true`; same key with different request = 422. ~150 bytes per key in the NEVER-EVICTING state Redis (512 MB): guard `IDEMPOTENCY_MEMORY_LIMIT` (0.8) answers 503 `IDEMPOTENCY_STORE_FULL` to keyed requests when it is nearly full. Watch `state_redis_memory_bytes`.
- **Throughput**: live bid events are now published INSIDE the bid Lua script (`PUBLISH_IN_SCRIPT`, on the state Redis; the hub subscribes to `config.PUBSUB_URL`), bids from one event-loop turn are pipelined (`BID_BATCH`), `AppError` captures no stack trace. Both switches default on; turn off to compare. Result: at 6,000 req/s offered ~34% more throughput (2,564 to 3,445 req/s), at 3,000 req/s median 5.6-7.5 ms to 1.6 ms; CPU profile busy 91% to 66%. Profile tools: `scripts/profile-server.mjs`, `scripts/analyze-profile.mjs`, `scripts/who-calls.mjs`, runner `loadtest/run-profile.sh`; A/B runner `loadtest/run-cluster.sh` + `loadtest/summarize.sh` (env `K6_EXTRA="-e IDEM=1 -e DUP=0.1"`).
- **Tests**: 29 on the Redis path (`BID_IMPL=redis npm test`), 11 on `single`/`legacy`.
- **Lessons**: a health check proves something answers, not which build (a stray `profile-server.mjs` once served old code; `cluster.sh stop` now kills it). Results from a run during a machine freeze are discarded (`results/09-throughput/discarded/`). Regexes written through a shell or template literal lose backslashes (`\d`): test them against real output. Compare configurations interleaved and repeated; one run is not evidence on this laptop (about +-7% noise, more at saturation).
- Machine: 7.8 GB RAM often <1 GB free; Docker Desktop once stopped all containers under pressure.
- Race check: `scripts/race-check.ts` fires bids from BOTH instances at the same auction at once (identical amounts: exactly one wins; different amounts: gapless seq, strictly rising, final price = highest). Passed 3 rounds (`results/10-race-check.txt`). Needs `scripts/cluster.sh start`.
