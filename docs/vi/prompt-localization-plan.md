# Kế hoạch: toàn bộ prompt đi theo ngôn ngữ hệ thống (zh / en / vi)

> Trạng thái: **đề xuất**, chưa triển khai. Ngày khảo sát: 2026-10-12. Mục tiêu: người dùng chọn ngôn ngữ nào thì mọi prompt gửi cho model (LLM, ảnh, video, chat agent) đều viết bằng ngôn ngữ đó, và nội dung model sinh ra cũng bằng ngôn ngữ đó.

## 1. Hiện trạng (kết quả khảo sát)

### 1.1 Backend không biết ngôn ngữ UI

- Frontend có 3 ngôn ngữ `SUPPORTED = ["zh","en","vi"]` (`frontend/src/i18n/languages.ts`). Ngôn ngữ chỉ lưu ở localStorage (`app-store.ts`, key `supertale-app`).
- **Không request API nào mang theo ngôn ngữ UI.** Cả `frontend/src/lib/api.ts` và `frontend/src/api/client.ts` (ky) đều không gửi header. Header `Accept-Language` của trình duyệt chỉ phản ánh locale của hệ điều hành.
- Backend chỉ đọc `accept-language` ở `api/routes/release_notifications.py` (và chỉ phân biệt zh/en).
- Project (`project_config.json`), user và các bảng setting đều không có trường ngôn ngữ.

### 1.2 Ngôn ngữ prompt hiện được đoán từ nội dung nguồn, chỉ có zh/en

- `utils/source_language.py` định nghĩa `AssetLanguage = Literal["zh","en"]`. Hàm `detect_asset_language()` đoán ngôn ngữ từ văn bản nguồn. **Mọi thứ không nhận ra là tiếng Anh, kể cả tiếng Việt, đều rơi về `zh`.**
- `asset_language_instruction()` nối thêm một câu dặn ("viết bằng tiếng X") vào cuối prompt. Thân prompt vẫn là tiếng Trung.
- Có nhiều đường đi khác nhau:
  - truyền `output_language` (structured_builders, structured_extraction, identity_planner, cognee pipeline);
  - truyền `language: str` (video/keyframe/global optimizer), default lúc `"zh"`, lúc `"en"`;
  - đoán riêng cho Seedance (`detect_seedance2_prompt_language`).
- `prompt_preview/steps/video_prompt.py:108` có ghi chú "đi theo ngôn ngữ UI". Ghi chú này sai, thực tế ngôn ngữ vẫn được đoán từ nguồn.

### 1.3 Quy mô prompt cần chuyển

| Nhóm | Số lượng (xấp xỉ) | Ngôn ngữ hiện tại | Có hook ngôn ngữ? |
|---|---|---|---|
| System prompt LLM cho pipeline (`agents/`, `workflows/`, `structured_extraction`, `cognee/`, `verification/`) | ~48 (38 zh, 10 en) | zh là chính | Một phần. 17 prompt không có hook nào: verification ×7, cognee legacy ×5, event_extractor, asset_compiler ×4 |
| `Field(description=…)` của pydantic, được gửi cho LLM dưới dạng JSON schema | ~165 trong core, cộng schema freezone story script (`api/schemas.py:1945`) | zh | Không |
| Prompt ảnh (`generators/`) | ~12 | Khung tiếng Anh xen đoạn zh; `voxel_restyle` thuần zh | Không |
| Prompt video (Seedance composer, I2V, keyframe, WAN) | 4 bộ | en + câu dặn, Seedance có template zh/en | Có (zh/en) |
| Chat (`chat/service.py`, `hermes_workspace.py`, `.hermes/plugins`) | ~10 khối instruction, cộng SOUL/MEMORY | en/zh lẫn lộn; SOUL.md zh, ghi ra đĩa theo user | Không (Skill Studio tự "theo ngôn ngữ người dùng gõ") |
| Freezone node (`text_node`, `jobs`, `video_node`, `image_node`, `route_helpers`) | ~20 prompt, 26 camera template, 45 style template | lẫn lộn, nhiều zh | Chỉ dịch zh↔en |
| Builtin catalog freezone (`agent_catalog/builtins`) | 11 skill, 60 recipe (~41.6k ký tự `system_prompt`, 66% zh) | zh là chính | Không có trường i18n |
| Skill markdown (`agent_skills/`, `.hermes/skills/`) | vài chục file | 30–60% zh | Không |

Tổng cộng có 347 file trong `src/novelvideo` chứa chữ Hán (~195k ký tự). Không phải file nào cũng là prompt: còn log, docstring, `lmsg` fallback, v.v.

