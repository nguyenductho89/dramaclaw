# Thời gian dựng pod RunPod từ đầu đến khi chạy được (2026-11-04)

Mục đích: cân nhắc bỏ serverless, tạo pod mới mỗi lần. Pod `hshgfstc7ruswj`, RTX 6000 Ada 48 GB, secure cloud $0,99/giờ, đĩa container 250 GB, image `runpod/pytorch:1.0.3-cu1281-torch291-ubuntu2404`, bằng `runpodctl pod create`. RAM cgroup 62 GB (host báo 503 GB), driver 595.91.07, 128 vCPU nhìn thấy.

| Mốc (UTC) | Giờ | Từ lúc tạo pod |
|---|---|---|
| Thử tạo community RTX 6000 Ada: "no longer any instances" | 03:51:30 | |
| Tạo pod secure thành công | 03:51:35 | 0 |
| Container chạy (suy từ `uptimeSeconds`) | ~03:53:38 | ~2 phút |
| SSH vào được lần đầu (xem ghi chú) | 04:04:49 | 13 phút 14 giây |
| Bắt đầu `setup_h3_box.sh` | 04:05:21 | |
| Cài xong + tải model xong | 04:08:21 | +179 giây |
| ComfyUI trả lời `system_stats`, node H3 có đủ | 04:08:59 | **17 phút 24 giây** |

Ghi chú:
- **Phần lớn 13 phút đầu là do phía tôi, không phải RunPod.** `runpodctl ssh info` báo "not ready" rất lâu dù `pod get` đã `running` từ ~03:53:38, và tôi dùng nhầm khoá SSH (`~/.ssh/id_ed25519`, không có trên pod) cho đến 04:04:49. Khoá đúng là `~/.runpod/ssh/runpodctl-ssh-key`. Mốc "SSH sẵn sàng" thật nhiều khả năng sớm hơn, không đo được.
- Ước tính tối thiểu nếu làm đúng ngay từ đầu: ~2 phút chờ container + ~3 phút cài + ~0,5 phút khởi động ComfyUI ≈ **5,5–6 phút**.
- Cài đặt (`setup_timing.csv`): apt 8 s, uv venv + ComfyUI 135 s, clone custom node 4 s, torch + sage 30 s, model tải nền song song.
- Tải model (`download_timing.csv`): 9 file, ~48 GB, tốc độ 192–385 MB/s; DiT 21 GB mất 52 s, text encoder 15,7 GB mất 39 s.
- Community cloud hết máy RTX 6000 Ada lúc tạo; secure đắt hơn ($0,99 so với $0,74). Community cũng không đảm bảo cổng SSH công khai.
- Tạo pod cần `--ports 22/tcp`. Tôi không dùng `--wait` ở lần tạo thành công (secure), nên thời gian chờ SSH tự động chưa đo.
