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

---

# Phần 2: job 2 shot với bộ đo RAM mới (2026-11-03 04:24 → 04:53 UTC)

Job `31d5e9dc-734a-459f-88d3-3e6111804b15-u1`, cùng worker `cvojuwf3756xze`, cùng cấu hình, 2 shot × 124 khung, seed 1234.
Bộ đo mới (`scripts/memmon.sh`, đưa vào worker qua biến env `MEMMON_B64` + `cmd` của endpoint) đọc cgroup **v1**
(worker dùng cgroup v1, nên bản đo trước đọc `memory.current` của v2 bị rỗng) và `/proc/<pid>/status` của ComfyUI.

## Số liệu thật
- `executionTime` 29,5 phút (04:24:07 → 04:53:38), `delayTime` 14 s (worker ấm, image đã có). Video 247 khung, 10,29 s, 14,2 MB.
- Shot 1: 04:28:31 → 04:43:04 = **14,6 phút** (job 1: 16,8 phút). Trước shot 1 có ~4,4 phút chuẩn bị (04:24:07 → 04:28:31).
- Shot 2: 04:43:04 → ~04:53:38 = **~10,6 phút** (job 1: 10,4 phút), tức không nhanh hơn dù worker ấm.
- **RAM container đỉnh 53.861 MiB (~52,6 GiB)** (`memory.max_usage_in_bytes`) trên giới hạn 82.970 MB (~65%). Tiến trình ComfyUI VmRSS đỉnh 52.646 MiB.
  `VmLck` = 0 và `VmPin` = 0 trong mọi mẫu.
- RAM tăng đều suốt shot 1 (1,2 GB lúc 04:24 → 24,8 GB lúc 04:33 → 50,6 GB lúc 04:42) rồi **tụt còn ~18,5 GB** ở đầu shot 2 (04:45).
  Tức trọng số bị giải phóng khỏi RAM giữa hai shot.
- VRAM đỉnh 23.825 MiB, giống job 1.
- `cgroup cache` chỉ 3,7 GB: page cache của file model không tính vào cgroup của container nên không đo được qua cột này.
  `Cached` của /proc/meminfo là của cả máy chủ (~274 GB), không dùng được.

## Dữ liệu bị mất (nói thẳng)
Tôi chỉ kịp lưu log của worker đến 04:45:46 (CSV: `bench_4090_ms2_ram_mem.csv`, 259 mẫu, 5 s/mẫu). Sau khi job xong tôi gọi `update-endpoint` (`workers.max=0`)
trước khi lấy phần log còn lại, và khi lấy thì RunPod trả `worker not found`. Không rõ worker biến mất do lệnh đó hay do `idleTimeout` 90 s.
Hậu quả:
- **Không có đỉnh RAM/VRAM của shot 2** (đỉnh RAM 53.861 MiB là của shot 1; `memory.max_usage_in_bytes` là đỉnh tích lũy nên shot 2 có thể cao hơn).
- **Không tách được pha của shot 2**, nên chưa trả lời được "khởi tạo DiT ở shot 2 còn 5–6 phút không". Chỉ có tổng 10,6 phút, khớp với job 1 (10,4 phút), nên khả năng cao là còn.
- Bài học cho lần sau: lấy hết log trước khi đặt `workers.max=0`, hoặc ghi log ra nơi khác (R2) từ trong worker.

## Suy luận (chưa kiểm chứng)
- Với giới hạn RAM 81 GiB, worker 4090 này không thiếu RAM. Đỉnh 52,6 GiB lớn hơn giới hạn 46,6 GiB mà ghi chú dự án từng ghi cho worker A40,
  nên việc A40 từng OOM RAM phù hợp với ngưỡng đó quá thấp so với mức model cần, chứ không chỉ do clip dài.
- RAM tụt giữa hai shot cho thấy trọng số được nạp lại ở mỗi shot, phù hợp với việc "Model Initializing" lặp lại ở mỗi shot.
  Cần job đo đầy đủ pha của shot 2 để chốt.

---

# Phần 3: thử "model ở ổ cục bộ" bị hủy (2026-11-03 05:14 → 05:30 UTC)

Mục tiêu: kiểm chứng giả thuyết "khởi tạo DiT lặp mỗi shot là do đọc lại model qua global volume" bằng cách chép 5 file model (~41 GB) vào `/local-models`
(`scripts/localcopy.sh`, `disk` 60 GB, `--extra-model-paths-config /tmp/local_paths.yaml` với `is_default: true`) rồi chạy lại job 2 shot.

Kết quả: **không có số liệu.** Job `d2f6571e-5a20-421d-b062-349c31718270-u1` ở `IN_QUEUE` suốt ~13 phút. Ba worker (EUR-IS-2) kéo xong image (05:22–05:23, ~8 phút) nhưng ở
trạng thái `THROTTLED` (4090 tồn kho `Low`), không container nào chạy. Job đã hủy lúc ~05:30, endpoint `workers.max=0`, `idleTimeout` 90.
Chưa biết: thời gian chép model, ComfyUI có thật sự dùng `/local-models` hay không, và `fast_disk` có đổi thành `True` không.
Cần chạy lại khi có GPU (hoặc dùng GPU 48 GB để tách "VRAM nhỏ" khỏi "ổ chậm").