### 1.4 Rủi ro: code đang so khớp chữ Trung trong output của model hoặc trong dữ liệu

Đổi ngôn ngữ prompt mà không xử lý các chỗ dưới đây sẽ làm hỏng logic một cách âm thầm:

1. **Enum chuẩn hoá bằng chữ Trung:**
   - `time_of_day` (`清晨…夜晚`, `无`);
   - `InteriorExterior = Literal["内","外","无"]`;
   - cỡ cảnh (`特写/近景…`) ở `freezone/jobs.py`;
   - identity mặc định `"默认"` và hậu tố `_默认`;
   - ID `角色_时期`.
2. **Parser đọc tiêu đề zh từ output LLM:** hợp đồng môi trường 360 (`正面/左侧/右侧/背面/光源/材质/风格/禁止元素`, `cognee/pipeline.py:640–685`). Prompt ảnh scene reference cũng tham chiếu `正面/背面`.
3. **Danh sách từ khoá zh khớp với `visual_description`:** vị trí, cỡ cảnh, hành động ngồi/ăn/đứng/rời đi, giới tính `男/女性`, có ở `generators/prompt_builder.py` và `global_video_optimizer.py:124`. Beat không phải tiếng Trung sẽ mất các heuristic này.
4. **Logic dựa vào văn bản tiếng Trung:**
   - nhận diện người dẫn chuyện (`旁白/解说/画外音…`);
   - denylist cảnh phái sinh (`asset_compiler.py:1562`);
   - tách câu theo `。` (`episode_fixer`).
5. **Freezone, chat và plugin so khớp chuỗi zh:**
   - giá trị option của skill (`"自定义角色"`, `"未指定"`);
   - text lỗi (`"产物"`, `"响应超时"`, `"声线缺失"`);
   - lọc dòng ở `presentation_text.py`;
   - `"草图"`/`"首帧"` ở `presentation_mapping.py`.
6. **Cache bỏ qua ngôn ngữ trong khoá:** scene enrichment, appearance, adjudication, compiled recipe (`recipe_runtime._cache_key`). Đổi ngôn ngữ sẽ trả lại kết quả cũ bằng ngôn ngữ cũ.
7. **Agent dựng một lần với `system_prompt` cố định:** các singleton ở `freezone/text_node.py:223–340`. Thread Codex cũng cố định developer instructions theo `_CODEX_FREEZONE_THREAD_PROTOCOL_VERSION`.
8. **Seedance bỏ guidance tự do không phải zh/en:** `_guidance_matches_language` lặng lẽ loại guidance tiếng Việt.
9. **Không cần đổi:** token tham chiếu của Seedance (`图片N`, `音频N`) là cú pháp của chính model.

### 1.5 Test

- Khoảng 45 file test assert nội dung prompt bằng `assert "..." in prompt` (không có snapshot hay golden file).
- Các file nặng nhất: `test_workflow_plan.py` (106), `test_seedance2_prompt.py` (44), `test_screenplay_normalizer.py`, `test_structured_builders.py`, `test_freezone_plugin.py`, `test_hermes_workspace.py`, `test_chat_service_user_agent_scope.py`.

## 2. Các quyết định thiết kế (cần chốt trước khi code)

