#!/usr/bin/env bash
# Memory monitor for RunPod workers: one VRAMMON and one RAMMON line every 5 s (values in MiB).
# Tries cgroup v2, then cgroup v1, then reports the ComfyUI process (RSS/locked) and /proc/meminfo page cache.
echo "MEMMON cgroup files: $(ls /sys/fs/cgroup 2>/dev/null | tr '\n' ' ' | cut -c1-400)"
echo "MEMMON cgroup v1 memory dir: $(ls /sys/fs/cgroup/memory 2>/dev/null | tr '\n' ' ' | cut -c1-300)"
mib() { [ -n "$1" ] && echo $(( $1 / 1048576 )) || echo NA; }
while true; do
  V=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | head -1)
  C2=$(cat /sys/fs/cgroup/memory.current 2>/dev/null); P2=$(cat /sys/fs/cgroup/memory.peak 2>/dev/null)
  C1=$(cat /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null); P1=$(cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes 2>/dev/null)
  F2=$(awk '$1=="file"{print $2}' /sys/fs/cgroup/memory.stat 2>/dev/null); A2=$(awk '$1=="anon"{print $2}' /sys/fs/cgroup/memory.stat 2>/dev/null)
  F1=$(awk '$1=="total_cache"{print $2}' /sys/fs/cgroup/memory/memory.stat 2>/dev/null); A1=$(awk '$1=="total_rss"{print $2}' /sys/fs/cgroup/memory/memory.stat 2>/dev/null)
  P=$(pgrep -f "comfyui/main.py" | head -1)
  PR=""; [ -n "$P" ] && PR=$(awk '/^(VmRSS|RssAnon|RssFile|RssShmem|VmLck|VmPin|VmHWM):/{printf "%s=%d ",$1,$2/1024}' /proc/$P/status 2>/dev/null)
  MI=$(awk '/^(MemAvailable|Cached|Active\(file\)|Inactive\(file\)):/{printf "%s=%d ",$1,$2/1024}' /proc/meminfo)
  echo "VRAMMON ${V} MiB"
  echo "RAMMON v2cur=$(mib "$C2") v2peak=$(mib "$P2") v2file=$(mib "$F2") v2anon=$(mib "$A2") v1cur=$(mib "$C1") v1peak=$(mib "$P1") v1cache=$(mib "$F1") v1rss=$(mib "$A1") proc[$PR] host[$MI]"
  sleep 5
done
