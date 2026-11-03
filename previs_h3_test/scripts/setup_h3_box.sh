#!/usr/bin/env bash
# Dựng ComfyUI 0.37.2 + H3 multishot trên máy thuê (Ubuntu 22.04, 1x RTX 4090) giống runpod/multishot/Dockerfile,
# tải model fl2va về NVMe cục bộ. Chạy bằng root: bash setup_h3_box.sh [--with-ref2va]
set -euo pipefail
# Thời gian từng bước cài đặt -> $ROOT/bench/setup_timing.csv (step,start_utc,seconds) để cải tiến sau này.
# Tải model chạy nền nên có dòng riêng: dl:<file> (giây, byte, MB/s) trong $ROOT/bench/download_timing.csv.
mkdir -p /opt/bench
TIMING=/opt/bench/setup_timing.csv; DLTIMING=/opt/bench/download_timing.csv
[ -f $TIMING ] || echo "step,start_utc,seconds" > $TIMING
[ -f $DLTIMING ] || echo "file,start_utc,seconds,bytes,mbps" > $DLTIMING
_STEP=""; _T0=0
mark() { # mark <tên bước tiếp theo>; ghi bước trước đó
  local now; now=$(date +%s)
  [ -n "$_STEP" ] && echo "$_STEP,$(date -u -d @$_T0 +%FT%TZ),$((now-_T0))" >> $TIMING
  _STEP=${1:-}; _T0=$now
}
mark total_start; SETUP_T0=$_T0
trap 'mark ""; echo "TONG,$(date -u -d @$SETUP_T0 +%FT%TZ),$(( $(date +%s)-SETUP_T0 ))" >> $TIMING' EXIT
ROOT=/opt; MODELS=$ROOT/models; COMFY=$ROOT/comfyui
H3_PDD_ACC_COMMIT=311a65dd53832d8a5f8177a9d5fb923c09e35a90
GGUF_COMMIT=6ea2651e7df66d7585f6ffee804b20e92fb38b8a
H3_MULTISHOT_COMMIT=d7d197709fc93c1afb125e3db1dfd4ac0ae28c60
WITH_REF2VA=0; [ "${1:-}" = "--with-ref2va" ] && WITH_REF2VA=1

mark check_box; echo "== 1. kiểm máy"; nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv; free -g | head -2; df -h $ROOT | tail -1
DRV=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1 | cut -d. -f1)
if [ "$DRV" -ge 580 ]; then CU=13.0; TIDX=cu130; else CU=12.8; TIDX=cu128; echo "!! driver $DRV < 580: dùng torch $TIDX (không có backend cuda của comfy_kitchen)"; fi

mark apt_packages; echo "== 2. gói hệ thống"
export DEBIAN_FRONTEND=noninteractive
apt-get update && apt-get install -y curl wget git gcc aria2 tmux ffmpeg jq \
  libgl1 libglib2.0-0 libsm6 libxext6 libxrender1 libtcmalloc-minimal4
# Python 3.12 do uv tải (có sẵn header cho Triton); add-apt-repository hỏng trên image này (thiếu apt_pkg).

mark start_bg_download; echo "== 2b. tải model nền (log: $ROOT/download.log)"
download_models() {
set -e
mkdir -p $MODELS/{diffusion_models,text_encoders,vae,pdd_acc,loras}
hf_find() { # repo, tên file (không đuôi) -> đường dẫn trong repo
  curl -s "https://huggingface.co/api/models/$1/tree/main?recursive=true" | jq -r '.[].path' | grep -E "(^|/)$2\.safetensors\$" | head -1; }
hf_get() { # repo, tên, thư mục đích; ghi giây/byte/MB/s vào download_timing.csv
  local p t0 t1 sz; p=$(hf_find "$1" "$2"); [ -n "$p" ] || { echo "KHÔNG THẤY $2 trong $1"; return 1; }
  t0=$(date +%s)
  aria2c -c -x16 -s16 -k4M --dir="$MODELS/$3" -o "$2.safetensors" "https://huggingface.co/$1/resolve/main/$p"; ls -l "$MODELS/$3/$2.safetensors"
  t1=$(date +%s); sz=$(stat -c %s "$MODELS/$3/$2.safetensors")
  echo "$2,$(date -u -d @$t0 +%FT%TZ),$((t1-t0)),$sz,$(awk -v b=$sz -v s=$((t1-t0)) 'BEGIN{printf "%.0f", b/1048576/(s>0?s:1)}')" >> $DLTIMING; }
hf_get Comfy-Org/MiniMax-H3 minimax_h3_fl2va_pruned_int8_convrot diffusion_models
hf_get Comfy-Org/MiniMax-H3 qwen3vl_32b_minimax_h3_nvfp4_awq text_encoders
hf_get Comfy-Org/MiniMax-H3 minimax_h3_video_vae_fp16 vae
hf_get Comfy-Org/MiniMax-H3 minimax_h3_audio_vae_fp32 vae
hf_get alibaba-pai/MiniMax-H3-Acc-LoRAs MiniMax-H3-FL2VA-Acc-8Step pdd_acc
if [ $WITH_REF2VA = 1 ]; then
  hf_get Comfy-Org/MiniMax-H3 minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16 loras || true
  echo "ref2va: thêm checkpoint ref2va + PDD ref2va bằng tay (tên file xem config.py)"
fi
}
download_models > $ROOT/download.log 2>&1 &
DL_PID=$!

