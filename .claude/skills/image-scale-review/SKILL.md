---
name: image-scale-review
description: Kiểm tra một ảnh previs do Gemini hoặc Qwen-Image sinh ra có hợp lý về tỷ lệ không gian 3D không (vật to/nhỏ đúng kích thước tương đối, đúng chiều sâu, đúng số lượng, không lẫn vật từ cảnh khác). Dùng sau khi sinh ảnh và TRƯỚC khi tốn GPU render H3, hoặc ngay sau khi viết prompt bằng image-scale-prompt. Agent tự đo pixel bằng PIL (không cần model detect). Chỉ báo lỗi, không tự sửa trừ khi được yêu cầu.
---

# Kiểm tra tỷ lệ không gian 3D của ảnh previs

Đọc ảnh, lấy các kích thước thật kỳ vọng (từ prompt đã dùng hoặc bảng trong `image-scale-prompt`), rồi **tự đo pixel bằng PIL qua Bash** và so tỷ lệ. Mục tiêu: bắt lỗi tỷ lệ TRƯỚC khi render, vì cả Gemini lẫn Qwen đều hay co mọi vật cho vừa khung (vật to thành nhỏ, vật nhỏ/nền thành to/gần/nhân đôi).

Tự đo và tính lại, **không tin cảm giác bằng mắt thường** — crop vùng từng vật rồi đọc chiều cao pixel thật. Cảm giác "nhìn ổn" đã nhiều lần sai (module trông "cũng tạm" nhưng đo ra chỉ bằng 57% người trong khi phải gấp ~4 lần).

## Mức độ

- **CHẶN**: tỷ lệ sai rõ (lệch > ~50% so với kỳ vọng), sai số lượng vật, hoặc lẫn vật/nhân vật từ cảnh khác. Gần như chắc ra video sai — phải sửa prompt và sinh lại.
- **CẢNH BÁO**: lệch ~30-50%, hoặc chiều sâu/chạm đất/bóng đổ chưa thuyết phục. Nên sinh lại nhưng không chặn cứng.
- **GỢI Ý**: lệch < ~30% hoặc chi tiết nhỏ cải thiện được.

## Phương pháp đo (agent tự làm, không script riêng)

1. **Nạp kỳ vọng**: liệt kê mọi vật có kích thước thật trong ảnh và chiều cao thật của chúng — lấy từ số đã viết trong prompt gốc, hoặc tra bảng trong skill `image-scale-prompt`. Ghi rõ con số dùng để đối chiếu.
2. **Chọn người làm thước** và đo chính xác bằng PIL qua Bash — crop vùng người (đỉnh đầu → gót chân), đọc chiều cao pixel:
   ```python
   from PIL import Image
   im = Image.open("<ảnh>"); print(im.size)
   # crop quanh người, xem bằng mắt để xác định đỉnh đầu/gót chân, rồi tính px
   ```
   Neo xác định thêm (tùy chọn): `faces_in()` trong `previs_h3_test/scripts/skits/science_humor/gravity_test/check_chains.py` trả `px` = chiều cao khuôn mặt; chiều cao người ≈ 7,5 × chiều cao mặt — dùng để cross-check số đo tay.
