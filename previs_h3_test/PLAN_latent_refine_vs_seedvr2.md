# Plan: lấy ý tưởng Open-H3-Regenerate-2K để cải thiện pipeline H3 hiện tại (2K/4K, thử trên 4090)

## Context
- Hiện tại: H3 sinh 1344×768, rồi SeedVR2 7B (pixel) nâng 2K/4K. Trên 4090: 2K ~5,6 phút, 4K ~11,8 phút cho 124 khung. 2x hay bịa chi tiết trên mặt nhỏ.
- Code đã có sẵn `two_stage` trong `build_h3_ref2va_graph` (`src/novelvideo/generators/runpod_minimax_h3_video.py`): pass 1 ở 1/1.5 độ phân giải → `MiniMaxH3AVLatentUpscaleBy` (**bislerp**) → redraw bằng nhánh PDD `denoise=0.35`. **Chưa từng benchmark.** Ghi chép cũ (`runpod-h3-qwen-endpoints.md` mục 5): tác giả pack multishot đã bỏ upscale latent hai lượt vì nội suy latent H3 ra khỏi manifold → "colour-noise mush".
- Open-H3-Regenerate-2K (NVlabs) giải đúng chỗ đó. User muốn **chỉ lấy ý tưởng**, không chạy CLI/pipeline của NVlabs (cần 150 GB VRAM). Ba ý tưởng đáng lấy:
  1. **Upscale latent bằng mô hình đã học** thay cho nội suy: node `MinimaxH3LatentUpscaler3D` (`LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler`, MIT, ComfyUI gốc; NVlabs chép nguyên văn node này).
  2. **Refine ngắn ở độ phân giải đích**: thêm nhiễu lại từ σ≈0,9, 3 bước Euler, CFG 1, lưới shift-6 (`[0.909375, 0.857143, 0.666667, 0]`), model có LoRA turbo + LoRA làm nét. Chỉ prompt, không cần first frame.
  3. **Toàn bộ trong latent, decode 1 lần**, không qua pixel như SeedVR2.
- Ý tưởng này đã có bản ComfyUI thuần: workflow mẫu của LBH (`minimax_h3_i2v_Latent Upscaler example workflow2.json`) chạy pass 1 ở 0,2 MP (608×352) với LoRA turbo lightx2v → upscaler → pass 2 `ManualSigmas "0.9035, 0.6316, 0.3158, 0"` (3 bước), dùng `LTXVSeparateAVLatent/ConcatAVLatent` cho audio. Pack này còn có `MMH3 Split Upscale` (refine chia ô không gian và đoạn thời gian, có khử mối nối và mỏ neo theo thời gian), dùng để vượt giới hạn VRAM ở 4K.

## Ba hướng cải thiện cần thử
- **H1, sửa `two_stage` (1-shot, có latent trong graph):** thay bislerp bằng upscaler LBH, thay redraw PDD 0.35 bằng lịch kiểu NVlabs (σ0≈0,9, 3 bước, LoRA turbo). Hai mục tiêu:
  - (a) **Nhanh hơn ở cùng 768P:** pass 1 ở 0,3–0,4 MP + 3 bước refine, so với sinh thẳng 768P.
  - (b) **Ra thẳng 1080p/2K**, không cần SeedVR2.
- **H2, upscale video đã có (thay SeedVR2, dùng cho output multishot):** node multishot là khối đóng, chỉ trả video đã decode, nên phải VAE encode lại từng đoạn 124 khung (khớp đúng ranh giới shot) → upscaler → refine 3 bước → decode. Để giữ liền mạch ở mối nối giữa các shot (multishot nối liền, không cắt cảnh): ghim khung đầu của đoạn sau bằng `MiniMaxH3AddGuide` (đã dùng trong production) từ khung cuối đã refine của đoạn trước, hoặc giảm σ0 xuống 0,7 / 2 bước ở mối nối.
- **H3, 4K trên 24 GB:** `MMH3 Split Upscale` (chia ô) cho bước refine ở 4K.
- Biến thể LoRA cho bước refine (A/B): chỉ turbo; turbo + LMS Sharp (`Alissonerdx/Minimax-H3-ComfyUI`, `minimax_h3_lms_v1.0_r64`, đã đúng định dạng ComfyUI, gồm cả 50 nhánh AdaLN); tuỳ chọn upscaler `h3_upscaler_lms_v0.1` (Alissonerdx, fine-tune từ LBH). Không dùng LoRA refiner 12 GB của NVlabs (đúng ý "chỉ lấy ý tưởng"). Chỉ thêm nó làm nhánh A/B nếu refine bằng base cho kết quả kém.

