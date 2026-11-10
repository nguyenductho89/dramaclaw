---
name: longform-minimax-h3-script-review
description: Review kịch bản YouTube long-form 16:9 ("Science explained with humor", Barnaby và Ambrose đối thoại) gồm file kịch bản trong examples/science-humor/ và các chain MiniMax H3 trong previs_h3_test/scripts/skits/science_humor/. Dùng khi user nhờ review một tập long-form, hoặc ngay sau khi viết bằng longform-minimax-h3-script-writer. Chỉ báo lỗi, không tự sửa trừ khi được yêu cầu. Không dùng cho short 9:16.
---

# Review kịch bản long-form 16:9 cho MiniMax H3

Đọc file kịch bản, mọi chain JSON của tập, `examples/science-humor/series-bible.md` và các tập trước. Lập bảng nhân vật từ chính nội dung, rồi chạy từng mục. Trích dòng có lỗi (file:line hoặc đoạn ngắn).

Tự đếm và tính lại, không tin số ghi trong file: số từ, âm tiết/giây, và mọi con số tính ra.

## Mức độ

- **CHẶN**: gần như chắc chắn sinh video sai, hoặc sai sự thật, hoặc vi phạm luật nhân vật. Phải sửa.
- **CẢNH BÁO**: rủi ro, nên sửa.
- **GỢI Ý**: cải thiện nội dung.

## A. Thoại

1. **CHẶN**: `<d>` mà người nói chỉ là "a man/someone/he/she (Sx)" khi khung có 2+ người.
2. **CHẶN**: nhãn Sx của một nhân vật khác nhau giữa các shot hoặc chain, hoặc một Sx gán cho 2 người.
3. **CHẶN**: thoại trong shot mà người nói không có mặt, trừ khi ghi rõ là narrator không thấy mặt.
4. **CHẶN**: thiếu `<d>[Language]` đúng định dạng, tag lệch ngôn ngữ nội dung, có dấu nháy kép bọc `<d>`.
5. **CHẶN**: thoại trong chain khác lời trong file kịch bản.
6. **CẢNH BÁO**: `<d>` trong chain hơn 3 âm tiết/giây, thoại bắt đầu trước 1.0 s, hoặc kết thúc cách cuối shot ngoài khoảng 1,2-2,0 s; thiếu câu lip-close chính thức sau `<d>`. Ghi phép tính.
7. **CHẶN**: một shot có hai người nói. **CẢNH BÁO**: không ghi người còn lại im lặng và đang làm gì; sau mốc "finishes" không ghi cả hai im lặng, ngậm miệng tới khung cuối (H3 từng tự nói thêm ở đoạn trống).
8. **CHẶN**: `<Audio N>` gán sai người (`<Audio 1>` là Barnaby, `<Audio 2>` là Ambrose). **CẢNH BÁO**: chain thiếu `voice_refs` hoặc sai thứ tự; giọng mô tả lệch giữa các shot mà không có lý do; hai giọng cùng giọng vùng (Barnaby phải Mỹ, Ambrose phải Anh) hoặc chưa đo cosine giữa hai giọng mẫu.

## B. Nhất quán giữa các shot và chain

9. **CHẶN**: mô tả ngoại hình khác nhau giữa các shot, hoặc khác câu mô tả ngắn trong series bible; prompt sheet khác khối mô tả trong series bible.
10. **CHẶN**: nhân vật chỉ được gọi bằng "he/the man/the same" mà không mô tả lại.
11. **CHẶN**: vị trí trái/phải của hai người đổi trong cùng bối cảnh hoặc không được nêu; người vào khung từ cạnh đã bị chiếm, hoặc điểm dừng đè lên vật cố định.
12. **CẢNH BÁO**: vật cố định không ghi vị trí, tả khác nhau giữa các shot, hoặc tự mâu thuẫn.
13. **CẢNH BÁO**: vị trí đổi mà không có hành động di chuyển; người phụ có thể bị cắt mép; người tiến gần máy làm đổi cỡ cảnh.
14. **CẢNH BÁO**: bối cảnh, ánh sáng, tông màu khác nhau trong cùng một cảnh.
15. **CẢNH BÁO**: shot nối tiếp không khớp tư thế cuối của shot trước.