| # | Câu hỏi | Đề xuất |
|---|---|---|
| D1 | "Ngôn ngữ hệ thống" là gì? | Là **ngôn ngữ UI** người dùng chọn (`zh`/`en`/`vi`). Mỗi request gửi kèm nó. Mỗi **project** lưu một bản `content_language`, lấy từ ngôn ngữ UI lúc tạo project và đổi được trong cài đặt project. Pipeline nền (ingest → script → render) đọc giá trị của **project**, không đọc header, để một tập phim không bị trộn ngôn ngữ khi người dùng đổi UI giữa chừng. Chat và canvas freezone (không gắn project) đọc header của từng request. |
| D2 | Nguồn truyện là tiếng Trung, UI là tiếng Việt thì sao? | Các trường mô tả, phân tích, prompt đều sinh bằng `content_language`. **Tên riêng giữ nguyên văn** (giữ quy tắc hiện có). **Lời thoại và lời dẫn trích nguyên văn** (literal script) giữ ngôn ngữ nguồn, trừ khi bật cờ dịch riêng `narration_language` (để giai đoạn sau, vì kéo theo TTS/voice). `detect_asset_language` chỉ còn dùng để biết ngôn ngữ **nguồn**, không còn quyết định ngôn ngữ prompt. |
| D3 | "Toàn bộ prompt" có gồm prompt gửi model ảnh/video không? | **Có, nhưng tách 2 lớp.** (a) Phần điều khiển và phần người dùng nhìn thấy (system prompt, schema, mô tả, prompt hiển thị trên UI) đi theo `content_language`. (b) Chuỗi cuối cùng gửi thẳng cho model ảnh/video được chọn theo **ngôn ngữ mà model đó hỗ trợ tốt** (bảng `media_prompt_language` theo model: Gemini/NanoBanana nhận en/zh/vi; Seedance chỉ zh/en; WAN là en). Nếu model không hỗ trợ `vi` thì fallback `en`. Lý do: chất lượng ảnh/video với prompt tiếng Việt kém rõ rệt ở nhiều model. Nếu muốn ép 100% theo ngôn ngữ hệ thống thì chỉ cần đổi bảng này, không phải sửa code. |
| D4 | Lưu prompt ở đâu? | Gom về catalog `src/novelvideo/prompts/` (hiện đang rỗng), mỗi ngôn ngữ một file. Giữ prompt tiếng Trung hiện tại làm **bản gốc** (đã qua tinh chỉnh). en/vi là bản dịch có người review. |
| D5 | Thiếu bản dịch thì làm gì? | Fallback `vi → en → zh`, có log cảnh báo. CI chặn merge nếu key thiếu ở bất kỳ ngôn ngữ nào. |
| D6 | Enum lưu trong DB (`内/外`, `清晨`, `默认`…)? | Chuyển sang **mã trung lập** (`INT/EXT/NONE`, `dawn/morning/…`, `default`). LLM trả về mã, UI hiển thị nhãn qua i18n. Lúc đọc vẫn nhận giá trị zh cũ (bảng alias) để không phải migrate dữ liệu ngay. |

## 3. Kiến trúc đích

### 3.1 Kiểu dữ liệu và chuyển ngôn ngữ từ request đến task

1. `utils/source_language.py`:
   - thêm `PromptLanguage = Literal["zh","en","vi"]`;
   - `AssetLanguage` thành alias để tương thích ngược;
   - thêm `normalize_language()` dùng chung (gộp với `normalize_locale` của release notes).
2. Frontend:
   - hook `beforeRequest` của **cả hai** ky client gửi header `X-DramaClaw-Language: <zh|en|vi>`;
   - form tạo project gửi `content_language`;
   - trang cài đặt project có ô chọn ngôn ngữ nội dung.
3. Backend request:
   - middleware FastAPI đọc header vào `ContextVar` `prompt_language`, theo mẫu `llm_instrumentation.py`;
   - `ProjectCreate` có thêm `content_language`, ghi vào `project_config.json`. Project cũ không có key này thì mặc định `zh` (giữ hành vi hiện tại).
4. Task nền:
   - `enqueue_project_task` tự thêm `prompt_language` vào payload (đã ký HMAC);
   - `sign_descendant` **copy key này sang task con**. Hiện nó không tự kế thừa, nên phải sửa trong `producer.py`;
   - runner (`run_core.py`) set ContextVar từ payload;
   - các closure freezone chạy in-process và các chỗ `run_in_executor` (vốn không mang contextvar) phải truyền ngôn ngữ dưới dạng tham số.
5. Hàm `current_prompt_language(project=None)`:
   - nếu có project thì lấy `content_language` của project;
   - nếu không thì lấy ContextVar;
   - nếu vẫn không có thì `zh`.

   Mọi call site gọi hàm này. Bỏ các default rải rác (`language="zh"`/`"en"` trong `schemas.py:189,227`, `scripts.py:129,181`, `runners/script.py:51`, `runners/video.py:710`).

### 3.2 Catalog prompt

```
src/novelvideo/prompts/
  __init__.py          # get_prompt(key, lang, **vars), get_rules(key, lang), language_instruction(lang)
  schema_i18n.py       # localized_output_type(Model, lang)
  zh/<module>.toml      # bản gốc
  en/<module>.toml
  vi/<module>.toml
  glossary.toml        # thuật ngữ điện ảnh: 近景 = close shot = cận cảnh…
```

- Prompt được lưu theo key, ví dụ `identity_planner.pass_a.system`, `verification.sketch_fact_check.system`. Biến chèn dùng `{name}`.
- Có test đối chiếu: các ngôn ngữ phải cùng tập key và cùng tập placeholder.
- **Schema:**
  - mô tả field tách ra thành `description_key`;
  - `localized_output_type(Model, lang)` dựng subclass bằng `pydantic.create_model` với description đã dịch, cache theo `(Model, lang)`;
  - pydantic-ai `Agent(output_type=...)` nhận model này.
