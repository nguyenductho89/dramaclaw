#!/usr/bin/env bash
# Dựng pod RunPod thử InfiniteTalk (Wan 2.1 I2V 14B fp8 + InfiniteTalk adapter), chạy được trên ảnh
# runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404. Dán nguyên script này vào biến môi trường BOOT_SCRIPT
# của pod, entrypoint ["/bin/bash","-c"], cmd ["eval \"$BOOT_SCRIPT\""], port 8188/http, disk >= 120 GB.
# KHÔNG ghi mô hình vào global volume (ghi song song cực chậm, đã đo 0 byte sau 2 phút): tải vào /root/models.
set -x
exec > >(tee -a /boot.log) 2>&1
echo PHASE1-apt
apt-get update -qq && apt-get install -y -qq git ffmpeg libgl1 libglib2.0-0 curl >/dev/null
echo PHASE2-comfyui
cd /root && rm -rf ComfyUI && git clone --depth 1 --branch v0.37.2 https://github.com/comfyanonymous/ComfyUI.git
cd /root/ComfyUI && pip install -q -r requirements.txt
echo PHASE3-nodes
cd /root/ComfyUI/custom_nodes
git clone --depth 1 https://github.com/kijai/ComfyUI-WanVideoWrapper
git clone --depth 1 https://github.com/kijai/ComfyUI-KJNodes
git clone --depth 1 https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite
for d in */; do [ -f "$d/requirements.txt" ] && pip install -q -r "$d/requirements.txt"; done
# Phải ghim CẢ BỘ BA cùng lúc: transformers mới nhất làm MultiTalkWav2VecEmbeds báo hidden_states=None;
# ghim riêng transformers 4.51.3 thì kéo huggingface_hub cũ làm diffusers mới hỏng (resolve_revision).
pip install -q "transformers==4.51.3" "diffusers==0.35.2" "huggingface_hub<1.0" hf_transfer
python -c "import diffusers, transformers; print('IMPORT-OK', diffusers.__version__, transformers.__version__)"
echo PHASE4-models
export HF_HUB_ENABLE_HF_TRANSFER=1
python - <<'PY'
import os, shutil, time
from huggingface_hub import hf_hub_download
M = '/root/models'
items = [
    ('Kijai/WanVideo_comfy', 'Wan2_1-I2V-14B-480P_fp8_e4m3fn.safetensors', 'diffusion_models'),
    ('Kijai/WanVideo_comfy', 'InfiniteTalk/Wan2_1-InfiniTetalk-Single_fp16.safetensors', 'diffusion_models/InfiniteTalk'),
    ('Kijai/WanVideo_comfy', 'Wan2_1_VAE_bf16.safetensors', 'vae/wanvideo'),
    ('Kijai/WanVideo_comfy', 'umt5-xxl-enc-bf16.safetensors', 'text_encoders'),
    ('Kijai/WanVideo_comfy', 'Lightx2v/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors', 'loras/WanVideo/Lightx2v'),
    ('Comfy-Org/Wan_2.1_ComfyUI_repackaged', 'split_files/clip_vision/clip_vision_h.safetensors', 'clip_vision'),
]
for repo, fn, sub in items:
    t = time.time(); os.makedirs(f'{M}/{sub}', exist_ok=True)
    dst = f'{M}/{sub}/' + os.path.basename(fn)
    if os.path.exists(dst) and os.path.getsize(dst) > 1e6:
        print('HAVE', fn, flush=True); continue
    p = hf_hub_download(repo, fn, local_dir='/root/hfdl')
    shutil.move(p, dst)
    print('GOT', fn, round(os.path.getsize(dst) / 1e9, 2), 'GB', round(time.time() - t), 's', flush=True)
PY
echo PHASE5-start
printf 'dc:\n  base_path: /root/models\n  diffusion_models: diffusion_models\n  text_encoders: text_encoders\n  vae: vae\n  loras: loras\n  clip_vision: clip_vision\n' > /root/ComfyUI/extra_model_paths.yaml
cd /root/ComfyUI && python main.py --listen 0.0.0.0 --port 8188 --disable-auto-launch
echo COMFY-EXITED
sleep infinity
