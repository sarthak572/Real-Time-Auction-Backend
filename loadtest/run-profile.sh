#!/bin/bash
# Profile one API instance under saturating load.
# Usage: ./loadtest/run-profile.sh <label> <outdir> [peak] [extra k6 -e options...]
LABEL=$1; R=$2; PEAK=${3:-3000}; shift 3
mkdir -p "$R"
cd "$(dirname "$0")/.." || exit 1

bash scripts/cluster.sh stop > /dev/null 2>&1
npm run build > /dev/null 2>&1 || { echo "build failed"; exit 1; }
docker exec auction_production-redis-state-1 redis-cli DEL flusher:stats > /dev/null

(NODE_ENV=production node dist/worker.js > "$R/flusher-$LABEL.log" 2>&1 &)
# k6 starts ~8 s after the server and its ramp reaches the peak at ~70 s; profile the steady part (test time ~75-103 s).
(PORT=3001 INSTANCE_ID=api-3001 NODE_ENV=production BID_IMPL=redis \
  PROFILE_START_S=85 PROFILE_SECONDS=28 PROFILE_OUT="$R/$LABEL.cpuprofile" \
  node scripts/profile-server.mjs > "$R/server-$LABEL.log" 2>&1 &)
sleep 8

powershell -NoProfile -File loadtest/cpu-sample.ps1 -DurationSec 125 > "$R/cpu-$LABEL.txt" 2>&1 &
k6 run -e BASE=http://localhost:3001 -e SCENARIO=bids_hot -e PEAK="$PEAK" -e PREVUS=100 -e MAXVUS=600 "$@" loadtest/auction.js > "$R/k6-$LABEL.txt" 2>&1
sleep 3
curl -s localhost:3001/health/stats > "$R/final-stats-$LABEL.json"
bash scripts/cluster.sh stop > /dev/null 2>&1
