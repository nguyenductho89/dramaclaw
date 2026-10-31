#!/usr/bin/env bash
# Worker boot script: first confirm the GPU can really compute (not just that the driver is present), then start ComfyUI and the handler.

TCMALLOC="$(ldconfig -p | grep -Po "libtcmalloc.so.\d" | head -n 1)"
export LD_PRELOAD="${TCMALLOC}"

echo "worker-qwen: checking GPU..."
if ! GPU_CHECK=$(python3 -c "
import torch
try:
    torch.cuda.init()
    name = torch.cuda.get_device_name(0)
    cap = torch.cuda.get_device_capability(0)
    _ = (torch.zeros(8, device='cuda') + 1).sum().item()
    torch.cuda.synchronize()
    print(f'OK: {name} (sm_{cap[0]}{cap[1]}), torch {torch.__version__}, cuda {torch.version.cuda}')
except Exception as e:
    print(f'FAIL: {e}')
    exit(1)
" 2>&1); then
    echo "worker-qwen: GPU unusable or incompatible with this torch build:"
    echo "worker-qwen: $GPU_CHECK"
    exit 1
fi
echo "worker-qwen: GPU usable - $GPU_CHECK"

: "${COMFY_LOG_LEVEL:=INFO}"
COMFY_PID_FILE="/tmp/comfyui.pid"

echo "worker-qwen: starting ComfyUI"
# COMFY_EXTRA_ARGS: optional ComfyUI flags set through the endpoint env, e.g.
# "--extra-model-paths-config /runpod-volume/extra_paths_loras.yaml". Deliberately unquoted so it splits into several flags.
echo "worker-qwen: COMFY_EXTRA_ARGS=${COMFY_EXTRA_ARGS:-<none>}"
# shellcheck disable=SC2086
python -u /comfyui/main.py --disable-auto-launch --disable-metadata --verbose "${COMFY_LOG_LEVEL}" --log-stdout ${COMFY_EXTRA_ARGS} &
echo $! > "$COMFY_PID_FILE"

echo "worker-qwen: starting RunPod handler"
python -u /handler.py
