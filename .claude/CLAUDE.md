# DramaClaw local setup notes (Claude Code)

Máy này đã cài và cấu hình sẵn. Đọc file này trước khi cài/cấu hình lại để khỏi mất thời gian. Không ghi bí mật vào đây; mật khẩu root NewAPI nằm ở `NEWAPI_ROOT_PASSWORD` trong `.env` (gitignored).


## Gateway chỉ dùng custom, NewAPI trên máy này (2026-10-29)

- Đã bỏ chế độ `official`/`hybrid`: `normalize_gateway_mode()` luôn trả `custom` (chỉ nhánh CE), route `/official/enable` và `/hybrid/enable` trả 410, Settings chỉ còn tab custom. Lý do: danh mục RunPod của Freezone chỉ merge ở custom/hybrid.
- Volume Docker của máy này tạo mới ngày 2026-10-22, nên các mục bên dưới viết "đã khởi tạo NewAPI / đã có channel" là trạng thái của máy khác. Ở máy này NewAPI được khởi tạo ngày 2026-10-29 (`POST /custom/newapi/init`, body `setupUsername`/`setupPassword`/`setupConfirmPassword`, mật khẩu = `NEWAPI_ROOT_PASSWORD`), rồi dựng lại bằng `upsert_channel()` đúng 2 channel: `DC-deepseek` (22 alias text) và `DC-qwen-vision` (5 alias vision: video-identity-detector, video-prompt-optimizer, freezone-vision, video-h3-prompt, render-qwen-edit-prompt). Chưa dựng `DC-custom`, `DC-ollama` và 3 alias cognee/hermes/codex.
- Khi dựng lại channel, đọc key từ biến môi trường trong container, đừng `echo` giá trị key khi kiểm tra `.env`.


## Chạy stack

- Dùng image dựng sẵn, không cần clone gateway: `docker compose -f docker-compose.release.yml up -d` (api, newapi, web).
- Nếu Docker chưa chạy: `open -a Docker`, chờ `docker info` thành công.
- Cổng: web `http://localhost:8080`, API `http://localhost:8780`, trang admin NewAPI `http://127.0.0.1:30000`.
- Cổng 3000 trên máy bị container `stub-server-stub-1` chiếm, nên `.env` đặt `ST_NEWAPI_PORT=30000`. Đừng bỏ dòng này.
- `/health` của API trả 404 (bình thường). Dùng `docker compose -f docker-compose.release.yml ps` (api phải `healthy`) và `GET /api/v1/projects`.
- `docker compose up` lần đầu pull image rất lâu (hơn 10 phút); chạy nền.


## Cấu hình model (mode `custom`, đã làm qua API, không cần DC key)

