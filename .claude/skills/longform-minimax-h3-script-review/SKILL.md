---
name: longform-minimax-h3-script-review
description: Review kịch bản YouTube long-form 16:9 ("Science explained with humor") gồm file examples/science-humor/epNN-script.md và các chain MiniMax H3 trong previs_h3_test/scripts/skits/science_humor/. Dùng khi user nhờ review một tập long-form, hoặc ngay sau khi viết bằng longform-minimax-h3-script-writer. Chỉ báo lỗi, không tự sửa trừ khi được yêu cầu. Không dùng cho short 9:16.
---

# Review kịch bản long-form 16:9 cho MiniMax H3

Đọc file kịch bản, mọi chain JSON của tập, `examples/science-humor/series-bible.md` và các tập trước. Lập bảng nhân vật từ chính nội dung, rồi chạy từng mục. Trích dòng có lỗi (file:line hoặc đoạn ngắn).

Tự đếm và tính lại, không tin số ghi trong file: số từ, tỉ lệ lớp, âm tiết/giây, và mọi con số tính ra.

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
6. **CẢNH BÁO**: `<d>` trong chain hơn 3 âm tiết/giây, thoại bắt đầu trước 1.0 s, hoặc kết thúc cách cuối shot dưới 1.5 s. Ghi phép tính. Voiceover Qwen3-TTS không theo giới hạn này; xem #28.
7. **CẢNH BÁO**: không ghi người còn lại im lặng hoặc đang làm gì; sau mốc "finishes" không ghi người nói im lặng, ngậm miệng tới khung cuối (H3 từng tự nói thêm ở đoạn trống).
8. **CẢNH BÁO**: chain có thoại mà thiếu `voice_ref`; giọng mô tả lệch giữa các shot mà không có lý do.

## B. Nhất quán giữa các shot và chain

9. **CHẶN**: mô tả ngoại hình khác nhau giữa các shot, hoặc khác khối mô tả trong series bible.
10. **CHẶN**: nhân vật chỉ được gọi bằng "he/the man/the same" mà không mô tả lại.
11. **CHẶN**: người vào khung từ cạnh đã bị chiếm, hoặc điểm dừng đè lên vật cố định.
12. **CẢNH BÁO**: vật cố định không ghi vị trí, tả khác nhau giữa các shot, hoặc tự mâu thuẫn.
13. **CẢNH BÁO**: vị trí đổi mà không có hành động di chuyển; người phụ có thể bị cắt mép; người tiến gần máy làm đổi cỡ cảnh.
14. **CẢNH BÁO**: bối cảnh, ánh sáng, tông màu khác nhau trong cùng một cảnh.
15. **CẢNH BÁO**: shot nối tiếp không khớp tư thế cuối của shot trước.

## C. Kỹ thuật H3 và khung 16:9

16. **CHẶN**: chain thiếu `"aspect_ratio": "16:9"` hoặc giá trị khác; prompt ghi khổ dọc hay 9:16.
17. **CHẶN**: mốc giây không tăng dần hoặc vượt thời lượng shot (192 khung ≈ 8 s; tối đa 12 s).
18. **CHẶN**: một shot có cắt cảnh, đổi góc, đổi địa điểm.
19. **CHẶN**: thiếu một trong 3 mục `integrated_multimodal_description`, `overall_soundscape`, `non_diegetic_music`; thiếu câu giữ khung, dòng real-time hoặc dòng cấm chữ/logo.
20. **CHẶN**: yêu cầu H3 vẽ chữ, phương trình, đồ thị hoặc số.
21. **CHẶN**: chain thiếu `start_image` hoặc `keyframe_prompt`. Pipeline không nhận ảnh sheet riêng, nên thiếu keyframe là mất mặt nhân vật.
22. **CHẶN**: camera chuyển động khi có 2+ người. **CẢNH BÁO**: camera đẩy, lia hoặc cầm tay khi có 1 người, trừ khi series bible ghi đã thử đạt.
23. **CẢNH BÁO**: `non_diegetic_music` không phải `N/A`.
24. **CẢNH BÁO**: không ghi vị trí theo phần ngang của khung; thiếu khoảng trống phía nhìn; đỉnh đầu hay vật quan trọng sát mép trên/dưới (bản 1344×768 bị cắt khoảng 1% mỗi phía).
25. **CẢNH BÁO**: cảm xúc chỉ có tính từ trần; hơn một lần đổi cảm xúc trong shot; kết shot bằng "continues/keeps"; có "slowly" hoặc "same ... as before".

## D. Long-form

