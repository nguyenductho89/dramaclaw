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
```bash
cd /opt/dramaclaw && BENCH_SHOTS=2 BENCH_FRAMES=25 BENCH_NOTE="nvme, ram đầy đủ" /opt/venv/bin/python previs_h3_test/scripts/bench_multishot30_local.py t2x25_pdd
```
Mỗi lần chạy tự lưu đủ căn cứ vào `previs_h3_test/runs/<UTC ts>_<host>_<label>/`:
- `meta.json` + `box/`: GPU/driver, CPU, RAM, cgroup `MemoryMax`, ổ chứa model (model, ROTA, TRAN), tốc độ đọc ổ đo bằng `dd` (lạnh nếu drop được cache), `pip freeze`, commit ComfyUI/custom node/repo, `run_comfy.sh`, yaml model, kích thước file model, biến `BENCH_*`/`RUNPOD_H3_*`.
- `mem.csv` (2 s/dòng): VRAM, GPU util/power/nhiệt, RAM available/cached/dirty, swap, cgroup, RSS/HWM của ComfyUI, MB/s đọc đĩa.
- `comfy.log`: đoạn log server ComfyUI của đúng lần chạy (có dấu giờ, từ `/opt/bench/comfy_server.log`).
- `phases.json`: thời gian từng pha từng shot (encode text, DiT, init, sampling, s/bước, decode video/audio) tách bằng `parse_h3_log.py`. Parser đã khớp đúng bảng RunPod trong `bench_4090_ms30_analysis.md`.
- `sysmon.csv` (`sysmon.py`): CPU %, load, CPU/threads của ComfyUI, **MB/s model nạp thật** (đọc `/proc/<pid>/io`, đúng cả khi ổ là overlay), xung nhịp GPU (SM/mem, max), **mã throttle GPU** (vd `0x4` = chạm giới hạn công suất), PCIe gen/width, nhiệt, mạng.
- `steps.json` (`parse_steps.py`): thời gian từng bước sampling của từng shot/pass (bước đầu gồm Model Initializing).
- `quality.json` (`video_quality.py`): ffprobe (độ phân giải, fps, bitrate, audio), độ sáng trung bình/đầu/cuối/nhảy lớn nhất, kích thước frame, Laplacian (nếu có OpenCV). Chỉ để so giữa các lần chạy, không thay cho xem bằng mắt.
- `graph.json`, `result.json`, `live.log`, `video.mp4`. `postrun.sh <run_dir>` chạy lại `steps.json`/`quality.json` cho run cũ.
- Một dòng thêm vào `previs_h3_test/runs/index.csv` để so các lần thuê/cấu hình.

Đổi cấu hình (mỗi biến thể một lần 2×25, label và `BENCH_NOTE` mô tả cấu hình; khởi động lại ComfyUI với biến tương ứng):
- RAM: không giới hạn nhân tạo, luôn dùng RAM thật của máy thuê. Muốn so RAM khác thì thuê máy cấu hình khác; dung lượng thật được ghi vào `meta.json` và `index.csv`.
- Ổ: chép model sang thư mục khác (vd `/dev/shm/models` khi RAM đủ) và đặt `COMFY_MODEL_PATHS=<yaml khác>`, `BENCH_MODELS=<thư mục đó>` để `dd` đo đúng ổ.
- Cờ ComfyUI: `COMFY_EXTRA_ARGS="..."`.

Thứ tự chạy (đã tối ưu, ước ~2,5 giờ thay vì ~4 giờ):
1. `BENCH_SHOTS=2 BENCH_FRAMES=25` có PDD (~10–15 phút): bắt lỗi graph. Init không phụ thuộc số khung nên vẫn thấy "Model Initializing" mỗi shot. Nếu init vẫn 5–6 phút/shot khi model nằm trên NVMe + RAM 120 GB thì không phải do ổ chậm.
2. `BENCH_SHOTS=2 BENCH_FRAMES=25 BENCH_PDD=""` (chẩn đoán, bỏ PDD): nếu init giảm hẳn thì nút thắt là việc vá PDD lên DiT mỗi shot (giả thuyết, chưa kiểm).
3. Đọc `python main.py --help` và mã node `ComfyUI-H3-Multishot` tìm cờ giữ trọng số giữa các shot; chỉ thử cái có thật.
4. Làm nóng cache: `cat /opt/models/*/*.safetensors > /dev/null`, rồi chạy **một** lần đủ 6 shot (`bench_multishot30_local.py run1`). Bỏ lần "page cache trống" vì NVMe đọc 41 GB chỉ ~7 s.

Script setup đã tải model nền song song và kiểm import `novelvideo` (cần `PYTHONPATH=/opt/dramaclaw/src`). Script bench tự đặt PDD 8 và tắt realism LoRA để khớp bản RunPod.

## 5. Đọc kết quả
Chỉ số: thời gian từng shot; thời gian Model Initializing / encode text / 8 bước sampling / decode VAE (từ log ComfyUI); đỉnh RAM; đỉnh VRAM; có OOM không. So với bản RunPod 4090: tổng 91,4 phút, init 5,4–6,8 phút mỗi shot, sampling 8 bước ~90 s.
- Init vẫn 5–6 phút dù NVMe + 120 GB RAM → giả thuyết "ổ chậm" sai; chuyển sang hướng giữ trọng số/encoder giữa các shot (thẻ Kanban "DramaClaw Kanban").
- Init rút xuống rõ rệt → nguyên nhân là global volume; ghi lại và cân nhắc chép model ra ổ cục bộ lúc khởi động worker (xem `scripts/localcopy.sh`).
- Ghi kết quả vào `previs_h3_test/bench_4090_ms30_analysis.md` và `.claude/CLAUDE.md`.

## 6. Chi phí và dọn dẹp
Cài ~1 giờ; mỗi lần bench 30 s ~1,5 giờ; tổng ~2,5 giờ ≈ 60.000đ. **Tắt/xoá máy khi xong.** Trước khi xoá máy, chép về: `rsync -av <box>:/opt/dramaclaw/previs_h3_test/runs/ previs_h3_test/runs/` và `scp <box>:/opt/bench/comfy_server.log previs_h3_test/runs/`. Commit toàn bộ thư mục `runs/` (meta, box, mem.csv, comfy.log, phases.json, result.json, index.csv, video).