- **Agent singleton:** đổi thành factory cache theo `lang` (`functools.lru_cache`), hoặc truyền `system_prompt` động bằng decorator `@agent.system_prompt` của pydantic-ai.
- **Cache kết quả:** thêm `lang` vào mọi cache key ở mục 1.4.6.
- `asset_language_instruction` chuyển thành `language_instruction(lang)` và có bản `vi`.

### 3.3 Heuristic phụ thuộc ngôn ngữ

- Các danh sách từ khoá (`prompt_builder`, nhận diện người dẫn chuyện, denylist cảnh phái sinh, giới tính, tách câu) chuyển vào `prompts/<lang>/keywords.toml`. Lúc chạy dùng **hợp của mọi ngôn ngữ**, vì dữ liệu cũ có thể là zh còn beat mới là vi.
- Hợp đồng 360 bỏ parse tiêu đề zh, đổi sang **structured output** (JSON có field `front/left/right/back/light/material/style/forbidden`). Phần render ra văn bản dùng nhãn đã dịch.
- Giá trị option của skill freezone: tách `value` (mã ổn định) khỏi `label` (dịch). Các chỗ so khớp `"自定义角色"`, `"未指定"` chuyển sang so mã.
- Text lỗi được so khớp (`"响应超时"`, `"声线缺失"`, `"产物"`…): chuyển sang mã lỗi (`error_code`), theo đúng quy ước `lmsg(code, text)` đã có trong `i18n_message.py`.

## 4. Lộ trình triển khai (mỗi giai đoạn là một hoặc vài PR, merge độc lập)

| Giai đoạn | Nội dung | Phạm vi chính | Ước lượng |
|---|---|---|---|
| **P0. Hạ tầng** | Chốt D1–D6. Làm `PromptLanguage`, header, middleware, ContextVar, `content_language` cho project, đưa vào payload task (kể cả task con), catalog `prompts/` cùng loader, `localized_output_type`, test đối chiếu key/placeholder, thêm `lang` vào cache key. Chưa đổi nội dung prompt; mặc định `zh` nên không đổi hành vi. | `source_language.py`, `api/`, `task_backend/`, `prompts/`, frontend client + form project | 3–4 ngày |
| **P1. Pipeline chính** | Chuyển vào catalog rồi dịch en/vi: `structured_extraction` (4), `identity_planner` (4 kể cả Pass 0), `literal_script_writing`, `cognee/screenplay_normalizer`, `cognee/pipeline` (scene enrichment + 5 prompt legacy), `event_extractor`, `cognee/store`, `asset_compiler` (4 + 2 user prompt), `episode_planner/fixer/reviewer`, `character_fixer/reviewer`, `content_rewriter`, `story_analysis` (nhãn `第N章/片段 N`). Dịch toàn bộ ~165 Field description. | Theo thứ tự chạy của pipeline: ingest → build_characters → identity → scene_prop → script | 5–7 ngày |
| **P2. Enum trung lập** | `time_of_day`, `InteriorExterior`, cỡ cảnh, identity mặc định, hợp đồng 360 (structured output). Thêm bảng alias đọc dữ liệu zh cũ. Thêm key i18n vào `frontend/public/locales/*`. | `time_of_day.py`, `screenplay_normalizer`, `asset_compiler`, `models.py`, `scene_reference_images.py` | 3–4 ngày |
| **P3. Prompt ảnh/video** | Bảng `media_prompt_language` (D3). `seedance2_i2v` thêm template `vi`, gộp bản trùng ở `panel_service.py:55`, sửa `_guidance_matches_language`. `video_prompt_builder`, `keyframe_prompt_builder`, `global_video_optimizer` dùng `current_prompt_language()`. `prompt_builder` đưa các đoạn zh vào catalog và gộp từ khoá đa ngôn ngữ (mục 3.3). `voxel_restyle` dịch. `style_analyzer` thôi ép `suggested_label` tiếng Trung. Sửa ghi chú sai ở `prompt_preview/steps/video_prompt.py:108`. | `generators/`, `seedance2_i2v/`, `agents/*video*`, `prompt_preview/` | 4–5 ngày |
| **P4. Verification** | 7 prompt trong `verification/prompts.py` cùng 30 Field description ở `verification/models.py`. | `verification/` | 1–2 ngày |
| **P5. Chat / Hermes** | `_prompt_with_user_context` chèn khối `[LANGUAGE] Reply in <lang>` vào **mỗi lượt**, để thread Codex đang mở vẫn đổi được ngôn ngữ. Dịch `_DRAMACLAW_SCRIPT_UPLOAD_MODEL_REPLY_INSTRUCTIONS` (đang ép "自然中文"), `_JSON_RENDER_CHAT_INSTRUCTIONS` và ví dụ chào hỏi. SOUL.md/MEMORY.md: có template theo ngôn ngữ; migrate bằng marker phiên bản thay cho so chuỗi `"你是虾导"`. Plugin `.hermes/plugins/*`: đổi thông báo lỗi sang mã cùng text đã dịch. Đổi các chỗ so chuỗi ở `presentation_*` và `display_fallback` sang mã. | `chat/`, `.hermes/` | 4–5 ngày |
| **P6. Freezone** | Node prompt (`text_node`, `jobs`, `video_node`, `image_node`). Dịch zh↔en mở rộng thành dịch giữa bất kỳ cặp nào trong 3 ngôn ngữ. Schema story script. Catalog builtin (11 skill, 60 recipe) và 45 style template, 26 camera template: thêm file overlay `<id>.<lang>.json` cạnh file gốc, loader merge theo ngôn ngữ, và thêm `lang` vào key cache compiled recipe. Planner tất định ở `agent_workflows/catalog.py` (tiêu đề node zh, parse từ khoá zh). Skill markdown: thư mục `references/<lang>/`. | `freezone/`, `api/schemas.py`, `agent_skills/`, `.hermes/skills/` | 8–10 ngày (khối lượng dịch lớn nhất) |
| **P7. Chốt chặn** | Test CI quét các module prompt và **cấm chữ Hán ngoài `prompts/zh/`** (có allowlist cho log, docstring, `lmsg` fallback, token Seedance). Script audit Langfuse (`llm_call_log`, đã có ở bản dev) để tìm lời gọi model có `lang != zh` mà prompt vẫn chứa chữ Hán. Cập nhật tài liệu. | `tests/`, `scripts/` | 1–2 ngày |