26. **CẢNH BÁO**: tổng ngoài 6-7 phút hoặc ngoài 800-1.000 từ.
27. **CẢNH BÁO**: tỉ lệ lớp lệch hơn 10 điểm phần trăm so với mặt 40%, B-roll 25%, minh hoạ 35%, mà không có lý do. Ghi tỉ lệ đã tính.
28. **CẢNH BÁO**: cảnh mặt quá 16 âm tiết cho mỗi shot 8 s; voiceover quá 2,9 từ/giây.
29. **CẢNH BÁO**: không có câu hỏi và lời hứa trong 30 giây đầu; khoảng trống trên 90 giây không có cú kéo mới; kết bằng tóm tắt khô.
30. **CHẶN**: thứ tự lớp, thí nghiệm hoặc kết cục gần như trùng tập trước. YouTube cấm nội dung theo khuôn lặp lại.
31. **CẢNH BÁO**: đoạn minh hoạ sai công cụ (Manim cho phương trình, đồ thị, sơ đồ 2D; Three.js cho vật thể và mô phỏng 3D), hoặc không ghi công cụ.
32. **CẢNH BÁO**: mốc thời gian trong bảng hở hoặc chồng nhau.

## E. Khoa học

33. **CHẶN**: tuyên bố hoặc con số không có mã nguồn; mã nguồn không tồn tại trong mục Nguồn.
34. **CHẶN**: nguồn không nói điều kịch bản nói. Mở nguồn để đối chiếu nếu đọc được; không đọc được thì ghi rõ "chưa đối chiếu".
35. **CHẶN**: con số tính ra không có phép tính, hoặc tính lại ra kết quả khác.
36. **CHẶN**: ghi công sai; nhân vật tự nhận là tác giả của phát hiện; câu trong ngoặc kép không có nguồn.
37. **CHẶN**: phóng đại mà người xem có thể tin là thật, không được đính chính trong tập.
38. **CHẶN**: mô phỏng hoặc hình minh hoạ trái với công thức đã nêu.
39. **CẢNH BÁO**: điều còn tranh cãi nói như đã chắc chắn; hình đơn giản hoá mà không nói rõ.

## F. Hài

40. **CẢNH BÁO**: đoạn trên 45 giây không có nhịp hài. Ghi mốc.
41. **CẢNH BÁO**: trò đùa không dẫn tới ý khoa học và không đến từ nó.
42. **CẢNH BÁO**: câu chốt không có khoảng dừng hoặc phản ứng; lời giải thích lại trò đùa.
43. **CẢNH BÁO**: trò đùa lặp từ tập trước, trừ chi tiết chạy xuyên series đã ghi trong bible.
44. **CẢNH BÁO**: cụm tiếng Anh gượng hoặc dịch từng từ mà chưa nằm trong mục "Cần người bản ngữ đọc".
45. **GỢI Ý**: trò đùa cuối tập không quay lại từ đầu tập.

## G. Nhân vật và chính sách

46. **CHẶN**: bất kỳ liên hệ nào với Einstein trong truyện: nhận là ông, người quen của ông, nhắc hoặc đùa về sự giống nhau.
47. **CHẶN**: dấu hiệu gắn với Einstein trong prompt, keyframe, bối cảnh hay giọng: lè lưỡi, phòng cấp bằng sáng chế, bảng E=mc², tẩu thuốc, giọng Đức.
48. **CHẶN**: tên hoặc ảnh Einstein ở tiêu đề, thumbnail, tên kênh. Chỉ được nói tên ông khi ghi công trong nội dung khoa học.
49. **CHẶN**: nhân vật AI đưa ra nội dung y tế, pháp lý, tài chính hoặc chính trị dưới dạng tư vấn.
50. **CHẶN**: thí nghiệm có thể gây hại khi bắt chước mà không có cảnh báo rõ.
51. **CHẶN**: tên người thật hoặc thương hiệu trong prompt H3.

## Định dạng báo cáo

1. Bảng số đo tự tính: thời lượng, số từ, tỉ lệ lớp, âm tiết/giây cao nhất.
2. Bảng nhân vật rút ra: tên, ngoại hình, Sx, vị trí.
3. Lỗi: `[CHẶN|CẢNH BÁO|GỢI Ý] #mục — file/shot/mốc — trích dẫn — hậu quả — cách sửa cụ thể`.
4. Những gì chưa kiểm được, ví dụ nguồn không mở được.
5. Kết luận: **ĐẠT** (0 CHẶN) hoặc **KHÔNG ĐẠT** (n lỗi CHẶN).

Đừng sửa file khi chưa được yêu cầu. Nếu user bảo sửa, sửa rồi chạy lại review từ đầu.
