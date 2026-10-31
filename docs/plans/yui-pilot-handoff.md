# YuiDrama pilot: bàn giao cho cloud session (2026-11-01)

Mục tiêu: sinh sketch + render hàng loạt bằng Qwen-Image 2.1 để dựng video dài multishot H3 (~28–40 s mỗi chuỗi), pilot beat 10–14 rồi nhân ra 30 beat.

## 1. Hiện trạng (đã xong, đã nằm trên `main`, commit `3cc0c454`)

- Prompt sketch riêng cho Qwen (`build_qwen21_sketch_prompt`), prompt render có ảnh cảnh + sheet identity.
- Sửa chọn ảnh identity theo từng beat (`resolve_identity_image_path`): trước đây cả lô dùng ảnh identity của beat đầu.
- Móc Turbo LoRA + seed cố định (mặc định tắt): `RUNPOD_QWEN21_RENDER_LORA / _LORA_STEPS / _LORA_STRENGTH / _SEED`.
- Nguồn image worker RunPod nằm ở `runpod/` (qwen, h3, multishot) + workflow `.github/workflows/build-runpod-worker-image.yml`.
- Chuỗi H3: mỗi shot chỉ khai nhân vật beat đó dùng; chỉ shot 1 có `<Picture 1>`; `multishot_video` có sàn timeout 3 giờ.
- Công cụ đo: `scripts/face_similarity.py` (SFace, ngưỡng 0,363), `scripts/qwen_render_ab.py` (A/B có seed, chạy trong container).
- Kết quả pilot: beat 10–11 đã ra video 16 s (đạt, người dùng duyệt). Beat 12–14 chưa chạy video.

## 2. Việc cho CLOUD session (không cần dữ liệu dự án local)

### 2.1 Build và đưa image Qwen mới lên (ưu tiên 1)
Lý do: endpoint `q639jfhc6uaf3t` đang chạy `ghcr.io/nguyenductho89/photoreal-qwen-worker:0.37.2-sam3-frameinterp`, không đọc `COMFY_EXTRA_ARGS` và không map `loras/`, nên không nạp được Turbo LoRA (nhanh ~5 lần: ~60 s so với ~300 s mỗi ảnh).

