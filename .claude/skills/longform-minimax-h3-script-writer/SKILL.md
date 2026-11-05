---
name: longform-minimax-h3-script-writer
description: Viết kịch bản video YouTube long-form 16:9 (6-7 phút, "Science explained with humor") gồm cảnh MiniMax H3 và minh hoạ Manim/Three.js. Dùng khi user nhờ viết hoặc sửa một tập long-form, thêm chain H3 16:9, hoặc đổi lời trong tập. Không dùng cho short 9:16 (dùng short-minimax-h3-script-writer). Viết xong luôn chạy longform-minimax-h3-script-review.
---

# Viết kịch bản long-form 16:9 cho MiniMax H3

Đọc trước khi viết:
- `examples/science-humor/series-bible.md`: nhân vật, bối cảnh, luật truyện, danh sách tập đã kiểm nguồn.
- Các tập đã viết trong `examples/science-humor/`: tránh trùng cấu trúc và trò đùa.
- `src/novelvideo/agents/prompts/minimax_h3_rules.md`: quy tắc gốc của H3.

## File đầu ra

1. `examples/science-humor/epNN-script.md`: kịch bản đầy đủ.
2. `previs_h3_test/scripts/skits/science_humor/epNN/chain_NN.json`: mỗi đoạn H3 liên tục một file.
3. `previs_h3_test/scripts/skits/science_humor/epNN/manim/` và file scene Three.js: minh hoạ, viết khi sang bước sản xuất.

### Khuôn file kịch bản

```markdown
# Ep NN: <câu hỏi tiếng Anh>
Tổng: <phút:giây>, <số từ> từ. Mặt <x>%, B-roll <y>%, minh hoạ <z>%.

| Mốc | Lớp | Hình | Lời | Trò đùa | Nguồn |
|---|---|---|---|---|---|
| 0:00-0:08 | H3 mặt (chain 01, shot 1) | ... | ... | ... | S1 |
| 0:08-0:20 | Manim | ... | ... | | S1, S2 |

## Nguồn
- S1: <tác giả, năm, tên, link>. Dùng cho: <tuyên bố>.

## Tính lại
<lệnh hoặc script, kèm kết quả, cho mọi con số tính ra>

## Cần người bản ngữ đọc
<cụm tiếng Anh có thể sai sắc thái>
```

Lớp hợp lệ: `H3 mặt`, `H3 B-roll`, `Manim`, `Three.js`.

### Khuôn chain JSON

```json
{
 "name": "science_humor_ep01_chain_01",
 "aspect_ratio": "16:9",
 "frames": 192,
 "checkpoint": "ref2va",
 "voice_ref": "previs_h3_test/scripts/skits/science_humor/voice/voice_ref.wav",
 "turbo_lora": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
 "turbo_steps": 12,
 "start_image": "previs_h3_test/scripts/skits/science_humor/ep01/keyframes/chain_01.png",
 "keyframe_prompt": "...",
 "shots": ["..."]
}
```

- `frames` 192 ≈ 8 s. Mỗi shot tối đa 12 s.
- Mỗi shot gồm 3 mục: `integrated_multimodal_description:`, `overall_soundscape:`, `non_diegetic_music:`.
- B-roll không có thoại thì bỏ `voice_ref`.
- `bench_multishot30_local.py` chỉ nhận `start_image` và `voice_ref`, không nhận ảnh sheet riêng. Mặt nhân vật đi vào H3 qua `start_image`, nên keyframe phải tạo từ sheet và mọi chain phải có keyframe riêng.

## Quy trình

1. Đọc mục tập trong series bible. Tìm nguồn còn thiếu và tính lại mọi con số trước khi viết lời.
2. Chọn một ý khoa học chính, một thí nghiệm hỏng, một trò đùa quay lại ở cuối.
3. Chia lớp theo ngân sách, viết bảng kịch bản.
4. Viết chain JSON cho các đoạn H3.
5. Điền bảng tự kiểm, sửa tới khi đạt.
6. Chạy `longform-minimax-h3-script-review`, sửa tới khi sạch CHẶN và CẢNH BÁO.

## Cấu trúc long-form

