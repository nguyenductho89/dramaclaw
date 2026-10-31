# RunPod endpoints — checkpoint, cấu hình, file đã tải

Snapshot trạng thái thật (đọc qua API `get-endpoint`/`get-network-volume`, 2026-10-29). Tài liệu
quyết định/lịch sử chi tiết hơn: `runpod-h3-qwen-endpoints.md` (cùng thư mục) — file này chỉ là
bảng tham chiếu nhanh, không lặp lại lý do từng quyết định.

## Hạ tầng chung

| | |
|---|---|
| Network Volume | `zyen2jmxt3` ("photoreal-drama-h3-ca-mtl-1"), 200GB, `HIGH_PERFORMANCE`, data center `CA-MTL-1` |
| Dùng chung bởi | Cả 3 endpoint dưới đây — cùng 1 bộ model trên đĩa, khác nhau ở `extra_model_paths.yaml` map được những thư mục nào |
| Object storage output | Cloudflare R2, bucket `photoreal-drama-jobs` |
| Container registry | `cmv2thumk00ccduuu6jxjfyl5` (GHCR) |
| Repo chứa Dockerfile/build workflow | **Repo này** (từ 2026-10-31): `runpod/{qwen,h3,multishot}/` + `runpod/common/handler.py`, build qua GitHub Actions `.github/workflows/build-runpod-worker-image.yml` (`workflow_dispatch`, chọn `image: qwen\|h3\|multishot`, native amd64 trên `ubuntu-latest`, cần secret `GHCR_PAT`). Bản cũ ở `~/Xuongphim/photoreal-short-drama-generator` (`runpod*/`, branch `tesla`) là nguồn gốc nhưng không còn là nơi sửa; xem `runpod/README.md` |

---

## 1. `q639jfhc6uaf3t` — "qwen-image-t2i-fast"

Dùng cho: sinh/sửa ảnh (Qwen-Image 2.1 t2i, Qwen-Image-Edit-2511), SeedVR2 video upscale, SAM3
ground-plane compositing, frame interpolation (RIFE/FILM).

| | |
|---|---|
| Image hiện tại | `ghcr.io/nguyenductho89/photoreal-qwen-worker:0.37.2-sam3-frameinterp` |
| GPU | `NVIDIA A40` (pool `AMPERE_48`), 1 GPU, `minCudaVersion: 12.0` |
| Workers | `max=0` (tắt), `min=0`, `idleTimeout=90s` |
| Disk container | 20GB (ephemeral) |
| `extra_model_paths.yaml` (`runpod-qwen/extra_model_paths.yaml`) | `diffusion_models`, `text_encoders`, `vae`, `pdd_acc`, `checkpoints`, `detection`, `frame_interpolation` |

**File trên volume map được bởi endpoint này** (đường dẫn tương đối `models/<category>/`):

