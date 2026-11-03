#!/usr/bin/env bash
# Memory/GPU/disk monitor.
#   memmon.sh <out.csv> [interval_s=2] [disk_dev]  -> one CSV row per interval (MiB unless noted)
#   memmon.sh                                       -> old RunPod mode: VRAMMON / RAMMON lines on stdout every 5 s
# Works with cgroup v2, cgroup v1 (RunPod) or neither (plain box); missing values are empty.
OUT=${1:-}; IV=${2:-2}; DEV=${3:-$(df /opt/models 2>/dev/null | awk 'NR==2{print $1}' | sed 's#/dev/##')}
mib() { [ -n "$1" ] && echo $(( $1 / 1048576 )); }
cg_cur() { cat /sys/fs/cgroup/memory.current 2>/dev/null || cat /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null; }
cg_peak() { cat /sys/fs/cgroup/memory.peak 2>/dev/null || cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes 2>/dev/null; }
cg_max() { cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null; }
proc() { local p; p=$(pgrep -f "main.py --listen" | head -1); [ -n "$p" ] && awk '{v[$1]=int($2/1024)} END{printf "%s,%s,%s,%s,%s", v["VmRSS:"], v["RssAnon:"], v["RssFile:"], v["VmHWM:"], v["VmSwap:"]}' /proc/$p/status 2>/dev/null; }
disk_sectors() { # sectors read on the base device (partition stripped)
  local d=${DEV%%[0-9]*}; [ "${DEV#nvme}" != "$DEV" ] && d=${DEV%%p[0-9]*}
  awk -v d="$d" '$3==d{print $6; exit}' /proc/diskstats 2>/dev/null; }

if [ -z "$OUT" ]; then  # legacy RunPod log mode
  while true; do
    echo "VRAMMON $(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | head -1) MiB"
    echo "RAMMON cgcur=$(mib "$(cg_cur)") cgpeak=$(mib "$(cg_peak)") proc[$(proc)] host[$(awk '/^(MemAvailable|Cached):/{printf "%s=%d ",$1,$2/1024}' /proc/meminfo)]"
    sleep 5
  done
fi

echo "ts_utc,vram_used_mib,vram_total_mib,gpu_util_pct,gpu_power_w,gpu_temp_c,host_memavailable_mib,host_cached_mib,host_dirty_mib,swap_used_mib,cgroup_cur_mib,cgroup_peak_mib,cgroup_max_mib,comfy_vmrss_mib,comfy_rssanon_mib,comfy_rssfile_mib,comfy_vmhwm_mib,comfy_swap_mib,disk_read_mbps" > "$OUT"
PREV=$(disk_sectors); PT=$(date +%s.%N)
while true; do
  G=$(nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu,power.draw,temperature.gpu --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ')
  [ -z "$G" ] && G=",,,,"
  M=$(awk '/^MemAvailable:/{a=$2}/^Cached:/{c=$2}/^Dirty:/{d=$2}/^SwapTotal:/{st=$2}/^SwapFree:/{sf=$2}END{printf "%d,%d,%d,%d", a/1024, c/1024, d/1024, (st-sf)/1024}' /proc/meminfo 2>/dev/null)
  CM=$(cg_max); [ "$CM" = max ] && CM=""
  P=$(proc); [ -z "$P" ] && P=",,,,"
  NOW=$(disk_sectors); NT=$(date +%s.%N); R=""
  [ -n "$NOW" ] && [ -n "$PREV" ] && R=$(awk -v a="$PREV" -v b="$NOW" -v s="$PT" -v e="$NT" 'BEGIN{printf "%.0f", (b-a)*512/1048576/(e-s)}')
  PREV=$NOW; PT=$NT
  echo "$(date -u +%Y-%m-%dT%H:%M:%S),$G,${M:-,,,},$(mib "$(cg_cur)"),$(mib "$(cg_peak)"),$(mib "$CM"),$P,$R" >> "$OUT"
  sleep "$IV"
done