- Khởi tạo NewAPI: `POST /api/v1/model-gateway/custom/newapi/init` (username `root`). Cập nhật mapping: `POST /api/v1/model-gateway/custom/newapi/channels` (cùng tên kênh thì thành update).
- **Text**: hầu hết alias → DeepSeek (`DC-deepseek`, type 43, model `deepseek-chat`, key `DEEPSEEK_API_KEY`). **Vision** (alias video-identity-detector, video-prompt-optimizer, freezone-vision, video-h3-prompt/vision, render-qwen-edit-prompt) → Qwen (`DC-qwen-vision`, type 1, base_url **`https://dashscope-intl.aliyuncs.com/compatible-mode`** — KHÔNG có hậu tố `/v1`, hậu tố đó gây 404 `openai_error` âm thầm, đã gặp lại ít nhất 1 lần sau khi sửa — luôn kiểm `base_url` qua `GET /api/channel/{id}` (127.0.0.1:30000, `root`/`NEWAPI_ROOT_PASSWORD`) trước khi nghi ngờ chỗ khác). Lý do/đầy đủ: `docs/adr/0002-identity-planner-and-text-models-deepseek.md`.
- **Qwen qua DashScope không dùng `tool_choice: required`** (chạy "thinking mode", trả 400 nếu ép) — chỉ dùng `output_type=str`/`NativeOutput`. Đừng route task kiểu identity_planner (cần forced tool-calling) sang Qwen.
- **Bẫy đổi model_mapping giữa 2 channel NewAPI**: xoá hẳn channel cũ (`delete_channel_by_name` trong `newapi_provisioner.py`), đừng chỉ sửa mapping về rỗng — bảng "abilities" nội bộ không tự đồng bộ theo `PUT /api/channel/`, request thật vẫn có thể bay vào channel rỗng và 404.
- **Debug bằng `upsert_channel()`/in response ra terminal**: field `sentPayload.channel.key` trả về là API key thật dạng plaintext — đừng `print()` nguyên response dict, chỉ lấy field cần (`ok`/`action`/`channelId`).
- Embedding: `DC-ollama` (type 4) → `http://host.docker.internal:11434`, `DC-cognee-embedding` → `bge-m3`, 1024 chiều, batch 10. Cần `ollama serve` chạy; lưu preset key (`provider-channels`) trước khi gọi `embedding-model`. Claude/Anthropic không có model embedding, đừng dùng cho alias này.
- **Ảnh**: mặc định toàn bộ (`DEFAULT_CHARACTER/SKETCH/RENDER_IMAGE_SELECTION`) = `gemini_webai` (qua `web_ai_server`:6969, Playwright-driven, đọc artifact trong `/chat/completions`, không dùng chuẩn OpenAI Images API). Chi tiết: `docs/adr/0001-local-gemini-webai-image-provider.md`.
  - **Bẫy**: mỗi lần `web_ai_server` (project `~/WebAI-to-API`) restart thì phải `docker restart dramaclaw-api-1` theo sau — cookie `runtime/auth/gemini.json` đổi inode mỗi lần start, bind-mount phía `api` bị "đứt" theo inode cũ.
  - **Bẫy khác**: bảng `conversation_snapshots` trong `conversation_snapshots.db` của `web_ai_server` có thể tự rỗng (không cần restart) — lỗi `no such table: conversation_snapshots`. Fix: `docker restart web_ai_server` rồi `docker restart dramaclaw-api-1`.
  - **Bẫy ref ảnh JPEG**: `web_ai_server` validate đuôi file khớp MIME — ảnh ref JPEG mà filename hardcode `.png` sẽ bị 400. Đã vá bằng `_webai_ref_filename()` dùng `mimetypes.guess_extension` ở các nhánh sketch/render/scene/prop.
  - Các lựa chọn dev-only khác trong `IMAGE_GENERATION_SELECTIONS` (ẩn trừ khi có key tương ứng trong `.env`): `google_gemini`/`_1k/2k/4k` (Google AI Studio trực tiếp, `GOOGLE_AI_API_KEY`, model `gemini-3.1-flash-lite-image`/`-flash-image`, aspect_ratio chỉ nhận enum cố định + model lite chỉ ra 1K), `qwen_image_2/2_pro/3/3_pro` (DashScope, `QWEN_API_KEY`, endpoint native `multimodal-generation`, giới hạn diện tích pixel [262144, 4194304]), `runpod_qwen*`/`runpod_qwen_edit*`/`runpod_qwen21_*` (RunPod serverless — xem mục "Trạng thái hiện tại các tính năng RunPod/H3" ngay dưới, lịch sử đầy đủ trong archive).
  - **Panorama (360) là pipeline riêng** — không theo Image source picker, chỉ đọc `SCENE_360_IMAGE_PROVIDER`/`MODEL` trong `.env` trực tiếp.
  - **Cảnh báo per-project override**: ảnh nhân vật (character, khác sketch/render) ghi cứng `character_image_selection` vào `project_config.json` của project ngay lần đầu mở panel chọn model — ghi đè vĩnh viễn default `.env` cho riêng project đó. Đổi `.env` không ảnh hưởng; phải tự xoá key này khỏi file (route PATCH chính thức validate theo danh sách khác, sẽ báo "Invalid character_image_selection").
