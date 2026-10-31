#!/bin/bash
# Samples server stats + Postgres CPU every ~3s while a load test runs. One line per sample per port.
# PORTS="3001 3002" samples each API instance directly (through nginx you would hit a random one).
PORTS=${PORTS:-3000}
while true; do
  PG=$(docker stats --no-stream --format "pgCpu={{.CPUPerc}}" auction_production-postgres-1)
  for P in $PORTS; do
    S=$(curl -s -m 3 localhost:$P/health/stats || echo '{"error":"timeout/unreachable"}')
    echo "$(date +%T) port=$P $PG $S"
  done
  sleep 3
done
