#!/bin/bash
# Prints one comparison row per run: ./loadtest/summarize.sh <dir> <label> [<label> ...]
R=$1; shift
printf "%-22s %8s %9s %9s %9s %9s %s\n" run "req/s" median p95 dropped "CPU tot/k6/node" "loop lag p99 (max)"
for t in "$@"; do
  rate=$(grep -o 'http_reqs[.]*: [0-9]* *[0-9.]*' $R/k6-$t.txt | awk '{printf "%.0f", $3}')
  med=$(grep 'http_req_duration\.\.' $R/k6-$t.txt | grep -o 'med=[0-9.]*[a-zµ]*' | cut -d= -f2)
  p95=$(grep 'http_req_duration\.\.' $R/k6-$t.txt | grep -o 'p(95)=[0-9.]*[a-zµ]*' | cut -d= -f2)
  drop=$(grep -o 'dropped_iterations[.]*: [0-9]*' $R/k6-$t.txt | awk '{print $2}')
  cpu=$(grep -E '^[0-9]{2}:' $R/cpu-$t.txt 2>/dev/null | awk 'NR>6 && $3>=0 && $4>=0 && $2>60 {T+=$2; K+=$3; N+=$4; C++} END{if(C) printf "%.0f%%/%.0f%%/%.0f%%", T/C, K/C, N/C; else printf "-"}')
  lag=$(grep -o 'eventLoopLagP99Ms":[0-9.]*' $R/monitor-$t.txt 2>/dev/null | cut -d: -f2 | sort -n | tail -1)
  printf "%-22s %8s %9s %9s %9s %16s %s\n" "$t" "$rate" "$med" "$p95" "$drop" "$cpu" "${lag}ms"
done
