---
name: short-minimax-h3-script-review
description: Review kịch bản short 9:16 viết cho video model MiniMax H3 (skit JSON multishot trong previs_h3_test/scripts/skits/). Dùng khi user nhờ review/kiểm tra kịch bản, hoặc ngay sau khi viết xong bằng short-minimax-h3-script-writer. Chỉ báo lỗi, không tự sửa trừ khi được yêu cầu.
---

# Review kịch bản short 9:16 cho MiniMax H3

Đọc file JSON, lập bảng nhân vật từ chính nội dung, rồi chạy từng mục. Với mỗi shot, trích dòng có lỗi (file:line hoặc đoạn trích ngắn).

## Mức độ
- **CHẶN**: gần như chắc chắn sinh video sai. Phải sửa.
- **CẢNH BÁO**: rủi ro, nên sửa.
- **GỢI Ý**: cải thiện nội dung.

## A. Gán lời thoại cho người nói (kiểm tra TRƯỚC, hay lỗi nhất)
1. **CHẶN**: câu `<d>` mà người nói chỉ là "a man/a woman/someone/he/she (Sx)" trong khi khung có 2+ người. Phải là `Tên (Sx) says`. Lỗi gốc: lời Mark bị gán cho Arthur.
2. **CHẶN**: nhãn Sx của cùng một nhân vật khác nhau giữa các shot, hoặc cùng Sx gán cho 2 người.
3. **CHẶN**: lời thoại trong shot mà người nói không có mặt trong khung, hoặc chủ thể nhắc đầu tiên trong shot không phải người nói mà câu thoại không nêu tên.
4. **CẢNH BÁO**: không ghi người còn lại im lặng/làm gì lúc nói.
5. **CẢNH BÁO**: giọng/kiểu nói cùng một nhân vật lệch giữa các shot (shot 1 khàn khóc, shot 3 deadpan) mà không có lý do cốt truyện, hoặc không có ref audio/khung đầu nối.
6. Đối chiếu nội dung câu thoại với kịch bản: ai hỏi, ai đáp có hợp logic (ví dụ câu trả lời punchline phải do đúng người nói).

## B. Nhất quán giữa các shot
7. **CHẶN**: mô tả ngoại hình của một nhân vật khác nhau giữa các shot (tuổi, tóc, râu, áo).
8. **CHẶN**: nhân vật chỉ được gọi bằng "he/the man/the same" ở shot sau mà không mô tả lại.
9. **CẢNH BÁO**: vị trí trái/phải đổi mà không có hành động di chuyển; shot 2+ người không nêu vị trí.
9b. **CHẶN**: người vào khung từ một cạnh nhưng khung đầu của shot không còn chỗ trống ở cạnh đó (vật cố định hoặc nhân vật chiếm), hoặc điểm dừng nằm đè lên vật cố định, hoặc "beside X on his right" khi bên phải X là vật cố định. Hậu quả đã thấy: tấm bia co lại/biến mất khi người mới bước vào. Sửa: nêu "open path fills the right side of frame", đặt vật ở phía đối diện, điểm dừng nằm trong khoảng trống.
9c. **CẢNH BÁO**: vật cố định không được tả vị trí trong khung, hoặc hình dạng tả khác nhau giữa các shot (shot sinh độc lập nên sẽ trôi).
9d. **CẢNH BÁO**: người phụ đứng "at the edge" hoặc có thể bị cắt mất một phần ở mép khung; người tiến gần camera làm đổi cỡ cảnh.
9e. **CẢNH BÁO**: cảnh có 3 phần tử ngang (vật cố định + 2 người, hoặc 3 người) mà cỡ cảnh là "medium close"/"close-up" trong khung dọc. Người ngoài cùng sẽ bị cắt mép (v2 shot 3). Sửa: đổi sang "medium shot", ghi vị trí theo phần chiều ngang, chừa khoảng trống tới mép.
9f. **CẢNH BÁO**: người vào khung mà không ghi hướng đi ngang qua khung và "same distance/same size": model có thể cho họ tiến gần camera, to dần và đẩy người khác ra khỏi khung (v2 shot 2).
9g. **CẢNH BÁO**: mô tả vật cố định tự mâu thuẫn (ví dụ "Celtic cross" cùng "rounded top") hoặc mỗi shot tả một kiểu: vật sẽ đổi hình giữa các shot. Mở rộng của 9c.
10. **CẢNH BÁO**: bối cảnh, ánh sáng, tông màu không giống nhau giữa các shot.
11. **CẢNH BÁO**: kịch bản có mốc thời đại (ví dụ Victoria 1880s) nhưng trang phục, đồ vật, bối cảnh hay âm thanh lệch thời đại, hoặc thiếu câu cấm đồ hiện đại.
11b. **CẢNH BÁO**: cảnh nối tiếp (shot sau tiếp diễn shot trước) nhưng đầu shot sau không khớp tư thế cuối shot trước.

