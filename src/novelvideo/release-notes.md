---
version: 2.0.6
attention: low
---
# v2.0.6

## User-facing Highlights (vi)

- **Kéo dài video**: Kéo dài video trên canvas khi đã cấu hình model tương ứng, đồng thời giữ nguyên tỉ lệ khung hình gốc.
- **Nâng cao chất lượng và tốc độ khung hình video**: Dùng các model đã cấu hình để điều chỉnh độ phân giải và tốc độ khung hình, bao gồm cả nội suy khung hình.
- **Tách âm thanh xuất MP3**: Âm thanh được tách ra nay ở định dạng MP3, dùng được làm âm thanh tham chiếu cho các model hỗ trợ định dạng này.

## User-facing Highlights (en)

- **Video extension**: Extend a canvas video when a compatible model is configured, while preserving its aspect ratio.
- **Video quality and frame-rate enhancement**: Use configured models to adjust resolution and frame rate, including frame interpolation.
- **MP3 output from audio separation**: Extracted audio is now MP3, making it usable as reference audio for models that accept this format.

## Fixes

- Audio separation now actually transcodes to MP3 and stays compatible with existing M4A results (#631).

## Improvements

- Added a configurable video extension mode and the matching canvas entry point (#662).
- Added a model-driven video enhancement flow and improved node-state sync when tasks resume (#716).
