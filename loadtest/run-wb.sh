#!/bin/bash
# One write-behind load run: API + separate flusher process + monitor + k6, then wait for the flusher to catch up.
# Usage: ./loadtest/run-wb.sh <scenario> <peak> <outdir> [tag]
SCENARIO=$1; PEAK=$2; R=$3; TAG=${4:-$1-$2rps}
mkdir -p "$R"

kill_api() {
  powershell -NoProfile -c "Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | % { Stop-Process -Id \$_.OwningProcess -Force }"
  sleep 2
}
kill_api

# node --import tsx = one process per service, so the PID we hold is the real process
(BID_IMPL=redis NODE_ENV=production node --import tsx src/worker.ts > "$R/flusher-$TAG.log" 2>&1) &
FPID=$!
(BID_IMPL=redis NODE_ENV=production node --import tsx src/server.ts > "$R/server-$TAG.log" 2>&1) &
sleep 8

# clean counters so this run's numbers are its own
docker exec auction_production-redis-state-1 redis-cli DEL flusher:stats > /dev/null

./loadtest/monitor.sh > "$R/monitor-$TAG.txt" 2>&1 &
MON=$!
k6 run -e SCENARIO=$SCENARIO -e PEAK=$PEAK loadtest/auction.js > "$R/k6-$TAG.txt" 2>&1
kill $MON 2>/dev/null

# how long until Postgres has everything?
START=$(date +%s)
for i in $(seq 1 120); do
  LEN=$(curl -s localhost:3000/health/stats | node -pe 'try{JSON.parse(require("fs").readFileSync(0)).writeBehind.streamLength}catch(e){-1}')
  [ "$LEN" = "0" ] && break
  sleep 1
done
echo "drain_seconds_after_k6=$(( $(date +%s) - START )) final_stream_length=$LEN" > "$R/drain-$TAG.txt"
curl -s localhost:3000/health/stats > "$R/final-stats-$TAG.json"

kill $FPID 2>/dev/null
kill_api
