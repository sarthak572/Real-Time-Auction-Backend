#!/bin/bash
# One k6 run against the cluster (or a single instance), with per-instance monitoring.
# Usage: ./loadtest/run-cluster.sh <label> <instances> <base-url> <scenario> <peak> <outdir>
#   <instances>  "3001"  or  "3001 3002"      <base-url> http://localhost:3000 (nginx) or http://localhost:3001 (direct)
LABEL=$1; INSTANCES_ARG=$2; BASE_URL=$3; SCENARIO=$4; PEAK=$5; R=$6
mkdir -p "$R"
cd "$(dirname "$0")/.." || exit 1

LOGDIR="$R/logs-$LABEL" INSTANCES="$INSTANCES_ARG" WS_MAX_CONNECTIONS_PER_IP=100000 bash scripts/cluster.sh start > "$R/start-$LABEL.txt" 2>&1
docker exec auction_production-redis-state-1 redis-cli DEL flusher:stats > /dev/null

powershell -NoProfile -File loadtest/cpu-sample.ps1 -DurationSec 140 > "$R/cpu-$LABEL.txt" 2>&1 &
PORTS="$INSTANCES_ARG" ./loadtest/monitor.sh > "$R/monitor-$LABEL.txt" 2>&1 &
MON=$!
k6 run -e BASE="$BASE_URL" -e SCENARIO="$SCENARIO" -e PEAK="$PEAK" -e PREVUS=100 -e MAXVUS=600 $K6_EXTRA loadtest/auction.js > "$R/k6-$LABEL.txt" 2>&1
kill $MON 2>/dev/null

# wait until Postgres has every accepted bid
FIRST=$(echo $INSTANCES_ARG | awk '{print $1}')
START=$(date +%s)
for i in $(seq 1 120); do
  LEN=$(curl -s localhost:$FIRST/health/stats | node -pe 'try{JSON.parse(require("fs").readFileSync(0)).writeBehind.streamLength}catch(e){-1}')
  [ "$LEN" = "0" ] && break
  sleep 1
done
echo "drain_seconds_after_k6=$(( $(date +%s) - START )) final_stream_length=$LEN" > "$R/drain-$LABEL.txt"
for p in $INSTANCES_ARG; do curl -s localhost:$p/health/stats > "$R/final-stats-$LABEL-$p.json"; done
bash scripts/cluster.sh status > "$R/processes-$LABEL.txt" 2>&1
bash scripts/cluster.sh stop > /dev/null 2>&1
