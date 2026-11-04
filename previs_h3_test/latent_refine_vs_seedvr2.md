# Latent refine (ý tưởng Open-H3-Regenerate-2K) vs SeedVR2: kết quả sơ bộ và việc còn dở

Plan gốc: `PLAN_latent_refine_vs_seedvr2.md`. Báo cáo này ghi kết quả của lần chạy đầu trên 4090 thuê (2026-11-03) và những gì chưa làm. Chưa phải báo cáo cuối của plan.

## Đã làm (2026-11-03, 1 máy 4090 24 GB, 120 GB RAM, NVMe)
- Cài box bằng `scripts/setup_h3_box.sh --with-latent-refine`; `object_info` có đủ `MinimaxH3LatentUpscaler3D`, `MMH3SplitUpscale`, `MMH3SpatialSplitParamsV10`, `ManualSigmas`, `LTXVSeparateAVLatent`, `LTXVConcatAVLatent`, `MiniMaxH3AddGuide`. Tên input của upscaler khớp script.
- Cổng 1 (22 khung, 1344×768 → 1080p, turbo LoRA 3 bước): LBH so với bislerp, rồi σ0 0,7 và 0,5.
- Full clip cáo/ếch 30 s (739 khung) 1080p, LBH, σ0 0,7, seam `guide`.
- Skit `who_has_it_worse` sinh lại (3×243 khung, PDD 8) và refine 1080p bằng cách trên.
- Run data: `runs/*_eloquent-emu_*`, `runs/latent_refine_index.csv`, log box ở `runs/_box_eloquent/`. Video (không commit) ở `previs_h3_test/compare_latent_refine/` trên máy local của người chạy (đã exclude khỏi git).

## Số đo
| Hạng mục | Kết quả |
|---|---|
| Upscale 768P → 1080p, 124 khung | ~146 s/đoạn, ~1,2 s/khung (clip 30 s: 921 s; skit 30 s: 931 s) |
| Sinh skit 3×243 khung | 1055 s; sampling ~36 s/bước, init ~38 s/shot, decode video ~31 s/shot |
| VRAM đỉnh | ~24 GB (gồm vùng allocator giữ chỗ), không OOM; RAM trống tối thiểu 66 GB |
| Audio | giống từng byte với bản gốc |
| Mối nối giữa đoạn | độ lệch khung liên tiếp ở 5 điểm nối bằng clip gốc, không thấy nhấp nháy do refine |

Cổng 1, so với nguồn (PSNR, chỉ là mức vẽ lại, không phải độ đẹp):

| Cấu hình | Thời gian (22 khung) | PSNR |
|---|---|---|
| LBH, σ0 0,9 | 31 s | 23,1 |
| bislerp, σ0 0,9 | 31 s | 23,5 |
| LBH, σ0 0,7 (`nvlabs2`) | 28 s | 25,2 |
| LBH, σ0 0,5 | 28 s | 25,3 |

## Kết luận sơ bộ
1. Hướng này chạy được trên 24 GB: latent upscale rồi refine ngắn bằng chính H3 cho video 1080p, không cần SeedVR2.
2. Lỗi "colour-noise mush" trong ghi chú cũ không tái hiện ở σ0 0,9 (cả LBH lẫn bislerp ra ảnh sạch). Chưa tách được nguyên nhân lỗi cũ của `two_stage`.
3. σ0 0,9 vẽ lại cảnh (mất khăn đỏ, đổi mặt, PSNR ~23); không dùng để làm nét. σ0 0,5–0,7 giữ được khăn đỏ và bố cục, nhưng mặt vẫn hơi khác nguồn.
4. LBH chưa hơn bislerp rõ ràng ở σ0 0,9 (PSNR thấp hơn 0,5 dB, cùng tốc độ).
5. Chi phí là điểm yếu: refine ~15 phút cho 30 s, gần bằng thời gian sinh (17,6 phút). Chưa so được với SeedVR2 vì chưa đo SeedVR2 ở cùng 1080p (số cũ ở 2K: ~2,7 s/khung).

