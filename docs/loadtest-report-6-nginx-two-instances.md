# Report 6: nginx in front of two API instances

Raw output: `results/06-nginx-two-instances/`, `results/06-nginx-cluster-check*.txt`.
Setup: nginx (container, published on :3000) -> `api-3001` and `api-3002` (compiled `node dist/server.js`, `TRUST_PROXY=true`) -> shared Postgres, cache Redis,
state Redis, and ONE flusher. Start with `scripts/cluster.sh start`. Everything, including k6, runs on one laptop (i5-1155G7: 4 physical cores, 8 threads, 7.8 GB RAM).

## What was added
- `nginx/nginx.conf`: `least_conn` balancing, WebSocket upgrade, keep-alive to the instances, `X-Forwarded-For` (overwritten, not appended) and `X-Request-Id` (the API logs it as `reqId`), `proxy_next_upstream error timeout` (a bid is retried on the other instance only if the connection to the first one failed before the request was sent), 16 KB body limit, logs only unexpected statuses (not 2xx/3xx/409).
- API: `TRUST_PROXY` (so `req.ip` is the real client), `INSTANCE_ID` (`x-instance` response header and `/health/stats`), `keepAliveTimeout` 65 s (must exceed nginx's 60 s, otherwise nginx reuses a connection Node just closed and a POST fails with 502).
- `scripts/cluster.sh` (start/stop/status/start-api), `scripts/cluster-check.ts`, `loadtest/run-cluster.sh`, `loadtest/cpu-sample.ps1`; k6 script now takes `MAXVUS`/`PREVUS` and does not keep response bodies.

## Two configuration bugs found on the way
1. **IPv6 in the upstream address.** `host.docker.internal` and Docker's `host-gateway` both add an IPv6 address the container cannot route to. nginx tried it first, got "Network unreachable", counted failures against healthy instances and answered 502 for a while. Fixed by pinning an IPv4-only alias (`apihost:192.168.65.254`, override with `API_HOST_IP`).
2. **Node keep-alive (5 s) shorter than nginx's (60 s).** Fixed as above. I did not observe this failure in testing; it is the known race, closed in advance.

## Correctness checks (`scripts/cluster-check.ts`, passed in 2 consecutive runs)
- Plain requests, WebSockets and bids are all spread over both instances (e.g. 30 sockets: 15/15; 40 bids: 30/10).
- 30 viewers connected to different instances all received bids 1..40 in order, whichever instance handled each bid (Redis pub/sub does this).
- The nginx request id arrives in the API (32 hex characters).
- **Failover:** one instance was killed (SIGKILL on its port) while bids were being sent through nginx: 146 bids, every one answered 201, none failed. Viewers on the dead instance were disconnected (14), reconnected through nginx, and received the correct snapshot.
- The restarted instance receives traffic again.

## Throughput: did a second instance help? No, not on this machine
Hot-auction bids, 4,000 req/s peak, 600 virtual users, same k6 script.

| | 1 instance direct (:3001) | 2 instances via nginx (run A) | 2 instances via nginx (run B, with CPU sampling) |
|---|---|---|---|
| Average served | 1,988 req/s | 2,001 req/s | 2,127 req/s |
| Failed requests | 0% | 0% | 0% |
| k6 median / p95 | 147 ms / 266 ms | 134 ms / 264 ms | 120 ms / 235 ms |
| Dropped by k6 (offered but not sent) | 50,551 | 48,401 | 34,319 |
| Event-loop lag p99 (max per instance) | 107 ms | 117 / 142 ms | not recorded |
| Peak RSS per instance | 334 MB | 140 / 143 MB | not recorded |
| Requests per instance | n/a | 113k / 109k (even) | n/a |

The differences between the three columns are within what I would expect from run-to-run noise (about 7%); I ran each once or twice.

**Why (measured in run B):** whole-machine CPU was **88-90% for the whole run**. By process group, as a share of all 8 logical processors: k6 ~17%, the two Node API processes together ~19%, Docker Desktop's Windows-side processes ~14% (this is the network path from Windows into the VM). That is ~50%. The remaining ~40% is not attributed to any process I can see; the most likely holder is the Docker VM (Postgres, both Redis servers, nginx), whose CPU Windows does not report per process. That attribution is inferred, not measured. The conclusion that matters holds either way: the machine is out of CPU, so a second Node process has nothing to run on.

Interesting details:
- The earlier "15.5% failures at 4,000 req/s" (report 5) came from k6 holding 3,000 virtual users and opening too many connections. With 600 users the same load shows 0% failures, so those were client-side, as suspected there.
- In report 5, 1,825 req/s average was the single-instance figure with 3,000 users; with 600 users it is 1,988 req/s.
- Memory: each compiled API process uses about 60-70 MB idle and 140 MB under two-instance load; nginx 32 MB. The whole cluster (2 APIs + flusher + nginx) costs roughly 400 MB, far less than the `tsx` setup.

## What this means
- The balancing, failover, WebSocket fan-out across instances and request tracing all work and are worth having.
- Two instances do NOT raise throughput here because CPU is the shared bottleneck. They would on a machine with spare cores, or with the database and load generator on other machines. That is not shown by this test.
- To raise req/s on THIS laptop: free CPU for the server (load generator on another machine, fewer background apps), reduce per-request work (logging), or accept ~2,000 req/s as this machine's ceiling.

## Not tested / limits
- No CPU sample for the one-instance run (the sampler was added afterwards).
- The unattributed ~40% CPU is inferred to be the Docker VM; I did not confirm it.
- The per-IP WebSocket limit is per instance (in memory), so a client can hold up to twice the limit across two instances. Behind nginx on Docker Desktop all local clients share one address (the Docker gateway), so tests need `WS_MAX_CONNECTIONS_PER_IP` raised.
- nginx itself is a single point of failure here.
- Rolling deploys (drain one instance at a time) were not tried.
