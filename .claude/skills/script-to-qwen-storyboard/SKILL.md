---
name: script-to-qwen-storyboard
description: Chuyển kịch bản text thường thành storyboard (gồm tư thế, vật cầm, camera từng shot) và danh sách keyframe, rồi prompt Qwen-Image 2.1 cho từng khung. Chỉ dựa vào kịch bản và tài liệu đi kèm. Prompt do skill qwen-image-prompting soạn và review. Dùng khi có một kịch bản (hoặc một tập mới) cần dựng storyboard bằng Qwen.
---

# Kịch bản text → storyboard → keyframe → prompt Qwen

## Nguyên tắc
- Chỉ dựa vào kịch bản và các tài liệu đi kèm trong cùng bộ kịch bản (ví dụ series bible).
- Mỗi ý trong storyboard ghi căn cứ: cột nào của kịch bản (người nói, lời, trò đùa, bối cảnh) hoặc mục nào của tài liệu đi kèm.
- Góc, cỡ khung và chuyển động camera từng shot do skill `longform-camera-angles` chọn theo nội dung kịch bản (lời, trò đùa, ai đang được nhấn), kèm lý do. Trong cùng chain, camera đầu shot i+1 đúng bằng camera cuối shot i; đổi góc là chain mới (một K0 mới).
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

| Chain, shot | Người nói, lời | Tư thế đầu shot | Tư thế cuối shot | Vật cầm | Góc | Cỡ khung đầu | Chuyển động | Phông | Căn cứ và lý do góc |
|---|---|---|---|---|---|---|---|---|---|

Góc và chuyển động ghi bằng mã của skill `longform-camera-angles`; cỡ khung bằng mã tiếng Anh, định nghĩa một lần trong mục "Chung" bằng điều nhìn thấy được: `wide` (thấy trọn từ đầu tới chân), `medium` (từ giữa đùi trở lên), `close` (từ dưới eo trở lên). Với shot có chuyển động, ghi điểm cuối của chuyển động trong cột Chuyển động. Góc một người: nêu người ngoài khung đang làm gì trong cột tư thế.

**Kiểm tra liền mạch:** với mọi shot i+1 trong cùng chain, tư thế đầu = tư thế cuối shot i, camera đầu shot i+1 (góc và cỡ khung) = camera cuối shot i (sau chuyển động của shot i), vật cầm và vị trí không đổi giữa hai dòng. Qua cú cắt giữa hai chain: tư thế, vật cầm và vị trí màn hình giữ nguyên, chỉ góc, cỡ khung và phông đổi. Sai ở đâu thì sửa trước khi đi tiếp.

### 3. Hỏi và duyệt
Hỏi user các điều không suy ra được, ghi câu trả lời vào mục Storyboard. User duyệt storyboard trước khi soạn prompt.

### 4. Lập danh sách keyframe (chỉ K0, một khung mỗi chain)
- H3 chỉ nhận một khung đầu cho cả chain, nên chỉ làm **K0** = khung đầu shot đầu tiên của chain. Không làm khung cuối từng shot.
- **Ảnh đầu vào**, đúng thứ tự gửi đi: `<image1>` là canvas = ảnh phông của setup chain (đúng địa điểm và loại phông `front`/`low`/`high`), rồi ảnh tham chiếu từng nhân vật theo thứ tự cố định ở bước 2. Góc một người: vẫn gửi cả hai sheet nhưng prompt chỉ nêu người trong khung. Tổng số ảnh mỗi khung tối đa 10 (`qwen-image-prompting` N1).
- **Chế độ:** K0 → `compose`: ảnh mới của các chủ thể, đặt nhân vật vào cảnh; canvas là ảnh phông (E2, E12).

### 5. Soạn prompt
Mỗi keyframe một prompt bằng tiếng Anh, bằng skill `qwen-image-prompting` (loại E). Đọc các ảnh đầu vào đã có; cỡ khung viết thành mô tả nhìn thấy được (E6); nhân vật trỏ bằng vị trí và thẻ ảnh tham chiếu của họ (E5, E9); nội dung khung lấy đúng từ dòng storyboard tương ứng.

### 6. Ghi file prompt
`video_production_with_skills/series/<series>/<tập>/keyframes/qwen_keyframe_prompts.json` (thư mục của tập; kịch bản là `video_production_with_skills/series/<series>/<tập>/script.md`):
```json
{"<cảnh>": [
  {"k": 0, "mode": "compose", "framing": "wide", "storyboard_ref": "chain 01, shot 1, start",
   "images": ["<ảnh nền>", "<ảnh nhân vật 1>", "<ảnh nhân vật 2>"],
   "present": ["einstein", "newton"],
   "rewritten_prompt": "...", "wh_ratio": "", "ratio_follow": "<image1>"}]}
```
`present` (tuỳ chọn, mặc định cả hai): các nhân vật có trong khung; góc một người ghi một tên (`"newton"` hoặc `"einstein"`) để cổng chấm ảnh không trừ điểm vì thiếu người. Khoá của file là `chain_NN` (một K0 mỗi chain).

### 7. Review và ghi sổ
- Review từng prompt bằng skill `qwen-image-prompting` (mục "Review prompt"); biên bản lưu ở `video_production_with_skills/series/<series>/<tập>/keyframes/reviews/<ngày>.md`.
- Sửa đến khi không còn vi phạm, rồi ghi sổ:
  `python3 video_production_with_skills/tools/qwen_prompt_gate.py record video_production_with_skills/series/<series>/<tập>/keyframes/qwen_keyframe_prompts.json --review <biên bản>`
- Kiểm: `python3 video_production_with_skills/tools/qwen_prompt_gate.py check video_production_with_skills/series/<series>/<tập>/keyframes/qwen_keyframe_prompts.json` → mọi prompt `reviewed`. Cổng chặn prompt có chữ tiếng Việt.

## Sau khi sinh ảnh
- Sinh từng khung: `python video_production_with_skills/tools/qwen_images.py keyframes video_production_with_skills/series/<series>/<tập> --until 0` (chỉ K0).
- Kiểm từng K0 có khớp dòng storyboard không bằng skill `image-review-haiku` và xem bằng mắt.
- Ảnh lệch storyboard: soạn lại prompt K0 đó bằng `qwen-image-prompting` dựa trên ảnh thật, review và ghi sổ lại (prompt đổi thì phải review lại mới chạy được).
