#!/usr/bin/env bash
# Snapshot the box config for one benchmark run: raw files under <run_dir>/box/ plus <run_dir>/meta.json.
# Never fails the run: a missing tool or permission just leaves that field null.
#   snapshot_box.sh <run_dir> [models_dir=/opt/models] [comfy_dir=/opt/comfyui]
RUN=${1:?run_dir}; MODELS=${2:-/opt/models}; COMFY=${3:-/opt/comfyui}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
B=$RUN/box; mkdir -p "$B"
cap() { local f=$1; shift; "$@" > "$B/$f" 2>&1 || echo "(failed: $*)" >> "$B/$f"; }
cap nvidia-smi.txt nvidia-smi -q
cap lscpu.txt lscpu
cap free.txt free -b
cap meminfo.txt cat /proc/meminfo
cap lsblk.txt lsblk -o NAME,MODEL,ROTA,TRAN,SIZE,TYPE,FSTYPE,MOUNTPOINT
cap df.txt df -hT "$MODELS"
cap uname.txt uname -a
cap os-release.txt cat /etc/os-release
cap cgroup.txt sh -c 'cat /proc/self/cgroup; for f in /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory/memory.limit_in_bytes; do [ -f $f ] && echo "$f $(cat $f)"; done'
cap pip-freeze.txt sh -c "[ -x /opt/venv/bin/python ] && /opt/venv/bin/python -m pip freeze 2>/dev/null || uv pip freeze --python /opt/venv/bin/python"
cap run_comfy.sh.txt cat /opt/run_comfy.sh
cap extra_model_paths.yaml cat /opt/extra_model_paths.yaml
cap models.txt sh -c "find '$MODELS' -name '*.safetensors' -printf '%s %p\n' | sort -k2"
cap git.txt sh -c "for d in '$COMFY' '$COMFY'/custom_nodes/*/ '$REPO'; do [ -d \"\$d/.git\" ] && echo \"\$(git -C \"\$d\" rev-parse HEAD) \$(git -C \"\$d\" status --porcelain | wc -l)dirty \$d\"; done"
env | grep -E '^(BENCH_|RUNPOD_H3_|COMFY_|CUDA_|PYTORCH_)' | sort > "$B/env.txt"

# Cold read speed of the biggest model file (needs root to drop the page cache; otherwise measures a warm read).
READ_MBPS=null; READ_MODE=null
BIG=$(find "$MODELS" -name '*.safetensors' -printf '%s %p\n' 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2-)
if [ -n "$BIG" ] && [ "${BENCH_SKIP_DD:-0}" != 1 ]; then
  if sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null; then READ_MODE='"cold"'; else READ_MODE='"warm(no drop_caches)"'; fi
  S=$(date +%s.%N); BYTES=$(dd if="$BIG" of=/dev/null bs=16M 2>&1 | awk '/bytes/{print $1; exit}'); E=$(date +%s.%N)
  [ -n "$BYTES" ] && READ_MBPS=$(awk -v b="$BYTES" -v s="$S" -v e="$E" 'BEGIN{printf "%.0f", b/1048576/(e-s)}')
  echo "dd $BIG bytes=$BYTES mode=$READ_MODE MBps=$READ_MBPS" > "$B/dd.txt"
fi

j() { [ -n "$1" ] && printf '"%s"' "$(echo "$1" | sed 's/"/\\"/g')" || echo null; }
GPU=$(nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>/dev/null | head -1)
RAM=$(awk '/^MemTotal:/{printf "%.1f", $2/1048576}' /proc/meminfo 2>/dev/null)
CGMAX=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null)
DEV=$(df "$MODELS" 2>/dev/null | awk 'NR==2{print $1}')
DISK=$(lsblk -no MODEL,ROTA,TRAN "$DEV" 2>/dev/null | head -1 | xargs)
CPU=$(lscpu 2>/dev/null | awk -F: '/Model name/{gsub(/^ +/,"",$2); print $2; exit}')
NCPU=$(nproc 2>/dev/null)
TORCH=$(/opt/venv/bin/python -c 'import torch; print(torch.__version__, torch.version.cuda)' 2>/dev/null)
cat > "$RUN/meta.json" <<JSON
{
  "host": $(j "$(hostname)"),
  "snapshot_utc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "gpu": $(j "$GPU"),
  "cpu": $(j "$CPU"), "cpu_count": ${NCPU:-null},
  "ram_gib": ${RAM:-null},
  "cgroup_memory_max": $(j "$CGMAX"),
  "models_dir": $(j "$MODELS"), "models_device": $(j "$DEV"), "models_disk": $(j "$DISK"),
  "disk_read_mbps": $READ_MBPS, "disk_read_mode": $READ_MODE,
  "torch": $(j "$TORCH"),
  "note": $(j "${BENCH_NOTE:-}"),
  "raw_dir": "box/"
}
JSON
echo "snapshot -> $RUN/meta.json"
