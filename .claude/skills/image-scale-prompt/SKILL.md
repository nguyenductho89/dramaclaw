---
name: image-scale-prompt
description: Viết prompt sinh ảnh previs (Gemini compose/plate, Qwen-Image render, storyboard) đúng tỷ lệ không gian 3D khi đặt cạnh nhau nhiều vật có kích thước thật khác nhau (người, xe, nhà, tàu vũ trụ, cây...). Dùng khi soạn hoặc sửa một prompt ảnh có từ 2 vật biết kích thước trở lên, nhất là khi một vật to/nhỏ hơn người nhiều lần. Cả Gemini lẫn Qwen đều hay sai tỷ lệ tương đối (mặc định nhét mọi thứ vừa khung) nên phải nêu số thật tường minh. Sinh ảnh xong luôn verify bằng image-scale-review.
---

# Viết prompt đúng tỷ lệ không gian 3D cho ảnh previs

Mục tiêu: khi prompt đặt cạnh nhau nhiều vật có kích thước thật đã biết, ép model giữ đúng **tỷ lệ tương đối** và **thứ tự chiều sâu**, thay vì để nó "nhét mọi thứ vừa khung".

## Tại sao cần skill này

Model sinh ảnh dạng compose/multi-reference (Gemini qua WebAI, Qwen-Image 2.1) **không suy luận không gian 3D thật**. Nó ghép từ nhiều ảnh nguồn có scale/góc khác nhau bằng cách đọc mô tả chữ, và mặc định **co mọi vật cho vừa khung** — nên vật to (tàu vũ trụ, nhà, cây) bị thu nhỏ lại, còn vật nhỏ hoặc nhân vật nền bị phóng to/kéo gần/nhân đôi. Đây là lỗi chung của cả hai model, không phải hỏng ngẫu nhiên:
- Qwen-Image từng render trẻ nhỏ thành người lớn vì prompt không có tín hiệu tỷ lệ cơ thể; fix bằng cách nhồi `subject_hints` body-type tường minh + câu "keep body proportions and size" (xem `docs/archive/claude-md-history.md`).
- Gemini từng vẽ lunar module (thật ~7m, phải cao gấp ~4 lần người) chỉ bằng ~57% chiều cao người; cải thiện rõ sau khi thêm số thật vào prompt — xem mẫu `SCENES["moon"]["plate"]` trong `previs_h3_test/scripts/skits/science_humor/gravity_test/gen_chains.py`.

Đòn bẩy duy nhất không đổi model là **viết số thật và bội số vào prompt**. Đừng tin model tự suy ra tỷ lệ đúng từ tên vật ("a lunar module", "an apple tree") — phải nói rõ nó cao bao nhiêu và cao gấp mấy lần người.

## Phương pháp 6 bước

1. **Liệt kê mọi vật có kích thước thật** trong khung (người, xe, nhà, cây, tàu, cột cờ, đồ vật lớn...).
2. **Tra/ước chiều cao thật mỗi vật** — dùng bảng dưới; vật lạ thì tự tra hoặc ước theo vật tương tự, ghi lại con số đã dùng.
3. **Chọn một vật làm thước** — gần như luôn là người đứng (~1,7m). Mọi tỷ lệ khác quy về bội số của thước này.
4. **Tính chiều cao mỗi vật theo bội số của thước**: ví dụ module 7m / người 1,7m ≈ **4× người**; cây táo 4m ≈ **2,3× người**; cửa 2m ≈ **1,2× người**.
5. **Quyết định thứ tự chiều sâu + khoảng cách tương đối**: vật nào ở tiền cảnh, vật nào lùi xa (xa thì nhỏ hơn trên ảnh dù thật to hơn — nêu rõ "ở xa phía sau" để model không kéo nó lên ngang người).
6. **Viết vào prompt TƯỜNG MINH**, với mỗi vật đáng kể:
   - kích thước thật (mét + feet): *"a real spacecraft about 7 metres / 23 feet tall"*;
   - bội số so với người: *"several times taller than a standing person"* hoặc *"about four times a person's height"*;
   - câu chống co giãn: *"...and must be drawn at that correct scale for its distance from the camera, not shrunk to fit the frame"* (vật to) / *"too far away and too small in frame to read any detail; it must not look larger, closer or more detailed than that"* (vật nhỏ/nền);
   - điểm chạm đất: *"legs/feet planted on the ground"*, bóng đổ nếu có nắng;
   - thứ tự chiều sâu: *"in the midground, behind the two men"*, *"far in the background"*.

