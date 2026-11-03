# Chạy H3 multishot trên máy RTX 4090 thuê (na-01) — hướng dẫn làm tại máy local

## Mục tiêu
Benchmark 30 s trên RunPod 4090 (`bench_4090_ms30_analysis.md`) cho thấy mỗi shot mất 5,4–6,8 phút "Model Initializing", sampling chỉ ~11%. Giả thuyết **chưa kiểm**: trọng số bị thả khỏi RAM rồi đọc lại ~35 GB từ global volume chậm. Máy thuê này có 120 GB RAM, NVMe 6,6 GB/s, không bị cgroup giới hạn RAM như RunPod, nên đủ để kiểm giả thuyết. Cách làm: dựng ComfyUI 0.37.2 + H3 multishot giống image `comfy-trends-h3-multishot:0.37.2-ms2.7.2-cu130`, chạy lại bench 30 s, so số liệu.

## 1. Tạo máy
- GPU: 1x RTX 4090 24 GB, CPU EPYC 7742, RAM 120 GB (22.500đ/giờ).
- **Template: `ubuntu22.04-devel` (`ezycloudx/ubuntu22.04-devel:cuda126`).** Phải là bản `devel` vì Triton/Sage cần `gcc` để biên dịch lúc chạy. Dự phòng: `nvidia/cuda:12.4.1-devel-ubuntu22.04`. Không dùng `pytorch:latest` (runtime, có thể thiếu gcc), `comfyui` (không rõ bản), `tensorflow`, `ollama`.
- Storage **250 GB** (model ~50 GB + venv ~15 GB + output). Cổng 22 là đủ; ComfyUI chạy ở `127.0.0.1:8188`, truy cập qua SSH tunnel.
- Torch cài bằng wheel cu130 (mang sẵn CUDA runtime) nên CUDA trong image không quan trọng. Chỉ cần **driver host ≥ 580**; thấp hơn thì script tự dùng torch cu128 (mất backend `cuda` của comfy_kitchen, chậm hơn chút).

## 2. Cài đặt (30–60 phút, chủ yếu tải model)
```bash
ssh -L 8188:127.0.0.1:8188 <user>@<host> -p <port>
git clone https://github.com/nguyenductho89/dramaclaw /opt/dramaclaw
bash /opt/dramaclaw/previs_h3_test/scripts/setup_h3_box.sh          # thêm --with-ref2va nếu cần ref2va
```
Script `previs_h3_test/scripts/setup_h3_box.sh` làm: kiểm GPU/driver → gói hệ thống + python3.12 → uv venv + ComfyUI 0.37.2 (comfy-cli 1.13.0) → 3 custom node ghim commit (PDD-Acc, GGUF, H3-Multishot v2.7.2) → torch + `sageattention==1.0.6` → tải model fl2va về `/opt/models` (dò đường dẫn qua API HuggingFace, không đoán) → ghi `extra_model_paths.yaml` và `run_comfy.sh`.

Model fl2va: `minimax_h3_fl2va_pruned_int8_convrot`, `qwen3vl_32b_minimax_h3_nvfp4_awq`, `minimax_h3_video_vae_fp16`, `minimax_h3_audio_vae_fp32` (repo `Comfy-Org/MiniMax-H3`), `MiniMax-H3-FL2VA-Acc-8Step` (`alibaba-pai/MiniMax-H3-Acc-LoRAs`).

Giới hạn đã biết của script: chưa tải checkpoint ref2va + PDD ref2va (tên file xem `src/novelvideo/config.py`), và **chưa chạy thử lần nào**. Nếu `hf_get` báo "KHÔNG THẤY", tên file trên HF đã đổi, sửa tay.

## 3. Khởi động và kiểm tra
```bash
tmux new -d -s comfy /opt/run_comfy.sh
curl -s 127.0.0.1:8188/system_stats | jq .system
curl -s 127.0.0.1:8188/object_info | jq 'keys[]' | grep -i -E 'h3|multishot'
nvidia-smi --query-gpu=name,driver_version --format=csv
```
Đạt khi: thấy 4090, import `torch, triton, sageattention` OK, `object_info` có các node H3/Multishot, ô chọn của `UNETLoader`/`CLIPLoader`/`VAELoader` hiện đủ tên file model.

## 4. Chạy benchmark
Để đo RAM/VRAM, chạy song song `previs_h3_test/scripts/memmon.sh` (script này đọc cgroup v1 của RunPod; trên máy thường cần sửa sang `free -m` / `/proc/meminfo`).

**Việc còn thiếu:** `previs_h3_test/scripts/bench_multishot30_local.py` chưa được viết. Ý định: tái dùng `BEATS`/`SHOTS` của `bench_multishot30.py` và `build_h3_multishot_graph()`, `dims_for_multishot`, `multishot_sampling_plan`, `join_shots_script` trong `src/novelvideo/generators/runpod_minimax_h3_multishot_video.py`; thay phần R2/RunPod bằng `POST /upload/image` (ảnh `photo_f0.png`), `POST /prompt`, theo dõi `/history/{id}`, tải video qua `/view`. Ghi kết quả `bench_4090local_ms30.json` cùng định dạng bản RunPod.

Thứ tự chạy:
1. `BENCH_SHOTS=2` (~15–25 phút) để bắt lỗi graph.
2. Đủ 6 shot, **lần 1** (page cache trống).
3. Đủ 6 shot, **lần 2** ngay sau (trọng số còn trong page cache). Hai lần tách "đọc đĩa" khỏi "khởi tạo DiT".

## 5. Đọc kết quả
Chỉ số: thời gian từng shot; thời gian Model Initializing / encode text / 8 bước sampling / decode VAE (từ log ComfyUI); đỉnh RAM; đỉnh VRAM; có OOM không. So với bản RunPod 4090: tổng 91,4 phút, init 5,4–6,8 phút mỗi shot, sampling 8 bước ~90 s.
- Init vẫn 5–6 phút dù NVMe + 120 GB RAM → giả thuyết "ổ chậm" sai; chuyển sang hướng giữ trọng số/encoder giữa các shot (thẻ Kanban "DramaClaw Kanban").
- Init rút xuống rõ rệt → nguyên nhân là global volume; ghi lại và cân nhắc chép model ra ổ cục bộ lúc khởi động worker (xem `scripts/localcopy.sh`).
- Ghi kết quả vào `previs_h3_test/bench_4090_ms30_analysis.md` và `.claude/CLAUDE.md`.

## 6. Chi phí và dọn dẹp
Cài ~1 giờ; mỗi lần bench 30 s ~1,5 giờ; tổng ~4 giờ ≈ 90.000đ. **Tắt/xoá máy khi xong.** Copy video và JSON kết quả về trước khi xoá.