- **Container `api` chạy image local build sẵn** (`dramaclaw-local/api`) — không `docker compose build`/`up --build` (Dockerfile pin digest không resolve trên máy này, sẽ fail). Sửa code Python áp dụng ngay: `docker cp` file vào `/app/src/novelvideo/...` trong container rồi `docker restart dramaclaw-api-1` (giữ filesystem container). Nếu bắt buộc `docker compose up -d` (recreate — cần khi đổi biến `.env` mới, vì `env_file` chỉ đọc lúc tạo container): `docker cp` TOÀN BỘ `src/novelvideo` (không phải vài file, image gốc cũ hơn khá nhiều, thiếu cả module) rồi cài lại `langfuse`/`boto3` (`docker exec ... uv pip install --python /app/.venv/bin/python langfuse boto3`) rồi `docker restart`.
- `IDENTITY_PLANNER_CAST_MODEL`/`_ANALYSIS_MODEL`/`_APPEARANCE_MODEL` trong `.env` → alias `DC-deepseek-identity-LLM`. 19 alias text khác (build_characters, script, scene/prop planner...) map thẳng trong channel `DC-deepseek`, không cần sửa `.env`.
- **`MINIMAXH3_KEY` (trong `.env`) không phải key gọi trực tiếp API MiniMax** — chỉ là tên catalog của gateway production, gọi trực tiếp `api.minimax.chat`/`api.minimaxi.com` luôn trả `invalid api key`. Đừng tốn thời gian test lại key này trên domain MiniMax chính thức.
- **Bẫy: `web` (frontend) build từ source, không còn prebuilt image `claymorelab/dramaclaw-frontend`** — build: `docker compose -f docker-compose.yml build web` (chỉ `web`, không `up --build` cả file vì `newapi` cần sibling checkout không có trên máy này); chạy: `docker compose -f docker-compose.release.yml -f docker-compose.web-local.yml up -d web` (file override gitignored, chỉ đổi image). **Chạy `up -d` không kèm `-f docker-compose.web-local.yml` sẽ kéo `web` về prebuilt cũ, mất tính năng** — đã tái xác nhận bẫy này nhiều lần. Lệnh `up -d` đụng `web` cũng có thể vô tình recreate luôn `api` (thấy cột IMAGE đổi về `claymorelab/dramaclaw:2.0.4` trong `docker compose ps`) — kiểm và patch lại `api` nếu vậy.
- Lịch sử đầy đủ (benchmark độ phân giải RunPod Qwen 2.1, bẫy `workers.max=0`, graph/prompt Edit-2511, bug ghép multi-character 2-pass, props.py unpack bug, Google Gemini native provider...): `docs/archive/claude-md-history.md`.

## Trạng thái hiện tại các tính năng RunPod/H3 (tóm tắt — chi tiết trong docs/archive/)