## Bảng tham chiếu kích thước thật (seed — mở rộng khi gặp vật mới)

| Vật | Cao thật | So với người (~1,7m) |
|---|---|---|
| Người lớn đứng | ~1,7 m | 1× (thước chuẩn) |
| Trẻ nhỏ | ~1,0-1,2 m | ~0,65× |
| Cửa ra vào | ~2,0 m | ~1,2× |
| Ô tô con (cao) | ~1,5 m | ~0,9× |
| Xe buýt 2 tầng | ~4,4 m | ~2,6× |
| Cây táo trưởng thành | ~3-5 m | ~2-3× |
| Apollo Lunar Module | ~7 m | ~4× |
| Cột cờ cầm tay / cắm đất | ~1-2 m | ~0,6-1,2× |
| Nhà 1 tầng (nóc) | ~3-4 m | ~2× |
| Voi châu Phi (vai) | ~3,2 m | ~1,9× |
| Trẻ 6 tuổi | ~1,15 m | ~0,68× (đỉnh đầu ngang thắt lưng/rốn người lớn) |
| Chó spaniel (vai) | ~0,45 m | ~0,26× (lưng ngang đầu gối–đùi trẻ 6 tuổi) |
| Xe đạp (tay lái) | ~1,0-1,1 m | ~0,6× (tay lái ngang hông người lớn) |
| Ô tô hatchback | ~1,5 m cao, ~4,2 m dài | ~0,9× cao, dài ~2,5× |
| Cột đèn gang kiểu Victoria | ~5 m | ~2,9× (≈2,5× cái cửa) |
| Người già / phụ nữ | ~1,55-1,65 m | ~0,95× |

Khi gặp vật ngoài bảng: tra kích thước thật, quy ra bội số so với người, rồi viết câu prompt theo bước 6. Ghi con số đã dùng vào ghi chú/commit để `image-scale-review` đối chiếu lại.

## Cảnh nhiều người, nhiều vật, nhiều độ sâu

Khi khung có ≥3 vật hoặc nhiều lớp độ sâu, nêu từng vật riêng lẻ là chưa đủ. Thêm các việc sau (rút từ test thật trên cảnh Mặt Trăng/Vườn Địa Đàng bằng `image-scale-review`):

