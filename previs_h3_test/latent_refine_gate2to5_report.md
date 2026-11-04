# Latent refine vs SeedVR2: cổng 2–5 trên pod RTX 6000 Ada (2026-11-04)

Tiếp nối `latent_refine_vs_seedvr2.md`. Pod RunPod `hshgfstc7ruswj` (RTX 6000 Ada 48 GB, secure, $0,99/giờ, cgroup RAM 57,7 GiB, driver 595.91.07), chạy 11:15–13:10 giờ VN, xoá lúc 13:18. Tổng ~2,4 giờ ≈ $2,4. Thời gian dựng pod: `pod_startup_timing.md`.

Dữ liệu và log: `runs/*_g2_*`, `*_g3_*`, `*_g4_*`, `*_g5_*` (mỗi thư mục có `meta.json`, `mem.csv`, `sysmon.csv`, `comfy.log`, `steps.json`, `quality.json`, `result.json`, `graph.json`, `video.mp4` đã commit-ignore), `runs/latent_refine_index.csv`, và log cả pod ở `runs/_pod_rtx6000ada/` (`setup.log`, `gate*.log`, `gate*.sh`, `bench/comfy_server.log`, `setup_timing.csv`, `download_timing.csv`). Clip: skit `who_has_it_worse`, shot 0/1/2, 124 khung, seed 42, một skit duy nhất.

## Kết quả

| Cổng | Cấu hình | Thời gian | Ghi chú |
|---|---|---|---|
| 2 | `direct` 768P | 195 s | chuẩn |
| 2 | draft 0.3 + LBH + refine, 768P | 96 s (−51%) | khung giây 2,5 sạch |
| 2 | draft 0.3 + bislerp + refine, 768P | 81 s (−58%) | có vệt cành lạ ở khung giây 2,5 |
| 3 | LBH 2K (upscale từ clip 768P), clip 0/1/2 | 559 / 561 / 588 s | **nhiễu ở cuối clip** (xem dưới) |
| 3 | SeedVR2 7B 2K, clip 0/1/2 | 478 / 477 / 480 s | sạch cả 3 clip |
| 4 | LBH `--split` 4K, 22 khung | 140 s | sạch |
| 4 | LBH `--split` 4K, 124 khung | 876 s (14,6 phút, trong giới hạn 30) | 3780×2160, sạch suốt clip |
| 5 | draft 0.3 → 2K một graph, LBH | 558 s | **nhiễu ở cuối clip** |
| 5 | draft 0.3 → 2K một graph, bislerp | 529 s | **nhiễu cả clip** (gợn kiểu kính mờ) |

## Đánh giá

- **H2 (LBH 2K thay SeedVR2) không đạt.** Về thời gian LBH chậm hơn SeedVR2 ~17% (trong ngưỡng 1,5 lần), nhưng chất lượng thua: ở cả 3 clip LBH có đoạn nhiễu. Clip 0 từ khung ~100 trở đi là nhiễu khối thuần (khung giây 4,5 không còn hình; độ nhiễu Laplacian tăng từ ~180 lên ~420); clip 1, 2 tụt ở khung ~96 (còn 69 và 87) rồi hồi lại. SeedVR2 ổn định suốt (130–200) trên cả 3 clip. Cosine mặt (SFace) so với khung 768P nguồn: LBH 0,57–0,74, SeedVR2 0,65–0,98 ở giây 0,5 và 2,5; khung giây 4,5 không dùng được vì LBH mất mặt ("no face") ở cả 3 clip. Clip 1 giây 2,5 cả hai đều dưới ngưỡng (0,03 và 0,08), nhiều khả năng do mặt nghiêng áp vào bia, detector không đáng tin. Chưa chấm mù bằng người.
- **H1a (draft thấp rồi nâng latent) có lợi tốc độ ở 768P**: nhanh hơn 51% so với sinh thẳng, khung sạch với LBH. Mẫu nhỏ (một clip, một seed, một khung được xem).
- **Draft thẳng lên 2K trong một graph chỉ nhanh ~17% so với SeedVR2** (558 s so với 195 + 478 = 673 s), vì phần refine ở 2K chiếm phần lớn thời gian, lại có nhiễu cuối clip. Không đáng dùng.
- **bislerp ở 2K hỏng hoàn toàn** (độ nhiễu ~1700 so với ~180): xác nhận ghi chú cũ về "colour-noise mush". Ở 768P (cổng 2) nhẹ hơn nhưng vẫn có vệt lạ.
- **4K `--split` chạy sạch** 124 khung trong 14,6 phút (7,1 s/khung). Chưa có baseline SeedVR2 4K trên máy này để so; số cũ trên 4090 ~5,7 s/khung.
- **Giả thuyết chưa kiểm chứng:** nhiễu cuối clip của LBH 2K có thể do VRAM sát trần (đỉnh 47,1 GiB trên 48 GiB, không có `--split`). 4K có `--split` thì sạch. Việc cần làm tiếp: chạy lại LBH 2K với `--split` để tách nguyên nhân.

## Tài nguyên

| Cấu hình | VRAM đỉnh (nvidia-smi, gồm vùng allocator giữ chỗ) | RSS đỉnh ComfyUI |
|---|---|---|
| `direct` 768P | 39,8 GiB | 45,1 GiB |
| draft + refine 768P | 43,3 GiB | 46,1 GiB |
| LBH 2K | 47,1 GiB | 46,0–52,1 GiB |
| SeedVR2 7B 2K | 31,8–36,1 GiB | 46,0–52,0 GiB |
| LBH `--split` 4K 124 khung | 44,1 GiB | 53,0 GiB |
| draft → 2K một graph | 47,1 GiB | 55,5 GiB |

RAM cgroup giới hạn 57,7 GiB, RSS ComfyUI tăng dần qua các lượt tới 55,5 GiB nhưng không có swap và không OOM. Tức pod 62 GB đủ cho kịch bản này, sát nếu chạy nhiều lượt liên tiếp không khởi động lại ComfyUI.

## Kết luận

Không đưa LBH latent upscale 2K vào sản phẩm: SeedVR2 7B nhanh hơn, ổn định hơn và giữ mặt tốt hơn. Hướng draft + LBH ở 768P (H1a) đáng thử thêm nhiều clip/seed trước khi tích hợp. Chưa làm: chấm mù, LBH 2K với `--split`, SeedVR2 4K baseline, `--draft-mp 0`, skit dọc 9:16.

Ghi chú vận hành: bước SeedVR2 1,5x + Lanczos bị bỏ theo yêu cầu. Thư mục `*_g3_sv15_c0` (bị cắt giữa chừng) và `g3_lanczos_c0` (Lanczos thuần của clip 0, hoàn chỉnh) vẫn nằm trong `runs/` nhưng không dùng trong đánh giá; thư mục `*_g3_lbh2k_c1` bản 04:55 UTC bị ngắt khi dừng script, bản đúng là 04:57 UTC.
