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

1. ✅ **XONG (2026-11-09)**: `build_h3_multishot_memory_graph()` viết trong `runpod_minimax_h3_multishot_video.py` (song song với `build_h3_multishot_graph()`, không sửa hàm cũ). Map `continuity`, `reference_subjects`, `master_normalize`, `memory_frames`, `anchor_frames`, `bank_pinned`. Đã đọc schema thật (`H3MultishotMemorySampler` trong `previs_h3_test/runs/_box_science_humor_gravity/object_info.json`) để lấy đúng tên field/tooltip thay vì đoán.
   - **Sửa lại 1 điểm so với bản nháp plan ở trên**: `continuity="first_frame"` **bắt buộc `checkpoint="fl2va"`** (tooltip node: "ref2va is trained for reference rows, not first-frame hand-off") và **tắt hẳn reference bank** ("fl2va has no reference rows") — nghĩa là **không dùng được cùng lúc với `reference_images`/nhận diện nhân vật mà dự án đang cần**. Bỏ `first_frame` khỏi danh sách thử ở bước 2 (không phải "chắc chắn chạy được" như ghi nhầm ở trên); chỉ còn `latent_handoff` là lựa chọn Giai đoạn 1 khả thi cho pipeline này. Đã thêm `raise ValueError` chặn tổ hợp sai trong code.
   - `context_pin` vẫn chặn cứng (cần pack `ComfyUI-H3-Motion-Context`, Giai đoạn 2) — đã verify bằng test lỗi.
2. ✅ **XONG (2026-11-09)**: script test riêng `gravity_test/bench_memory_sampler.py` (không đụng `gen_chains.py`/`run_batch.sh`). Dùng lại nguyên văn 4 shot prompt của `chain_01_refs_only.json` (bối cảnh vườn chỉ truyền qua text, không qua reference image — đúng thiết kế node: `reference_images` là ref NHÂN VẬT, không phải bối cảnh), `continuity=latent_handoff`, `reference_images` = 4 ảnh góc riêng (`barnaby_front`/`ambrose_front` có sẵn + `barnaby_turned`/`ambrose_turned` — cắt tay lúc chạy từ nửa còn lại của `*_sheet.png`, không tạo asset nhân vật mới cố định), `reference_subjects="2,2"`. Đã verify dry (không cần pod): import/compile sạch, crop ra đúng ảnh góc nghiêng (khác góc thẳng của `*_front.png`), `build_h3_multishot_memory_graph()` build graph 16 node không lỗi.
3. **Chưa làm — cần pod**: chạy thật trên 4090/5090, so với `chain_01_refs_only` đã render trước đó (có cả bản render thật `chain_01_sb`/`shot_01_*_sb` mới hơn nữa để so sánh thêm — xem `science_humor_gravity_test_run.md`, mục render 2026-11-09): trôi vườn, sheet lọt khung, mặt/trang phục giữ qua các shot (đo bằng `check_chains.py`).
   - **Mục tiêu so sánh mở rộng** (phát hiện mới 2026-11-09 từ render `chain_01_sb`): ngoài 2 lỗi gốc, bản render V1 (`chain_01_sb`, nối latent qua `H3MultishotSampler` classic) lộ thêm 2 vấn đề đáng xem memory sampler có giảm được không — (a) **Adam/Eva (nhân vật nền) đổi trang phục giữa các shot** (Adam từ lá che tối giản sang áo choàng đỏ có dây buộc), (b) **camera reset không ổn định** giữa latent hand-off các shot (dù bài test đó dùng prompt động, không liên quan trực tiếp memory sampler, nhưng cùng gốc "điều gì giữ nguyên qua latent hand-off" nên đáng ghi chú khi so sánh).
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