- **Độ dài:** 6-7 phút, 800-1.000 từ.
- **Ngân sách lớp:** mặt ~40%, B-roll ~25%, minh hoạ ~35%. Lệch 10 điểm phần trăm vẫn được nếu tập cần. Đây là ngân sách, không phải khuôn: thứ tự và cấu trúc phải khác các tập trước.
- **Tốc độ theo lớp:** cảnh mặt tối đa 16 âm tiết cho mỗi shot 8 s; voiceover tối đa 2,9 từ/giây. Lời dài đưa sang voiceover trên B-roll hoặc minh hoạ.
- **Mở đầu:** nêu câu hỏi và lời hứa trong 30 giây đầu.
- **Giữ chân:** khoảng 60-90 giây có một cú kéo mới, ví dụ thí nghiệm hỏng thêm, kết quả ngược dự đoán, câu hỏi tiếp theo.
- **Kết:** trò đùa quay lại từ đầu tập, không kết bằng tóm tắt khô.

## Lớp minh hoạ

- **Manim:** phương trình, đồ thị, sơ đồ 2D.
- **Three.js:** vật thể và mô phỏng 3D (`previs_h3_test/render.js`, `render_video.js`).
- Mọi số liệu trong hình cần mã nguồn như lời thoại. Mô phỏng phải tính từ công thức, không tạo chuyển động cho đẹp.
- Hình đơn giản hoá thì lời phải nói rõ là đơn giản hoá.
- Dùng bảng màu và font trong series bible. Kết xuất 1920×1080, cùng số khung/giây với H3.
- Chữ, đồ thị và phương trình chỉ nằm ở lớp này hoặc thêm lúc dựng, không bao giờ yêu cầu H3 vẽ.

## Science humor

- **Trò đùa đến từ khoa học:** nó dẫn tới ý khoa học hoặc đến từ chính ý đó. Nhân vật hỏng theo đúng cách định luật dự đoán.
- **Không có đoạn dài thiếu trò đùa:** mỗi 30-45 giây có ít nhất một nhịp hài.
- **Không giải thích trò đùa.** Để khoảng dừng hoặc phản ứng im lặng trước và sau câu chốt.
- **Phóng đại phải nhận ra được là phóng đại.** Nếu người xem có thể tin là thật, phải đính chính ngay trong tập.
- **Nguồn:** mỗi tuyên bố khoa học có mã nguồn. Điều còn tranh cãi phải nói là còn tranh cãi. Ngoặc kép chỉ dành cho câu nói có nguồn thật.
- **Ghi công:** nói đúng tên người phát hiện. Nhân vật không tự nhận công.
- **Tiếng Anh tự nhiên:** dùng dạng rút gọn như nói thật ("isn't", "I'm"). Tránh chơi chữ mà bạn không chắc. Đánh dấu cụm dễ sai sắc thái.
- **Kết quả chưa ai đo** phải gắn "in theory", "according to the sums" hoặc nói rõ là hư cấu. Con số chỉ đúng trong một mô hình thì nói rõ là của mô hình.
- **Đạo cụ hài** phải vô hại khi bắt chước. Đừng tả dụng cụ dễ gây thương tích như lò xo mạnh.
- **An toàn:** thí nghiệm người xem có thể bắt chước và gây hại phải có cảnh báo rõ, hoặc bị bỏ.
- **Không dùng** y tế, pháp lý, tài chính, chính trị làm nội dung tư vấn từ nhân vật AI.

## Nhân vật

Chép nguyên văn khối mô tả trong series bible vào mọi shot có mặt ông.

- **Không liên hệ với Einstein trong truyện:** không phải ông, không phải người quen của ông; không nhắc tới sự giống nhau, không đùa về nó.
- **Không dùng dấu hiệu gắn với Einstein:** lè lưỡi, phòng cấp bằng sáng chế, bảng E=mc², tẩu thuốc, giọng Đức.
- **Tên Einstein** chỉ được nói khi ghi công đúng trong nội dung khoa học. Không đặt trong tiêu đề hay thumbnail.

## Quy tắc H3 (từng gây lỗi thật)