## C. Kỹ thuật H3 và khung 16:9

16. **CHẶN**: chain thiếu `"aspect_ratio": "16:9"` hoặc giá trị khác; prompt ghi khổ dọc hay 9:16.
17. **CHẶN**: mốc giây không tăng dần hoặc vượt thời lượng shot (192 khung = 8 s; tối đa 12 s); `frames` không có dạng 17k+5; shot có thoại dưới 192 khung (generator ghi mối nối bị clip).
18. **CHẶN**: một shot có cắt cảnh, đổi góc, đổi địa điểm.
19. **CHẶN**: thiếu một trong 6 mục `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, `non_diegetic_music`; thiếu câu giữ khung, dòng real-time hoặc dòng cấm chữ/logo.
20. **CHẶN**: yêu cầu H3 vẽ chữ, phương trình, đồ thị, sơ đồ hoặc số; yêu cầu H3 diễn thí nghiệm hay chuyển động cần đúng vật lý.
21. **CHẶN**: chain thiếu `reference_images` hoặc ảnh nền; số `<Picture N>`, `<Subject N>` lệch thứ tự ảnh gửi đi; nền làm khung đầu mà shot 1 không cho hai người đi vào khung. **CẢNH BÁO**: prompt Qwen dùng từ đẩy độ nét ("ultra detailed", "sharp", "realistic detail") hoặc từ phủ định ("no moustache", "no labels"), ảnh nền có người, hoặc sheet có chữ, ô viền, hay 3 người; `subject_definitions` không nói sheet là một người ở nhiều góc; prompt ghép ảnh storyboard (compose nhiều ảnh tham chiếu thành 1 cảnh) không yêu cầu chiếu sáng lại nhân vật theo đúng ảnh nền và không có bóng đổ dưới chân — dễ ra ảnh kiểu nhân vật bị "dán cắt" lên nền (giữ nguyên ánh sáng phẳng của ảnh sheet thay vì khớp môi trường mới). Với prompt storyboard dạng Qwen (`storyboard_prompts_qwen`): thẻ `<imageN>` phải đủ 1..N, đúng thứ tự file gửi lên (`<image1>` là nền, rồi hai sheet), một đoạn văn không nháy kép, có "photorealistic", không có "16:9"/"4K", mỗi sheet được tả là một người nhiều góc nhìn; chạy `qwen_images.py ... --dry-run` để lint. **CHẶN**: nền vừa là `start_image` vừa nằm cùng ảnh sheet hai góc trên nền xám (đã gặp: H3 vẽ lại sheet trong khung). Mặc định là nền làm ảnh tham chiếu, `start_image` null.
22. **CHẶN**: camera chuyển động.
23. **CẢNH BÁO**: `non_diegetic_music` không phải `N/A`.
24. **CẢNH BÁO**: không ghi vị trí theo phần ngang của khung; hai người chỉ "face each other" mà không ghi quay ba phần tư về máy, nên mặt dễ nghiêng; người đang nói quay đi chỗ khác; đồ cần thấy nằm ở phía xa máy; mặt người ngược nắng; thiếu cỡ và độ sâu của hai người; đỉnh đầu hay vật quan trọng sát mép trên/dưới (bản 1344×768 bị cắt khoảng 1% mỗi phía).
25. **CẢNH BÁO**: cảm xúc chỉ có tính từ trần; hơn một lần đổi cảm xúc trong shot; kết shot bằng "continues/keeps"; có "slowly" hoặc "same ... as before".

## D. Long-form

26. **CẢNH BÁO**: tổng ngoài 6-7 phút hoặc ngoài 550-700 từ (mức tạm, chưa đo).
27. **CẢNH BÁO**: một người nói quá 2 shot liền mà không có lý do; hai người lệch quá 70/30 số từ. Ghi tỉ lệ đã tính.
28. **CẢNH BÁO**: một shot 8 s quá 18 âm tiết.
29. **CẢNH BÁO**: không có câu hỏi và lời hứa trong 30 giây đầu; khoảng trống trên 90 giây không có cú kéo mới; kết bằng tóm tắt khô.
30. **CHẶN**: thứ tự cãi nhau, bối cảnh hoặc kết cục gần như trùng tập trước. YouTube cấm nội dung theo khuôn lặp lại.
31. **CẢNH BÁO**: bối cảnh không khớp lời đang nói, hoặc đổi bối cảnh trong một shot.
32. **CẢNH BÁO**: mốc thời gian trong bảng hở hoặc chồng nhau.

## E. Khoa học

33. **CHẶN**: tuyên bố hoặc con số không có mã nguồn; mã nguồn không tồn tại trong mục Nguồn.
34. **CHẶN**: nguồn không nói điều kịch bản nói. Mở nguồn để đối chiếu nếu đọc được; không đọc được thì ghi rõ "chưa đối chiếu".
35. **CHẶN**: con số tính ra không có phép tính, hoặc tính lại ra kết quả khác.
36. **CHẶN**: ghi công sai; nhân vật tự nhận là tác giả của phát hiện; câu trong ngoặc kép không có nguồn.
37. **CHẶN**: phóng đại mà người xem có thể tin là thật, không được đính chính trong tập.
38. **CHẶN**: hình trong prompt trái với điều lời thoại nói là đúng; chi tiết nguy hiểm thật trong bối cảnh (không khí, nhiệt độ) mà thoại không đùa tới, khiến người xem có thể tưởng thật.
39. **CẢNH BÁO**: điều còn tranh cãi nói như đã chắc chắn; khoa học cổ điển bị nói như sai hoàn toàn thay vì nêu đúng phạm vi.

## F. Hài

40. **CẢNH BÁO**: đoạn trên 45 giây không có nhịp hài. Ghi mốc.
41. **CẢNH BÁO**: trò đùa không dẫn tới ý khoa học và không đến từ nó.
42. **CẢNH BÁO**: câu chốt không có khoảng dừng hoặc phản ứng; lời giải thích lại trò đùa.
43. **CẢNH BÁO**: trò đùa lặp từ tập trước, trừ chi tiết chạy xuyên series đã ghi trong bible.
44. **CẢNH BÁO**: cụm tiếng Anh gượng hoặc dịch từng từ mà chưa nằm trong mục "Cần người bản ngữ đọc".
45. **GỢI Ý**: trò đùa cuối tập không quay lại từ đầu tập.

## G. Nhân vật và chính sách

46. **CHẶN**: bất kỳ liên hệ nào với Einstein hay Newton trong truyện: nhận là ông, người quen của ông, nhắc hoặc đùa về sự giống nhau. **CHẶN**: Barnaby giảng khoa học cổ điển như của mình, hoặc Ambrose giảng kiến thức hiện đại, trừ khi đang trích lời bên kia để cãi.
47. **CHẶN**: dấu hiệu gắn với Einstein trong prompt, keyframe, bối cảnh hay giọng: lè lưỡi, phòng cấp bằng sáng chế, bảng E=mc², tẩu thuốc, giọng Đức.
48. **CHẶN**: tên hoặc ảnh Einstein ở tiêu đề, thumbnail, tên kênh. Chỉ được nói tên ông khi ghi công trong nội dung khoa học.
49. **CHẶN**: nhân vật AI đưa ra nội dung y tế, pháp lý, tài chính hoặc chính trị dưới dạng tư vấn.
50. **CHẶN**: thí nghiệm có thể gây hại khi bắt chước mà không có cảnh báo rõ.
51. **CHẶN**: tên người thật hoặc thương hiệu trong phần tả cảnh của prompt H3. Tên trong `<d>` để ghi công khoa học thì được.

## Định dạng báo cáo

1. Bảng số đo tự tính: thời lượng, số từ mỗi người, âm tiết/giây cao nhất.
2. Bảng nhân vật rút ra: tên, ngoại hình, Sx, vị trí.
3. Lỗi: `[CHẶN|CẢNH BÁO|GỢI Ý] #mục — file/shot/mốc — trích dẫn — hậu quả — cách sửa cụ thể`.
4. Những gì chưa kiểm được, ví dụ nguồn không mở được.
5. Kết luận: **ĐẠT** (0 CHẶN) hoặc **KHÔNG ĐẠT** (n lỗi CHẶN).

Đừng sửa file khi chưa được yêu cầu. Nếu user bảo sửa, sửa rồi chạy lại review từ đầu.
