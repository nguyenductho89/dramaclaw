---
name: image-review-haiku
description: Review hàng loạt ảnh do AI sinh (storyboard/keyframe, plate nền, sheet nhân vật, khung render — Qwen-Image hay Gemini) bằng Haiku theo nhiều góc độ, điều khiển bằng một file spec của từng tập/cảnh: dàn nhân vật và số lần xuất hiện, nhân đôi/thiếu/thừa người, vật cầm (prop) đúng người, thứ phải giữ qua các khung, khung bị cắt, lỗi hình (vệt, chữ, méo), và liên tục giữa từng cặp khung liền kề; bỏ phiếu nhiều lượt và hiệu chuẩn trên ảnh đã biết đáp án. Dùng ngay sau khi sinh ảnh và TRƯỚC khi đưa cho user duyệt. Không thay thế cổng duyệt của user và không đo tỉ lệ 3D (dùng image-scale-review).
---

# Review ảnh AI bằng Haiku (tổng quát, theo spec)

Haiku (rẻ, nhanh, đọc được ảnh) làm **vòng lọc đầu**: nó trả JSON theo checklist sinh từ spec; `review.py` chấm bằng **luật cố định** (không để model tự phán PASS/FAIL). Mọi `FAIL`/`MANUAL` được model chính xem lại ảnh thật. **Chỉ user duyệt** (`approve_storyboard.py approve` không bao giờ được tự chạy).

Không có gì trong skill này gắn với một tập cụ thể: mọi thứ riêng của tập (ai là nhân vật, ai cầm gì, nền phải giữ gì, khung hình từng bước) nằm trong **file spec**. Mẫu: `examples/episode_spec.json`.

## Các góc độ review

| Góc độ | Kiểm gì | Ai kiểm | Độ tin cậy đã đo* |
|---|---|---|---|
| **cast** | từng nhân vật xuất hiện đúng số lần; nhân đôi/clone; thiếu người; người lạ ở tiền cảnh | Haiku | tốt: bắt đúng cả 2 ảnh có 3–4 người; đếm đúng 10/10 |
| **props** | vật có trong khung không, ai cầm (theo spec, có thể khác theo chuỗi) | Haiku | khá: 9/10 đúng, 1 "unclear" |
| **continuity** (từng ảnh) | các thứ `must_persist` còn đó không (cây, đồi, vật nền, nhân vật nền nhỏ) | Haiku | chưa đo kỹ, **hiệu chuẩn trước khi tin** |
| **continuity** (từng cặp) | cùng địa điểm? người có đổi chỗ trên mặt đất? vật đổi người? ánh sáng đổi? kiểu camera | Haiku, nhìn 2 ảnh | chưa đo, **hiệu chuẩn trước khi tin** |
| **framing** | đầu/tay/chân bị cắt bởi mép ảnh | Haiku (thô) | nhận cắt đầu/chân; **không** phân biệt đầu gối/eo/ngực |
| **framing** (push-in) | khung đổi cỡ có thực sự to hơn khung trước | **số đo** (`--measured`, cỡ mặt) | đo được, không giao cho Haiku |
| **artifact** | vệt/blotch, chữ, watermark, tay/mặt méo | Haiku | vệt: thấy đúng 2/2, không báo oan; phần còn lại chưa đo |
| **forbidden** | thứ cấm theo spec (chữ, logo, người thứ ba) | Haiku | chưa đo |
| **scale 3D** | tỉ lệ vật/người, chạm đất, bóng | skill `image-scale-review` | không thuộc skill này |

*Đo 2026-11-10 trên 14 ảnh, 1–2 lượt, checklist soạn khi đã biết đáp án: chỉ là bằng chứng ban đầu. Với loại ảnh/lỗi mới luôn chạy `calibrate` (bên dưới) trước khi dựa vào một góc độ.

## File spec (`spec.json`)

