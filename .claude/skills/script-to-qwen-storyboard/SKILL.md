---
name: script-to-qwen-storyboard
description: Chuyển kịch bản text thường thành storyboard (gồm tư thế, vật cầm, camera từng shot) và danh sách keyframe, rồi prompt Qwen-Image 2.1 cho từng khung. Chỉ dựa vào kịch bản và tài liệu đi kèm. Prompt do skill qwen-image-prompting soạn và review. Dùng khi có một kịch bản (hoặc một tập mới) cần dựng storyboard bằng Qwen.
---

# Kịch bản text → storyboard → keyframe → prompt Qwen

## Nguyên tắc
- Chỉ dựa vào kịch bản và các tài liệu đi kèm trong cùng bộ kịch bản (ví dụ series bible).
- Mỗi ý trong storyboard ghi căn cứ: cột nào của kịch bản (người nói, lời, trò đùa, bối cảnh) hoặc mục nào của tài liệu đi kèm.
- Camera và cỡ khung từng shot do skill viết theo nội dung kịch bản (lời, trò đùa, ai đang được nhấn). Cỡ khung chỉ đổi bên trong một shot; ở chỗ nối hai shot không cắt khung: khung đầu shot i+1 đúng bằng khung cuối shot i.
- Điều không suy ra được từ kịch bản thì hỏi user, không tự chọn.
- Prompt Qwen không do code viết: soạn và review bằng skill `qwen-image-prompting`.
- **Không có tiếng Việt trong prompt và trong file prompt.** `rewritten_prompt` viết bằng tiếng Anh (`qwen-image-prompting` E15: yêu cầu không phải tiếng Trung hay tiếng Anh thì mô tả bằng tiếng Anh); mọi trường khác của file prompt cũng bằng tiếng Anh. Storyboard trong kịch bản có thể viết bằng ngôn ngữ của kịch bản, nhưng khi soạn prompt phải chuyển nội dung sang tiếng Anh.

## Quy trình

### 1. Đọc
Kịch bản và tài liệu đi kèm: bối cảnh từng shot, người nói, lời, trò đùa, mô tả nhân vật, quy tắc bố cục, vật dụng, ảnh nền và ảnh tham chiếu nhân vật có sẵn.

### 2. Viết storyboard
Thêm mục `## Storyboard` vào cuối file kịch bản, gồm:

**Chung:** ảnh nền từng cảnh; ảnh tham chiếu từng nhân vật và **thứ tự cố định** của chúng (dùng cho mọi keyframe); vị trí từng nhân vật trong khung; vật cầm và người cầm; vật nền phải giữ. Mỗi dòng kèm căn cứ.

**Bảng shot** (một dòng mỗi shot):

| Cảnh, shot | Người nói, lời | Tư thế đầu shot | Tư thế cuối shot | Vật cầm | Cỡ khung đầu | Cỡ khung cuối | Căn cứ |
|---|---|---|---|---|---|---|---|

Cỡ khung ghi bằng mã tiếng Anh, định nghĩa một lần trong mục "Chung" bằng điều nhìn thấy được: `wide` (thấy trọn từ đầu tới chân), `medium` (từ giữa đùi trở lên), `close` (từ dưới eo trở lên).

**Kiểm tra liền mạch:** với mọi shot i+1 trong cùng cảnh, tư thế đầu = tư thế cuối shot i, cỡ khung đầu = cỡ khung cuối shot i, vật cầm và vị trí không đổi giữa hai dòng. Sai ở đâu thì sửa trước khi đi tiếp.

### 3. Hỏi và duyệt
Hỏi user các điều không suy ra được, ghi câu trả lời vào mục Storyboard. User duyệt storyboard trước khi soạn prompt.

### 4. Lập danh sách keyframe (theo từng cảnh)
- K0 = khung đầu shot đầu tiên của cảnh; K(i) = khung cuối shot i (cũng là khung đầu shot i+1).
- **Ảnh đầu vào**, đúng thứ tự gửi đi: `<image1>` là canvas (ảnh nền của cảnh cho K0; keyframe vừa chọn của khung trước, ghi là `@prev`, cho K1 trở đi), rồi ảnh tham chiếu từng nhân vật theo thứ tự cố định ở bước 2. Tổng số ảnh mỗi khung tối đa 10 (`qwen-image-prompting` N1).
- **Chế độ:**
  - K0 → `compose`: ảnh mới của các chủ thể, đặt nhân vật vào cảnh; canvas là ảnh cảnh (E2, E12).
  - K(i), cỡ khung K(i) bằng cỡ khung K(i−1) → `edit`: sửa chính ảnh, chỉ đổi tư thế và biểu cảm; canvas là `<image1>` (E2).
  - K(i), cỡ khung khác K(i−1) → `reframe`: sửa chính ảnh, đổi khoảng cách camera và tư thế; canvas là `<image1>` (E2).

### 5. Soạn prompt
Mỗi keyframe một prompt bằng tiếng Anh, bằng skill `qwen-image-prompting` (loại E). Đọc các ảnh đầu vào đã có; cỡ khung viết thành mô tả nhìn thấy được (E6); nhân vật trỏ bằng vị trí và thẻ ảnh tham chiếu của họ (E5, E9); nội dung khung lấy đúng từ dòng storyboard tương ứng.

### 6. Ghi file prompt
`<thư mục dựng của tập>/qwen_keyframe_prompts.json` (thư mục chứa các chain JSON của tập):
```json
{"<cảnh>": [
  {"k": 0, "mode": "compose", "framing": "wide", "storyboard_ref": "scene 01, shot 1, start",
   "images": ["<ảnh nền>", "<ảnh nhân vật 1>", "<ảnh nhân vật 2>"],
   "rewritten_prompt": "...", "wh_ratio": "", "ratio_follow": "<image1>"},
  {"k": 1, "mode": "edit", "framing": "wide", "storyboard_ref": "scene 01, shot 1, end",
   "images": ["@prev", "<ảnh nhân vật 1>", "<ảnh nhân vật 2>"],
   "rewritten_prompt": "...", "wh_ratio": "", "ratio_follow": "<image1>"}]}
```

### 7. Review và ghi sổ
- Review từng prompt bằng skill `qwen-image-prompting` (mục "Review prompt"); biên bản lưu ở `<thư mục dựng của tập>/qwen_prompt_reviews/<ngày>.md`.
- Sửa đến khi không còn vi phạm, rồi ghi sổ:
  `python3 previs_h3_test/scripts/qwen_prompt_gate.py record <thư mục dựng của tập>/qwen_keyframe_prompts.json --review <biên bản>`
- Kiểm: `python3 previs_h3_test/scripts/qwen_prompt_gate.py check <thư mục dựng của tập>/qwen_keyframe_prompts.json` → mọi prompt `reviewed`. Cổng chặn prompt có chữ tiếng Việt.

## Sau khi sinh ảnh
- Sinh từng khung: `python previs_h3_test/scripts/qwen_images.py keyframes <thư mục dựng của tập> --until <k>`.
- Trước khi sinh khung kế tiếp, kiểm ảnh vừa chọn có khớp dòng storyboard không bằng skill `image-review-haiku` và xem bằng mắt.
- Ảnh lệch storyboard: soạn lại prompt của khung kế tiếp bằng `qwen-image-prompting` dựa trên ảnh thật, review và ghi sổ lại (prompt đổi thì phải review lại mới chạy được).