## Khả thi và kỳ vọng (ước tính, chưa chạy)
- Mọi node cần đều là ComfyUI gốc hoặc pack MIT, chạy được trên ComfyUI 0.37.2 của máy 4090. Tải thêm ít: upscaler LBH ~0,7 GB, LMS r64 ~1,2 GB, LoRA turbo fl2v comfy ~1,4 GB (kiểm xem đã có trên máy chưa).
- Tốc độ 2K: refine 3 bước ở 2K ước ~5–7 phút/124 khung (token gấp 3,6 lần, attention gấp 12,7 lần so với 768P đo 12,4 s/bước), **ngang SeedVR2**. Lợi thế thật nằm ở H1(a) (sinh nhanh hơn ở 768P), không phải ở tốc độ upscale.
- VRAM 2K: ước đỉnh ~15 GB activation (tensor `mlp.fc1` ~7,6 GB) cộng phần đệm streaming, sát trần 24 GB. 4K không chia ô thì gần như chắc OOM, nên H3 dùng `MMH3 Split Upscale`.
- Chất lượng: có thể nét hơn và ít nhấp nháy hơn SeedVR2, vì refine cả 124 khung cùng lúc bằng chính H3. Rủi ro: σ0≈0,9 vẽ lại mạnh, có thể đổi mặt, chữ và chi tiết nhỏ. LoRA turbo/LMS không được train cho bài "khôi phục" như refiner của NVlabs, nên chất lượng có thể thấp hơn số liệu NVlabs công bố.

## Các bước

### 1. Cài trên máy 4090 (ComfyUI 0.37.2, model ở `/opt/models`)
- Mở rộng `previs_h3_test/scripts/setup_h3_box.sh` bằng cờ `--with-latent-refine`: cài pack LBH (ghim commit), tải upscaler LBH, LMS r64, LoRA turbo fl2v comfy; map `latent_upscale_models/` trong `extra_model_paths.yaml`.
- Kiểm `object_info`: có `MinimaxH3LatentUpscaler3D`, `MMH3 Split Upscale`, `ManualSigmas`, `LTXVSeparateAVLatent`.

### 2. Script thí nghiệm `previs_h3_test/scripts/latent_refine_local.py`
- Dựa trên `upscale_video_local.py` và `bench_multishot30_local.py` (tái dùng `http/upload/run_graph`, run dir + `index.csv`, `memmon`, `parse_h3_log.py`). Hai chế độ:
  - `--mode gen` (H1): prompt (+ first frame) → pass 1 ở `--draft-mp` → upscaler → refine ở `--target 768p|1080p|2k` → decode. Graph lấy theo workflow mẫu LBH, viết lại thành dict API.
  - `--mode upscale` (H2/H3): video có sẵn → cắt đoạn 124 khung theo ranh giới shot → encode → upscaler → refine → decode → ghép, giữ audio gốc. Neo mối nối bằng `MiniMaxH3AddGuide` (`--seam guide|sigma|none`); `--split` để dùng `MMH3 Split Upscale`.
  - Chung: `--steps 3|2`, `--start-sigma`, `--loras turbo,lms`, `--upscaler lbh|lms`, `--seed`.