- `images_dir`, `glob`: ảnh cần review. `sequence_pattern`: regex có nhóm `seq` (chuỗi) và `i` (thứ tự) để tự suy ra **khung liền trước** của từng ảnh (ví dụ `^(?P<seq>.+)_k(?P<i>\d+)$`).
- `cast`: `[{id, describe, count}]` — mô tả bằng đặc điểm nhìn thấy (tóc, trang phục), không dùng tên riêng mà Haiku không thấy.
- `props`: `[{id, describe, holder, required_visible}]`; ghi đè theo chuỗi bằng `sequences.<seq>.prop_holder`.
- `scene.forbidden`: thứ không được xuất hiện.
- `sequences.<seq>`: `framings` (cỡ khung từng bước: `wide`/`medium`/`close` → suy ra camera mong đợi `none`/`push_in`/`pull_out`), `must_persist` (thứ phải còn qua các khung, mô tả nhìn thấy được), `known_issues` (lỗi đã biết, chỉ in INFO, không FAIL — ví dụ lỗi của plate).
- `min_push_in_growth`: ngưỡng cỡ mặt to lên (mặc định 1,4).

Soạn spec từ nguồn có sẵn của tập (kịch bản, `LINES`, `CAMERA`, sheet nhân vật), không đoán. Thêm tập mới = copy spec mẫu và sửa các trường trên.

## Quy trình

1. **Spec**: tạo/cập nhật `spec.json` cho tập.
2. **Prompt từng ảnh**: `python3 .claude/skills/image-review-haiku/review.py prompt-frames spec.json > /tmp/frames_prompt.txt`
3. **Haiku** (công cụ Agent, `subagent_type: general-purpose`, `model: haiku`, nền): prompt rút gọn = "đọc `/tmp/frames_prompt.txt` bằng Read và làm đúng theo; chỉ trả JSON". Chạy **2 lượt** (2 agent) khi cần độ chắc: lượt bất đồng sẽ thành MANUAL. Lưu mỗi JSON ra file.
4. **Prompt cặp liền kề** (nếu là chuỗi liên tục): `review.py prompt-pairs spec.json > /tmp/pairs_prompt.txt`, chạy Haiku tương tự → `pairs.json`.
5. **Số đo push-in** (nếu có `keyframes_report.json` của `qwen_images.py`): `review.py measured-from-qwen-report <report> > measured.json`.
6. **Chấm**: `review.py verdict spec.json --frames r1.json r2.json --pairs p1.json --measured measured.json --json out.json`. Mức: **FAIL** (lỗi chắc: sai số người, nhân đôi, vật sai chỗ/mất, thiếu thứ phải giữ, đổi địa điểm, người đổi chỗ, đầu bị cắt, thứ cấm, lỗi hình mức cao), **MANUAL** (unclear, tin cậy thấp, các lượt bất đồng), **WARN** (push-in yếu, chi tiết nền đổi, ánh sáng đổi, lỗi hình vừa), INFO (lỗi đã biết). Mã thoát 2 nếu có FAIL.
7. **Xem tận mắt** mọi FAIL/MANUAL; lỗi thật → sửa prompt sinh ảnh, sinh lại, review lại.
8. Khi ảnh sinh theo chuỗi (mỗi khung sửa từ khung trước), review **K0 trước** (cổng `--until 0` của `qwen_images.py`) rồi mới cho sinh tiếp; viết lại prompt theo skill `qwen-image-prompting` khi gặp lỗi lặp lại.
9. Gửi contact sheet cho user; **chờ user duyệt**.

## Hiệu chuẩn (bắt buộc với loại lỗi/loại ảnh mới)

Lập `calibration.json`: `[{"item": "<stem hoặc A->B>", "expect": [{"dimension": "props", "contains": "held by"}], "clean": true/false}]` gồm ảnh **đã biết có lỗi** và ảnh **đã biết sạch**; chạy `review.py calibrate spec.json calibration.json --frames ... [--pairs ...]`. Bảng cho biết mỗi góc độ bắt được/bỏ sót bao nhiêu lỗi đã biết và báo oan bao nhiêu trên ảnh sạch. Chỉ tin một góc độ khi bắt đủ và không báo oan; nếu không, hạ nó thành WARN hoặc xem tay. Mẫu: `examples/episode_calibration.json`.

## Mở rộng

Thêm góc độ mới: thêm trường vào checklist trong `prompt_frames`/`prompt_pairs`, thêm luật tương ứng trong `frame_findings`/`pair_findings`, thêm ca vào calibration, đo lại. Luật nằm trong code để kết quả lặp lại được; đừng chuyển phán quyết sang lời của Haiku.