- **4 endpoint RunPod**: `a31613hf7l83r5` (`qwen-t2i-h3-i2v-ref2va` — Qwen-Image 2.1 t2i/edit + H3 1-shot ref2va/fl2va, dùng chung với project `~/Xuongphim/trends/comfy-trends`), `u0hkrms7k1xeua` (`h3-multishot-i2v-fl2va-ref2va` — H3 multishot, cũng dùng chung với comfy-trends), `cekzpt4p7680pt` (Qwen-Image-Edit-2511), `q639jfhc6uaf3t` (`qwen-image-t2i-fast` — có SAM3/SAM3DBody/RT-DETR nạp sẵn). Cả 4 đang `workers.max=0` theo mặc định — bật tay qua Settings → Models (nút Bật/Tắt worker, chỉ chạy trên runtime CE-local) hoặc MCP RunPod trước khi render, tắt lại sau khi xong. Vì dùng chung với project khác, luôn kiểm trạng thái thật (`GET .../runpod-worker/status`) trước khi render — đừng giả định `workers.max` còn giữ từ lần trước.
- **Lưu trữ model**: global volume `dramaclaw-models-global` (đọc ở `/runpod-volume`) là nguồn chính cho cả 4 endpoint (đã verify chạy thật). Network volume cũ `zyen2jmxt3` coi như đã nghỉ (chưa xoá, còn vài file dự phòng).
- **Khi thuê GPU rời (ngoài RunPod serverless, ví dụ để benchmark/chạy model với toàn quyền máy — xem "Pilot Three.js previs"/"Benchmark H3 multishot 30s" trong archive) chỉ thuê RTX 4090 hoặc RTX 5090**, chưa chốt dùng nhà cung cấp/loại GPU khác.
- **`VIDEO_BACKEND` mặc định = `runpod_minimax_h3`** (`.env`, máy này). H3 ref2va hiện chạy **base 20 bước** (`RUNPOD_H3_PDD_REF2VA` để rỗng — PDD 8 bước làm nhoè mặt/bóng ma); fl2va vẫn PDD (`RUNPOD_H3_PDD_FL2VA` có giá trị). LoRA Turbo (6-8 bước, nhanh hơn) có công tắc riêng (`RUNPOD_H3_TURBO_LORA_REF2VA`/`RUNPOD_H3_MULTISHOT_TURBO_LORA`) nhưng **mặc định tắt**.
- **LoRA realism** (`fal/MiniMax-H3-Realism-People-LoRA`) đang **bật** qua `.env` (`RUNPOD_H3_REALISM_LORA` có giá trị, strength 0.7) — A/B chưa thấy lợi ích rõ rệt nhưng đang giữ bật theo yêu cầu.
- **Rewriter prompt H3 là kiến trúc 2 bước**: bước 1 vision (Qwen, `DC-video-h3-vision-LLM`, chỉ mô tả ảnh thật 1 câu/ảnh) → bước 2 compile (DeepSeek, `DC-video-h3-prompt-LLM`, forced tool-calling, không gửi ảnh). Auto-retry tối đa 3 lần khi lint lỗi.
- **Luồng render nhiều nhân vật khuyến nghị hiện tại**: `runpod_qwen21_compose` (sketch-free, N ảnh scene+identity+prop trong 1 lần gọi, không mask) — kết quả tốt nhất đã verify (đúng tuổi/tỉ lệ cơ thể + identity + nhanh ~8 phút). `runpod_qwen21_render`/`_render_multi` (sketch+mask 2-pass) và `runpod_qwen_edit_render`/`_render_multi` (Edit-2511) vẫn là phương án dự phòng, có bug fidelity/tỉ lệ cơ thể từng gặp — xem archive trước khi dùng lại.
- **Project "Yui"**: đã bỏ hẳn bước ghép ảnh tĩnh (Qwen compose) cho nhân vật vào location — giờ đưa location sạch + sheet identity + prop thẳng vào MiniMax H3 (video model tự đặt nhân vật vào cảnh đúng tỉ lệ/identity hơn ghép ảnh tĩnh). Soạn prompt H3 luôn qua `/freezone/video/multishot/review` (có LLM compile+lint+vision), không viết tay — kể cả cảnh 1-shot (gọi review với 2 shot giả, lấy prompt shot 1).
- **Luồng "Segment multishot" 2 pha** (duyệt hết ảnh rồi mới tạo video hàng loạt) đã có đủ route backend (`segments/plan`, `/apply`, `/frames/generate`, `/frame/approve`, `/videos/review`, `/video/generate`) — chưa có UI frontend, chưa chạy GPU thật qua route này.
- **Freezone giờ có RunPod** (ảnh: `runpod_qwen_image`/`runpod_qwen_edit`/`runpod_qwen21_render`; video: `runpod_minimax_h3`) — phải đi qua 3-4 lớp allowlist/catalog riêng của Freezone (khác cơ chế provider/selection của pipeline beat chính) — xem archive nếu cần thêm provider RunPod mới vào Freezone.
- **SAM3/SAM3DBody/RT-DETR** đã nạp trên endpoint `q639jfhc6uaf3t`, nhưng pipeline ground-plane dựa trên nó (`scripts/sam3_pipeline/`) đã bị **xoá chủ động** (project Yui chuyển sang dùng H3 trực tiếp, xem trên) — muốn dùng lại phải viết lại từ đầu theo `docs/adr/0010-sam3-ground-plane-compositing.md`.
- **Tự cứu worker kẹt**: `StuckWorkerWatchdog` tự cycle `workers.max` khi job kẹt `IN_QUEUE` quá hạn, đã nối vào các vòng poll chính — chưa verify bằng GPU thật.
- **SeedVR2 upscale 2x**: route `/freezone/video/upscale-seedvr2` hoặc `scripts/seedvr2_upscale_chunked.py`. Ở mặt nhỏ trong khung, upscale 2x hay sinh chi tiết giả (ví dụ khuyên mũi không có thật) — fix bằng upscale 1.5x rồi Lanczos lên đúng kích thước 2x.

