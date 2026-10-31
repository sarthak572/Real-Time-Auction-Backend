# Load test results

One folder per run, named `NN-description-date`. Never overwrite old runs; compare new runs against them.

Each folder holds:
- `k6-<scenario>.txt`: k6 summary (latency percentiles, failures, dropped iterations)
- `monitor-<scenario>.txt`: server and Postgres samples every ~3-5s (memory, event-loop lag, pool, pg CPU)
- `server-<scenario>.log.gz`: full JSON server logs (gzipped; read with `gzip -dc file | grep ...`)

## Runs
| Folder | What | Report |
|---|---|---|
| `01-baseline-2026-10-26` | Phase 1 code, no fixes, pool=10 | `docs/loadtest-report-1-baseline.md` |
| `02-redis-reads-2026-10-26` | Phase 3: Redis cache on auction reads, reads scenario only | `docs/loadtest-report-2-redis-reads.md` |
| `03-websockets` | Phase 4: WebSocket fan-out, 5000 sockets (spread vs one hot auction), logs of the two-instance check | `docs/loadtest-report-3-websockets.md` |
| `04-bid-lock-ab` | Bid lock A/B: legacy 5-round-trip transaction vs one SQL statement (hot auction at 300 and 1000 rps, spread at 1000 rps) | `docs/loadtest-report-4-bid-lock.md` |
| `05-write-behind` | Redis write-behind bids: 1000 rps hot and spread, 4000 rps ceiling hunt, kill-the-flusher/kill-Redis failure drill | `docs/loadtest-report-5-write-behind.md` |
| `06-nginx-two-instances` | nginx + 2 API instances: 1 vs 2 instances at 4000 rps with CPU sampling; cluster-check output is in results/06-nginx-cluster-check*.txt | `docs/loadtest-report-6-nginx-two-instances.md` |
| `07-logging-ab` | Verbose vs lean logging, interleaved 2x each, one instance at 4000 rps | `docs/loadtest-report-7-logging.md` |
| `08-observability` | Warm-up run used to verify the dashboard queries | `docs/report-8-observability.md` |
| `09-throughput` | Bid path: publish-in-script and batching switches (3000 and 6000 rps), idempotency cost, CPU profiles before/after; `discarded/` holds a run ruined by a machine freeze | `docs/report-9-idempotency-and-throughput.md` |
| `10-race-check.txt` | Simultaneous bids from both instances on one auction (`scripts/race-check.ts`): 3 rounds, all checks passed | `docs/report-9-idempotency-and-throughput.md` (mechanism) |
