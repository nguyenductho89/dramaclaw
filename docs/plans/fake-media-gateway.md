# Plan: API giả kiểu NewAPI cho dramaclaw, render thật bằng Qwen/H3 (ComfyUI)

## Context
dramaclaw không tự gọi Qwen hay H3. Mọi request ảnh/video đều đi qua gateway NewAPI theo kiểu OpenAI:
- **Video:** `NewApiVideoGenerator` (`src/novelvideo/generators/video_generator.py:1970`).
- **Ảnh:** `_call_newapi_image_api` (`src/novelvideo/generators/nanobanana_grid.py:3656`).

Repo gateway thật (`dramaclaw-gateway`) không có ở máy này. Trong khi đó, `ad-with-skills` đã có sẵn hạ tầng chạy được: ComfyUI trên pod Vast/RunPod, cùng graph Qwen-Image 2.1 và graph MiniMax H3 v16.

Mục tiêu là dựng một server "giả gateway" để đặt `NEWAPI_BASE_URL` trỏ vào nó. Server nhận request NewAPI, dựng graph ComfyUI bằng code port từ ad-with-skills, chạy trên pod qua `COMFY_URL`, rồi trả kết quả đúng hình dạng client dramaclaw đang đọc. Không phải sửa gì trong `src/novelvideo`.

## Vị trí và cấu trúc
`scripts/fake_media_gateway/` là một package nhỏ, chạy bằng `uv run python -m scripts.fake_media_gateway --port 8790`:
- `comfy_client.py`: port `upload` và `render` từ `ad-with-skills/tools/comfy_qwen.py:54-90`, thêm phần lấy `.mp4` từ mọi output node như `tools/render_chain.py:_run`. Dùng httpx, đọc `COMFY_URL` (mặc định `http://127.0.0.1:8188`), timeout lấy từ env.
- `qwen_graph.py`: port `loaders()` và `sampler()` từ `comfy_qwen.py`, `compose_graph()` từ `qwen_images.py:34`, `canvas_image()` từ `:237` và `finish()` từ `:58`.
  - Lấy tên model từ `ad-with-skills/vendor/novelvideo/config.py:16-26` (env `RUNPOD_QWEN_IMAGE_*`).
  - Không port `qwen_prompt_gate`, vì đó là quy trình review riêng của ad-with-skills.
- `h3_graph.py`: copy nguyên `V16`, `build_v16_graph`, `resolution` và `preflight` từ `tools/h3_workflow_graph.py`, cộng `frames_for(sec)` từ `tools/lint_h3_prompts.py:32`. `resolution()` được mở rộng để nhận các ratio dramaclaw gửi (21:9, 16:9, 4:3, 1:1, 3:4, 9:16), giữ quy tắc ~1MP và bội số 32.
- `server.py`: app FastAPI (dramaclaw đã có fastapi và uvicorn). Chi tiết ở mục dưới.
- `__main__.py`: CLI (`--host`, `--port`, `--output-dir`, `--comfy-url`).
- `README.md`: cách bật pod (dùng `tools/pod/pod_up.sh` của ad-with-skills, cờ `--workflow-v16 --with-qwen`), cách dùng `ssh -L 8188:127.0.0.1:8188`, và các env cần đặt cho dramaclaw.

## Hợp đồng của server (khớp với client dramaclaw)

**Auth:** chấp nhận mọi `Bearer`. Nếu có env `FAKE_GATEWAY_API_KEY` thì so khớp với nó.

**Ảnh: `POST /images/generations` và `POST /images/edits`**
- Đọc `prompt`, `width`/`height` hoặc `metadata.ratio`. Ảnh tham chiếu nhận cả hai dạng: `image: [url]` và `images: [{image_url}]`.
- Mỗi tham chiếu là URL http(s) hoặc `data:` URI. Server tải về rồi `upload` lên ComfyUI.
- Không có tham chiếu: dùng ảnh nền xám `canvas_image` làm image_1 (cách của ad-with-skills với `@canvas`).
- Gọi đồng bộ, trả `{"created":…, "data":[{"b64_json": …}]}` (client đọc ở `nanobanana_grid.py:3932-4013`).

**Video: `POST /video/generations`**
- Đọc `prompt`, `duration` (int 4–15, `"auto"` thì lấy 5), `image` (frame đầu), `metadata.{ratio, reference_images[], reference_audios[], last_frame_image}`.
- Ánh xạ sang chain v16: `frames = frames_for(duration)`, một shot, ảnh ref = frame đầu (nếu có) + `reference_images` (tối đa 9), voice = `reference_audios` (tối đa 3).
- Không có ảnh nào thì trả 400 và nói rõ lý do: v16 cần từ 1 đến 9 ảnh. `last_frame_image` và `reference_videos` cũng trả 400 "unsupported", không lặng lẽ bỏ qua.
- Ghi task vào bộ nhớ, trả `{"task_id", "status":"queued"}`.
- Một worker chạy nền xử lý tuần tự: pod chỉ có 1 GPU nên `asyncio.Queue` với 1 consumer là đủ. Worker gọi `GET /object_info` rồi `preflight`, sau đó `render`.

**Video: `GET /video/generations/{task_id}`**
- Trả `{"task_id", "status": queued|in_progress|completed|failed, "result_url", "error"}`.
- `result_url = http://127.0.0.1:<port>/files/<task_id>.mp4`. Client đã tự đổi localhost sang host của gateway (`video_generator.py:2706`).

**Phụ:** `GET /files/{name}` (StaticFiles trỏ vào output dir) và `GET /healthz` (thử `COMFY_URL/system_stats`).

Output nằm ở `--output-dir`, mặc định `output/fake_media_gateway/` (đã nằm trong gitignore của output, sẽ kiểm tra lại).

## Cấu hình phía dramaclaw (chỉ là env, không sửa code)
```
NEWAPI_BASE_URL=http://127.0.0.1:8790
NEWAPI_API_KEY=fake
VIDEO_BACKEND=newapi_MiniMax-H3
```
Model ảnh giữ `NEWAPI_IMAGE_MODEL` như cũ. Server định tuyến theo endpoint, không theo tên model.

File ảnh hoặc audio nằm trên máy cục bộ vẫn đi qua `MEDIA_RELAY_PROVIDER` như bình thường, nên server chỉ cần nhận URL. README sẽ ghi rõ điều này.

## Test
`tests/test_fake_media_gateway.py`:
- Dựng một ComfyUI giả bằng `ThreadingHTTPServer` theo mẫu `tests/test_workflow_mcp.py:1057`, có các route `/upload/image`, `/prompt`, `/history/{id}`, `/view` và `/object_info`.
- Chạy server bằng FastAPI `TestClient`.
- Kiểm tra bốn việc:
  1. Request ảnh tạo graph Qwen có node `TextEncodeQwenImage21` và số ảnh đúng, rồi trả `b64_json`.
  2. Request video tạo graph v16 có `duration = frames/24` và các `ref_image_k` đúng, đi từ queued sang completed, và `result_url` tải được.
  3. Request video không có ảnh trả 400.
  4. Unit test `frames_for` và `resolution` theo từng ratio.

## Verification (lần này chỉ test mock, chưa chạy pod)
1. `uv run pytest tests/test_fake_media_gateway.py`: unit test với ComfyUI giả, không cần GPU.
2. Smoke test cục bộ:
   - Bật một stub ComfyUI nhỏ (lấy lại handler trong test) và chạy server.
   - `curl` một request ảnh và một request video, kiểm tra hình dạng response và luồng poll.
3. Chạy thật trên pod để sau, khi bạn yêu cầu.