1. **Thước là người được nêu tên trong cảnh**, không mặc định 1,7 m. Cảnh có người cao 1,85 m và bé 1,15 m thì quy mọi bội số theo người 1,85 m và ghi rõ con số đó.
2. **Mốc "đỉnh đầu/lưng tới đâu" giữa các vật CÙNG lớp độ sâu** — dễ kiểm hơn con số tuyệt đối: *"the top of the child's head reaches only about the man's belt or navel"*, *"the dog's back reaches only about the child's knee"*, *"the bicycle's handlebars sit at the man's hip height"*, *"the man's head sits about 15 cm below the top of the door frame"*. Mỗi cặp liền kề một mốc, chuỗi mốc này giữ các vật cùng lớp khớp nhau.
3. **Một câu thứ tự độ sâu liệt kê theo lớp** (tiền cảnh → trung cảnh → hậu cảnh), kèm "perspective shrinks each object consistently". Vật xa to thật (cột đèn, nhà) phải được nói rõ là to thật nhưng ở xa, tránh bị kéo lên ngang người.
4. **Neo chung một camera và một mặt đất** — lỗi hay gặp nhất ở cảnh ghép là *cả lớp nền* và *lớp người* được vẽ ở hai thang khác nhau (đo thật: module + phi hành gia + cờ đều chỉ ~0,3-0,4× so với người). Thêm câu kiểu *"one camera, one ground plane: the horizon line cuts through the people at about chest/shoulder height, and every object on the ground — people, vehicles, poles — is drawn with the same perspective, standing on that same ground"*. Nếu prompt ghi "eye-level" thì ghi luôn chân trời xuyên qua đâu của người (đo thật: ảnh ghi eye-level nhưng chân trời ra ngang hông, camera ~0,8 m).
5. **Vật hữu cơ không có kích thước chuẩn (cây, đám đông)**: vẫn nêu khoảng (vd "an apple tree 4 m tall, about twice the height of the man") — nếu không nêu, model vẽ cây to hơn nhiều (đo thật: cây ≥7 m-tương-đương ở cảnh Vườn Địa Đàng).
6. **Đếm và cấm thừa**: mỗi nhóm nêu số lượng chính xác và đóng khung bằng *"No other people, animals or vehicles anywhere in the frame."*

Mẫu prompt đầy đủ cho cảnh phố (người lớn 1,85 m + bé + chó + xe đạp + ô tô + cửa + bà cụ xa + cột đèn) đã soạn theo các điểm trên; **chưa sinh ảnh kiểm chứng** vì quota ảnh Gemini hết hôm đó — khi sinh được, chạy `image-scale-review` để xác nhận trước khi tin.

## Bẫy & anti-pattern cần né

- **Chỉ nói "life-size" / "at the correct scale" chung chung** mà không neo số thật → vô dụng, model vẫn co vừa khung. Luôn kèm mét + bội số.
- **Vật/nhân vật nền bị phóng to, quá rõ, quá gần** thay vì nhỏ-xa-mờ. Với mọi thứ ở hậu cảnh: nêu rõ *"small, distant and out of focus, too far to read detail"* và cấm nó to/gần/rõ hơn thế.
- **Đếm sai hoặc nhân đôi vật nền** (ví dụ phi hành gia lúc 0 lúc 1 lúc 2). Nêu số lượng chính xác (*"a single astronaut", "no one else in the frame"*). Nếu sinh nhiều ảnh cùng một bối cảnh qua Gemini, dùng **conversation riêng cho mỗi bối cảnh** (xem `cmd_storyboard` trong `previs_h3_test/scripts/gemini_webai_images.py`) — hội thoại dùng chung giữa các cảnh khác nhau làm model lẫn vật/nhân vật nền từ cảnh này sang cảnh kia.
- **Nhân vật nền lẫn từ cảnh khác** (Adam/Eve từ vườn lọt sang mặt trăng, không mặc đồ phi hành gia). Cùng nguyên nhân hội thoại dùng chung ở trên.
- **Ảnh ghép nhiều ref trông "dán cắt"** (sai ánh sáng/bóng đổ) là lỗi anh em nhưng KHÁC tỷ lệ — xử lý ở skill khác (luật chiếu sáng storyboard trong `series-bible.md`), đừng lẫn hai thứ.

## Đầu ra

Trả về các câu prompt cụ thể để chèn vào prompt gốc (không viết lại cả prompt trừ khi được yêu cầu), mỗi vật đáng kể một câu theo mẫu bước 6. Mẫu đã dùng thật, copy được:

> "The lunar excursion module sits nearby ... — it is a real spacecraft about 7 metres/23 feet tall, several times taller than a standing person, and must be drawn at that correct scale for its distance from the camera, not shrunk to fit the frame. Far behind the module, small and indistinct ..., a single astronaut ... roughly the height of an adult person at that same distance, too far away and too small in frame for any detail to read; it must not look larger, closer or more detailed than that. No one else in the frame."

Sinh ảnh xong, **luôn verify bằng skill `image-scale-review`** trước khi tốn GPU render.