Tổng ước lượng khoảng 30–40 ngày công, trong đó phần lớn là dịch và review nội dung (P1, P6).

### Quy trình dịch

1. Bản zh là gốc. Dùng LLM dịch theo `glossary.toml`, giữ nguyên placeholder `{…}`, JSON mẫu và token kỹ thuật.
2. Người review bản `vi` (thuật ngữ điện ảnh) và bản `en`.
3. Với các prompt quan trọng (identity, script, scene, Seedance), chạy A/B trên project mẫu và so chất lượng output với bản zh trước khi bật.

## 5. Kiểm thử và nghiệm thu

- **Unit:**
  - test đối chiếu catalog (key, placeholder, JSON hợp lệ);
  - `localized_output_type` sinh schema có mô tả đúng ngôn ngữ;
  - ngôn ngữ đi từ request vào payload, rồi sang task con, rồi vào ContextVar trong runner;
  - đọc enum alias zh cũ.
- **Cập nhật khoảng 45 file test hiện có:** đổi `assert "<chuỗi zh>" in prompt` thành tham số hoá theo ngôn ngữ, lấy chuỗi kỳ vọng từ catalog thay vì hard-code.
- **E2E (stack local):** tạo project mới với `content_language=vi` và `=en` từ cùng `examples/tesla-pov-short-60s.md`, chạy ingest → build_characters → identity_plan → scene_prop → script → sketch. Kiểm Langfuse: không prompt nào lẫn chữ Hán (ngoài tên riêng hay trích nguyên văn); output hiển thị đúng ngôn ngữ. Chạy lại project `tesla_pov_short` (zh mặc định) để chắc chắn không bị hồi quy.
- **Lưu ý triển khai local** (theo `.claude/CLAUDE.md`): image `dramaclaw-local/api` không build lại được, nên khi test phải `docker cp` **toàn bộ** `src/novelvideo` vào container rồi `docker restart`. Model rẻ đang dùng (DeepSeek, Qwen vision) cần được thử với prompt `vi` ngay ở P1 để phát hiện sớm vấn đề chất lượng.

## 6. Rủi ro còn lại

- Prompt zh đã được tinh chỉnh lâu; bản dịch có thể kém hơn lúc đầu. Giảm rủi ro bằng A/B (mục 4) và giữ được tuỳ chọn ép prompt `zh` cho riêng từng project (`prompt_language_override`) trong thời gian chuyển tiếp.
- Prompt tiếng Việt tốn token hơn tiếng Trung (khoảng 1.5–2 lần) nên chi phí LLM tăng. Cần đo bằng `llm_call_log`.
- Project cũ có dữ liệu zh lẫn với lượt sinh mới bằng vi nếu người dùng đổi `content_language` giữa chừng. UI cần cảnh báo và gợi ý chạy lại các bước liên quan.
