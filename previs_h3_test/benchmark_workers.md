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