## Agent model (Xia Director) dùng DeepSeek trực tiếp (2026-10-29)

- Settings → Models → **Agent model** = Third party: `POST /api/v1/model-gateway/agent/config` với `mode:"third_party"`, `baseUrl:"https://api.deepseek.com/v1"`, `model:"deepseek-chat"`, `apiKey` = `DEEPSEEK_API_KEY` (lưu trong settings DB của CE, không ghi vào repo). Chỉ ảnh hưởng Agent; các route text/ảnh/video vẫn theo gateway `custom`.
- Codex App Server cần `wire_api="responses"`; đã kiểm `api.deepseek.com/v1/responses` trả 200 nên dùng được. Không qua NewAPI nên không cần alias `DC-codex-agent-LLM`.
- Muốn quay lại: chọn "Follow current channel" (`mode:"inherit"`).

- **Bẫy: Hermes trong container phải là bản fork, không phải stock (2026-10-29).** Image local cài Hermes gốc (v0.19.0) nên mọi lượt chat báo `Model connection failed ... cannot be reached` (log thật ở `/data/runtime/api.log`: `HermesForkMissing ... _recover_turn_meta`), không liên quan model. Fix: clone `github.com/dramaclaw/hermes-agent` nhánh `brainclaw/evidence-plane` trên host (container không có git), `docker cp` vào `/opt/hermes-fork`, rồi `docker exec -e UV_HTTP_TIMEOUT=120 -e UV_HTTP_RETRIES=5 dramaclaw-api-1 sh -c 'cd /opt/hermes-fork && uv pip install --python /root/.local/share/uv/tools/hermes-agent/bin/python -e ".[acp]"'` (tải wheel `nemo-relay` hay lỗi DNS, thử lại), xong `docker restart dramaclaw-api-1`. Mất khi container bị recreate. Verify bằng websocket `chat.message` (cần `docker exec -i`).


## Embedding có cần không?

- Dự án mới tạo qua API luôn là `knowledge_pipeline: "structured_v1"` (`src/novelvideo/api/routes/projects.py:765`): không embedding, không đồ thị, không vector index. Ingest chỉ lưu nguồn và chia chunk.
- Chỉ dự án `cognee_legacy` (trường `knowledge_pipeline` vắng hoặc khác `structured_v1`, cố định từ lúc tạo) mới cần embedding. Xem trường này ở `GET /api/v1/projects/{id}`.
- `structured_v1` chỉ chia tập theo chương/số tập (`planning_mode: "chapters"`); thao tác Cognee báo `KnowledgePipelineUnsupported`.


## Tài liệu channel/model theo từng bước pipeline

