#!/usr/bin/env bash
# Copy the models used by the fl2va multishot job from the global volume to the container's local disk, in parallel,
# and write a ComfyUI extra-paths yaml that puts the local copies first. Logs LOCALCOPY lines for the benchmark.
set -u
SRC=/runpod-volume/models; DST=/local-models
mkdir -p $DST/diffusion_models $DST/text_encoders $DST/vae $DST/pdd_acc
echo "LOCALCOPY start $(date -u +%H:%M:%S) df: $(df -m $DST | tail -1)"
T0=$(date +%s)
cp_one() { s=$(date +%s); if cp "$SRC/$1" "$DST/$1"; then echo "LOCALCOPY $1 ok in $(( $(date +%s) - s ))s size=$(stat -c%s "$DST/$1")"; else echo "LOCALCOPY $1 FAILED"; fi; }
cp_one diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors &
cp_one text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors &
cp_one vae/minimax_h3_video_vae_fp16.safetensors &
cp_one vae/minimax_h3_audio_vae_fp32.safetensors &
cp_one pdd_acc/MiniMax-H3-FL2VA-Acc-8Step.safetensors &
wait
cat > /tmp/local_paths.yaml <<'YAML'
local_models:
  base_path: /local-models
  is_default: true
  diffusion_models: diffusion_models/
  text_encoders: text_encoders/
  vae: vae/
  pdd_acc: pdd_acc/
YAML
echo "LOCALCOPY total $(( $(date +%s) - T0 ))s $(date -u +%H:%M:%S) df: $(df -m $DST | tail -1)"
