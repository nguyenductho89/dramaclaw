# Cấu hình RunPod Serverless Endpoints — H3 / Qwen-Image

Tài liệu tham khảo kỹ thuật thuần (RunPod config + ComfyUI graph), không gắn với project cụ thể nào.

**Trạng thái (2026-10-19)**: toàn bộ code backend+frontend dramaclaw-side đã xong và có test — tách 3 endpoint (mục 1-4), H3 1-shot two-stage/audio-refine (mục 1.2-1.3), và multishot full stack: graph+job-runner+data model+routes review/enqueue+task runner+billing (mục 5, kể cả 5d). Tổng ~30 file sửa/mới, ~85 test mới, 0 regression trên toàn bộ suite (`pytest tests/`, so với baseline trước khi sửa). **Chưa làm**: build/push Docker image mới, tạo/sửa endpoint RunPod thật (bao gồm set `RUNPOD_H3_MULTISHOT_ENDPOINT_ID`/`RUNPOD_QWEN_EDIT_ENDPOINT_ID` trong `.env`), mọi verification tốn GPU, và UI (chưa có nút/form cho multishot hay toggle two-stage/audio-refine) — các bước này cần xác nhận riêng trước khi thực hiện (build 1 image ~2h45 qua buildx/QEMU, theo kinh nghiệm thực tế đã đo của 2 image hiện có). Xem "Việc cần làm tiếp theo" ở cuối file.

---

## Hạ tầng chung

| Thành phần | Giá trị |
|---|---|
| Datacenter | `CA-MTL-1` |
| Network Volume | id `zyen2jmxt3`, 200 GB, loại `HIGH_PERFORMANCE` |
| Object storage output | Cloudflare R2, bucket `photoreal-drama-jobs` |
| Registry | container registry id `cmv2thumk00ccduuu6jxjfyl5` |
| Flashboot | ON (mọi endpoint) |
| Scaling | `QUEUE_DELAY`, delay 4s (mọi endpoint) |
| Idle timeout worker | 90s (mặc định, mỗi endpoint có biến riêng trong `config.py`) |

Global Volume (đa dạng GPU/đa region) **chưa làm** — xem mục cuối "Việc cần làm tiếp theo".

Biến môi trường chung (secret, resolve qua RunPod Secrets):
```
R2_ACCESS_KEY_ID     = {{ RUNPOD_SECRET_r2-access-key-id }}
R2_SECRET_ACCESS_KEY = {{ RUNPOD_SECRET_r2-secret-access-key }}
R2_BUCKET             = photoreal-drama-jobs
R2_ENDPOINT           = https://5f508a4c92bfbd347b48e7c3877a647f.r2.cloudflarestorage.com
```

---

## 1. Endpoint `h3-i2v-ref2va` (giữ nguyên id, tách từ endpoint cũ)

- **Endpoint ID**: `a31613hf7l83r5` (không đổi qua mọi lần đổi tên: `photoreal-drama-h3` → `qwen-t2i-h3-i2v-ref2va` → `h3-i2v-ref2va`)
- **Image hiện tại**: `ghcr.io/nguyenductho89/photoreal-h3-worker:0.37.2` (vẫn còn Qwen 2.1 + Edit-2511 bên trong — **chưa build image mới đã bỏ 2 cái này**, xem "Việc cần làm tiếp theo")
- **GPU pools**: `AMPERE_48` (count 1)
- **`.env`**: `RUNPOD_H3_VIDEO_ENDPOINT_ID=a31613hf7l83r5` (dòng config.py không còn fallback về `RUNPOD_QWEN_IMAGE_ENDPOINT_ID` nữa — thiếu biến này thì `_runpod_h3_video_configured()` trả `False` thẳng, không âm thầm route sang endpoint khác)
- **Workers**: min 0 / max 0 (mặc định tắt, cần bật tay) / idleTimeout `RUNPOD_H3_VIDEO_IDLE_TIMEOUT_SECONDS` (default 90s)

### 1.1. Pipeline H3 1-shot (ref2va / fl2va) — graph không đổi

Xem mục 1.3 bản cũ (không lặp lại ở đây) — `generators/runpod_minimax_h3_video.py`'s `build_h3_ref2va_graph`/`build_h3_fl2va_graph`. PDD 8-step cho ref2va, base 20-step cho fl2va, SigmaShift 12/3, resolution profile `formal` 768×1344 / `draft` 416×736.

### 1.2. Two-Stage (upscale + redraw) — **đã code, chưa benchmark GPU thật**

Thêm 2026-10-19, env-gated `RUNPOD_H3_TWO_STAGE_ENABLED` (default `False`). Chỉ áp dụng cho **ref2va**, dùng 2 node đã có sẵn trong `ComfyUI-MiniMax-H3-PDD-Acc` (không cần pack mới):