1. Tạo secret `GHCR_PAT` (quyền write:packages) trong repo `nguyenductho89/dramaclaw`.
2. **Trước khi build**, đối chiếu `runpod/qwen/` với image đang chạy (nguồn gốc: repo `photoreal-short-drama-generator`, nhánh `tesla`, thư mục `runpod-qwen/`). Phải xác nhận không mất tính năng `frameinterp` / `detection` / `checkpoints`. Yaml hiện đã giữ các thư mục này; cần kiểm Dockerfile có cài đủ node/phụ thuộc không.
3. Chạy workflow `build-runpod-worker-image` với `image: qwen`, tag mới (ví dụ `0.37.2-sam3-frameinterp-loras`).
4. Cập nhật endpoint `q639jfhc6uaf3t` qua MCP RunPod `update-endpoint`: image mới + `COMFY_EXTRA_ARGS=--extra-model-paths-config /runpod-volume/extra_paths_loras.yaml`. **Bẫy:** `env` bị ghi đè nguyên bộ, phải gửi lại đủ 4 biến R2 (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` là secret ref `{{ RUNPOD_SECRET_... }}`, `R2_BUCKET`, `R2_ENDPOINT`). Endpoint dùng chung volume `zyen2jmxt3` với `comfy-trends`.
5. Kiểm: 1 job Qwen 2.1 có `lora_name` Turbo; `object_info` phải liệt kê LoRA; job không có LoRA vẫn chạy như cũ (hồi quy).
6. Rollback: đặt lại image `0.37.2-sam3-frameinterp`, xóa `COMFY_EXTRA_ARGS`.
7. Giữ `workers.max=0` khi xong.

LoRA đã có trên volume `models/loras/`: `qwen_image_2.1_turbo_lora_avg_rank_178_bf16.safetensors` (8 bước, cfg 1), `p_q_image_2.1_8_steps_v0.1_comfyui_bf16.safetensors`, `p_q_image_2.1_6_steps_v0.2_comfyui_bf16.safetensors`. Giấy phép Qwen 2.1: Research License (không thương mại).

### 2.2 Nghiên cứu điều khiển dáng (tùy chọn)
Dáng trong sketch hay trôi về "đứng thẳng nhìn camera" (beat 11). Không có tài liệu chính chủ nói Qwen 2.1 edit đọc sketch làm điều khiển dáng.
- Có `alibaba-pai/Qwen-Image-2.1-Fun-Controlnet-Union` (Pose/Depth/Canny/Scribble/Lineart); Comfy-Org đóng gói trong `Comfy-Org/Qwen-Image-2.1/model_patches/`.
- Việc cần làm: hỏi `object_info` của worker thật xem node nào áp dụng nó (ComfyUI 0.37.2; PR 16519 liên quan), rồi thử trên 1 beat. Nếu không có node, dừng và báo lại, đừng tự nâng ComfyUI.

## 3. Việc chỉ làm được trên MÁY LOCAL (cần container và dữ liệu dự án)

Container `dramaclaw-api-1` giữ dữ liệu dự án `YuiDrama` (id `01M5YQ80R0H4DJF6AHDJGMAZQ6`), cổng API `localhost:8780`. Cloud không truy cập được.

1. **Triển khai code mới vào container** (không recreate): `docker cp src/novelvideo dramaclaw-api-1:/app/src/` rồi `docker restart dramaclaw-api-1`. Nếu phải recreate thì cài lại `uv pip install --python /app/.venv/bin/python langfuse boto3`.
2. **Chạy chuỗi beat 12–14** (`seg_ep001_07`, kosode): `segments/videos/review` rồi `segments/video/generate` với `review_fingerprint`. Ước ~35 phút, ~$0,9 trên A40. Bật worker bằng `POST /api/v1/runpod-worker/multishot/start`, tắt bằng `/stop`. Mỗi shot chạy ~8 s (192 khung) dù review ghi 5–6 s.
3. **Chuỗi còn lại** của tập 1 (các segment `seg_ep001_01…16`): cần frame đầu (render) cho beat đầu mỗi chuỗi.
4. **Nhân ra 30 beat**: sketch 1x1 từng beat (`sketch_regen`), rồi `render/plan` + `render/execute`. Giới hạn **3 task cùng lúc mỗi dự án**, chia lô ≤3 beat. Dùng `image_generation_selection=runpod_qwen21_render`.
5. **Bật Turbo LoRA** sau khi 2.1 xong: đặt `RUNPOD_QWEN21_RENDER_LORA=qwen_image_2.1_turbo_lora_avg_rank_178_bf16.safetensors` trong `.env`, recreate api theo quy trình ở mục 1. Đo trước bằng `scripts/qwen_render_ab.py` (cùng seed) và `scripts/face_similarity.py`.

## 4. Vấn đề đã biết (đừng tưởng đã giải quyết)

- Beat 11 render đúng mặt (cosine 0,536) nhưng dáng đứng thẳng nhìn camera, không quay lại cửa như sketch.
- Beat 13 người dùng đánh giá **sai mặt**: mặt nhỏ (~43px), nghiêng; cosine 0,381 sát ngưỡng nên không tin được. Ảnh có mảng trời trắng thừa. Hướng đã chốt: để H3 giữ danh tính từ ảnh tham chiếu lúc tạo video, thay vì sửa trên ảnh tĩnh.
- Review prompt H3 đôi khi rơi về `fallback_template` (AI lỗi); chạy lại `segments/videos/review` là được.
- Giới hạn task 60 phút (`ST_PROJECT_TASK_TIMEOUT_S=3600`): chuỗi 5 shot từng bị hủy lúc gần xong, mất ~55 phút GPU. Đã thêm sàn 3 giờ cho `multishot_video` (đã nạp vào container). Chuỗi dài vẫn nên kiểm timeout trước khi chạy.
- Chưa có điều khiển dáng chính thức cho Qwen 2.1 (xem 2.2).
- 9 test H3 và 3 test freezone image-backend fail từ trước (không do thay đổi này); `check_no_cjk.py` còn 1 dòng ngoài phạm vi; `lint_banned_words.py` báo "open source" trong `docs/h3-templates/index.html`.

## 5. Quy tắc làm việc

- Mọi thay đổi chỉ áp dụng cho `runpod_qwen21_render`, không đụng provider khác.
- Việc tốn GPU (render, video, build) phải báo chi phí và hỏi trước.
- Đừng in key/secret ra log. Không `docker compose build` image api (digest không resolve được).
- Commit theo kiểu repo: có trailer `Co-Authored-By`, không `Signed-off-by`. Chạy `python scripts/check_no_cjk.py` trước khi commit.
