# Samples whole-machine CPU and CPU per process group every 3 s, as a percentage of ALL logical processors.
# Usage: powershell -File loadtest/cpu-sample.ps1 -DurationSec 135
param([int]$DurationSec = 135)
$cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
$groups = @{ k6 = @('k6'); node = @('node'); docker_vm = @('vmmemWSL','vmmem'); docker_other = @('com.docker.backend','wslrelay','Docker Desktop') }
function Snap {
  $s = @{}
  foreach ($g in $groups.Keys) {
    $t = 0.0
    foreach ($n in $groups[$g]) { Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object { $t += $_.TotalProcessorTime.TotalSeconds } }
    $s[$g] = $t
  }
  return $s
}
$prev = Snap
$prevTime = Get-Date
$end = (Get-Date).AddSeconds($DurationSec)
"time total_pct k6_pct node_pct docker_vm_pct docker_other_pct (all as % of $cores logical processors)"
while ((Get-Date) -lt $end) {
  Start-Sleep -Seconds 3
  $total = (Get-Counter '\Processor Information(_Total)\% Processor Utility' -ErrorAction SilentlyContinue).CounterSamples[0].CookedValue
  $now = Snap
  $dt = ((Get-Date) - $prevTime).TotalSeconds
  $line = "{0} {1:N0} {2:N0} {3:N0} {4:N0} {5:N0}" -f (Get-Date -Format HH:mm:ss), [math]::Min($total,100),
    (($now.k6 - $prev.k6) / ($dt * $cores) * 100), (($now.node - $prev.node) / ($dt * $cores) * 100),
    (($now.docker_vm - $prev.docker_vm) / ($dt * $cores) * 100), (($now.docker_other - $prev.docker_other) / ($dt * $cores) * 100)
  $line
  $prev = $now; $prevTime = Get-Date
}
