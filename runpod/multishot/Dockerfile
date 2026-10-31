# Worker image RIÊNG cho ComfyUI-H3-Multishot (video 1 cú máy liền mạch, nhiều shot nối nhau).
# Bản sao từ ~/Xuongphim/photoreal-short-drama-generator/runpod/Dockerfile (KHÔNG sửa file gốc đó),
# thêm đúng 1 custom node pack: ComfyUI-H3-Multishot (jlucasmcrell), pin theo tag v2.7.2.
#
# Không đụng image/endpoint photoreal-drama-h3 (a31613hf7l83r5) đang dùng chung với dramaclaw — image này
# build riêng, push registry riêng, chạy trên endpoint RunPod mới nhưng dùng CHUNG Network Volume
# zyen2jmxt3 (model H3 fl2va/ref2va + text encoder + VAE đã có sẵn, không cần tải lại).
#
# Build bằng CI của repo photoreal-short-drama-generator (workflow build-worker-image.yml, image=multishot) —
# nguồn gốc là ~/Xuongphim/trends/comfy-trends/runpod_multishot/Dockerfile (bản cu128, build tay qua QEMU).
# 2026-10-28: đổi sang cu130 + gcc + sageattention như runpod/Dockerfile (xem dramaclaw's
# runpod-h3-qwen-endpoints.md mục 8). Endpoint cần gpu.minCudaVersion=13.0; cờ Sage/Triton đặt qua env COMFY_EXTRA_ARGS.
#
# Build (máy Mac arm64 không build được image amd64/cuda; QEMU giả lập qua Docker Desktop buildx, đo thật
# ~2h45 cho bản gốc 14.7GB — cần Docker Desktop đang BẬT):
#   docker buildx build --platform linux/amd64 -t ghcr.io/nguyenductho89/comfy-trends-h3-multishot:0.37.2-ms2.7.2 --push runpod_multishot/

FROM nvidia/cuda:13.0.3-cudnn-runtime-ubuntu24.04

ARG COMFYUI_VERSION=0.37.2
ARG H3_PDD_ACC_COMMIT=311a65dd53832d8a5f8177a9d5fb923c09e35a90
ARG GGUF_COMMIT=6ea2651e7df66d7585f6ffee804b20e92fb38b8a
ARG H3_MULTISHOT_COMMIT=d7d197709fc93c1afb125e3db1dfd4ac0ae28c60
# ^ tag v2.7.2 của https://github.com/jlucasmcrell/ComfyUI-H3-Multishot (xác nhận bằng `git ls-remote --tags`,
#   giống SHA của refs/heads/master lúc build — là bản mới nhất khi commit Dockerfile này).

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_PREFER_BINARY=1 \
    PYTHONUNBUFFERED=1 \
    CMAKE_BUILD_PARALLEL_LEVEL=8

RUN apt-get update && apt-get install -y \
    python3.12 python3.12-venv python3.12-dev gcc git wget \
    libgl1 libglib2.0-0 libsm6 libxext6 libxrender1 ffmpeg \
    && ln -sf /usr/bin/python3.12 /usr/bin/python \
    && ln -sf /usr/bin/pip3 /usr/bin/pip \
    && apt-get autoremove -y && apt-get clean -y && rm -rf /var/lib/apt/lists/*

RUN wget -qO- https://astral.sh/uv/install.sh | sh \
    && ln -s /root/.local/bin/uv /usr/local/bin/uv \
    && ln -s /root/.local/bin/uvx /usr/local/bin/uvx \
    && uv venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

# comfy-cli phiên bản cố định: quyết định cách cài ComfyUI và chọn torch index, không ghim thì mỗi lần build
# ra kết quả khác nhau
RUN uv pip install comfy-cli==1.13.0 pip setuptools wheel
RUN /usr/bin/yes | comfy --workspace /comfyui install --version "${COMFYUI_VERSION}" --cuda-version 13.0 --nvidia

# Custom node: PDD acceleration (dùng cho vị trí chính thức), GGUF (Qwen-Image quant dùng), H3-Multishot
# (chain nhiều shot H3 thành 1 cú máy liền mạch). Ghim theo commit, không trôi theo branch.
RUN git clone https://github.com/Jalen-Brunson/ComfyUI-MiniMax-H3-PDD-Acc /comfyui/custom_nodes/ComfyUI-MiniMax-H3-PDD-Acc \
    && git -C /comfyui/custom_nodes/ComfyUI-MiniMax-H3-PDD-Acc checkout "${H3_PDD_ACC_COMMIT}" \
    && git clone https://github.com/city96/ComfyUI-GGUF /comfyui/custom_nodes/ComfyUI-GGUF \
    && git -C /comfyui/custom_nodes/ComfyUI-GGUF checkout "${GGUF_COMMIT}" \
    && git clone https://github.com/jlucasmcrell/ComfyUI-H3-Multishot /comfyui/custom_nodes/ComfyUI-H3-Multishot \
    && git -C /comfyui/custom_nodes/ComfyUI-H3-Multishot checkout "${H3_MULTISHOT_COMMIT}"

# torch cài trước, ghim cu130 (ComfyUI 0.37.2 chỉ bật backend `cuda` của comfy_kitchen khi torch.version.cuda >= 13).
# sageattention==1.0.6: wheel Python thuần (kernel Triton JIT), cần gcc + python3.12-dev ở trên để Triton biên dịch stub.
RUN uv pip install torch==2.11.0 torchvision==0.26.0 torchaudio==2.11.0 \
      --index-url https://download.pytorch.org/whl/cu130 \
    && uv pip install sageattention==1.0.6 \
    && uv pip install -r /comfyui/requirements.txt \
    && for r in /comfyui/custom_nodes/*/requirements.txt; do \
         [ -f "$r" ] && uv pip install -r "$r" || true; \
       done
# ComfyUI-H3-Multishot không có requirements.txt (pyproject.toml deps=[]: torch/numpy/PIL/av/psutil đã có
# sẵn trong ComfyUI) nên vòng lặp trên bỏ qua nó, không cần thêm bước cài riêng.

# Import thử toàn bộ ComfyUI (CPU) lúc build: lỗi tương thích của pack mới (API nội bộ comfy_extras.nodes_minimax_h3
# đổi giữa các bản ComfyUI) lộ ra NGAY ở đây, không phải tới lúc chạy job thật mới thấy "server not reachable"
# không rõ nguyên nhân.
RUN cd /comfyui && timeout 300 python main.py --quick-test-for-ci --cpu
RUN python -c "import torch, triton, sageattention; assert torch.version.cuda.startswith('13'), torch.version.cuda; print(torch.__version__, torch.version.cuda, triton.__version__)"

WORKDIR /comfyui
ADD multishot/extra_model_paths.yaml ./
WORKDIR /

RUN uv pip install runpod requests websocket-client boto3

ADD multishot/start.sh common/handler.py ./
RUN chmod +x /start.sh

CMD ["/start.sh"]
