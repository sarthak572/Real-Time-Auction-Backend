#!/bin/bash
# Run the whole stack behind nginx with compiled code (less memory than tsx):
#   nginx :3000  ->  api-3001, api-3002   (+ one flusher)   ->  Postgres, Redis (cache), Redis (state)
# Usage: scripts/cluster.sh start | stop | status | start-api <port>
cd "$(dirname "$0")/.." || exit 1
LOGDIR=${LOGDIR:-.cluster}
mkdir -p "$LOGDIR"

start_api() { # $1 = port
  (INSTANCE_ID=api-$1 PORT=$1 TRUST_PROXY=true NODE_ENV=production BID_IMPL=${BID_IMPL:-redis} \
    node dist/server.js >> "$LOGDIR/api-$1.log" 2>&1 &)
}

wait_health() { # $1 = url
  for i in $(seq 1 40); do
    curl -s -m 2 -o /dev/null -w "%{http_code}" "$1" 2>/dev/null | grep -q 200 && return 0
    sleep 0.5
  done
  return 1
}

stop_all() {
  # Also stops the profiling wrapper (scripts/profile-server.mjs): a stray one keeps answering on its port with OLD code,
  # and the health check of a freshly started instance passes anyway because the old process answers it.
  powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match 'dist[\\\\/](server|worker)\.js|profile-server\.mjs' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }"
}

case "$1" in
  start)
    stop_all
    docker compose up -d postgres redis redis-state nginx > /dev/null 2>&1
    npm run build > /dev/null 2>&1 || { echo "build failed"; exit 1; }
    (NODE_ENV=production BID_IMPL=${BID_IMPL:-redis} node dist/worker.js >> "$LOGDIR/flusher.log" 2>&1 &)
    for p in ${INSTANCES:-3001 3002}; do start_api $p; done   # INSTANCES="3001" runs just one (for comparisons)
    for p in ${INSTANCES:-3001 3002}; do wait_health http://localhost:$p/health/live && echo "api-$p up"; done
    [ -z "$INSTANCES" ] && wait_health http://localhost:3000/health/live && echo "nginx :3000 up (balancing both instances)"
    ;;
  start-api)
    start_api "$2"
    wait_health "http://localhost:$2/health/live" && echo "api-$2 up"
    ;;
  stop)
    stop_all
    echo "stopped API instances and flusher (containers left running; docker compose stop nginx to stop the proxy)"
    ;;
  status)
    for p in 3001 3002 3000; do
      printf "port %s: " "$p"; curl -s -m 2 "http://localhost:$p/health/live" || echo "down"; echo
    done
    powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match 'dist[\\\\/](server|worker)\.js' } | ForEach-Object { '{0} {1} MB' -f (\$_.CommandLine -replace '.*(dist[\\\\/][a-z]+\.js).*','\$1'), [int](\$_.WorkingSetSize/1MB) }"
    ;;
  *)
    echo "usage: $0 start | stop | status | start-api <port>"; exit 1 ;;
esac
