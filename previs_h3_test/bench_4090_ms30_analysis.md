# H3 multishot 30 s trên RTX 4090 24 GB — phân tích RAM/VRAM (2026-11-03)

Job `3e0ea358-4fae-453f-85fb-211ac22bc049-u2`, endpoint thử `wshx3f8j38jvqy` (pool `ADA_24`, EUR-IS-2, worker `cvojuwf3756xze`),
image `comfy-trends-h3-multishot:0.37.2-ms2.7.2-cu130`, fl2va PDD 8 bước, 6 shot × 124 khung, 1344×768, seed 1234.
Dữ liệu gốc: `bench_4090_ms30_vram.csv` (nvidia-smi mỗi 5 s, 912 mẫu, 02:50:02 → 04:06:01, không có khoảng trống > 15 s)
và `bench_4090_ms30_events.log` (log container đã lọc). Hai file ghép từ 5 lần đọc `stream-worker-logs` chồng lên nhau.

## Cấu hình bộ nhớ worker (từ log ComfyUI)
- `Total VRAM 24083 MB, total RAM 82970 MB`; `RAM limited by cgroup to 82970 MB (host has 451126 MB)`.
- `Set vram state to: NORMAL_VRAM`, `Using async weight offloading with 2 streams`, `Enabled pinned memory 66585` (MB),
  `DynamicVRAM support detected and enabled` (comfy-aimdo 0.5.5), `Using RAM pressure cache`.
- `[H3AutoReserve]`: giữ hết 19,5 GB trọng số DiT thì thiếu 13,4 GB → stream ~18,5 GB trọng số, reserve 19,2 GB.
- Kích thước "Staged": text encoder 14.956 MB, DiT 19.995 MB, VAE video 4.965 MB, VAE audio 576 MB (tổng 40.492 MB).

## VRAM (đo thật, nvidia-smi `memory.used`)
- Đỉnh toàn job: **24.077 MiB / 24.564 MiB lúc 03:11:29**, tức lúc chuyển từ decode audio shot 1 sang encode text shot 2.
  Đỉnh này KHÔNG nằm trong lúc sampling.
- Trong pha DiT (sampling): đỉnh 23.813–23.825 MiB. Trong pha decode VAE video: 23.725–24.015 MiB.
- Trong pha encode text (shot 3–5): 11,0–23,4 GB.
- `memory.used` của nvidia-smi gồm cả bộ nhớ pool của `cudaMallocAsync` đã giữ chỗ, và H3AutoReserve cố ý giữ 19,2 GB.
  Nên ~98% là allocator dùng hết chỗ có sẵn, không chứng minh model cần đúng chừng đó. Không có OOM.

| Shot | Encode text | DiT (gồm khởi tạo) | trong đó "Model Initializing" | 8 bước sampling | Decode VAE video | Decode audio | Tổng shot |
|---|---|---|---|---|---|---|---|
| 1 | 290 s | 530 s | 405 s | 90 s | 167 s | 20 s | 16,8 phút |
| 2 | 18 s | 473 s | 360 s | 90 s | 122 s | 11 s | 10,4 phút |
| 3 | 276 s | 444 s | 333 s | 90 s | 131 s | 11 s | 14,4 phút |
| 4 | 246 s | 434 s | 324 s | 90 s | 152 s | 11 s | 14,1 phút |
| 5 | 270 s | 444 s | 325 s | 90 s | 173 s | 16 s | 15,1 phút |

Sampling ổn định 11,76 s/bước. **Nút thắt là bước "Model Initializing" trước bước 1: 5,4–6,8 phút ở MỌI shot**,
lớn gấp ~4 lần sampling. Trên Blackwell 96 GB bước này chỉ tốn 321 s ở shot đầu. Trên 4090 nó lặp lại mỗi shot,
khớp với log `TE evicted; 17.7 GB free for the DiT` mỗi shot (text encoder và DiT đổi chỗ nhau mỗi shot).

## RAM: CHƯA ĐO ĐƯỢC
- Lệnh đọc `/sys/fs/cgroup/memory.current` thất bại (file không tồn tại), nên mọi dòng `RAMMON` đều rỗng.
- Không có dòng OOM, `Killed` hay `Traceback` trong log.
- Suy luận (chưa kiểm chứng): tổng trọng số "Staged" ~40,5 GB, pinned memory tối đa 66,6 GB, giới hạn cgroup 83 GB.
  Nếu page cache của file model bị đẩy khỏi RAM giữa các shot, mỗi shot phải đọc lại ~20 GB DiT từ global volume.
  ~20 GB / ~325 s ≈ 60 MB/s, gần tốc độ đọc global volume đã đo ở EUR-IS-2 trước đây (~60 MB/s cho VAE; DiT lần đó 210 MB/s).
  Đây là giả thuyết số 1 cho bước khởi tạo lặp lại, chưa phải kết luận. Không phải PCIe: 20 GB qua PCIe 4.0 chỉ ~1–2 s.
- Encode text ~4,5 phút/shot (trừ shot 2: 18 s) cũng khớp kiểu "đọc lại 15 GB text encoder", nhưng cũng chưa kiểm chứng.

## Cần làm để có số RAM thật
- Sửa lệnh đo: thử theo thứ tự `/sys/fs/cgroup/memory.current` + `memory.peak` (v2), `/sys/fs/cgroup/memory/memory.usage_in_bytes`
  + `memory.max_usage_in_bytes` (v1), rồi `free -m`; và in `Cached`/`Active(file)` từ `/proc/meminfo` để thấy page cache.
- Chạy lại một job 2 shot (không cần 6) để xem shot 2 có còn bước khởi tạo 5–6 phút không.
- Thử `--disable-pinned-memory` hoặc đọc trước file model vào RAM để kiểm tra giả thuyết page cache.