3. **Đo từng vật khác ở CÙNG độ sâu với người**: crop, đọc chiều cao pixel, tính `tỷ lệ_đo = cao_px_vật / cao_px_người`, so với `tỷ lệ_kỳ_vọng = cao_thật_vật / 1,7m`. Lệch % = |đo − kỳ vọng| / kỳ vọng.
4. **Vật ở độ sâu khác** (xa hơn thì nhỏ hơn trên ảnh): KHÔNG so thẳng với người (so thẳng sẽ sai — vật xa phải nhỏ hơn). Dùng mục **"Đo định lượng nhiều độ sâu"** bên dưới để tính chiều cao px *kỳ vọng* tại đúng vị trí mặt đất của vật đó rồi so với số đo. Chỉ rơi về phán định tính khi vật không đứng trên mặt đất (bay, treo) hoặc không xác định được chân vật.
5. **Kiểm thêm, không chỉ tỷ lệ**:
   - **Số lượng vật khớp prompt chưa** (bẫy phi hành gia 0/1/2, hai cái bóng người thành một...). Đếm bằng mắt trên ảnh phóng to.
   - **Có lẫn vật/nhân vật từ cảnh khác không** (ví dụ người không mặc đồ phi hành gia đứng trên mặt trăng = Adam/Eve lọt từ cảnh vườn sang).
   - **Vật/nhân vật nền có nhỏ-xa-mờ không**, hay bị kéo to/gần/rõ như nhân vật chính.
   - **Chạm đất + bóng đổ**: chân vật có trên mặt đất không, có bóng đổ khớp hướng nắng không, hay trông như dán nổi lên nền.
   - **Đường chân trời / mặt đất nhất quán** giữa các vật.
6. **Ngưỡng**: áp mục "Mức độ" ở trên theo lệch % đã tính.

## Đo định lượng nhiều độ sâu (quy luật mặt phẳng nền) — dùng khi có nhiều người/vật

Với vật đứng trên cùng một mặt đất phẳng, chiều cao px tỉ lệ với khoảng cách từ chân vật tới đường chân trời: `cao_px = K × (y_chân − y_chân_trời) × H_thật` (H_thật tính bằng mét). Nhờ vậy mọi vật quy được về một thang chung dù ở xa hay gần. Làm bằng tay với PIL, không cần model:

1. **Đo (y_chân, cao_px) của MỌI người/vật đo được**: crop từng vật, đọc y chân (chạm đất) và y đỉnh. Ghi bảng thô trước khi tính.
2. **Tìm y đường chân trời**: nhìn thấy rõ (ranh trời–đất, đo bằng cột sáng) thì lấy luôn; nếu bị tán cây/nhà che → giải từ **hai vật cùng chiều cao thật ở hai độ sâu khác nhau** (hai người, hoặc người gần + người xa): `y_ct = (h1·f2 − h2·f1) / (h1 − h2)` với `h` = cao px, `f` = y chân. Chọn cặp cách xa nhau về độ sâu (nếu hai chân y gần nhau, phép giải nhiễu).
3. **Hiệu chỉnh K** bằng người: `K = cao_px_người / ((y_chân − y_ct) × H_người)`. Có ≥2 người thì tính K từng người — hai K phải khớp (lệch ≤ ~3%); lệch nhiều = giả định chiều cao người sai hoặc đo sai, sửa trước khi đi tiếp. Chiều cao camera ≈ `1/K` mét.
4. **Tính cao_px kỳ vọng cho từng vật còn lại** bằng công thức trên rồi lấy `đo / kỳ vọng`. Chiều cao thật tra từ prompt hoặc bảng `image-scale-prompt`; vật hữu cơ (cây, đám đông) cho một khoảng (vd 3-5 m) → ra khoảng kỳ vọng.
5. **Đọc kết quả theo nhóm, không chỉ từng vật** — đây là chỗ lộ nguyên nhân:
   - Mọi vật nền cùng lệch **một hệ số** (vd đều ~0,3-0,4) → lỗi ở **cả lớp**: nền và người được vẽ ở hai thang khác nhau (compose ghép người quá to vào plate, hoặc ngược lại). Sửa ở prompt compose/plate (neo "cùng camera, cùng mặt đất, chân trời xuyên qua ngực/thắt lưng người"), đừng sửa từng vật.
   - Chỉ MỘT vật lệch, các vật khác đúng → lỗi riêng vật đó (module bị thu nhỏ, cây bị phóng to).
   - Hai người cùng hiệu chỉnh nhưng K lệch → hai người không cùng thang, hoặc một người đứng khác mặt phẳng.