## C. Kỹ thuật H3
12. **CHẶN**: mốc giây không tăng dần, hoặc vượt thời lượng shot (243 khung ≈ 10s; tối đa 12s/shot).
13. **CHẶN**: một shot có cắt cảnh/đổi góc/đổi địa điểm.
13b. **CHẶN**: file thiếu `"aspect_ratio": "9:16"` hoặc có giá trị khác; prompt ghi khổ ngang/16:9.
14. **CHẶN**: camera chuyển động (push/pan/track) khi có 2+ người; thiếu câu giữ khung cuối.
15. **CHẶN**: thiếu `<d>[Language]` đúng định dạng, ngôn ngữ tag lệch ngôn ngữ nội dung, có dấu nháy kép bọc `<d>`, hoặc dịch/diễn giải lời thoại.
16. **CHẶN**: thiếu một trong 3 mục `integrated_multimodal_description`, `overall_soundscape`, `non_diegetic_music`; thiếu dòng cấm subtitle/chữ/logo.
17. **CẢNH BÁO**: lời thoại quá dài so với cửa sổ nói (hơn khoảng 3 âm tiết/giây), hoặc thoại bắt đầu trước 1s hay kéo tới giây cuối.
18. **CẢNH BÁO**: cảm xúc chỉ có tính từ trần, không có hành vi quan sát được; chuỗi hơn một lần đổi cảm xúc trong một shot.
19. **CẢNH BÁO**: kết shot dùng "continues/keeps" thay vì tư thế tĩnh; vật dụng đổi tay không có hành động.
20. **CẢNH BÁO**: `non_diegetic_music` mâu thuẫn (vừa nhạc vừa "no BGM") hoặc không phải mô tả/`N/A`.
21. Từ gây hại chậm: "slowly" trong khi yêu cầu real-time; "cinematic" không kèm chi tiết.

## D. Hợp với short 9:16 (YouTube Shorts/TikTok)
22. **CẢNH BÁO**: shot 1 không có hook trong 1-2s đầu.
23. **CẢNH BÁO**: tổng thời lượng ngoài 15-60s, hoặc quá nhiều shot cho ngân sách (mỗi shot tốn thời gian GPU).
24. **CẢNH BÁO**: cỡ cảnh rộng khiến mặt nhỏ trong khung dọc; ưu tiên medium/close-up, nhân vật xếp dọc hợp 9:16.
25. **GỢI Ý**: punchline/twist không nằm ở shot cuối hoặc cuối shot; thiếu nhịp im lặng trước punchline.
26. **CẢNH BÁO**: nội dung vi phạm chính sách nền tảng (bạo lực, người thật, thương hiệu).

## Định dạng báo cáo
1. Bảng nhân vật rút ra (tên, ngoại hình, Sx, vị trí).
2. Danh sách lỗi: `[CHẶN|CẢNH BÁO|GỢI Ý] #mục — shot N — trích dẫn — hậu quả — cách sửa cụ thể (viết sẵn câu thay thế)`.
3. Kết luận: **ĐẠT** (0 CHẶN) hoặc **KHÔNG ĐẠT** (n lỗi CHẶN).

Đừng sửa file khi chưa được yêu cầu. Nếu user bảo sửa, sửa rồi chạy lại review từ đầu.