mark uv_venv_comfyui_install; echo "== 3. uv + venv + ComfyUI"
command -v uv >/dev/null || { curl -LsSf https://astral.sh/uv/install.sh | sh; ln -sf /root/.local/bin/uv /usr/local/bin/uv; }
[ -d $ROOT/venv ] || uv venv --python 3.12 $ROOT/venv
export PATH="$ROOT/venv/bin:$PATH"
uv pip install comfy-cli==1.13.0 pip setuptools wheel
# `yes |` gặp SIGPIPE khi comfy xong -> pipefail làm script thoát; chạy trong subshell tắt pipefail rồi kiểm thư mục.
[ -f $COMFY/main.py ] || { (set +o pipefail; yes | comfy --workspace $COMFY install --version 0.37.2 --cuda-version $CU --nvidia) || true; }
[ -f $COMFY/main.py ] || { echo "!! cài ComfyUI lỗi"; exit 1; }

mark custom_nodes_clone; echo "== 4. custom node (ghim commit)"
clone() { [ -d "$COMFY/custom_nodes/$2" ] || git clone "$1" "$COMFY/custom_nodes/$2"; git -C "$COMFY/custom_nodes/$2" checkout "$3"; }
clone https://github.com/Jalen-Brunson/ComfyUI-MiniMax-H3-PDD-Acc ComfyUI-MiniMax-H3-PDD-Acc $H3_PDD_ACC_COMMIT
clone https://github.com/city96/ComfyUI-GGUF ComfyUI-GGUF $GGUF_COMMIT
clone https://github.com/jlucasmcrell/ComfyUI-H3-Multishot ComfyUI-H3-Multishot $H3_MULTISHOT_COMMIT

mark torch_sage_pip; echo "== 5. torch $TIDX + sage"
if [ "$TIDX" = cu130 ]; then TV="torch==2.11.0 torchvision==0.26.0 torchaudio==2.11.0"; else TV="torch torchvision torchaudio"; fi
uv pip install $TV --index-url https://download.pytorch.org/whl/$TIDX
uv pip install sageattention==1.0.6 runpod requests websocket-client boto3 huggingface_hub python-dotenv
uv pip install -r $COMFY/requirements.txt
for r in $COMFY/custom_nodes/*/requirements.txt; do [ -f "$r" ] && uv pip install -r "$r" || true; done
python -c "import torch, triton, sageattention; print(torch.__version__, torch.version.cuda, torch.cuda.is_available())"

mark wait_model_download; echo "== 6. chờ tải model xong"; wait $DL_PID || { echo "!! tải model lỗi, xem $ROOT/download.log"; exit 1; }

mark write_config_and_verify
cat > $ROOT/extra_model_paths.yaml <<YAML
local_models:
  base_path: $MODELS
  is_default: true
  diffusion_models: diffusion_models/
  text_encoders: text_encoders/
  vae: vae/
  pdd_acc: pdd_acc/
  loras: loras/
YAML

# Log server có dấu giờ (parse_h3_log.py đọc) ở $ROOT/bench/comfy_server.log.
# Biến tuỳ chọn: COMFY_EXTRA_ARGS (cờ thêm), COMFY_MODEL_PATHS (yaml khác, để thử ổ khác).
# RAM: dùng nguyên RAM thật của máy; snapshot_box.sh ghi dung lượng vào meta.json.
mkdir -p $ROOT/bench
cat > $ROOT/run_comfy.sh <<SH
#!/usr/bin/env bash
export PATH=$ROOT/venv/bin:\$PATH LD_PRELOAD=\$(ldconfig -p | grep -Po "libtcmalloc_minimal.so.\d" | head -1)
echo "=== start \$(date -u +%FT%TZ) paths=\${COMFY_MODEL_PATHS:-$ROOT/extra_model_paths.yaml} extra=\${COMFY_EXTRA_ARGS:-}" >> $ROOT/bench/comfy_server.log
cd $COMFY && python -u main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch --disable-metadata \
  --use-sage-attention --extra-model-paths-config \${COMFY_MODEL_PATHS:-$ROOT/extra_model_paths.yaml} \${COMFY_EXTRA_ARGS:-} 2>&1 \
  | python3 -u $ROOT/dramaclaw/previs_h3_test/scripts/tslog.py $ROOT/bench/comfy_server.log
SH
chmod +x $ROOT/run_comfy.sh
PYTHONPATH=$ROOT/dramaclaw/src python -c "import novelvideo.generators.runpod_minimax_h3_multishot_video" && echo "import novelvideo OK" || echo "!! import novelvideo lỗi (cần git clone dramaclaw vào $ROOT/dramaclaw)"
echo "XONG. Chạy: tmux new -d -s comfy $ROOT/run_comfy.sh ; curl -s 127.0.0.1:8188/system_stats | jq .system"