`docs/vi/pipeline/index.html` có tab **Model & Channel** (bên cạnh tab Pipeline gốc): bảng 4 channel NewAPI đang chạy (đối chiếu `list_channels()` live), và mỗi bước pipeline dùng key `.env` nào → alias nào → channel/model thật nào, kèm chế độ output (Tool/forced tool-call, NativeOutput, str) và có cần vision hay không. Đối chiếu lúc 2026-10-13; sửa channel/alias/`.env` theo các bullet ở trên thì nhớ cập nhật lại tab này.


## Quy ước API đã gặp

- Tên dự án chỉ gồm chữ, số, gạch dưới (không có `-`). Các route dùng **project id** (ULID), không dùng tên.
- Upload nguồn: `POST /api/v1/projects/{id}/ingest/upload` (multipart `file`, tùy chọn `spine_template`), rồi `POST .../ingest/start` với `{"filename":..., "spine_template":"narrated"|"drama"}`.
- Đổi `spine_template` của dự án đã tồn tại bắt buộc `"rebuild": true`, nếu không báo "project type can only be changed on re-import".
- Trạng thái: `GET .../tasks`, `GET .../pipeline/status` (bước kế tiếp: `build_characters`).


## Dự án Tesla

- `tesla_pov_short`, id `01M4QF11AY84RDH1B0FMW62W86`, kịch bản nguồn `examples/tesla-pov-short-60s.md`, mẫu `narrated`, đã ingest xong (`structured_v1`, 1 chunk).
- Bản tải lên hiện gồm cả bảng ghi chú kiểm chứng; nên tải bản chỉ có lời dẫn nếu muốn trích xuất sạch.
- `identity_plan` đã chạy xong cho tập 1 (qua DeepSeek, xem bullet `DC-deepseek-identity-LLM` ở trên): 5 identity cho Nikola Tesla (`young_adult` mặc định + 4 identity theo từng thời kỳ 1876–77 Graz/1882 Budapest/1884 New York/1893 Chicago), cả 5 đều có `appearance_details` và đã sinh ảnh identity xong qua `gemini_webai`. Bước kế tiếp theo pipeline doc: `scene_prop`/`script`.


## LLM call log (Langfuse, dev-only)

Đã bật trên máy này theo `docs/en/guides/llm-call-log.md` (2026-10-13). Chi tiết:

- `.env` đã có đủ `LLM_CALL_LOG_ENABLED=1` + `LANGFUSE_HOST/PUBLIC_KEY/SECRET_KEY` + các secret của stack (`LANGFUSE_NEXTAUTH_SECRET`/`SALT`/`ENCRYPTION_KEY`/`INIT_USER_PASSWORD`/`POSTGRES`/`CLICKHOUSE`/`REDIS`/`MINIO_PASSWORD`). Đừng generate lại, chỉ cần `docker compose -f docker-compose.langfuse.yml --env-file .env up -d` khi cần khởi động lại stack.
- UI Langfuse: `http://localhost:3100`, login `admin@dramaclaw.local` / mật khẩu ở `LANGFUSE_INIT_USER_PASSWORD` trong `.env`.
- **`minio/mc` đã bị gỡ khỏi Docker Hub** (MinIO đổi license 2024); `quay.io/minio/mc` và `cgr.dev/chainguard/mc` đều từ chối pull ẩn danh. Service `minio-retention` (chỉ dùng để set rule tự xoá media cũ sau `LLM_LOG_RETENTION_DAYS`) **không chạy được** trên máy này — bỏ qua nó, chỉ `up -d` các service: `langfuse-web langfuse-worker clickhouse minio redis postgres`. Không ảnh hưởng tính năng log, chỉ thiếu auto-cleanup; dọn `scripts/llm_call_log_cleanup.py` bằng tay hoặc cron nếu cần.
- Image `dramaclaw/api` (prebuilt) chưa có `module novelvideo.llm_call_log` và chưa cài `langfuse` — đã `docker cp src/novelvideo dramaclaw-api-1:/app/src/` và cài package. **Lưu ý: app chạy bằng venv ở `/app/.venv` (uv-managed, không có `pip` trong venv)**, `pip install langfuse` thường (global pip) sẽ cài nhầm vào `/usr/local/lib/python3.12/site-packages` — venv không thấy. Cách đúng: `docker exec dramaclaw-api-1 sh -c 'cd /app && uv pip install --python /app/.venv/bin/python langfuse'`, rồi `docker restart dramaclaw-api-1`. Giống các lần vá code khác: nếu phải `docker compose -f docker-compose.release.yml up -d` (recreate), nhớ `docker cp src/novelvideo` lại rồi cài `langfuse` lại bằng `uv pip` như trên trước khi restart.
- Đã verify end-to-end bằng cách gọi thật `http://host.docker.internal:6969/v1/chat/completions` (gemini-flash, không tốn phí NewAPI) từ bên trong container rồi check `GET http://localhost:3100/api/public/traces` (basic auth bằng `LANGFUSE_PUBLIC_KEY:LANGFUSE_SECRET_KEY`) — trace hiện ra đầy đủ input/output/latency. Không nên tự gọi NewAPI trực tiếp để test vì app dùng cơ chế auth per-turn (placeholder key + latch), không có static token tĩnh để tái dùng ngoài flow thật.