- Thứ tự chạy, mỗi bước là một cổng:
  1. Upscale 768P→1080p, 25 khung, chỉ để kiểm có ra rác/"mush" không, so luôn với bislerp (lặp lại lỗi cũ để xác nhận upscaler học được có sửa được không).
  2. H1(a): gen 0,3 MP → 768P, 124 khung, so thời gian và chất lượng với sinh thẳng 768P (cùng prompt, seed).
  3. H2: upscale 2K 124 khung trên 3 clip; sau đó 2 shot liền nhau để kiểm mối nối.
  4. H3: 4K bằng `MMH3 Split Upscale`, 25 khung rồi 124 khung; dừng nếu quá 30 phút cho 124 khung.

### 3. Clip test và baseline (cùng máy)
- 3 clip 1344×768: cáo/ếch (`bench_4090_ms30.mp4`, 2 shot đầu để kiểm mối nối), skit `who_has_it_worse` (mặt cỡ trung), một clip có mặt nhỏ (kiểm lỗi bịa chi tiết). Prompt lấy từ skit JSON.
- Baseline: SeedVR2 7B 2K/4K (`upscale_video_local.py`, cấu hình nhanh nhất đã đo), SeedVR2 1.5x + Lanczos, Lanczos thuần. Riêng H1(a): baseline là sinh thẳng 768P và `two_stage` hiện tại (bislerp + PDD).

### 4. So sánh và báo cáo
- Số đo: thời gian/giây video, VRAM và RAM đỉnh; `video_quality.py`; Laplacian vùng mặt; `scripts/face_similarity.py` so với nháp; PSNR/SSIM sau khi thu về 768P (đo mức vẽ lại); chênh lệch ở mối nối shot.
- Trang HTML so sánh song song để user chấm mù.
- `previs_h3_test/latent_refine_vs_seedvr2.md`. Tiêu chí thắng ở 2K: được chọn ≥ 2/3 số clip, cosine mặt không thấp hơn SeedVR2 quá 0,05, thời gian ≤ 1,5 lần SeedVR2. H1(a) thắng nếu nhanh hơn ≥ 25% so với sinh thẳng 768P mà người chấm không thấy kém hơn.

### 5. Tích hợp vào code sản phẩm (chỉ khi thắng, cần user duyệt sau bước 4)
- H1: trong `build_h3_ref2va_graph`, đổi node `"60"` (`MiniMaxH3AVLatentUpscaleBy`) sang `MinimaxH3LatentUpscaler3D` và nhánh `"61"–"62"` (PDD 0.35) sang `ManualSigmas` + LoRA turbo/LMS. Thêm biến `.env` kiểu `RUNPOD_H3_STAGE2_UPSCALER`, `RUNPOD_H3_STAGE2_SIGMAS`, và gỡ ràng buộc "two_stage cần PDD". Cập nhật `tests/test_h3_two_stage_audio_refine.py`.
- H2: generator mới cạnh `generators/runpod_seedvr2_upscale.py` (tái dùng `plan_segments`/`iter_stitched`/`write_video_stream`), cùng route/task với upscale SeedVR2 hiện có (`freezone_video_upscale_seedvr2`), chọn bằng tham số `method`.
- Image worker phải có pack LBH và model trên volume: build lại image (`runpod/`), nên chỉ làm khi đã chốt.

## Lưu ý
- Không dùng RunPod trong giai đoạn thí nghiệm, chỉ máy 4090 thuê (22.500đ/giờ). Không commit video.
- Giấy phép: pack LBH là MIT; LoRA turbo/LMS có giấy phép riêng (LMS: tổ chức doanh thu trên 1 triệu USD phải ghi nguồn); H3 theo MiniMax Community License như hiện tại.
- Thời gian dự kiến: cài 1 giờ; cổng 1–2 ~1 giờ máy; H2 + baseline 2–3 giờ; H3 1–2 giờ.

## Verification
- Bước 1: `object_info` có đủ node; nạp LoRA không có `lora key not loaded`.
- Cổng 1: upscaler học được không ra "mush", trong khi bislerp ra (hoặc ghi lại nếu cả hai đều ổn).
- Mỗi lần chạy có run dir + dòng `index.csv`; báo cáo có bảng số, crop mặt/mối nối, trang so sánh.
