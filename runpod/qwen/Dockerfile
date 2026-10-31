# Worker image cho RunPod Serverless — DÙNG CHUNG cho 2 endpoint tách ra 2026-10-19/20
# (xem dramaclaw's runpod-h3-qwen-endpoints.md mục 2-3):
#   - `qwen-edit-2511-relight`  — Qwen-Image-Edit-2511 (render identity-swap + edit ảnh)
#   - `qwen-image-t2i-fast`    — Qwen-Image 2.1 (t2i nhanh: background/prop/render/sketch)
#
# Cả 2 model đều chỉ cần node CORE của ComfyUI (TextEncodeQwenImage21/QwenImage21Cache,
# TextEncodeQwenImageEditPlus, ModelSamplingAuraFlow, CFGNorm, FluxKontextImageScale,
# SetLatentNoiseMask, ...) — xác nhận lúc tách: không cần ComfyUI-MiniMax-H3-PDD-Acc,
# ComfyUI-KJNodes/sageattention (SageAttention giờ chỉ dùng cho H3, xem
# dramaclaw's generators/comfy_sage.py), hay ComfyUI-GGUF (orphan trên image cũ — không
# model Qwen nào ở đây dùng file .gguf, chỉ .safetensors int8_convrot qua UNETLoader
# thường). Vì y hệt nhau, build 1 image duy nhất rồi deploy lên CẢ 2 endpoint — không cần
# build 2 lần.
#
# Cùng base/ComfyUI/torch với ../runpod/Dockerfile (endpoint H3) để dễ so sánh/maintain,
# chỉ bớt hẳn phần custom node.
#
# Build (máy Mac arm64 không build được image amd64/cuda; build local bằng Docker
# Desktop's buildx + QEMU, xem ../runpod/README.md §3.1 — không có node H3 nên nhẹ hơn,
# build chắc nhanh hơn ~2h45 đo được của image H3/Qwen chung cũ):
#   docker buildx build --platform linux/amd64 -t <registry>/<name>:<tag> -f runpod/qwen/Dockerfile --push runpod/

FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04

ARG COMFYUI_VERSION=0.37.2

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_PREFER_BINARY=1 \
    PIP_DEFAULT_TIMEOUT=180 \
    PIP_RETRIES=10 \
    PYTHONUNBUFFERED=1 \
    CMAKE_BUILD_PARALLEL_LEVEL=8

RUN apt-get update && apt-get install -y \
    python3.12 python3.12-venv git wget \
    libgl1 libglib2.0-0 libsm6 libxext6 libxrender1 ffmpeg \
    && ln -sf /usr/bin/python3.12 /usr/bin/python \
    && ln -sf /usr/bin/pip3 /usr/bin/pip \
    && apt-get autoremove -y && apt-get clean -y && rm -rf /var/lib/apt/lists/*

RUN wget -qO- https://astral.sh/uv/install.sh | sh \
    && ln -s /root/.local/bin/uv /usr/local/bin/uv \
    && ln -s /root/.local/bin/uvx /usr/local/bin/uvx \
    && uv venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

# comfy-cli version pinned: it decides how ComfyUI is installed and which torch index is chosen; an unpinned version makes every build differ
RUN uv pip install comfy-cli==1.13.0 pip setuptools wheel
RUN /usr/bin/yes | comfy --workspace /comfyui install --version "${COMFYUI_VERSION}" --cuda-version 12.8 --nvidia

# Không có custom_nodes nào ở image này — xem comment đầu file.

# Install torch first, pinned to cu128: ComfyUI's requirements.txt has an unbounded torch, which may pull a cu13 wheel that needs a newer driver
# UV_HTTP_TIMEOUT cao hơn default (30s): mạng build local (QEMU amd64 trên Mac) đo được rất chậm
# (~1.2MB/s) và nhiều gói CUDA to (500-600MB) tải đồng thời, default timeout làm uv báo lỗi giữa chừng
ENV UV_HTTP_TIMEOUT=300
RUN uv pip install torch==2.11.0 torchvision==0.26.0 torchaudio==2.11.0 \
      --index-url https://download.pytorch.org/whl/cu128 \
    && uv pip install -r /comfyui/requirements.txt

# Import all of ComfyUI once at build time (CPU is enough): dependency problems that would kill startup surface here,
# instead of an opaque "server not reachable" on the real worker
RUN cd /comfyui && timeout 300 python main.py --quick-test-for-ci --cpu

WORKDIR /comfyui
ADD qwen/extra_model_paths.yaml ./
WORKDIR /

RUN uv pip install runpod requests websocket-client boto3

ADD qwen/start.sh common/handler.py ./
RUN chmod +x /start.sh

CMD ["/start.sh"]