## Đừng làm

- Đừng tìm hay in `settings.db` / token chạy của DramaClaw (hệ thống chặn thao tác dò thông tin xác thực).


## Sync với upstream (dramaclaw/dramaclaw) mà không dính conflict tiếng Trung lặp lại

- Repo này đã dịch toàn bộ comment/chuỗi trong code sang tiếng Anh, upstream vẫn sửa trên bản tiếng Trung nên mỗi lần merge đều xung đột ở các dòng đã dịch. Gốc rễ là hai bên khác văn bản; cách giữ hướng "tiếng Anh" là dùng công cụ, không có cách triệt để.
- Chạy `scripts/sync_upstream.sh` (tự thêm remote `upstream`, unshallow nếu cần, bật `git rerere` để nhớ cách giải, merge `--no-commit`, in danh sách file xung đột và phần CJK mới). Không `git stash` giữa lúc merge dở — sẽ mất `MERGE_HEAD`.
- Quy tắc giải: giữ chữ tiếng Anh + key i18n của mình, lấy logic mới của upstream, dịch chữ Trung mới sang tiếng Anh (dòng bắt buộc giữ CJK thì thêm `no-cjk-exempt`). Locale `zh`, `docs/zh/`, `readme/README_zh.md` được miễn khỏi gate `scripts/check_no_cjk.py`.
- Merge xong: `python scripts/check_no_cjk.py` phải sạch, rồi chạy test Python liên quan; test đếm cứng (route decorator, leaf, task type) cần kiểm lại; đăng ký trùng runner khi cả hai bên cùng thêm một tính năng.
- `git rerere` chỉ lưu trong `.git` cục bộ, máy khác cần chạy lại `git config rerere.enabled true`.


## Lịch sử phiên làm việc đã lưu trữ

Log chi tiết từng phiên làm việc (thử nghiệm, debug, benchmark) đã chuyển sang `docs/archive/claude-md-history.md` (2026-11-06) để giữ file này dưới giới hạn ký tự của harness. Mục đích phần này: tra nhanh phiên nào nói về gì, rồi mở archive theo header tương ứng.