Giới hạn: 1 clip chính, 1 seed, mới xem bằng mắt crop của clip 22 khung; chưa đo cosine mặt; chưa chấm mù.

## Việc còn dở
Cập nhật 2026-11-04: cổng 2, 3, 4 và bản "draft thẳng lên 2K" đã chạy trên RTX 6000 Ada, kết quả và đánh giá ở `latent_refine_gate2to5_report.md` (LBH 2K thua SeedVR2: nhiễu cuối clip; draft + LBH ở 768P nhanh hơn 51%).
- [x] **Cổng 2 (H1a):** `latent_refine_local.py gen` với `--draft-mp 0,3` rồi upscale/refine, so thời gian và chất lượng với `direct` (sinh thẳng 768P, cùng prompt/seed) và `two_stage` hiện tại (bislerp + PDD). Đây là nơi plan kỳ vọng lợi ích thật (nhanh hơn ≥ 25%).
- [x] **Cổng 3 (H2):** (đã chạy LBH vs SeedVR2 7B 2K; không chạy 1,5x + Lanczos theo yêu cầu) upscale 2K 124 khung trên 3 clip và so với baseline SeedVR2 7B 2K (`upscale_video_local.py`, cấu hình nhanh nhất), SeedVR2 1,5x + Lanczos, Lanczos thuần. Gồm cả 2 shot liền nhau để kiểm mối nối. Đo VRAM thật ở 2K.
- [x] **Cổng 4 (H3):** 4K bằng `--split` (`MMH3 Split Upscale`), 25 khung rồi 124 khung; dừng nếu quá 30 phút cho 124 khung.
- [ ] Đo bổ sung: cosine mặt (`scripts/face_similarity.py`), Laplacian vùng mặt, PSNR/SSIM sau khi thu về 768P, A/B LoRA (turbo / turbo + LMS) và upscaler LMS (`h3_upscaler_lms_v0.1`).
- [ ] Trang HTML so sánh song song để chấm mù; tiêu chí thắng 2K: chọn ≥ 2/3 clip, cosine mặt không thấp hơn SeedVR2 quá 0,05, thời gian ≤ 1,5 lần SeedVR2.
- [x] Skit bản **dọc 9:16**: `bench_multishot30_local.py` đọc `aspect_ratio` từ skit JSON (mặc định 9:16). Đã sinh lại 768×1344, 30,29 s trên RunPod L40S, xem `skit_916_l40s_run.md` (1827 s, ~$1,09).
- [ ] Skit refine chưa xem kỹ bằng mắt nội dung 30 s (mặt, chữ, chi tiết nhỏ có bị vẽ lại không).
- [ ] Bước 5 (tích hợp code sản phẩm: `build_h3_ref2va_graph` đổi node `"60"`/`"61"–"62"`, biến `.env` `RUNPOD_H3_STAGE2_*`, route upscale `method`): chỉ làm khi thắng ở cổng 3 và được duyệt; cần build lại image worker có pack LBH.

## Bẫy đã gặp (cho lần chạy sau)
- `LoadVideo` cũng báo mp4 đầu vào là output trong `/history`; phải lọc `type == "output"` (đã sửa trong script).
- `plan_segments` của SeedVR2 đòi 4n+1; đoạn H3 là 17n+5 (124) nên script dùng `plan_h3_segments`.
- Skit chưa có khổ dọc (xem trên).
- Vòng chờ kiểu `while pgrep -f "tên_script"` tự khớp với chính lệnh chờ; dùng `pgrep -f "[t]ên_script"` hoặc cờ file.
- Box thuê chỉ nhận mật khẩu SSH: cần `ssh-copy-id` thủ công một lần. Đừng commit file chứa mật khẩu; đổi mật khẩu khi trả máy.
