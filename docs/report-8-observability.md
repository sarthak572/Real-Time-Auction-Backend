# Report 8: observability (Prometheus + Grafana)

Code: `src/metrics.ts`, `src/metrics-collectors.ts`, `src/flusher.ts`, `src/worker.ts`, `prometheus/prometheus.yml`, `grafana/`, `scripts/gen-dashboard.mjs`.

## Run it
```
npm run cluster:start                                  # API instances + flusher + nginx
docker compose --profile observability up -d           # Prometheus + Grafana (optional; stop them with `docker compose stop prometheus grafana`)
```
- Grafana: http://localhost:3030 (opens on the "Auction backend" dashboard, no login; reachable from this computer only)
- Prometheus: http://localhost:9090 (try the Status > Targets page)
- Raw metrics: http://localhost:3001/metrics, http://localhost:3002/metrics, http://localhost:9101/metrics (the flusher). nginx deliberately answers 404 for `/metrics`.

## What is measured
| Area | Metrics | Question it answers |
|---|---|---|
| Requests | `http_request_duration_seconds` (histogram by method, route pattern, status) | How many requests, how fast (p50/p95/p99), how many errors? |
| Bids | `auction_bids_total{result}`, `auction_bid_decision_seconds` | Accepted, too low, closed, replayed (idempotent retry), unavailable? How long does the Redis decision take? |
| Node process | `process_cpu_seconds_total`, `process_resident_memory_bytes`, `nodejs_heap_*`, `nodejs_eventloop_lag_*`, GC | Is the single JavaScript thread the limit? Is memory growing? |
| Postgres pool | `pg_pool_connections{state}` | Are requests queued for a database connection? |
| Cache | `cache_hits_total`, `cache_misses_total`, `cache_errors_total`, `cache_coalesced_total` | Hit ratio, stampede protection working? |
| WebSockets | `ws_active_sockets`, `ws_messages_sent_total`, `ws_dropped_slow_clients_total`, `ws_buffered_bytes`, `pubsub_*` | Viewers, fan-out volume, slow clients |
| Write-behind | `writebehind_stream_length` (from the API), `flusher_lag_seconds`, `flusher_bids_total`, `flusher_batch_size`, `flusher_flush_duration_seconds`, `flusher_failures_total`, `flusher_conflicts_total`, `flusher_last_flush_timestamp_seconds` | Is Postgres keeping up? Is the flusher alive? Did any bid collide? |
| State Redis memory | `state_redis_memory_bytes{kind=used|max}` | How close is the never-evicting Redis to refusing writes? |

Design choices worth knowing: route labels use the pattern (`/auctions/:id/bids`), never the raw URL, so the number of time series stays small; the backlog is reported by the API and not only by the flusher, so it is still visible when the flusher is dead; the flusher runs its own small HTTP port because it has no web server.

## Verified
- Prometheus scrapes both API instances and the flusher (targets `up`); the optional `api-dev` target (port 3010) is down unless you run a dev instance.
- All 28 queries on the 20 dashboard panels returned data under load, none returned an error.
- Cost: Grafana ~70 MB and Prometheus ~25-45 MB of memory (limits 320 MB / 256 MB), retention 6 hours / 300 MB.

## Not verified / limits
- **I have not seen the dashboard rendered.** The browser extension was not connected, so panel layout, colours and legends are unchecked. The queries behind them were run through the Prometheus API.
- No alerting rules, and no Postgres or Redis exporters (Postgres CPU and Redis memory beyond the one gauge are not on the dashboard).
- Grafana runs with anonymous admin access, bound to localhost only. Do not expose port 3030.
- During setup Docker Desktop stopped all containers once (exit 255) under memory pressure; they came back with their data after a restart. With ~0.7-1 GB free on this laptop, keep an eye on memory when the observability profile is running.
- Adding instrumentation costs CPU: prom-client was about 2% of one instance's busy time in the CPU profile.
