# Auction Lab Console

A web page with buttons that create traffic and failures against the auction backend, so you can watch the effect on the Grafana dashboard.

```
Browser (React page) ──► control server :4000 ──► auction API (via nginx :3000)    load + test data
                                  │──► docker compose pause/unpause (postgres, redis-state only)
                                  └──► Prometheus :9090  (a few live numbers shown on the page)
Grafana :3030 (dashboard "Auction backend") ◄── you watch this in a second tab
```

The browser cannot generate heavy load or pause containers, so a small Node server does that. It lives in this folder and
does not modify the auction backend's code.

## Run it

1. Stop anything else on ports 3000 / 9090 (for example the other Prometheus lab stack).
2. In the project root (one level up):
   ```
   npm run cluster:start      # flusher + two API instances + nginx on :3000
   npm run obs:up             # Prometheus :9090 + Grafana :3030
   ```
3. In this folder:
   ```
   npm install
   npm run build
   npm start                  # http://localhost:4000
   ```
4. Open http://localhost:4000 and the Grafana dashboard side by side. Run **Steady traffic** first to see "normal".

Development: `npm run dev:server` and `npm run dev:ui` (page on :5173).

## Scenarios
| Button | What it does |
|---|---|
| Steady traffic | 80% bids / 20% reads over 20 auctions, flat rate. Your baseline. |
| Hot auction | All bids to one auction. |
| Traffic spike | 50 req/s, a 15 s jump to the peak, back down. |
| Ramp to saturation | Rate climbs until something gives. Heavy. |
| Read-heavy (cache) | Reads only; shows the cache protecting Postgres. |
| Retry storm | Bids with `Idempotency-Key`, 30% exact repeats. |
| Live viewers | WebSocket viewers on one auction while bids arrive. |
| Postgres outage | Freezes the Postgres container for 20 s (`docker compose pause`). |
| State Redis outage | Freezes the state Redis for 10 s. |

Each run creates its own users and auctions (names start with `lab-`, open for one hour). They stay in the development database.

## Safety
- Listens on 127.0.0.1 only; refuses a non-localhost `Host` header and cross-origin POSTs.
- Targets localhost only (`LAB_ALLOW_REMOTE=1` to override; only use on systems you own).
- Hard caps: 2,000 req/s, 300 s, 800 requests in flight. One run at a time.
- Failure drills need confirmation, can only touch `postgres` and `redis-state`, and **always unpause when the run ends, is stopped, or the server exits**. The **Recover now** button / `POST /api/recover` unpauses by hand. If everything seems stuck: `docker compose unpause postgres redis-state`.
- Your notes record a laptop freeze at 6,000 req/s offered and 7.8 GB RAM. Close other programs before "Ramp to saturation".

## Settings (environment variables)
`LAB_TARGET` (default http://localhost:3000), `LAB_PROMETHEUS` (:9090), `LAB_GRAFANA` (:3030), `LAB_DASHBOARD_UID` (auction), `PORT` (4000), `LAB_COMPOSE_FILE`.

## Tests
`npm run build && npm run test:smoke` runs the control server against a FAKE API, fake Prometheus and a stub in place of docker
(30 checks: caps, stop, idempotent replays, WebSocket limits, drills freeze and always unfreeze, origin/host checks).
It proves the tool's logic, not how the real backend behaves.

## Known limits
- Client-side latency here is bucketed and measured from the same machine as the server under test; Grafana shows the server's view.
- A frozen (paused) process may make requests hang instead of fail fast, so a drill can show up as latency and in-flight requests rather than 5xx.
- The "Live viewers" scenario is bounded by the per-address WebSocket limit (default 50 per instance).
- Not yet run against the real stack (see the notes in the main project).
