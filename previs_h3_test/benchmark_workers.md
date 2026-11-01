# Quan sát worker RunPod (ghi tay, bổ sung cho benchmark.json)

Dữ liệu tự động (thời gian, cấu hình, ffprobe) nằm trong `benchmark.json`, do `scripts/pipeline.py` ghi.
File này ghi những gì chỉ lấy được từ RunPod MCP (loại GPU, data center, mốc khởi động).

## Lần chạy 2026-11-01 (global volume `dramaclaw-models-global`)
- Cấu hình endpoint: pool `AMPERE_48`, `ADA_48_PRO`, `BLACKWELL_96` (thứ tự ưu tiên 48 GB trước).
- Data center cho phép: CA-MTL-3/4, EUR-IS-1..5, EUR-NO-1/2, AP-JP-1, AP-IN-1, OC-AU-1.
- Qwen t2i (`q639jfhc6uaf3t`), job gửi 14:06:00 UTC, Turbo LoRA 8 bước.
  - Worker `t87t5iyopdoluh`: EUR-IS-2, NVIDIA RTX PRO 6000 Blackwell Server Edition (96 GB), image `...-sam3-frameinterp-loras`, startedAt 14:05:06 UTC.
  - Không có A40 / Ada 48 GB còn hàng, nên RunPod đặt vào pool Blackwell (giá serverless $3,49/giờ so với A40 $1,22/giờ).
- H3 multishot (`u0hkrms7k1xeua`): worker `buokl91cpvk4cc` cũng ở EUR-IS-2, RTX PRO 6000 Blackwell Server (96 GB), image `comfy-trends-h3-multishot:0.37.2-ms2.7.2-cu130`, startedAt 14:05:19 UTC. Worker dựng lên ngay khi bật `workers.max=1` dù chưa có job (chưa có ảnh Qwen), nên tính phí chờ.
- Qwen job chuyển sang inProgress lúc 14:11:37 UTC (gửi 14:06:00; worker startedAt 14:05:06; cold start đầu tiên ở EUR-IS-2 gồm kéo image Docker ~6,7 GB + nạp model từ global volume).

### Nhật ký nạp model của worker Qwen `t87t5iyopdoluh` (từ log container, UTC)
- 14:11:14 ComfyUI khởi động xong; 14:11:17 nhận prompt (job Qwen, Turbo LoRA 8 bước).
- Mọi model đọc từ `/runpod-volume/models/...` trên global volume → **global volume mount đúng và đọc được**.
- Text encoder dùng cho Qwen 2.1: `qwen3vl_8b_int8_convrot.safetensors` (xác nhận, 8,9 GB staged) — giả định trước đó đã đúng.
- VAE `qwen_image_2.1_vae_bf16` (644 MB): 14:11:18 → staged 14:11:29 (~11 s, ~60 MB/s).
- Text encoder 8,9 GB: yêu cầu nạp 14:11:35 → staged 14:11:41 (~6 s).
- ComfyUI báo `Using pytorch attention` (Qwen image chưa bật Sage; endpoint Qwen không có `--use-sage-attention`).

### Kết quả bước Qwen (previs Three.js → ảnh photoreal)
- Tổng thời gian từ lúc gửi job đến khi có ảnh: **731,9 s** (14:06:00 → ~14:18:12 UTC), gồm kéo image Docker ở data center mới, cold start, nạp model từ global volume và sinh ảnh. Qwen 2.1, Turbo LoRA 8 bước, 1344×768.
- Chất lượng: bố cục, vị trí nhân vật, tỉ lệ người/thùng và góc máy giữ đúng theo previs; chất liệu phẳng chuyển hoàn toàn sang ảnh thật. Chưa dùng sheet identity nên mặt/trang phục là do model tự chọn theo prompt.
- GPU: RTX PRO 6000 Blackwell Server (96 GB) tại EUR-IS-2.

### Nhật ký worker H3 multishot `buokl91cpvk4cc` (UTC)
- 14:18:18 worker bắt đầu (image đã có sẵn ở EUR-IS-2 từ lần dựng worker trước 14:05); 14:18:33 ComfyUI sẵn sàng; 14:18:35 nhận prompt (shot 1/2, fl2va, PDD 8 bước).
- DiT `minimax_h3_fl2va_pruned_int8_convrot` (21 GB) nạp từ global volume: 14:18:36 → 14:20:15 = **~99 s (~210 MB/s)**. Kiểm tra `partition check ok: fl2va file on fl2va model`.
- VAE video fp16 đọc từ `/runpod-volume/models/vae/...` (global volume mount đúng).
- Quan sát chi phí: endpoint đặt `workers.max=1` nhưng RunPod dựng **2 worker** cùng lúc (`dty3wzm3oqxjw7` IDLE, bắt đầu 14:18:23, thừa). Mỗi worker Blackwell tính $3,49/giờ khi chạy/idle; hiện tượng này đã gặp trước đó với endpoint dùng chung.

### H3 multishot fl2va, PDD 8 bước, 1344×768, 124 khung/shot — RTX PRO 6000 Blackwell 96 GB (EUR-IS-2)
Mốc từ log worker `buokl91cpvk4cc` (UTC), shot 1/2:
- 14:18:35 nhận prompt; 14:20:15 DiT nạp xong từ global volume (~99 s); 14:20:47 PDD áp xong.
- 14:20:48 → 14:23:52 nạp text encoder 32B NVFP4 (15 GB staged).
- 14:23:52 → 14:28:13 **encode text ~4,3 phút** (pha chậm nhất ngoài sampling lần đầu).
- 14:28:34 nạp DiT vào VRAM (reserve 77,3 GB, ~12,3 GB trọng số phải stream).
- Sampling bước đầu tiên **321,8 s** (khởi tạo mô hình/stream lần đầu), 7 bước còn lại **~7,5–8,0 s/bước** → 8 bước ≈ 60 s sau khi khởi tạo. So với ghi chú cũ trên A40 (~55 s/bước): **Blackwell nhanh ~7 lần mỗi bước**.
- 14:35:28 → 14:37:48 decode VAE video + VAE audio ~2,3 phút; shot 1 lưu xong **14:37:48** (tổng shot 1 ≈ 19,5 phút kể từ nhận prompt, trong đó cold start/encode/khởi tạo chiếm phần lớn).
- Shot 2 bắt đầu 14:37:48; DiT đã nạp lại 14:38:03 (nhanh hơn nhiều vì trọng số còn trong RAM).