6. **Kiểm chiều cao camera**: prompt ghi "eye-level" thì `1/K` phải ≈ 1,4-1,7 m (chân trời xuyên qua khoảng mắt/vai người). Nếu ra ~0,8 m (chân trời ngang hông) thì camera thực tế thấp hơn eye-level — ghi CẢNH BÁO.
7. **Vật bị cắt khỏi khung** (tán cây vượt mép trên): chỉ có **cận dưới** của chiều cao — vẫn kết luận được nếu cận dưới đã vượt khoảng kỳ vọng (vd "≥7 m-tương-đương, vượt 3-5 m"), ghi rõ là cận dưới.
8. **Giới hạn**: mặt đất phải gần phẳng (đồi dốc, bậc thang làm sai công thức — ghi chú); chân vật bị cỏ/đá che làm y chân lệch vài chục px, nhất là vật ở gần chân trời (mẫu số `y_chân − y_ct` nhỏ → sai số lớn, hạ mức kết luận xuống CẢNH BÁO); và phải đo đúng *chân chạm đất*, không phải bóng.

Ví dụ làm tay thật (`chain_02_shot3.png`, Mặt Trăng): chân trời y≈233 (đo cột sáng); Barnaby 628px chân y735 → K=0,736; Ambrose 617px chân y725 → K=0,738 (khớp 0,2%, camera ~1,36 m). Kỳ vọng vs đo: module 7 m → 1006 vs 340px (**0,34×**); phi hành gia 1,8 m → 194 vs 61px (**0,32×**); cột cờ ~2,4 m → 384 vs 148px (**0,39×**). Cả ba lệch cùng hệ số ~0,3-0,4 → **lỗi cả lớp nền (nhỏ ~3× so với hai người)**, không phải lỗi từng vật.

## Định dạng báo cáo

1. **Bảng đo**:

| Vật | Cao thật | y chân | Cao px đo | Cao px kỳ vọng tại y chân đó | đo/kỳ vọng | Ghi chú |
|---|---|---|---|---|---|---|

   Ghi kèm một dòng hiệu chỉnh: y chân trời (đo hay giải), K từng người, chiều cao camera `1/K`. Cảnh chỉ có một độ sâu thì cột "kỳ vọng" có thể tính thẳng bằng tỷ lệ so người.

2. **Kiểm khác**: số lượng / lẫn cảnh / nền nhỏ-xa / chạm đất-bóng đổ / chân trời / chiều cao camera so với "eye-level" — mỗi mục ghi đạt hay lỗi. Ghi rõ lỗi nằm ở **từng vật** hay **cả lớp** (mục "Đọc kết quả theo nhóm").
3. **Lỗi**: `[CHẶN|CẢNH BÁO|GỢI Ý] — <ảnh> — <vật/vấn đề> — số đo — hậu quả — cách sửa (câu prompt cần thêm/sửa, trỏ image-scale-prompt)`.
4. **Chưa đo được**: vật không tách được rõ, hay độ sâu không chắc — ghi rõ.
5. **Kết luận**: **ĐẠT** (0 CHẶN) hoặc **KHÔNG ĐẠT** (n lỗi CHẶN).

## Tùy chọn: ý kiến thứ hai từ vision model (KHÔNG bắt buộc)

Có thể gửi ảnh + số thật cho vision bridge local để ước lượng chéo: `generate()` trong `previs_h3_test/scripts/gemini_webai_images.py` nhận ảnh + text, đọc nhánh text `choices[0].message.content` (thay vì tải artifact ảnh). Hỏi kiểu "đo chiều cao module theo số lần chiều cao người, có đúng ~4 lần không". **Cảnh báo**: bridge cùng lớp model vừa sinh ảnh, có thể sai y như lúc sinh — chỉ dùng tham khảo, **số đo PIL ở bước 2-3 vẫn là căn cứ chính**.

Đừng sửa prompt/ảnh khi chưa được yêu cầu. Nếu user bảo sửa: sửa prompt (theo `image-scale-prompt`), sinh lại ảnh, rồi chạy lại review này từ đầu.