- **Gắn giọng vào tên:** `Tên (S1) says in a warm, amused voice: <d>[English] ...</d>`, không viết `a man (S1)`.
- **Mỗi thoại một người nói,** nêu tên ngay trong mệnh đề. Người còn lại ghi im lặng và đang làm gì.
- **Mô tả chép nguyên văn ở mọi shot:** ngoại hình, bối cảnh, ánh sáng, vật cố định. Shot sinh độc lập, không nhớ shot trước. Không viết "the same man", "him", "as before".
- **Đồ vật:** tả hình dạng và vị trí một lần, chép giống hệt, không tự mâu thuẫn. Đạo cụ càng đơn giản càng tốt, vì đồ vật dễ trôi giữa các shot.
- **Một shot một sự kiện liên tục,** không cắt cảnh. Đổi góc máy là shot mới.
- **Tính thoại trước khi viết:** đếm âm tiết của từng `<d>`, chia cho số giây nói, phải ≤ 3 âm tiết/giây. Thoại bắt đầu từ 1.0 s và kết thúc cách cuối shot ít nhất 1.5 s.
- **Mốc giây tăng dần,** không vượt thời lượng, mỗi 1-2 s có một thay đổi nhìn thấy được.
- **Hành vi quan sát được:** "lifts one eyebrow, lips pressed", không phải "looks amused". Mỗi shot tối đa một lần đổi cảm xúc.
- **Từ cấm:** "slowly", "the same ... as before".
- **Kết shot** là tư thế tĩnh rõ ràng, không dùng "continues" hay "keeps".
- **Thoại đang nói không kèm hành động miệng:** "lips pressed", "smiles" chỉ đặt sau mốc "finishes", nếu không dễ hỏng khớp môi.
- **Thoại nguyên văn** trong `<d>[English] ...</d>`, không dấu nháy kép bọc ngoài.
- **Dòng cuối phần mô tả:** "The camera holds this framing until the final frame. All motion happens at natural real-time speed, not slow motion. There are no subtitles, captions, on-screen text, logos or watermarks anywhere in frame."
- **Không nêu** người thật hay thương hiệu trong prompt.

## Khung 16:9

- Dòng phong cách ghi "horizontal 16:9 framing". `aspect_ratio` bắt buộc là `"16:9"`.
- **Máy mặc định đặt cố định, ngang mắt, ông nhìn thẳng ống kính kiểu vlog.** Selfie cầm tay chỉ dùng sau khi đã thử đạt.
- **Vị trí theo phần ba khung:** "in the left third", "in the center". Vật quan trọng ghi rõ thuộc phần nào của chiều ngang.
- **Chừa khoảng trống phía nhìn:** người nhìn sang phải thì đặt lệch trái.
- **Chừa đầu và chân khung:** bản 1344×768 bị cắt khoảng 1% trên và dưới khi về đúng 16:9. Đỉnh đầu và vật quan trọng không sát mép.
- **Người vào khung** đi ngang qua khung, cùng khoảng cách với máy, từ cạnh còn trống ngay từ khung đầu của shot, không đè lên vật cố định.
- **Không dùng 3 phần tử ngang sát nhau ở cỡ cận mà không chia phần ba.** Khung ngang rộng hơn, nhưng vẫn phải ghi vị trí từng phần tử.
- **Âm nhạc:** `non_diegetic_music:` luôn là `N/A`. Nhạc thêm lúc dựng, vì nhạc sinh riêng từng shot sẽ lộ khi cắt.

## Bảng tự kiểm (trả lời từng dòng trước khi báo xong)

1. Tổng thời lượng ___, số từ ___, mặt ___%, B-roll ___%, minh hoạ ___%?
2. Câu hỏi và lời hứa nằm trong 30 giây đầu? Các cú kéo ở mốc nào? Trò đùa cuối quay lại từ đâu?
3. Cấu trúc và trò đùa có trùng tập trước không?
4. Mỗi tuyên bố có mã nguồn? Mỗi con số tính ra có phép tính? Điều gì còn tranh cãi đã nói rõ?
5. Mỗi đoạn minh hoạ đúng công cụ? Số trong hình có nguồn?
6. Có liên hệ hay dấu hiệu Einstein nào không? Nhân vật có nhận công không?
7. Mỗi `<d>`: ___ âm tiết / ___ s = ___ (≤ 3)? Bắt đầu ≥ 1.0 s, kết thúc cách cuối shot ≥ 1.5 s?
8. Có "slowly", "same ... as before" không? (grep)
9. Mô tả nhân vật, bối cảnh, vật cố định giống hệt ở mọi shot?
10. Mốc giây tăng dần, trong thời lượng shot, chỉ một lần vào khung?
11. `aspect_ratio` là `"16:9"`, `non_diegetic_music` là `N/A`, đủ các dòng cuối shot?
12. Mỗi chain có thoại có `voice_ref`? Mỗi chain có `start_image` và `keyframe_prompt`?

Sau đó chạy `longform-minimax-h3-script-review`.
