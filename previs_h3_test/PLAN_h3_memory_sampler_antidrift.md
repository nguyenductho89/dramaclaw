# Plan: chuyển sang `H3MultishotMemorySampler` để sửa lỗi trôi vườn + lỗi sheet lọt khung

## Context

Bài test gravity (xem `science_humor_gravity_test_run.md`) gặp 2 lỗi chưa giải quyết triệt để:
1. **Trôi nền**: dùng `start_image` (nền làm khung đầu), vườn đổi sang cảnh khác ở shot 4. Đã né được bằng cách chuyển sang `_refs_only` (nền làm ảnh tham chiếu lặp lại mỗi shot) — hoạt động tốt cho chain 4-shot ngắn, nhưng đây là cách lách, không phải sửa cơ chế gốc.
2. **Sheet lọt khung**: khi dùng ảnh sheet 2 góc nhìn (ghép 2-up trên nền xám) làm `reference_images`, H3 đôi khi vẽ lại chính cái sheet vào khung hình. Đã né bằng cách cắt chỉ còn 1 góc nhìn (`*_front.png`) — nhưng mất thông tin góc nhìn phụ, có rủi ro giữ identity kém hơn ở các góc máy khác nhau trong câu chuyện dài hơn.

## Phát hiện từ source code thật (không phải README suông — đã kiểm `object_info.json` thật lấy từ box đã chạy gravity test)

Hiện code của dự án (`runpod_minimax_h3_multishot_video.py`) **chỉ build graph cho `H3MultishotSampler`** (classic, input đơn giản: `script/shot_count/width/height/frames_per_shot/seed/steps/seed_per_shot` + optional `start_image/reference_images/voice_ref`). Node khác mạnh hơn hẳn, **đã có sẵn trên cùng node pack** (không cần cài gì để nó tồn tại) là `H3MultishotMemorySampler`:

- `continuity`: `cut | seamless | seamless_tail | latent_handoff | first_frame | flf_chain | context_pin` (mặc định `cut`). Chỉ `context_pin` (và có thể `seamless_tail`) cần cài thêm pack `ComfyUI-H3-Motion-Context` (chưa có trên máy này, `setup_h3_box.sh` chưa clone). **`latent_handoff` và `first_frame` chạy được ngay, không cần cài gì thêm** — đây là phát hiện quan trọng nhất, nghĩa là có thể thử nghiệm phần lớn lợi ích của memory sampler mà **không tốn thêm bước cài đặt/rủi ro tương thích**.
- `reference_subjects` (string, CHỈ có trên memory sampler): nhóm nhiều ảnh tham chiếu RIÊNG BIỆT (không phải 1 ảnh ghép 2-up) theo nhân vật, ví dụ `"2,2"` = 2 ảnh đầu thuộc nhân vật A, 2 ảnh sau thuộc nhân vật B. Đây đúng là cách chính thống của pack để giữ nhiều góc mặt — khác hẳn cách sheet 2-up ghép pixel đang dùng. Nguồn: changelog "reference pictures of two characters... blended into one face" + field `reference_subjects` xác nhận trong schema thật.
- `master_normalize` (mặc định BẬT sẵn `luma+contrast`), `color_level`, `chain_gain_control`, `pin_renorm`, `bank_pinned` — các dial chống trôi màu/nét hoàn toàn không có trên sampler classic.

## Kế hoạch 2 giai đoạn

### Giai đoạn 1 — không cần cài thêm gì, rủi ro thấp (ưu tiên làm trước)

1. Viết `build_h3_multishot_memory_graph()` mới trong `runpod_minimax_h3_multishot_video.py` (song song với `build_h3_multishot_graph()` hiện có, KHÔNG sửa hàm cũ — production vẫn dùng sampler classic cho tới khi giai đoạn này được verify). Input mới cần map: `continuity`, `reference_subjects`, `master_normalize`, `memory_frames`, `anchor_frames`.
2. Script test riêng (không đụng `gen_chains.py`/`run_batch.sh` production): dùng lại bối cảnh vườn táo của `chain_01`, nhưng:
   - `continuity=latent_handoff` (thử trước — tài liệu nói hoạt động với mọi mode kể cả không có Motion-Context)
   - Nếu `latent_handoff` báo lỗi/không khác biệt, thử `first_frame` (chắc chắn chạy được, là baseline tương đương classic sampler nhưng có thêm `master_normalize`)
   - `reference_images` = 4 ảnh riêng (barnaby_front, barnaby_sheet-crop-góc-2, ambrose_front, ambrose_sheet-crop-góc-2 — cắt tay từ sheet 2-up hiện có, không ghép lại), `reference_subjects="2,2"`
3. Chạy trên 1 pod 4090/5090 (≥60GB RAM theo yêu cầu), 1 chain 4-shot giống gravity test, so sánh với bản `_refs_only` đã có: có còn trôi vườn không, sheet có còn lọt khung không, mặt/trang phục có giữ đúng qua các shot không (đo bằng `check_chains.py` hiện có — cosine SFace).
4. Nếu Giai đoạn 1 đã giải quyết được cả 2 lỗi → **không cần Giai đoạn 2**, cập nhật `gen_chains.py`/`run_batch.sh` dùng memory sampler làm mặc định mới cho gravity test tiếp theo.

### Giai đoạn 2 — chỉ làm nếu Giai đoạn 1 chưa đủ, hoặc khi cần chain dài (>5 shot)

1. Cài `ComfyUI-H3-Motion-Context` vào `setup_h3_box.sh` (cờ `--with-motion-context`), kiểm tương thích ComfyUI 0.37.2 (repo yêu cầu 0.34+, nên về lý thuyết ổn, nhưng dự án chưa verify thật).
2. Test `continuity=context_pin` (raw latent, mạnh nhất, có `chain_gain_control=flatten` cho chain dài) trên đúng kịch bản gravity test.
3. Nếu dùng cho sản xuất thật, phải thêm nhánh dispatch mới cho endpoint RunPod đang chạy production (`h3-multishot-i2v-fl2va-ref2va`, ảnh worker riêng) — không chỉ máy thuê rời test.

## Việc KHÔNG làm trong plan này

- Không sửa generator classic `build_h3_multishot_graph()` — giữ nguyên cho production đang chạy ổn.
- Không tự động chuyển production sang memory sampler cho tới khi có số liệu verify thật (ảnh/video, không chỉ đọc tài liệu).
- Không làm Giai đoạn 2 trước khi biết Giai đoạn 1 có đủ hay không (tránh tốn thêm 1 vòng cài đặt/rủi ro tương thích không cần thiết).

## Ước tính chi phí

Giai đoạn 1: 1 pod 4090/5090 ≥60GB RAM, ước ~45-60 phút (setup + 1 chain 4-shot + check) ≈ $0,7-1,0 (giá $0,89/giờ như các lần trước). Giai đoạn 2 (nếu cần): thêm ~15-20 phút cài pack mới + 1 chain test ≈ +$0,3-0,5.