- Review video trước khi generate + backend RunPod MiniMax H3 (2026-10-17) — màn hình review prompt H3 trước khi render video, lint/rewrite tự động.
- Review step trước khi Render + chuẩn prompt chính thức Qwen-Image-Edit-2511 (2026-10-17) — màn hình review prompt render, mask preview.
- `runpod_qwen21_render`/`_multi` — Qwen-Image 2.1 cho render, nhanh hơn Edit-2511 (2026-10-18) — port graph 2.1 cho render + fix tỉ lệ cơ thể/identity nhiều nhân vật.
- `runpod_qwen21_compose` — render sketch-free (2026-10-18) — bỏ sketch, ghép thẳng background+identity+prop, kết quả tốt nhất đã verify.
- Đo tốc độ H3 ref2va trên A40: INT8 không nhanh hơn (2026-10-18) — benchmark encoder/VAE INT8 vs NVFP4.
- PDD 8 cho mọi đường H3 + Sage (2026-10-21) — bật PDD 8 bước + Sage Attention cho H3.
- Luồng "Segment multishot" 2 pha (2026-10-21) — thiết kế duyệt-ảnh-rồi-video-hàng-loạt, segment_planner.
- H3 turbo LoRA + A/B ChainNormalize (2026-10-30) — benchmark LoRA turbo 6/8 bước, node chuẩn hoá chain.
- Rewriter H3 quay lại 2 bước (2026-10-30) — lý do đổi từ 1-call vision+JSON sang vision-riêng + compile-riêng.
- SeedVR2 upscale 2x cho video (2026-10-30) — ghép theo luồng, resume theo cache đoạn.
- Compose prompt (sketch-free) + "staging bible" theo cảnh (2026-10-22) — scene_staging_planner, 3 bug rò rỉ tên nhân vật vắng mặt.
- Freezone: thêm RunPod serverless cho image + video (2026-10-22) — 4 lớp chặn ảnh, 3 lớp chặn video, đã vá.
- Freezone: Qwen-Image-Edit-2511 relight + series "Yui" (2026-10-25) — wiring edit/relight, series bible Yui ep1.
- Freezone: wire `runpod_qwen21_render` (2026-10-26) — thử sửa bug tỉ lệ cơ thể compositing vào location, không thành công hoàn toàn.
- Video Breakdown (2026-10-26) — port tính năng phân tích video thành storyboard/motion/music từ upstream.
- SAM3/SAM3DBody trên worker `qwen-image-t2i-fast` (2026-10-27) — pipeline đo scale bằng hình học, đã xoá sau đó.
- Yui: đổi pipeline — bỏ ghép ảnh tĩnh, dùng H3 trực tiếp (2026-10-27) — quyết định kiến trúc hiện hành cho project Yui.
- H3 extend (nối tiếp clip) (2026-10-31) — A/B sheet nhân vật + video đuôi cho nút Smart extend.
- Qwen 2.1 render: sketch riêng, chọn ảnh identity theo beat, Turbo LoRA (2026-10-31) — fix bug chọn nhầm ảnh identity khi render nhiều beat.
- Series Science humor (Einstein và Newton): sản xuất video bằng skill nằm ở `video_production_with_skills/` (xem `pipeline.html` trong đó); benchmark và thử nghiệm H3 cũ ở `research/h3_benchmarks/` (trước đây là `previs_h3_test/`).
- Freezone: mẫu prompt H3 dựng sẵn cho RunPod (2026-10-28) — 16 template prompt H3 trong UI node Video.
- Worker H3 nhanh hơn: torch cu130 + Sage (2026-10-28) — đổi image worker, benchmark tốc độ.
- SeedVR2: 2x hallucinate chi tiết (nhẫn mũi) trên mặt nhỏ (2026-10-29) — fix bằng 1.5x + Lanczos finish.
- H3 ref2va chạy base 20 bước thay PDD (2026-10-29) — lý do tắt PDD cho ref2va trên máy này.
- LoRA realism `fal/MiniMax-H3-Realism-People-LoRA` (2026-10-30) — A/B strength, kết luận chưa rõ lợi ích.
- Tự cứu worker RunPod kẹt khởi động (2026-10-31) — thiết kế `StuckWorkerWatchdog`.
- Pilot Three.js previs → MiniMax H3 (2026-11-01/02) — chuyển sang global volume, đo cold-start/nút thắt thời gian H3.
- Benchmark H3 multishot 30s trên RTX 4090 24GB (2026-11-03) — đo thời gian/RAM/VRAM trên nhiều cấu hình GPU, kể cả máy thuê ngoài RunPod.