- **Pass 1**: giữ nguyên `MiniMaxH3PDDAccApply(nfe=8)` hiện tại, nhưng render ở độ phân giải **1/`RUNPOD_H3_STAGE2_SCALE_BY`** (default 1.5) của đích — ví dụ profile `formal` 16:9 (1344×768) → pass 1 = 896×512 (chia đúng, không lệch). Tổng quát: `stage1_dims_for_two_stage(width, height, scale_by)` round về lưới 32px.
- **`MiniMaxH3AVLatentUpscaleBy(scale_by, upscale_method="bislerp")`**: upscale latent video pass 1 về gần đích (audio latent giữ nguyên).
- **Pass 2 ("re-draw")**: **Apply branch riêng** `MiniMaxH3PDDAccApply(nfe=RUNPOD_H3_STAGE2_NFE, default "6")` từ cùng node `MiniMaxH3SigmaShift` (không đụng pass-1's branch nfe=8) + `MiniMaxH3PDDAccScheduler(nfe, denoise=RUNPOD_H3_STAGE2_DENOISE, default 0.35)` — giữ lại `round(nfe*denoise)` block cuối (default 6×0.35→2 block).
- Sampler pass 2 dùng lại `KSamplerSelect(euler)` của pass 1; seed giống seed gốc (chưa thử seed riêng).

Node IDs: `"60"` upscale, `"61"` Apply(nfe=stage2), `"62"` Scheduler, `"63"` BasicGuider, `"64"` RandomNoise, `"65"` SamplerCustomAdvanced (output cuối nếu không có audio-refine).

**Chưa benchmark thật trên A40** — lợi ích tốc độ kỳ vọng (pass 1 ở 1/4 pixel) chưa đo. Cần verify end-to-end + so với baseline 518s/1-shot cũ trước khi đặt `RUNPOD_H3_TWO_STAGE_ENABLED=True` làm default.

### 1.3. Audio Refine — **đã code, cần thêm pack mới vào image**

Env-gated `RUNPOD_H3_AUDIO_REFINE_ENABLED` (default `False`). Node `MiniMaxH3ChainAudioRefineSampler` — **thuộc pack khác** `ethanfel/ComfyUI-MiniMaxH3-Context-Loop`, pin commit `43afeffcc570beb5f7382593e79e4b211c7e02f6` (biến `RUNPOD_H3_CONTEXT_LOOP_PACK_COMMIT` trong `config.py`) — **chưa có trong image hiện tại**, cần thêm vào Dockerfile trước khi dùng được.

- Input: `model, positive, negative, latent, context_latent, seed, steps(RUNPOD_H3_AUDIO_REFINE_STEPS=4), cfg(RUNPOD_H3_AUDIO_REFINE_CFG=1.0), sampler_name=euler, scheduler=simple, audio_denoise(RUNPOD_H3_AUDIO_REFINE_DENOISE=0.5)`.
- **Không cần dựng toàn bộ hệ "Chain Context"** của pack: `context_latent` chỉ cần đúng SHAPE với latent đang refine và **không có key `noise_mask`** — khi đó pack tự coi là "chưa có gì được bảo vệ", audio mask ra toàn 1 (full-repaint). Dùng latent pre-sample của node `"7"` (`["7",1]`) khi không có two-stage, hoặc latent đã upscale `"60"` (`["60",0]`) khi có two-stage.
- `negative` nối cùng conditioning với `positive` — ở `cfg=1.0`, CFG toán học bỏ qua `negative` hoàn toàn (`negative + 1.0*(positive-negative) = positive`).
- Video luôn bị freeze (mask video=0), chỉ audio được denoise lại.
- Node id `"66"`, output cuối (`VAEDecode`/`VAEDecodeAudio` lấy từ `"66"` nếu bật, ưu tiên cao nhất qua stage 2/pass 1).
- **Rủi ro cần verify lúc build** (`--quick-test-for-ci --cpu`): node gọi `require_h3_mask_support()`, raise lỗi rõ nếu ComfyUI chưa có "native Add Guide/MultiRef core" (PR #15439 upstream) — khả năng cao ComfyUI 0.37.2 đã có (vì `MiniMaxH3AddGuide` đang chạy production), nhưng chưa build-test thật.

Test graph-shape: `tests/test_h3_two_stage_audio_refine.py` (9 test, pure Python, không cần GPU/ComfyUI thật — chỉ assert đúng cấu trúc dict graph).

### 1.4. SageAttention — không đổi

Vẫn opt-in qua `RUNPOD_H3_SAGE_ATTENTION`, chỉ áp dụng cho graph H3 (`apply_sage_patch` đã bị **xoá khỏi mọi graph Qwen** — xem mục 3/4, vì Qwen giờ chạy trên worker riêng không có KJNodes).

### Verify GPU ref2va + PDD 8 (2026-10-21)

- Job `c9dbbf1e…`: ref2va, 1 ảnh tham chiếu chân dung nhân vật (`<Picture 1>`, turnaround sheet 7 góc) + 1 first frame, 768×1344, 124 khung, PDD 8 bước. Log worker xác nhận `partition check ok: ref2va file on ref2va model`.
- **`executionTime` 613.7s (~10.2 phút)** — chậm hơn fl2va cùng cấu hình (525.4s) khoảng **88.3 giây (~17%)**. Hợp lý: ref2va có thêm bước mã hoá ảnh tham chiếu + `MiniMaxH3AddGuide` pin frame mà fl2va không có.
- Cold start lần này bất thường chậm: `delayTime` 416.8s (~7 phút, so với gần 0s ở 2 lần chạy trước đó cùng ngày) — worker đã tắt khoảng 8 tiếng trước đó (từ job `34474b7e` lúc ~17:16 UTC tới job này lúc ~01:54 UTC hôm sau), nghi do cache image/model trên host bị đẩy ra sau thời gian rảnh dài, không phải lỗi graph/code.
- Video đúng: giữ nguyên khuôn mặt/trang phục/bối cảnh khớp ảnh tham chiếu, đúng diễn biến prompt (đọc điện thoại → nhíu mày → nói), có audio AAC.
- **Multishot ref2va + PDD vẫn CHƯA được verify GPU thật** — chỉ mới verify 1-shot.

### Dockerfile — việc cần làm

Image hiện tại (`photoreal-h3-worker:0.37.2`) còn đủ cả Qwen+H3. Cần (chưa làm):
1. Build image mới CHỈ còn H3 (bỏ Qwen 2.1 + Edit-2511's model/node nếu muốn gọn, không bắt buộc — giữ `ComfyUI-GGUF` chỉ nếu Qwen volume còn cần nó ở đâu khác, xác nhận lúc build).
2. Thêm `ethanfel/ComfyUI-MiniMaxH3-Context-Loop` pin `43afeffcc570beb5f7382593e79e4b211c7e02f6` (cho mục 1.3).
3. Build-time smoke test `--quick-test-for-ci --cpu`, đặc biệt chạy thử 1 graph có audio-refine để xác nhận `require_h3_mask_support()` không raise.
4. Push, rồi `update-endpoint` (hoặc giữ nguyên id, chỉ đổi image) qua RunPod MCP.

---

## 2. Endpoint `qwen-edit-2511-relight` — **đã tạo, đã verify GPU thật (2026-10-21)**

- Chỉ Qwen-Image-Edit-2511 (render identity-swap + các việc edit ảnh khác như relight).
- `.env`: `RUNPOD_QWEN_EDIT_ENDPOINT_ID=cekzpt4p7680pt`, `RUNPOD_QWEN_EDIT_TIMEOUT_SECONDS` (default 1500), `RUNPOD_QWEN_EDIT_IDLE_TIMEOUT_SECONDS` (default 90). Image `ghcr.io/nguyenductho89/photoreal-qwen-worker:0.37.2`, GPU A40.
- Code: `nanobanana_grid.py`'s `_call_runpod_qwen_edit_image_api` dùng 2 biến trên (không còn dùng chung `RUNPOD_QWEN_IMAGE_*` của endpoint t2i); `_runpod_qwen_edit_image_graph` không còn gọi `apply_sage_patch`.
- Pipeline (không đổi): UNET/encoder/VAE Edit-2511, `ModelSamplingAuraFlow`+`CFGNorm`, `FluxKontextImageScale`→`VAEEncode`, `SetLatentNoiseMask` khi có mask, 40 bước/cfg 4.0.
- **Verify relight thật (job `9b92772d…`, không qua pipeline DramaClaw — gọi thẳng `_call_runpod_qwen_edit_image_api` với 1 ảnh, không mask, không reference thứ 2)**: yêu cầu đổi ánh sáng đêm (chỉ đèn bàn) sang ban ngày (cửa sổ chiếu mặt) + giữ đèn bàn sáng hắt tóc. Tổng thời gian gọi (gồm cold start lần đầu worker này chạy — kéo image + nạp model) **765 giây**. Kết quả: phòng chuyển sáng ban ngày đúng yêu cầu, cửa sổ/rèm/khung cảnh thành phố hiện qua ánh sáng ngày, đèn bàn vẫn sáng, trang phục/tư thế/bối cảnh giữ nguyên đúng yêu cầu Human-ID-Editing. **1 lệch đáng chú ý**: màu tóc đổi hẳn từ nâu đen sang nâu-cam ấm trên toàn bộ mái tóc (không chỉ viền rim-light mỏng như yêu cầu "chỉ hắt sáng viền tóc") — tức "warm rim light" bị model hiểu lan thành đổi tông màu nền tóc, không phải chỉ thêm highlight viền.

**Đã sửa + verify lại (job thứ 2, cùng ngày)**: thêm câu tường minh "a thin warm rim-light highlight only along the hair's silhouette edge... must NOT recolor or tint the hair's own surface or base color at all: keep her hair exactly the same dark brown shade" — kết quả đúng: tóc giữ nguyên màu gốc, chỉ còn 1 viền sáng ấm mỏng đúng rìa tóc phía đèn. Mọi yêu cầu khác (ánh sáng ngày qua cửa sổ, đèn bàn vẫn sáng, trang phục/tư thế/bối cảnh) đều đúng. Thời gian 857s — **không nhanh hơn** lần đầu (765s) dù image đã cache ở tầng Docker, vì mỗi lần `start_worker` riêng biệt vẫn là 1 cold start container mới (không phải warm pool); muốn nhanh phải gọi liên tiếp nhiều job trong lúc worker đang chạy, không dừng hẳn giữa 2 lần.

**Bài học prompt Edit-2511**: khi mô tả "ánh sáng X hắt lên bề mặt Y", PHẢI nói rõ "chỉ thêm viền sáng mỏng ở rìa (edge/silhouette), giữ nguyên màu nền/bề mặt gốc của Y" — nếu không, model mặc định hiểu thành tô màu/nhuộm cả vùng Y theo tông màu ánh sáng, không chỉ highlight viền.

---

## 3. Endpoint mới `qwen-image-t2i-fast` — **code xong, endpoint CHƯA tạo**

- Qwen-Image 2.1 (t2i/render nhanh: background, prop, render, sketch).
- `.env`: vẫn dùng `RUNPOD_QWEN_IMAGE_ENDPOINT_ID`/`RUNPOD_QWEN_IMAGE_TIMEOUT_SECONDS`/`RUNPOD_QWEN_IMAGE_IDLE_TIMEOUT_SECONDS` đã có sẵn (chỉ đổi Ý NGHĨA — giờ đây là endpoint riêng chỉ còn Qwen 2.1, không còn chung với H3 nữa).
- Pipeline không đổi (`runpod_qwen`/`runpod_qwen21_render(_multi)`/`runpod_qwen21_compose`). `_runpod_qwen_image_graph`/`_runpod_qwen21_render_image_graph` không còn gọi `apply_sage_patch`.
- **Cần làm**: build Dockerfile riêng (bỏ H3+KJNodes), tạo endpoint mới, set lại `RUNPOD_QWEN_IMAGE_ENDPOINT_ID` sang id MỚI (giá trị hiện tại trong `.env`, nếu có, vẫn đang trỏ vào endpoint CŨ dùng chung — phải đổi khi endpoint mới ra đời, không thể vừa dùng chung vừa tách).

---

## 4. Worker control (Settings → Models) — đã code lại thành registry 4 endpoint

`src/novelvideo/runpod_worker_control.py` giờ có 4 key cố định: `h3`, `qwen_edit`, `qwen_t2i`, `multishot` — mỗi key tra `config.py` riêng (endpoint id/idle-timeout/gate `_configured()` riêng), không còn 1 endpoint chung.

- Route: `GET /api/v1/runpod-worker/keys` (liệt kê key), `GET/POST /api/v1/runpod-worker/{key}/status|start|stop`.
- `GET /api/v1/config` trả `runpod_worker_control_enabled` (đổi tên từ `runpod_qwen_worker_control_enabled` — true nếu **bất kỳ** 1 trong 4 endpoint được cấu hình).
- Frontend: `Settings → Models` giờ render N section (1/endpoint đã cấu hình) thay vì 1 toggle cứng. 2 dialog review (`VideoReviewDialog` → luôn key `h3`; `RenderReviewDialog` → `qwen_edit` nếu selection bắt đầu `runpod_qwen_edit`, ngược lại `qwen_t2i`) tự chọn đúng key.
- Test: `tests/test_runpod_worker_control.py` (10 test, mock HTTP, không gọi RunPod thật).

---

## 5. Endpoint `h3-multishot-i2v-fl2va-ref2va` — tích hợp vào DramaClaw cho video dài liên tục

**Trạng thái**: graph builder + job submit/poll (`generators/runpod_minimax_h3_multishot_video.py`) đã code + test (17 test, `tests/test_h3_multishot_graph.py`). **Chưa làm**: data model (đánh dấu N beat liên tiếp = 1 "cảnh quay"), prompt builder (ghép script theo rule AIRLOCK/LAND SETTLED), route review/enqueue, runner, billing exemption — xem "Việc cần làm tiếp theo".

### 5a. Lỗi thật đã gặp trước đây (dùng qua `comfy-trends`/`photoreal`) + cách đã tránh trong code mới

| # | Lỗi | Nguyên nhân gốc | Đã tránh thế nào |
|---|---|---|---|
| 1 | `pin_frames=39` không có tác dụng | `H3MultishotSampler` **không có input `pin_frames`** (đã đọc source xác nhận, cả 2.6.5 và 2.7.2) — tham số đó chỉ tồn tại ở node khác (`H3MultishotMemorySampler`, cần pack `ComfyUI-H3-Motion-Context` chưa cài). ComfyUI âm thầm bỏ qua widget lạ. | Module mới **không có** tham số `pin_frames` ở đâu cả — không thể vô tình gửi lại tham số chết này. |
| 2 | Job dài bị tự hủy gần xong (mất ~39 phút GPU) | Client cũ tính timeout từ `submit()`, không phải từ `IN_PROGRESS` — cold start 2-6 phút ăn vào budget. | `run_h3_multishot_job()` **reset đồng hồ 1 lần** khi thấy status chuyển `IN_PROGRESS` lần đầu, rồi mới tính deadline `timeout_seconds` từ đó. |
| 3 | Hết RAM host ở cuối job (không phải VRAM), mất trắng job | `H3MultishotSampler` giữ toàn bộ khung mọi shot trong RAM tới khi ghép cuối; `handler.py`'s `collect_outputs()` tải cả file vào RAM trước khi upload R2 (phần này ở ngoài repo dramaclaw, thuộc `comfy-trends`, **chưa vá**). | `build_h3_multishot_graph()` **luôn** ép `save_every_shot=True` (không expose làm tham số tắt được) — pack tự ghi mục đích "insurance for long chains". Giảm thêm rủi ro: `RUNPOD_H3_MULTISHOT_MAX_SHOTS` default 6 (đã đo 6 shot × 124 khung không OOM, xem mục 8c). |
| 4 | Thử cu130 cho nhanh hơn → chậm hơn (eager mode) + vẫn OOM | Image tag `-cu130` thiếu runtime cu130 đầy đủ. | Không đổi runtime — endpoint vẫn dùng image cu128 hiện tại. |
| 5 | `409 ENDPOINT_PAUSED` ngay sau khi bật worker | Độ trễ propagation RunPod. | `run_h3_multishot_job()` giữ đúng cơ chế retry 6 lần/10s như 1-shot H3. |
| 6 | Phụ kiện (mũ) biến mất giữa shot | Pack không có bộ nhớ phụ kiện, frame relay chỉ truyền pixel. | Giảm nhẹ (chưa giải quyết hẳn): lặp nguyên văn mô tả nhân vật/phụ kiện mọi shot (việc của prompt builder, **chưa viết**) + `H3ChainNormalize` (từng wire mặc định; **đã tắt mặc định 2026-10-30**, xem mục 8d). |
| 7 | Chưa ai test chain dài thật (3 shot×243 khung ước ~4.2h/$5.2) | Chưa test, không phải lỗi. | `RUNPOD_H3_MULTISHOT_MAX_SHOTS` default 6 (đã verify 3 và 6 shot × 124 khung, xem mục 8c). |

### 5b. Graph đã implement (`build_h3_multishot_graph`)

Node khác hẳn 1-shot: `H3ModelLoaderAny`/`H3ClipLoaderAny` (không phải `UNETLoader`/`CLIPLoader`), `H3MultishotSampler` (class_type xác nhận từ source pack, pin commit `d7d197709fc93c1afb125e3db1dfd4ac0ae28c60`, biến `RUNPOD_H3_MULTISHOT_PACK_COMMIT`), `H3ChainNormalize` (node mới 2.7.0, san màu/texture — input/output `images` xác nhận từ source), `CreateVideo`/`SaveVideo` giống 1-shot.

- Model files: **dùng chung** filename config với 1-shot (`RUNPOD_H3_UNET_REF2VA/FL2VA`, `RUNPOD_H3_TEXT_ENCODER`, `RUNPOD_H3_VIDEO_VAE`, `RUNPOD_H3_AUDIO_VAE`) — cùng network volume, cùng file.
- `width`/`height` phải chia hết 32 (khác lưới 16px của node 1-shot) — `dims_for_multishot()` tự round.
- `frames_per_shot`: `frames_for_shot(seconds, is_dialogue)` — clamp [124,294] như 1-shot, nhưng sàn 192 khi beat là dialogue (PROMPTING.md tác giả pack: "124 khung không hoạt động cho dialogue").
- `reference_images` (chỉ ref2va): nhiều ảnh được fold qua `ImageBatch` 2-ảnh-1-lần (đúng cách client cũ làm).
- `voice_ref`/`voice_ref_2`/`voice_ref_3` (chỉ ref2va, tối đa 3).
- `checkpoint="fl2va"` reject nếu có `reference_images`/`voice_ref`/`self_anchor_voice` (node không được train cho reference rows ở fl2va, theo đúng tooltip chính thức).

### 5c. Job runner (`run_h3_multishot_job`)

Upload R2 (dùng chung helper `nanobanana_grid.py`), submit (retry 409 ×6), poll (deadline reset tại `IN_PROGRESS` đầu tiên — fix lỗi #2), download + verify sha256. `config.py`: `RUNPOD_H3_MULTISHOT_ENDPOINT_ID` (= `u0hkrms7k1xeua`, chưa set giá trị thật trong `.env` — endpoint tồn tại nhưng GPU pool/workers.max chưa cấu hình lại theo khuyến nghị dưới), `RUNPOD_H3_MULTISHOT_TIMEOUT_SECONDS` (default 14000s, gần sát timeout job 4h của endpoint), `RUNPOD_H3_MULTISHOT_IDLE_TIMEOUT_SECONDS`, `RUNPOD_H3_MULTISHOT_MAX_SHOTS` (default 6), gate `_runpod_h3_multishot_configured()`.

### 5d. Data model + prompt nguồn + routes + runner — ĐÃ XONG (2026-10-19)

Thiết kế cuối cùng khác với dự kiến ban đầu ở 1 điểm quan trọng, đơn giản hoá đáng kể: **không viết prompt-builder LLM mới cho multishot**. Mỗi beat trong chain tiếp tục dùng ĐÚNG route 1-shot đã có (`minimax-h3-prompt/generate`) để tự sinh + lưu `final_prompt` riêng của nó (`seedance2_config_json`) — route multishot chỉ ĐỌC các `final_prompt` đã lưu sẵn đó rồi nối bằng `---`, không gọi LLM gì thêm. Lý do an toàn: numbering `<Picture N>` trong mỗi `final_prompt` được đánh theo đúng reference-list RIÊNG của beat đó — nối 2 prompt có reference-list KHÁC NHAU lại sẽ làm `<Picture 2>` ở shot này chỉ người khác ở shot kia. Giải pháp: **bắt buộc mọi beat trong 1 chain phải có đúng cùng 1 danh sách identity reference (cùng người, cùng thứ tự)** — validate cứng ở `_multishot_shared_references()`, chặn enqueue nếu không khớp. Đây là giới hạn v1 có chủ đích (không phải thiếu sót): một chain chưa thể đổi/thêm nhân vật giữa các shot.

- **Data model**: `NovelVisualBeat.multishot_chain_id` (cột mới `beats.multishot_chain_id`, migration qua `_add_column_if_missing`, mặc định rỗng) — user đánh dấu N beat liên tiếp qua route PATCH `beats/{beat_num}` đã có sẵn (`BeatUpdate.multishot_chain_id`). Backend validate **liên tiếp theo đúng thứ tự hiển thị** (`get_beats_as_dicts` đã sort theo `shot_order`) — không chỉ `beat_number` liền kề, vì shot thủ công có thể chèn giữa.
- **Routes** (`api/routes/generation.py`): `POST .../episodes/{ep}/multishot/{chain_id}/review` (dry-run — không tốn gì: liệt kê beat trong chain, flag beat còn thiếu prompt, validate reference list khớp, tính `frames_per_shot` chung (= max per-beat, vì `H3MultishotSampler.frames_per_shot` là 1 giá trị cho mọi shot, không phải list), checkpoint ref2va/fl2va, trạng thái worker, fingerprint) và `POST .../episodes/{ep}/multishot/{chain_id}/video` (enqueue, nhận `review_fingerprint`, trả `input_stale` nếu lệch).
- **Runner** (`task_backend/runners/video.py`'s `_run_multishot_video_async`/`run_multishot_video`, task_type `multishot_video`): đọc config đã build sẵn ở route enqueue, dựng graph (`build_h3_multishot_graph`), gọi `run_h3_multishot_job()`, lưu video vào `videos_dir/multishot_{chain_id}.mp4`.
- **Billing**: route enqueue tự truyền `billing={}` (không qua credit DramaClaw) — đúng pattern đã làm cho `runpod_minimax_h3` 1-shot, tránh lại bug "invalid video backend".
- **Không cần `VideoGeneratorBase` wrapper riêng** — runner gọi trực tiếp `run_h3_multishot_job()`/`build_h3_multishot_graph()`, không qua `create_video_generator()` factory (chain N-beat không khớp interface `generate(image_path, prompt, ...)` 1-beat của factory đó).
- Test: `tests/test_multishot_chain_id_column.py` (4 test, SQLite thật qua migration) + `tests/test_multishot_review_helpers.py` (14 test, chain validation/shared-reference/fingerprint, pure Python).

### 5f. PDD 8 cho multishot + vì sao KHÔNG có Upscale → Re-draw → Audio Refine trong chain (2026-10-20)

- **PDD 8 đã code** (`multishot_sampling_plan()` + `build_h3_multishot_graph(pdd_nfe, pdd_file)`): `H3MultishotSampler` (v2.7.2, đã đọc source tại commit pin) nhận `model` + `sigmas` từ ngoài và chỉ dùng `BasicGuider` (cfg=1) — nên cắm thẳng `MiniMaxH3SigmaShift(12/3)` → `MiniMaxH3PDDAccApply(nfe=8)` giống 1-shot, `sigmas=["6",1]`, ép `sampler_name=euler` (default của node là `res_multistep`, không phải lưới PDD đã train). Endpoint multishot dùng chung volume `zyen2jmxt3` và image đã có pack PDD-Acc → không cần build lại image.
- **fl2va PDD — đã tải (2026-10-21)**: `MiniMax-H3-FL2VA-Acc-8Step.safetensors` (1372450680 byte, sha256 `0b29be7042d883970eb0c20774a9ba03d95669ed80a721bb4d21be8ea0d0a196`, khớp HF `alibaba-pai/MiniMax-H3-Acc-LoRAs`) nằm ở `models/pdd_acc/` trên volume `zyen2jmxt3`, cạnh file Ref2VA. Tải bằng pod A40 tạm ở CA-MTL-1 (CA-MTL-1 không có pod CPU; ~1 phút, tải 164MB/s từ HF, xoá pod ngay sau). Volume còn trống ~38GB/187GB. `.env` đặt `RUNPOD_H3_PDD_FL2VA=MiniMax-H3-FL2VA-Acc-8Step.safetensors` → **cả H3 1-shot fl2va lẫn multishot fl2va** giờ cũng PDD 8 (`build_h3_fl2va_graph(pdd_file=...)`: SigmaShift → PDDAccApply, euler, bỏ `BasicScheduler`). Để trống biến này là quay về base 20 bước.
- Biến: `RUNPOD_H3_MULTISHOT_PDD_NFE` (default `8`, `""` = tắt), `RUNPOD_H3_MULTISHOT_OUTPUT_SCALE` (default 1.0 = tắt; upscale lanczos sau decode, có sẵn trong node).
- **Không ghép được Upscale → Re-draw → Audio Refine vào trong chain**: node là 1 khối đóng (lặp shot, relay frame cuối, seam-trim, decode bên trong) và chỉ trả IMAGE/AUDIO đã decode — không có latent để upscale/redraw/refine audio. Tác giả pack đã **xoá** latent two-pass upscale từ 2.1.3 vì latent H3 nội suy ra ngoài manifold → "colour-noise mush" (3 lần A/B). Redraw/refine sau khi ghép thì mỗi shot bị sửa độc lập → mất liên tục ở mối nối. Hai cách còn lại: (a) chỉ upscale pixel (`output_scale`), (b) bỏ node multishot, tự chain N job 1-shot (mỗi shot đủ PDD + two-stage + audio-refine, frame cuối shot trước làm first frame shot sau) — chưa làm, cần quyết định.
- **Verify GPU (2026-10-21)**: H3 1-shot fl2va + PDD 8 chạy thật thành công (job `34474b7e…`, 525s trên A40 ấm, log worker xác nhận `partition check ok: fl2va file on fl2va model`, `steps=8`). Multishot + PDD cũng chạy thật thành công (xem bullet riêng bên dưới).
- **SageAttention hỏng trên image `h3only-0.37.2`**: Triton báo `Failed to find C compiler` lúc sampling (image không có `gcc`). Đã tắt (`RUNPOD_H3_SAGE_ATTENTION=` rỗng) cho tới khi build lại image có `gcc`.

### 5g. Multishot: 2 bug thật tìm được + verify GPU thành công (2026-10-21)

- **Bug 1, đã sửa (`join_shots_script`)**: `H3MultishotSampler._parse_script` coi script là JSON nếu ký tự ĐẦU TIÊN là `[`/`{`, raise nếu parse JSON thất bại. Mọi prompt H3 của DramaClaw luôn mở đầu bằng `[Shot 1]` → script nối bằng `---` (dạng cũ) LUÔN hỏng thật trên worker (job `ad485558…`: `H3 script looks like JSON but does not parse`). Đã sửa `join_shots_script()` sang gửi đúng dạng JSON `{"prompts": [...]}` mà node cũng hỗ trợ chính thức — verify bằng cách chạy thẳng `_parse_script` của pack (source đúng commit pin) với output mới, và verify lại trên worker thật (job `d7792b56…` qua được bước parse).
- **Bug 2, đã sửa qua RunPod (không phải code DramaClaw)**: endpoint `u0hkrms7k1xeua` có `args` override `sed -i 's/--log-stdout/--log-stdout --enable-triton-backend/' /start.sh` (ai đó thêm tay, không có trong Dockerfile repo `comfy-trends`) — image cu128 không có `gcc`, nên bất kỳ job nào gọi tới op Triton (rope, int8 linear...) đều crash `Failed to find C compiler` (giống hệt lỗi Sage ở H3 1-shot, cùng nguyên nhân gốc). Đã gỡ bằng `update-endpoint(args="")`, cycle `workers.max` 0→1 để terminate 2 worker cũ (version 5, còn cờ) và chỉ còn worker version 6 (không cờ).
- **Verify GPU thật thành công (job `29aefcbb…`)**: 2 shot × 124 frame, fl2va + PDD 8 (steps=8 cả 2 shot, log xác nhận), 768×1344, `start_image` = ảnh thật. `executionTime` 1101.7s (~18.4 phút) cho cả 2 shot (so với baseline cũ ghi nhận ở `comfy-trends`: 1 shot 243 khung/14 bước ở eager chậm **hơn 38 phút chưa xong** — PDD 8 giảm đáng kể, dù so sánh không hoàn toàn ngang nhau về frame/step). Video ra đúng: 247 frame (= 2×124 − 1 frame seam-trim, đúng thiết kế), có audio AAC. **Airlock hoạt động đúng**: frame đầu shot 2 giữ nguyên tư thế/khung hình/ánh sáng của frame cuối shot 1 (không giật hình ở mối nối), nhân vật/trang phục/bối cảnh nhất quán suốt cả 2 shot.
- **RAM host lên 96% (44.86/46.57 GiB) ngay lúc chuyển shot 1→2 (unload/reload model)**, cao hơn mức ~83% ổn định mà `comfy-trends` từng đo trên backend `eager` — chưa OOM, job vẫn hoàn thành, nhưng đáng chú ý nếu thử chain dài hơn 2 shot (RAM có thể cộng dồn theo số shot, risk OOM ở bước ghép cuối vẫn còn theo ghi chép cũ). `save_every_shot=True` (ép cứng) đã lưu từng shot ra đĩa ngay khi decode xong — không cần tới nếu job này, nhưng vẫn đúng vai trò bảo hiểm.
- **Đã trả `workers.max` của endpoint multishot về 0** sau khi test xong (dùng chung với `comfy-trends`, không để treo phí).

### 5e. Verification cần làm (tăng dần, tốn GPU thật — xác nhận trước mỗi bước)

1. Dry-run review (miễn phí) cho 1 chain 2 beat thật.
2. Chạy thật 2 shot × 124 khung (narration), `checkpoint=fl2va` — so với baseline cũ (1482s/$0.50) để xác nhận `save_every_shot` không gây lỗi mới.
3. Tăng dần: 2 shot×243 (có dialogue, test sàn ≥192 khung) → 3 shot — dừng báo cáo nếu gặp lại lỗi RAM (#3) trước khi đi xa hơn.

---

## 8. Tăng tốc worker H3: torch cu130 + Sage attention (2026-10-28)

Đo trên endpoint `h3-i2v-ref2va` (`a31613hf7l83r5`), A40, graph ref2va + PDD 8 bước, 768×1344, 141 khung (~5.9s), cùng seed/input cho mọi lượt (job baseline `0179590c…`).

| Biến thể | Image / cờ (`COMFY_EXTRA_ARGS`) | `executionTime` | Sampling |
| --- | --- | --- | --- |
| Baseline | `h3only-0.37.2` (torch cu128) | 718s | ~640s (80s/bước) |
| V1 | `h3only-0.37.2-cu130`, không cờ | 417s | ~346s (43s/bước) |
| V2 | V1 + `--enable-triton-backend` | 417s | không nhanh thêm |
| **V3 (đang dùng)** | V1 + `--use-sage-attention` | **382s** | — |

- **Nguyên nhân chậm:** ComfyUI 0.37.2 (`comfy/quant_ops.py`) tắt backend `cuda` của comfy_kitchen khi `torch.version.cuda < 13`, nên DiT `int8_convrot` chạy bằng backend `eager`. Chỉ đổi base image + torch sang cu130 (cùng `torch 2.11.0`, `triton 3.6.0`) là giảm 42%. Log worker mới: `comfy_kitchen backend cuda: disabled False`.
- **Triton (`--enable-triton-backend`): không giúp** khi backend `cuda` đã bật, không dùng.
- **Sage (`--use-sage-attention`): giảm thêm ~8%.** `sageattention==1.0.6` là wheel Python thuần (kernel Triton JIT), không gắn ABI với torch. Lỗi cũ "Failed to find C compiler" đã hết nhờ `gcc python3.12-dev` trong image. Log: `Using sage attention`, không có `Error running sage attention`.
- **Chất lượng:** 5 khung then chốt giữa baseline/V1/V3 giống nhau (mặt đúng ảnh tham chiếu, tay đủ ngón, nền không vỡ). SSIM V1 so baseline 0.964 (PSNR 32.6 dB), V3 so baseline 0.972 (PSNR 34.3 dB); mọi kiểm tra tự động (141 khung, 768×1344, độ sáng, audio, SSIM khung đầu ≥ 0.90) đều đạt. Cảnh test không có chữ trong hình nên chưa kiểm text.
- **Cấu hình endpoint hiện tại:** image `ghcr.io/nguyenductho89/photoreal-h3-worker:h3only-0.37.2-cu130`, `gpu.minCudaVersion=13.0`, env `COMFY_EXTRA_ARGS=--use-sage-attention` (giữ nguyên 4 biến R2). Image build từ nhánh `tesla` của `photoreal-short-drama-generator`, commit `e4e0e44` (`runpod/Dockerfile`: base `nvidia/cuda:13.0.3`, torch cu130, `gcc`; `runpod/start.sh`: nối `${COMFY_EXTRA_ARGS}`).
- **Rollback:** đổi image về `h3only-0.37.2`, `minCudaVersion` về `12.0`, xoá `COMFY_EXTRA_ARGS`. Chỉ tắt Sage: xoá `COMFY_EXTRA_ARGS` (vẫn giữ cu130).
- **`RUNPOD_H3_SAGE_ATTENTION` trong `.env` giữ trống:** Sage giờ bật bằng cờ toàn cục của ComfyUI trên worker, không cần node KJ `PathchSageAttentionKJ` (`generators/comfy_sage.py`). Chỉ dùng được vì image H3 đã tách riêng khỏi Qwen.
- **Endpoint này dùng chung với project `comfy-trends`:** họ cũng chạy trên image cu130 + Sage từ nay.
- **Chưa kiểm — đừng coi là an toàn cho clip dài:** lần thử cu130 trước (dòng 4 bảng sự cố) từng OOM RAM hệ thống ở bước VAE decode/thu output với 243 khung × 14 bước; ngày 2026-10-28 test thêm ref2va 243 khung PDD 8 bước: xong 869s, không OOM, RAM worker đỉnh 96% lúc VAE decode (sát trần, 294 khung chưa thử); đo trước đó chỉ 141 khung (1 shot) và 2×124 khung (multishot, worker báo RAM 96%), chưa chạy lại 243 khung/14 bước hay 294 khung, và ref2va có `ref_video` cũng chưa test. Multishot 3 shot × 124 khung (~15s, job c4dd3b09…) cũng xong 958s, không OOM, RAM đỉnh 96% và không tăng theo số shot. Nếu gặp `Connection to remote host was lost`, tra log tìm OOM và kiểm R2 trước.
- **Chưa làm:** chưa đo PDD 4/6 bước, `two_stage`, profile `draft`, và chưa đo encoder `int8_convrot` sau cu130 (encode ~29s).

### 8b. Endpoint multishot `u0hkrms7k1xeua` cũng đã lên cu130 + Sage (2026-10-28)

Đo 2 shot × 124 khung, ref2va, PDD 8 bước, 768×1344, seed 424242, cùng graph/input (`build_h3_multishot_graph`), A40:

| Cấu hình | `executionTime` | Sampling mỗi shot |
| --- | --- | --- |
| Image `0.37.2-ms2.7.2` (cu128) | 1181s | ~64s/bước (shot 1 ~9.6 phút) |
| Image `0.37.2-ms2.7.2-cu130` + `--use-sage-attention` | **631s** (−47%) | ~31s/bước (shot 1 ~5.1 phút) |

- **Image build ở đâu:** repo `comfy-trends` không có CI, nên `runpod_multishot/` được sao sang repo `photoreal-short-drama-generator` (thư mục `runpod-multishot/`, nhánh `tesla`, commit `45ed415`) và workflow `build-worker-image.yml` có thêm lựa chọn `image=multishot`. Image đẩy về `ghcr.io/nguyenductho89/comfy-trends-h3-multishot:0.37.2-ms2.7.2-cu130`; tag cũ `0.37.2-ms2.7.2` giữ nguyên để rollback. Dockerfile đổi cùng kiểu như image 1-shot (CUDA 13.0.3, torch cu130, `gcc python3.12-dev`, `sageattention==1.0.6`); `handler.py` và `extra_model_paths.yaml` giống hệt bản 1-shot; `start.sh` nối `${COMFY_EXTRA_ARGS}`.
- **Cấu hình endpoint hiện tại:** image `-cu130`, `gpu.minCudaVersion=13.0`, env `COMFY_EXTRA_ARGS=--use-sage-attention` (giữ nguyên 4 biến R2). Log khởi động: `torch 2.11.0+cu130`, comfy_kitchen `cuda: disabled False`, `Using sage attention`, không có `Error running sage attention`.
- **Chất lượng:** không có lỗi hình ảnh (mặt, áo, nền, tay đều sạch), kiểm tra tự động đạt (247 khung, 768×1344, độ sáng, audio). **Nhưng video không giống từng khung với bản cũ:** SSIM so với baseline chỉ 0.87 (PSNR 23.0 dB), thấp hơn nhiều so với 1-shot (0.97). Lý do: pack multishot nối các shot qua khung cuối thật, nên sai khác số học nhỏ từ kernel mới cộng dồn qua chuỗi và quỹ đạo hành động rẽ hướng khác (baseline: nhân vật quay mặt về camera rồi xoay lưng; bản mới: quay lưng ở giữa rồi quay mặt ở cuối). Cả hai đều là cách diễn giải hợp lệ của prompt. Với multishot, đừng kỳ vọng cùng seed cho đúng cùng video giữa các bản image.
- **SSIM khung đầu không dùng được làm ngưỡng cho multishot:** chính baseline cũng chỉ đạt 0.809 (bản mới 0.789), vì pack không ghim `start_image` chặt như `MiniMaxH3AddGuide` của graph 1-shot. Với multishot phải so với baseline, không dùng ngưỡng tuyệt đối 0.90.
- **Đã quan sát:** job có `retries: 1` (bị đẩy lại hàng đợi 1 lần khi worker cũ bị thay sau khi đổi image/env), chạy lại ổn trên worker mới, không có crash. Cold start worker multishot ~8.7 phút (cu128) / ~6 phút (cu130).
- **Rollback:** đổi image về `0.37.2-ms2.7.2`, `minCudaVersion` về `12.0`, xoá `COMFY_EXTRA_ARGS`.
- Cold start worker mới sau khi đổi image/env ~6 phút (kéo image + nạp model).

### 8c. Benchmark độ dài / RAM trên A40 sau cu130 + Sage (2026-10-28)

Cấu hình chung: A40 48 GB (RAM container 46,57 GiB), ref2va, PDD 8 bước, 768×1344, 24 fps, `--use-sage-attention`, worker đã ấm (trừ cold start ghi riêng). Endpoint chính = `a31613hf7l83r5`, multishot = `u0hkrms7k1xeua`. RAM lấy từ log hệ thống của worker (lấy mẫu mỗi ~30s, nên đỉnh thật có thể cao hơn số ghi).

| Kịch bản | Endpoint | Khung / độ dài video | `executionTime` | RAM đỉnh quan sát | Kết quả |
|---|---|---|---|---|---|
| 1 shot 141 khung | chính | 141 / 5,9s | 382s | không ghi | OK |
| 1 shot 243 khung | chính | 243 / 10,1s | 869s | 96% (44,75 GiB) lúc VAE decode | OK, không OOM |
| 2 shot × 124 khung | multishot | 247 / 10,3s | 631s | 96% | OK |
| 3 shot × 124 khung | multishot | 370 / 15,4s | 958s (~320s/shot) | 96% (44,73 GiB) | OK, không OOM |
| 6 shot × 124 khung | multishot | 739 / 30,8s | 1897s (~316s/shot) | ≥94% (44,2 GiB) quan sát được | OK, không OOM |

Nhận xét:
- Thời gian tuyến tính theo số shot (~316–320s/shot, 124 khung); không có bước nhảy nào ở 6 shot.
- RAM đỉnh không tăng theo số shot: sampler decode từng shot rồi để timeline fp16 trên RAM máy (~6,2 MB/khung, tổng vài GB cho 30s). Baseline ~93% là do model được nạp sẵn.
- Số khung = N × 124 − (N − 1) vì mỗi shot sau cắt 1 khung trùng ở chỗ nối.
- Giới hạn chưa thử: shot 243 khung × nhiều shot, > 6 shot, độ phân giải cao hơn, ref2va có `ref_video`, và ca fl2va 14 bước base của 18/10. Đỉnh RAM chỉ sát trần (96%) chứ chưa chạm; một cấu hình nặng hơn có thể vượt.
- Chưa đánh giá chất lượng hình/nhất quán nhân vật qua chuỗi 6 shot (chưa tải video về xem). Prompt test là cảnh mưa đêm lặp lại 6 hành động đơn giản.
- Mp4 lưu ở R2 bucket `photoreal-drama-jobs`: `jobs/c4dd3b09-…/h3_ms3x124_00001_.mp4`, `jobs/30c80449-…/h3_ms6x124_00001_.mp4`, `jobs/42ac901b-…/h3_oom243_00001_.mp4`.

Khuyến nghị: giữ mỗi shot ≤124 khung ở 768×1344 khi nối chuỗi dài; chuỗi 30s đã chạy được trên A40. Cần RAM lớn hơn chỉ khi tăng khung/shot hoặc độ phân giải.

## 6. Global Volume — chưa làm, để sau (quyết định của user 2026-10-19)

RunPod Global Volume (beta): object-backed, eventually-consistent, không hỗ trợ file lock/atomic rename/hardlink, tối đa 1 volume/endpoint, không dùng song song với network volume trên cùng endpoint, billing theo storage + request (Class A write $0.005/1k request, Class B read $0.0005/1k request); GPU-only (không CPU); balance $0 → xoá sau 15 ngày.

Khi làm: cần 1 pod tạm gắn cả network volume cũ + global volume mới, copy toàn bộ `models/` (ước lượng >100GB cho H3+Qwen2.1+Edit-2511), rồi đổi `networkVolumes`→`globalVolumes` trên từng endpoint (không làm đồng thời cả 2 trên 1 endpoint). Lợi ích: bỏ giới hạn 1 data-center, cho phép khai nhiều GPU pool/nhiều region (đa dạng GPU/tăng khả dụng) mà không cần tự quản nhiều bản copy model theo từng region.

---

## Việc cần làm tiếp theo (tổng hợp, theo thứ tự rủi ro tăng dần)

1. ~~Code backend/frontend tách 3 endpoint~~ ✅ xong, test pass.
2. ~~Code graph two-stage/audio-refine (1-shot H3)~~ ✅ xong, test pass, **chưa benchmark GPU**.
3. ~~Code graph + job-runner multishot~~ ✅ xong, test pass.
4. ~~Data model + routes (review/enqueue) + runner + billing cho multishot~~ ✅ xong, test pass (mục 5d) — **UI chưa có nút** để set `multishot_chain_id` hay gọi 2 route mới (hiện chỉ gọi được qua API/`curl`, chưa có component React); cũng chưa UI cho `two_stage`/`audio_refine` toggle của H3 1-shot (hiện chỉ đổi được qua `.env`).
5. Viết Dockerfile mới cho 2 endpoint Qwen tách riêng + thêm Context-Loop pack vào Dockerfile H3 — **cần xác nhận trước khi build** (mỗi build ~2h45 theo kinh nghiệm thực tế 2 image hiện có).
6. Build + push 3 image (sửa H3, mới Qwen-Edit, mới Qwen-t2i) — tốn thời gian build, không tốn GPU $ (build chạy trên máy local qua buildx/QEMU).
7. Tạo 2 endpoint RunPod mới (Qwen-Edit, Qwen-t2i) + đổi image endpoint H3 hiện tại — **RunPod infra mutation, cần xác nhận**.
8. Set `.env`: `RUNPOD_QWEN_EDIT_ENDPOINT_ID` (mới), đổi `RUNPOD_QWEN_IMAGE_ENDPOINT_ID` sang id mới (endpoint t2i tách riêng), set `RUNPOD_H3_MULTISHOT_ENDPOINT_ID=u0hkrms7k1xeua` (hiện chưa set).
9. Verify từng endpoint bằng 1 job nhỏ (tốn GPU $, cần xác nhận) — theo đúng thứ tự: Edit-2511 1 ảnh, Qwen2.1 t2i 1 ảnh, H3 two-stage+audio-refine 1 video, multishot 2 shot ngắn (qua API trực tiếp, chưa có UI).
10. Thu hẹp GPU pool multishot endpoint về `AMPERE_48` — RunPod infra mutation nhỏ, cần xác nhận.
11. UI cho multishot (đánh dấu chain trên beat, nút review/enqueue) + UI toggle two-stage/audio-refine — chưa làm, cần xác nhận UX trước (ví dụ: chọn nhiều beat rồi "Group into Multishot chain" ở đâu trong giao diện hiện tại).
12. Global Volume migration (mục 6) — để sau, không nằm trong phạm vi lần này.

---

## 7. Điều tra "giọng hơi máy/méo" của H3 (2026-10-21)

Dùng crest factor (`ffmpeg astats`) + spectrogram (`showspectrumpic`) để chẩn đoán thay vì chỉ nghe cảm tính — giọng người thật crest factor thường 10-20dB (tỉ lệ 3-10 lần đỉnh/RMS), các mẫu H3 dưới đây chỉ 4.5-7.5dB (tỉ lệ ~1.7-2.4 lần) và phổ tần trải rộng đồng đều tới 15kHz thay vì giảm dần theo tần số như giọng thật — dấu hiệu "buzzy"/kim loại kinh điển của vocoder tổng hợp.

**5 lần thử GPU thật, tất cả cùng 1 beat/prompt (first frame + nhân vật Hương, thoại tiếng Việt)**:

| Thử nghiệm | Crest factor | Kết quả |
|---|---|---|
| fl2va, PDD 8 | 2.03 (~6.1dB) | buzzy |
| ref2va, PDD 8 (không voice ref) | 2.36 (~7.5dB) | buzzy |
| fl2va, base 20 bước (không PDD) | 2.30 (~7.3dB) | buzzy — **loại bỏ giả thuyết "PDD gây lỗi"** |
| fl2va, PDD 8 + `audio_refine=True` (4 bước riêng, `MiniMaxH3ChainAudioRefineSampler`, pack `Context-Loop` xác nhận có sẵn trên image) | 2.29 | buzzy — **refine không đổi gì** |
| ref2va, PDD 8 + voice reference thật (`ShotReference(type="audio")`, 6s giọng mẫu trim bằng `trim_voice_sample_content`, `AudioVAE` xác nhận nạp) | **1.69 (~4.5dB)** | buzzy + **nặng hơn**, thêm 2 đợt nhiễu lạ trước đoạn thoại, âm lượng nhỏ hơn hẳn |

**Kết luận**: không phải do số bước sampling, không phải do thiếu audio-refine pass, không phải do model tự bịa giọng không có mẫu — cả 4 hướng sửa trong phạm vi code/cấu hình DramaClaw đều không cải thiện, 1 hướng còn làm tệ hơn. Tính chất buzzy nhiều khả năng là giới hạn vốn có của nhánh audio trong trọng số DiT int8-quantized hiện có trên volume (`minimax_h3_*_pruned_int8_convrot.safetensors`), dùng chung cho cả video lẫn audio.

**Hướng còn lại, chưa thử**: `RUNPOD_H3_AUDIO_REFINE_DENOISE=1.0` (refine toàn bộ thay vì 0.5 — khả năng thấp vì 0.5 đã không đổi gì); trọng số UNET không quantize (nếu có, tốn VRAM/chậm hơn nhiều); hoặc **chuyển hẳn sang TTS riêng + ghép audio vào video** thay vì để H3 tự sinh giọng — khuyến nghị cho các beat cần giọng rõ.

### 8d. `H3ChainNormalize` trong multishot: khung đầu bị nhuộm + mờ hơn; độ sáng chưa kết luận (2026-10-30)

Video multishot turbo (job `b95e4ef9…`, 2 shot × 124 khung, LoRA 8 bước) có khung đầu mờ và độ sáng đổi qua các khung. Graph multishot luôn chèn node `H3ChainNormalize` (từ 2026-10-19, `colour_match=True`): nó histogram-match **từng khung, từng kênh màu** về một khung giữa shot 1 và làm mềm các khung có năng lượng chi tiết vượt 1,06× baseline (EMA, tối đa 0,85). Pack ghi node dành cho chuỗi dài (đo trên 84 giây).

A/B cùng ảnh đầu vào, prompt, seed (job `1c5d34c0…`: 3 shot, **không** node; so với `b95e4ef9…`: 2 shot, có node):

| Chỉ số | Có node (2 shot) | Không node (3 shot) | 1-shot turbo6 / base20 (không node) |
|---|---|---|---|
| Dải trời khung 0 (ảnh gốc ~143) | 115 (nhuộm tím) | 143 | 142 / 146 |
| Độ nét khung 0 → 36 → 48 | 420 → 221 → 249 | 458 → 360 → 348 | 448 → 384 → 376 / 522 → 306 → 336 |
| p90 luma (đỉnh sáng) | 135–141 (phẳng) | 161 → 137 trong 60 khung đầu, sau đó 131–144 | — |
| p50 luma | 55–59 (phẳng) | 59 → 37–44 ở các cảnh nhân vật chiếm khung | — |
| Chạy GPU | 696s (2 shot) | 1023s (3 shot, ~340s/shot), không OOM | — |

Kết luận có căn cứ: node làm khung đầu mất màu thật và mờ hơn rõ rệt (độ nét khung 36 thấp hơn 39%). **Chưa kết luận được về độ sáng:** bản không node tối dần chủ yếu do nội dung (nhân vật tiến lại, đồng phục tối chiếm khung, trời ra khỏi khung), còn bản có node bị ép phẳng bằng histogram matching; số đo không phân biệt được "ép phẳng" là sửa hay làm hỏng thứ người xem thấy. Cần xem mắt hai video.

Cũng nâng `RUNPOD_H3_MULTISHOT_MAX_SHOTS` mặc định 2 → 6 theo mục 8c; job 3 shot × 124 khung lần này xong 1023s, không OOM. Biến mới `RUNPOD_H3_MULTISHOT_CHAIN_NORMALIZE`: `off` (mặc định, không có node "20"), `texture` (`colour_match=False`), `full` (hành vi cũ). Chưa thử > 6 shot, shot dài hơn 124 khung nhiều shot.
