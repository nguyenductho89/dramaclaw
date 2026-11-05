#!/bin/bash
# pod_up.sh HOST PORT: wait for SSH, check the pod network, upload code, install ComfyUI + models, start ComfyUI, then start
# the images stage in tmux. Run from anywhere; the repo root is found from this file.
# Exit codes: 1 no SSH or upload failed, 3 pod network too slow (delete the pod).
H=${1:?host}; P=${2:?port}
SSH="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -o LogLevel=ERROR -p $P root@$H"
R=$(cd "$(dirname "$0")/../../../../.." && pwd)
for i in $(seq 1 60); do $SSH true 2>/dev/null && break; sleep 15; done
$SSH true || { echo "SSH NOT UP"; exit 1; }
echo "ssh ok $(date -u +%T)"
SPEED=$($SSH 'curl -s -L -o /dev/null --max-time 20 -w "%{speed_download}" --fail https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors')
echo "pod download from HF: $SPEED bytes/s"
python3 -c "import sys; sys.exit(0 if float('${SPEED:-0}') > 20e6 else 1)" || { echo "NET_SLOW"; exit 3; }
T0=$(date +%s); head -c 5000000 /dev/urandom | $SSH 'cat >/dev/null'; echo "mac upload 5 MB: $(( $(date +%s) - T0 )) s"
$SSH 'mkdir -p /opt/dramaclaw /opt/bench; nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader; free -g | sed -n 2p; df -h /opt | tail -1'
cd "$R" && COPYFILE_DISABLE=1 tar czf - --exclude='__pycache__' --exclude='*.pyc' --exclude='previs_h3_test/runs' --exclude='previs_h3_test/scripts/skits/newton_pov' \
  --exclude='previs_h3_test/scripts/skits/science_humor/ep01/keyframes' --exclude='previs_h3_test/scripts/skits/science_humor/ep01/manim' \
  src pyproject.toml previs_h3_test/scripts | $SSH 'tar xzf - -C /opt/dramaclaw' || { echo "UPLOAD FAILED"; exit 1; }
echo "upload ok $(date -u +%T)"
$SSH 'cd /opt/dramaclaw && bash previs_h3_test/scripts/setup_h3_box.sh --with-ref2va --with-qwen > /opt/bench/setup.log 2>&1; echo setup-exit $?' || exit 1
$SSH 'tail -3 /opt/bench/setup.log | cut -c1-200'
$SSH 'command -v tmux >/dev/null || apt-get install -y tmux >/dev/null 2>&1; tmux new -d -s comfy /opt/run_comfy.sh; sleep 2; tmux new -d -s images "bash /opt/dramaclaw/previs_h3_test/scripts/skits/science_humor/gravity_test/run_batch.sh images"; sleep 3; tmux ls'
echo "images stage started $(date -u +%T)"