| Category | File | Dung lượng | Dùng cho |
|---|---|---|---|
| `diffusion_models` | `qwen_image_2.1_int8_convrot.safetensors` | — | Qwen-Image 2.1 t2i/compose |
| `diffusion_models` | `qwen_image_edit_2511_int8_convrot.safetensors` | ~20.5GB | Qwen-Image-Edit-2511 (relight/edit) |
| `diffusion_models` | `seedvr2_3b_int8_convrot.safetensors` | 3.46GB | SeedVR2 video upscale (mặc định) |
| `diffusion_models` | `seedvr2_7b_int8_convrot.safetensors` | 8,334,897,976 B (~7.76GiB) | SeedVR2 7B — **mới tải 2026-10-29**, test cho thấy tránh được lỗi hallucinate chi tiết (khuyên mũi giả) mà 3B gặp ở upscale 2x |
| `diffusion_models` | `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | — | DiT MiniMax H3 (fl2va) — chỉ nằm trên volume dùng chung, endpoint này **không** dùng tới (không có node H3 trên image Qwen) |
| `diffusion_models` | `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | — | DiT MiniMax H3 (ref2va) — cùng lý do, không dùng trên endpoint này |
| `diffusion_models` | `acestep_v1.5_turbo.safetensors` | — | ACE-Step audio (turbo) — xuất hiện trong `UNETLoader`, mục đích/ai dùng chưa rõ, có thể orphan trên volume dùng chung |
| `text_encoders` | `qwen_2.5_vl_7b_fp8_scaled.safetensors` | ~9.4GB | Text encoder cho Qwen-Image-Edit-2511 |
| `text_encoders` | `qwen3vl_32b_minimax_h3_int8_convrot.safetensors` | ~27GB | Text encoder H3 (INT8) — chỉ nằm trên volume dùng chung, không dùng trên endpoint này (xem mục "Đo tốc độ H3..." trong CLAUDE.md: INT8 encoder/VAE test ra KHÔNG nhanh hơn, đã bỏ) |
| `text_encoders` | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | — | Text encoder H3 (NVFP4, production thật trên endpoint #2/#3) — chỉ nằm trên volume dùng chung |
| `text_encoders` | `qwen3vl_8b_int8_convrot.safetensors` | — | Biến thể nhỏ hơn của text encoder H3 — chưa rõ còn dùng không, xuất hiện trong danh sách |
| `text_encoders` | `qwen_0.6b_ace15.safetensors` | — | CLIP cho ACE-Step audio — orphan nghi vấn, giống `acestep_v1.5_turbo` |
| `text_encoders` | `qwen_1.7b_ace15.safetensors` | — | CLIP cho ACE-Step audio — cùng nhóm orphan nghi vấn |
| `vae` | `qwen_image_vae.safetensors` | ~243MB | VAE cho Qwen-Image 2.1 / Edit-2511 |
| `vae` | `qwen_image_2.1_vae_bf16.safetensors` | — | VAE Qwen-Image 2.1 (biến thể bf16) — chưa rõ nhánh code nào chọn file này thay vì `qwen_image_vae.safetensors` |
| `vae` | `seedvr2_ema_vae_fp16.safetensors` | ~0.50GB | VAE SeedVR2 (dùng chung cho cả 3B lẫn 7B) |
| `vae` | `ace_1.5_vae.safetensors` | — | VAE ACE-Step audio — cùng nhóm orphan nghi vấn |
| `vae` | `minimax_h3_audio_vae_fp32.safetensors` | — | VAE audio của H3 — chỉ nằm trên volume dùng chung, không dùng trên endpoint này |
| `vae` | `minimax_h3_video_vae_fp16.safetensors` | — | VAE video H3 (fp16, production thật) — chỉ nằm trên volume dùng chung |
| `vae` | `minimax_h3_video_vae_int8_convrot.safetensors` | — | VAE video H3 (INT8, đã test và bỏ — chậm hơn fp16 trên A40) — chỉ nằm trên volume dùng chung |
| `checkpoints` | `sam3.1_multiplex_fp16.safetensors` | 1,745,546,848 B | SAM3 detect (person/object) |
| `detection` | `sam_3d_body_dinov3_bf16.safetensors` | 2,830,737,652 B | SAM3DBody — ước pose/tỉ lệ cơ thể |
| `diffusion_models` | `rt_detr_v4-x-hgnet_fp32.safetensors` | 247,790,660 B | RT-DETR, nạp qua `UNETLoader`, lọc vật cản theo class COCO |
| `frame_interpolation` | `rife_v4.26.safetensors` | 22,674,688 B | RIFE — **mới tải 2026-10-29**, nội suy khung hình (multiplier nguyên: 2x/3x/4x...) |
| `frame_interpolation` | `film_net_fp16.safetensors` | 68,882,302 B | FILM — **mới tải 2026-10-29**, cùng loader với RIFE (tự nhận diện loại model) |
| *(chưa tải)* | `moge_2_vitl_normal_fp16.safetensors` | — | MoGe (ước FOV/độ sâu) — cần cho thư mục `geometry_estimation/`, **chưa map trong yaml**, chưa cần tới |

Danh sách trên lấy từ `object_info` thật của endpoint #1 (2026-10-29) — các dòng ghi "chỉ nằm trên
volume dùng chung, không dùng trên endpoint này" là file H3/ACE-Step VẪN liệt kê trong dropdown
node tương ứng (vì node đó đọc thẳng cả thư mục trên volume) nhưng không có node H3/audio nào cài
trên image Qwen để thực sự load chúng — không tốn gì, chỉ là noise hiển thị. `pdd_acc` có map
trong `extra_model_paths.yaml` của endpoint này nhưng **không có node PDD nào** trên image Qwen
đọc tới (PDD là custom node riêng của image H3) — mapping tồn tại nhưng không dùng.

**Node chính dùng trên endpoint này**: `SeedVR2Preprocess`/`Conditioning`/`TemporalChunk`/`TemporalMerge`/`PostProcessing`
(core ComfyUI 0.37.2, không phải custom node numz), `FrameInterpolate`/`FrameInterpolationModelLoader`
(core, built-in — xác nhận qua `docs.comfy.org/built-in-nodes/FrameInterpolationModelLoader`),
`SAM3_Detect`, `SAM3DBody_Loader`/`_Predict`, `RTDETR_detect`.

**Giới hạn thật đã đo (A40 48GB, 2026-10-29)**:
- SeedVR2 7B, upscale 2x, 33 khung: OK, 196s thực thi, không OOM.
- SeedVR2 7B, upscale 2x, 124 khung (full clip): **VRAM OOM** ở KSampler (43.35/44.42 GiB) khi chạy nguyên khối; dùng `SeedVR2TemporalChunk(auto)` thì né được VRAM (tự chia `frames_per_chunk=53`) nhưng **RAM hệ thống đứt kết nối websocket sau ~670s** (cùng lỗi RAM đã gặp với 3B ở bài trước) — worker không tự hồi phục, phải cycle `workers.max` 0→1. Cách chắc ăn đã dùng với 3B: chia 2 job riêng (không chunk trong 1 job), mỗi job 1 nửa số khung có chồng lấn, ghép crossfade bằng ffmpeg.
- **Cách xử lý (2026-10-29)**: `scripts/seedvr2_upscale_chunked.py` (logic trong `src/novelvideo/generators/runpod_seedvr2_upscale.py`). Script chia clip thành các đoạn 41 khung, hai đoạn liền nhau chồng 8 khung, và gửi mỗi đoạn thành **một job RunPod riêng**. Graph mỗi job không có `SeedVR2TemporalChunk` và dùng `VAEEncodeTiled`/`VAEDecodeTiled`, nên VRAM lẫn RAM của worker chỉ phụ thuộc kích thước một đoạn, không phụ thuộc độ dài clip. Resize lanczos làm ở local (crf 0); các đoạn được ghép ở local bằng crossfade cùng dạng cửa sổ với `SeedVR2TemporalMerge`, rồi gắn lại audio gốc. Đoạn đã xong được lưu trong `--work-dir`, nên khi chạy lại chỉ gửi các đoạn còn thiếu. Ví dụ: `python scripts/seedvr2_upscale_chunked.py in.mp4 out.mp4 --model 7b --scale 2 --work-dir /tmp/sv2`.
- **Cập nhật 2026-10-30 — ghép theo luồng + task trong `api`**: `stitch_segments()` giữ cả clip upscale trong RAM (841 khung × 2688×1536 ≈ 10 GB, gấp đôi khi stitch) nên trước đây phải cắt tay clip dài thành nhiều phần. Giờ `upscale_video_chunked()` dùng `iter_stitched()` (sinh từng đoạn, chỉ giữ một đoạn + phần chồng lấn 8 khung) và `write_video_stream()` (ghi thẳng vào một lần encode ffmpeg), RAM chỉ phụ thuộc kích thước đoạn (~1-2 GB ở 2688×1536), không phụ thuộc độ dài clip; test `test_iter_stitched_matches_stitch_segments` khẳng định kết quả giống hệt `stitch_segments()`. `on_progress(done, total, msg)` báo tiến độ từng đoạn. Task mới `freezone_video_upscale_seedvr2` (`POST /api/v1/projects/{p}/freezone/video/upscale-seedvr2`, body `source_url`/`scale`/`model`/`segment_frames`/`overlap_frames`/`seed`; runner trong `task_backend/runners/video.py`): tự bật worker `qwen_t2i` nếu đang tắt, thư mục cache đoạn khóa theo (file nguồn + mtime + cài đặt) chứ không theo `job_id` nên gửi lại cùng yêu cầu sau khi lỗi/timeout sẽ chạy tiếp từ đoạn còn thiếu, xóa cache khi thành công. Timeout task nâng sàn lên 6 giờ (`_LONG_RUNNING_TASK_TIMEOUT_S` trong `run_core.py`) vì `ST_PROJECT_TASK_TIMEOUT_S` toàn cục (30-60 phút) sẽ cắt giữa chừng; lỗi hết giờ thì cache vẫn còn.
- **Số đo thật đầu tiên (2026-10-30, A40 48GB, SeedVR2 7B int8, 2x, 1344×768→2688×1536, đoạn 41 khung/chồng 8, clip multishot cáo/ếch `FoxFrogChase` 841 khung):** chạy 4 đoạn đầu (khung 0-106 + một phần), dừng theo yêu cầu, chưa chạy hết clip. Mỗi đoạn ~5 phút GPU (xong lúc 12:01, 12:06, 12:11 sau job bắt đầu 11:47), không OOM VRAM, RAM host bình thường. Cold start ~9 phút (đoạn đầu mất 14 phút). Quy đổi ~3,5 phút GPU mỗi giây video (mỗi đoạn thêm ~33 khung mới) → clip 35s ≈ 2 giờ ≈ $2,5 ở $1,22/giờ. Chất lượng được xác nhận bằng mắt là ổn (7B 2x, không thấy chi tiết giả rõ rệt ở bản xem trước 4,4s ghép bằng `iter_stitched`). Chưa kiểm: chỗ nối audio, chạy nguyên 841 khung bằng đường streaming. Ước tính ban đầu "4 phút/đoạn" (từ số đo 196s/33 khung) hơi thấp; dùng 5 phút/đoạn.
- **A/B model SeedVR2 (2026-10-30, A40, clip dọc 768×1344 cảnh gothic, 2 cửa sổ 41 khung: W = mặt rất nhỏ, M = hai mặt + râu + ghim + khuyên ngọc trai; 1 lần chạy mỗi biến thể, seed 42, `lab`, đoạn 41/chồng 8, thời gian là wall-clock gồm upload/download R2 + nạp model):**

  | | Model/scale | s/đoạn (ấm) | $/giây video | 35s clip | PSNR / SSIM (W) | Laplacian mặt W / râu M |
  |---|---|---|---|---|---|---|
  | L | Lanczos 2x (mốc) | — | — | — | — | 9,5 / 6,9 |
  | A | 7B int8 2x | ~276 (có thể gồm khởi động lại) | $0,068 | ~$2,4 / ~117 phút | 38,61 / 0,9710 | 41,9 / 19,6 |
  | B | 7B **sharp** int8 2x | ~246 | $0,061 | ~$2,1 / ~104 phút | 38,72 / 0,9714 | 34,8 / 19,6 |
  | C | 7B **fp16** 2x | ~215 | $0,053 | ~$1,9 / ~91 phút | 38,63 / 0,9711 | 41,8 / 19,7 |
  | D | 7B int8 **1,5x + Lanczos 2x** | ~175 | $0,043 | ~$1,5 / ~74 phút | 38,24 / 0,9699 | 29,2 / 15,6 |

  Kết luận: (1) **int8 và fp16 cho kết quả gần như giống hệt** (PSNR chênh 0,02 dB, độ nét chênh <0,3%), nên fp16 không đáng tải (16,5 GB) và còn không chậm hơn; (2) `sharp` không nét hơn theo số đo (ít năng lượng tần số cao hơn A ~17%, PSNR cao hơn 0,1 dB), bằng mắt gần như không khác; (3) 1,5x + Lanczos mềm hơn rõ ở râu, ghim và mặt nhỏ (độ nét giảm 16% đến 36% tùy vùng so với A, nhiều nhất ở ghim và mặt nhỏ) nhưng rẻ hơn khoảng 36% so với A; (4) cả bốn biến thể SeedVR2 nét gấp ~4 lần Lanczos và không thấy chi tiết giả (không vẽ thêm khuyên mũi, mắt/răng/râu/ghim đúng nguyên bản); (5) mọi biến thể thấp hơn bản gốc ~0,8/255 về độ sáng, không nhấp nháy bất thường (tỉ lệ nhấp nháy 1,1x bản gốc ở W, 1,17x ở M). Số thời gian của A có thể bị đẩy lên vì đoạn đó chạy ngay sau lần worker nghỉ dài; thứ hạng A/B/C trong khoảng ±15% chưa đủ để kết luận int8 chậm hơn fp16. Muốn rẻ hơn mà vẫn nét thì dùng D cho cảnh rộng và A cho cận. Volume `zyen2jmxt3` đã xóa `text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors` (27 GB, không còn dùng) để lấy chỗ.

---

## 2. `a31613hf7l83r5` — "h3-i2v-ref2va-fl2va"

Dùng cho: sinh video MiniMax H3 1-shot (ref2va có tham chiếu, fl2va chỉ first-frame).

| | |
|---|---|
| Image hiện tại | `ghcr.io/nguyenductho89/photoreal-h3-worker:h3only-0.37.2-cu130` |
| GPU | `NVIDIA A40` (pool `AMPERE_48`), 1 GPU, `minCudaVersion: 13.0` |
| Workers | `max=0` (tắt), `min=0`, `idleTimeout=90s` |
| Disk container | 20GB |
| `env` riêng | `COMFY_EXTRA_ARGS=--use-sage-attention` (Sage Attention, cần image có `gcc`/`build-essential` để Triton compile — image `h3only` này có, image gốc `0.37.2` không) |
| `timeout` job | 5,400,000 ms (90 phút — dài hơn 2 endpoint kia vì video gen lâu) |
| `extra_model_paths.yaml` (`runpod/extra_model_paths.yaml`) | `diffusion_models`, `text_encoders`, `vae`, `pdd_acc` — **không có** `checkpoints`/`detection`/`frame_interpolation` |

**File trên volume map được bởi endpoint này**:

| Category | File | Ghi chú |
|---|---|---|
| `diffusion_models` | `minimax_h3_*_pruned_int8_convrot.safetensors` (tên chính xác chưa ghi lại — xem log worker lúc chạy thật) | DiT chính của MiniMax H3, dùng chung video+audio |
| `pdd_acc` | `MiniMax-H3-FL2VA-Acc-8Step.safetensors` | PDD 8-step acceleration cho fl2va 1-shot |
| `vae` | file VAE H3 (int8_convrot, xem mục "Đo tốc độ H3..." trong `.claude/CLAUDE.md` — đã thử nghiệm INT8 nhưng **không nhanh hơn** fp16, quyết định giữ NVFP4 DiT + VAE fp16) | |

**Benchmark thật (A40, 768×1344, PDD 8 bước, cu130+Sage)**: ref2va 141 khung ~382s; fl2va 124
khung (5.2s) ~525s (text-encode cache từ job trước). Không dùng được cho frame interpolation
(yaml chưa map `frame_interpolation`) hay SAM3 (chưa map `checkpoints`/`detection`) dù file vẫn
nằm sẵn trên volume dùng chung.

---

## 3. `u0hkrms7k1xeua` — "h3-multishot-i2v-fl2va-ref2va"

Dùng cho: sinh video MiniMax H3 nhiều shot nối liền (multishot chain).

| | |
|---|---|
| Image hiện tại | `ghcr.io/nguyenductho89/comfy-trends-h3-multishot:0.37.2-ms2.7.2-cu130` |
| GPU | `NVIDIA A40` (pool `AMPERE_48`), 1 GPU, `minCudaVersion: 13.0` |
| Workers | `max=0` (tắt), `min=0`, `idleTimeout=90s` |
| Disk container | 10GB |
| `env` riêng | `COMFY_EXTRA_ARGS=--use-sage-attention` |
| `timeout` job | 14,400,000 ms (**4 giờ** — dài nhất, vì chain nhiều shot có thể chạy rất lâu) |
| `extra_model_paths.yaml` (`runpod-multishot/extra_model_paths.yaml`) | `diffusion_models`, `text_encoders`, `vae`, `pdd_acc` — giống endpoint H3 1-shot, không có `checkpoints`/`detection`/`frame_interpolation` |
| Build từ | Workflow CI của repo này (`runpod/multishot/`, từ 2026-10-31; trước đó là `photoreal-short-drama-generator`/`runpod-multishot/`, không bao giờ từ `comfy-trends`) |
| Custom node pack | `ComfyUI-MiniMaxH3-Context-Loop` (nối shot qua khung cuối thật — đã xác nhận có trên image) |

**Benchmark thật (A40, 768×1344, PDD 8 bước, cu130+Sage)**: 2 shot×124 khung: 1181s→631s sau khi
lên cu130+Sage (−47%). Quan sát cũ (trước cu130): thời gian tuyến tính ~316-320s/shot tới 6 shot
(739 khung/30.8s), RAM đỉnh ~96% nhưng không tăng theo số shot, chưa OOM tới 6 shot.

**Lưu ý quan trọng**: cùng seed KHÔNG cho cùng video giữa các bản image (nối shot qua khung cuối
thật → sai khác nhỏ ở khung đầu cộng dồn qua từng shot).

---

## Endpoint RunPod khác không dùng trực tiếp bởi DramaClaw

- **Qwen-Image-Edit-2511 / Qwen-t2i tách riêng** (mục "Việc cần làm tiếp theo" #5-10 trong
  `runpod-h3-qwen-endpoints.md`): **chưa làm** — hiện vẫn gộp chung trong endpoint #1
  (`q639jfhc6uaf3t`), có image riêng (`photoreal-h3-worker:0.37.2`, chưa bỏ Qwen 2.1+Edit-2511)
  nhưng chưa tách endpoint RunPod riêng.

## Việc chưa làm / chưa xác nhận (liên quan tới bảng trên)

- Tên file chính xác của base H3 DiT checkpoint — cần đọc lại log worker lúc chạy job thật trên
  endpoint #2/#3 để ghi đúng tên (hiện chỉ có pattern glob từ tài liệu cũ).
- `moge_2_vitl_normal_fp16.safetensors` chưa tải, chưa map vào `extra_model_paths.yaml` của bất kỳ
  endpoint nào.
- Dung lượng còn trống trên volume `zyen2jmxt3` (200GB tổng) — chưa kiểm tra % đã dùng.
