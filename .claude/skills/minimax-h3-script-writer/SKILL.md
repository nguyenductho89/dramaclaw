---
name: minimax-h3-script-writer
description: Viết kịch bản short 9:16 (YouTube Shorts/TikTok) dạng multishot, CHỈ cho video model MiniMax H3 (fl2va/ref2va) trong previs_h3_test/scripts/skits/*.json. Dùng khi user nhờ viết skit/kịch bản short, thêm shot, hoặc đổi lời thoại. Sau khi viết xong luôn chạy skill minimax-h3-script-review.
---

# Viết kịch bản short 9:16 cho MiniMax H3 (multishot)

## File đầu ra
`previs_h3_test/scripts/skits/<ten>.json`, theo mẫu `who_has_it_worse.json`:
`{"name", "frames", "start_image", "shots": [<chuỗi prompt mỗi shot>]}`.
Mỗi shot là một chuỗi gồm 3 mục: `integrated_multimodal_description:`, `overall_soundscape:`, `non_diegetic_music:`.

> Kịch bản này chạy trên MiniMax H3 (RunPod, `generators/runpod_minimax_h3_video.py`), mỗi shot ≤12s, prompt theo chuẩn H3: `[Shot N]`, mốc giây, `<d>[Language] ...</d>`, nhãn giọng `(Sx)`. Không áp dụng cho Seedance/Grok/Veo. Quy tắc gốc: `src/novelvideo/agents/prompts/minimax_h3_rules.md`.

## Quy trình
1. Chốt trước: số nhân vật (tối đa 3), mỗi nhân vật 1 nhãn giọng cố định **S1, S2, S3 dùng nhất quán cho mọi shot**, độ dài mỗi shot (5-12s, 243 khung ≈ 10s), khổ 9:16.
2. Viết **bảng nhân vật** (không đưa vào JSON): tên, tuổi, tóc/râu, trang phục, nhãn giọng, kiểu giọng. Mỗi shot chép lại NGUYÊN VĂN mô tả này (shot sinh độc lập, không nhớ shot trước).
3. Viết từng shot theo khuôn: phong cách → `[Shot N]` + cỡ cảnh + bối cảnh → nhân vật có mô tả → timeline theo giây → câu chốt → âm thanh.
4. Chạy skill `minimax-h3-script-review` và sửa tới khi sạch lỗi CHẶN.

## Quy tắc BẮT BUỘC (mỗi quy tắc từng gây lỗi thật)
- **Gắn giọng vào TÊN nhân vật, không bao giờ vào "a man/a woman".** Viết `Mark (S1) says in a flat, deadpan voice: <d>[English] ...</d>`, KHÔNG viết `a man (S1) says it`. Khi có 2+ người cùng khung, "a man" khiến model gán lời nhầm người (lỗi shot 3 của who_has_it_worse: lời Mark bị đọc bởi Arthur).
- **Mỗi lời thoại chỉ có đúng một người nói.** Ngay trước/sau câu thoại ghi rõ người còn lại im lặng và làm gì ("Arthur stays silent, frozen").
- **Người nói được nhắc tên ngay trong mệnh đề của câu thoại**, không dựa vào câu trước. Chủ thể nhắc đầu tiên trong shot dễ bị coi là người nói.
- **Vị trí trái/phải của mỗi người nêu rõ ở mọi shot có 2+ người**, giữ nhất quán giữa các shot (Mark bên trái, Arthur bên phải).
- **Mô tả ngoại hình lặp lại đủ trong mọi shot** (tuổi, tóc, râu, áo). Không viết "the same man" hay "him".
- **Một shot = một sự kiện liên tục**, không cắt cảnh. Đổi góc máy = shot mới.
- **Camera `static` / giữ khung** khi có 2+ người; không đẩy, không lia. Kết bằng "The camera holds this framing until the final frame."
- **Lời thoại vừa thời lượng**: khoảng 2-3 âm tiết/giây trong cửa sổ thoại. Câu dài hơn thì rút hoặc chia shot. Chừa 1-2s mở đầu và 1s cuối không thoại.
- **Mốc giây tăng dần, không vượt thời lượng shot**, mỗi 1-2s có một thay đổi nhìn thấy được.
- **Hành vi quan sát được, không tính từ cảm xúc trần** ("nhíu mày, siết hàm", không phải "anh ta buồn").
- **Kết shot (end state)** là tư thế tĩnh rõ ràng, không viết "continues/keeps".
- **Lời thoại nguyên văn trong `<d>[Language] ...</d>`**, đúng ngôn ngữ, không dịch, không dấu nháy kép bọc ngoài, không chữ hiện trên màn hình. Dòng cuối mỗi shot: "All motion happens at natural real-time speed, not slow motion. There are no subtitles, captions, on-screen text, logos or watermarks anywhere in frame."
- **Hook trong 1-2s đầu** (short xem trong feed): có hành động hoặc câu nói gây chú ý ngay shot 1. Punchline hoặc cú twist nằm ở shot cuối, kết bằng khoảnh khắc im lặng hoặc phản ứng.
- **Âm thanh**: soundscape 1-4 câu, đúng với hành động nhìn thấy. `non_diegetic_music` là mô tả cụ thể hoặc đúng `N/A`, không tự mâu thuẫn.
- Không nêu tên người thật, thương hiệu, nội dung bạo lực/nhạy cảm vi phạm chính sách nền tảng.

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
