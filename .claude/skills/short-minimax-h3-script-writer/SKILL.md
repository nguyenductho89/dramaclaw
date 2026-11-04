---
name: short-minimax-h3-script-writer
description: Viết kịch bản short 9:16 (YouTube Shorts/TikTok) dạng multishot, CHỈ cho video model MiniMax H3 (fl2va/ref2va) trong previs_h3_test/scripts/skits/*.json. Dùng khi user nhờ viết skit/kịch bản short, thêm shot, hoặc đổi lời thoại. Sau khi viết xong luôn chạy skill short-minimax-h3-script-review.
---

# Viết kịch bản short 9:16 cho MiniMax H3 (multishot)

## File đầu ra
`previs_h3_test/scripts/skits/<ten>.json`, theo mẫu `who_has_it_worse.json`:
`{"name", "aspect_ratio": "9:16", "frames", "start_image", "shots": [<chuỗi prompt mỗi shot>]}`. `aspect_ratio` bắt buộc là `"9:16"`; script sinh video đọc trường này để chọn 768×1344, thiếu thì skit vẫn mặc định 9:16.
Mỗi shot là một chuỗi gồm 3 mục: `integrated_multimodal_description:`, `overall_soundscape:`, `non_diegetic_music:`.

> Kịch bản này chạy trên MiniMax H3 (RunPod, `generators/runpod_minimax_h3_video.py`), mỗi shot ≤12s, prompt theo chuẩn H3: `[Shot N]`, mốc giây, `<d>[Language] ...</d>`, nhãn giọng `(Sx)`. Không áp dụng cho Seedance/Grok/Veo. Quy tắc gốc: `src/novelvideo/agents/prompts/minimax_h3_rules.md`.

## Quy trình
1. Chốt trước: số nhân vật (tối đa 3), mỗi nhân vật 1 nhãn giọng cố định **S1, S2, S3 dùng nhất quán cho mọi shot**, độ dài mỗi shot (5-12s, 243 khung ≈ 10s), khổ 9:16.
2. Viết **bảng nhân vật** (không đưa vào JSON): tên, tuổi, tóc/râu, trang phục, nhãn giọng, kiểu giọng. Mỗi shot chép lại NGUYÊN VĂN mô tả này (shot sinh độc lập, không nhớ shot trước).
3. Viết từng shot theo khuôn: phong cách → `[Shot N]` + cỡ cảnh + bối cảnh → nhân vật có mô tả → timeline theo giây → câu chốt → âm thanh.
4. Điền bảng tự kiểm ở cuối file, sửa tới khi đạt, rồi chạy skill `short-minimax-h3-script-review` và sửa tới khi sạch lỗi CHẶN và CẢNH BÁO.

## Quy tắc BẮT BUỘC (mỗi quy tắc từng gây lỗi thật)
- **Gắn giọng vào TÊN nhân vật, không bao giờ vào "a man/a woman".** Viết `Mark (S1) says in a flat, deadpan voice: <d>[English] ...</d>`, KHÔNG viết `a man (S1) says it`. Khi có 2+ người cùng khung, "a man" khiến model gán lời nhầm người (lỗi shot 3 của who_has_it_worse: lời Mark bị đọc bởi Arthur).
- **Mỗi lời thoại chỉ có đúng một người nói.** Ngay trước/sau câu thoại ghi rõ người còn lại im lặng và làm gì ("Arthur stays silent, frozen").
- **Người nói được nhắc tên ngay trong mệnh đề của câu thoại**, không dựa vào câu trước. Chủ thể nhắc đầu tiên trong shot dễ bị coi là người nói.
- **Vị trí trái/phải của mỗi người nêu rõ ở mọi shot có 2+ người**, giữ nhất quán giữa các shot (Mark bên trái, Arthur bên phải).
- **Bố cục không gian (đã gây lỗi thật: tấm bia biến mất khi Arthur bước vào, who_has_it_worse 2026-11-04):**
  - Vật cố định (bia, bàn, cửa, xe) mô tả hình dạng và vị trí trong khung MỘT lần, chép nguyên văn ở mọi shot ("the old stone tombstone with a carved Celtic cross, fixed on the left side of frame, full rounded top visible"). Shot sinh độc lập nên hình dạng sẽ trôi nếu mỗi shot tả một kiểu.
  - Người vào khung từ một cạnh thì cạnh đó phải còn **trống ngay từ khung đầu của shot** (ghi "open gravel path and grass fill the right side of frame"). Nếu vật hay người khác đang chiếm cạnh đó, model sẽ co vật/người ấy lại để nhường chỗ.
  - Điểm đến của người vào khung nằm trong khoảng trống, không đè lên vật cố định. Không viết "beside X on his right" khi bên phải của X là vật cố định; đặt vật ở phía đối diện với người sẽ vào.
  - Người phụ phải nằm **trọn trong khung**, không "at the edge"; ghi cỡ và khoảng cách ("stays at medium distance, same size in frame"), không để họ tiến gần camera làm đổi cỡ cảnh.
- **Mô tả ngoại hình lặp lại đủ trong mọi shot** (tuổi, tóc, râu, áo). Không viết "the same man" hay "him".
- **Một shot = một sự kiện liên tục**, không cắt cảnh. Đổi góc máy = shot mới.
- **Camera `static` / giữ khung** khi có 2+ người; không đẩy, không lia. Kết bằng "The camera holds this framing until the final frame."
- **Lời thoại vừa thời lượng, phải TÍNH rồi mới viết**: đếm âm tiết tiếng Anh của từng `<d>` (mỗi nguyên âm tách được là một âm tiết, ví dụ "haven't" = 2), chia cho số giây từ lúc bắt đầu nói tới lúc ghi "finishes". Phải ≤ 3 âm tiết/giây, kể cả khi khóc nấc hay nói chậm. Quá thì kéo cửa sổ thoại (bắt đầu từ 1.0s, kết thúc trước giây cuối ít nhất 1.5s), rồi mới rút lời, rồi mới chia shot. Không đổi lời thoại của user mà không hỏi. Ghi phép tính vào bảng tự kiểm (xem cuối file).
- **Mốc giây tăng dần, không vượt thời lượng shot**, mỗi 1-2s có một thay đổi nhìn thấy được.
- **Hành vi quan sát được, không tính từ cảm xúc trần** ("nhíu mày, siết hàm", không phải "anh ta buồn"). Cụm như "a deeply sympathetic, concerned expression" vẫn là tính từ trần; viết "brows drawn together, head tilted, lips pressed". Mỗi shot tối đa một lần đổi cảm xúc.
- **Từ cấm trong prompt**: "slowly" (mâu thuẫn với real-time; dùng "with measured steps" hay bỏ), "the same voice/man/him as before" (shot sinh độc lập, không có "trước đó").
- **Giọng viết đủ trong từng shot, không tham chiếu shot trước.** Nếu cùng nhân vật đổi giọng (khóc rồi deadpan) thì mô tả cả hai trong shot đó: "his weeping voice drops to a flat, deadpan, dry voice". Muốn giữ giọng thật sự giữa các shot thì cần `start_image` hoặc ref audio; không có thì phải nói rõ với user rằng giọng có thể lệch.
- **Một shot chỉ một lần di chuyển vào khung**: không viết hai điểm dừng liên tiếp ("stops on the right" rồi "stops beside Mark"). Gộp thành một câu với điểm đến cuối cùng.
- **Khung dọc 9:16**: ưu tiên cỡ cảnh vừa/cận (medium close-up, medium close two-shot). Hai người cùng khung thì xếp theo chiều dọc (một người đứng, một người cúi/ngồi) hoặc kề sát nhau, không đứng cách xa theo chiều ngang. Không dùng cỡ cảnh toàn.
- **Mốc thời đại**: nếu kịch bản gắn với một thời kỳ (ví dụ Victoria 1880s), ghi thời kỳ ở dòng phong cách, trang phục/bối cảnh/âm thanh đúng thời kỳ, và thêm "no modern objects" vào dòng cấm cuối shot.
- **Kết shot (end state)** là tư thế tĩnh rõ ràng, không viết "continues/keeps".
- **Lời thoại nguyên văn trong `<d>[Language] ...</d>`**, đúng ngôn ngữ, không dịch, không dấu nháy kép bọc ngoài, không chữ hiện trên màn hình. Dòng cuối mỗi shot: "All motion happens at natural real-time speed, not slow motion. There are no subtitles, captions, on-screen text, logos or watermarks anywhere in frame."
- **Hook trong 1-2s đầu** (short xem trong feed): có hành động hoặc câu nói gây chú ý ngay shot 1. Punchline hoặc cú twist nằm ở shot cuối, kết bằng khoảnh khắc im lặng hoặc phản ứng.
- **Âm thanh**: soundscape 1-4 câu, đúng với hành động nhìn thấy. `non_diegetic_music` là mô tả cụ thể hoặc đúng `N/A`, không tự mâu thuẫn.
- Không nêu tên người thật, thương hiệu, nội dung bạo lực/nhạy cảm vi phạm chính sách nền tảng.

## Bảng tự kiểm (BẮT BUỘC trước khi báo xong, trả lời từng dòng)
1. Mỗi `<d>`: người nói nêu tên + (Sx); người còn lại ghi im lặng? 
2. Mỗi `<d>`: ___ âm tiết / ___ s = ___ (≤ 3)? Thoại bắt đầu ≥ 1.0s và kết thúc cách cuối shot ≥ 1.5s?
3. Có chữ "slowly", "same ... as before" nào không? (tìm bằng grep)
4. Ngoại hình, bối cảnh, ánh sáng chép nguyên văn giống nhau ở mọi shot?
5. Mỗi nhân vật có đúng một nhãn Sx, vị trí trái/phải nhất quán? Vật cố định tả giống hệt ở mọi shot? Cạnh người vào khung còn trống từ khung đầu? Người phụ nằm trọn trong khung?
6. Mốc giây tăng dần, ≤ thời lượng shot, không hai điểm dừng liên tiếp?
7. Cảm xúc nào chỉ là tính từ? Giọng có tham chiếu shot trước?
8. Cỡ cảnh hợp 9:16? Có `aspect_ratio: "9:16"` trong JSON?
9. Có câu giữ khung cuối, dòng real-time, dòng cấm chữ/logo (cộng "no modern objects" nếu có mốc thời đại)?
Sau đó chạy `short-minimax-h3-script-review`.

## Mẫu một shot có 2 người
```
integrated_multimodal_description:
Live-action film footage, <ánh sáng>, cinematic <thể loại>.
[Shot 3] <cỡ cảnh> in <bối cảnh>. Mark (S1), <mô tả đầy đủ>, on the left; Arthur (S2), <mô tả đầy đủ>, on the right.
At 2.00 seconds Mark straightens up... At 4.00 seconds Mark (S1) says in a flat, deadpan voice: <d>[English] No, it's her first husband.</d> Arthur (S2) stays silent. At 6.00 seconds Arthur freezes...
The camera holds this framing until the final frame. All motion happens at natural real-time speed... 

overall_soundscape:
...

non_diegetic_music:
N/A
```
