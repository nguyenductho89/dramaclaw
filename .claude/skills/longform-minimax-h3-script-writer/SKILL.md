---
name: longform-minimax-h3-script-writer
description: Viết kịch bản video YouTube long-form 16:9 (6-7 phút, "Science explained with humor") dạng hai nhân vật Barnaby và Ambrose đối thoại, toàn bộ bằng MiniMax H3, bối cảnh minh hoạ cho lời nói. Dùng khi user nhờ viết hoặc sửa một tập long-form, thêm chain H3 16:9, hoặc đổi lời trong tập. Không dùng cho short 9:16 (dùng short-minimax-h3-script-writer). Viết xong luôn chạy longform-minimax-h3-script-review.
---

# Viết kịch bản long-form 16:9 cho MiniMax H3

Đọc trước khi viết:
- `examples/science-humor/series-bible.md`: nhân vật, phân vai, bối cảnh, luật truyện, danh sách tập.
- Các tập đã viết trong `examples/science-humor/`: tránh trùng cấu trúc và trò đùa.
- `src/novelvideo/agents/prompts/minimax_h3_rules.md`: quy tắc gốc của H3.

## File đầu ra

1. `examples/science-humor/<tập>-script.md`: kịch bản đầy đủ.
2. `previs_h3_test/scripts/skits/science_humor/<tập>/chain_NN.json`: mỗi đoạn H3 liên tục một file.

### Khuôn file kịch bản

```markdown
# <câu hỏi tiếng Anh>
Tổng: <phút:giây>, <số từ> từ. Barnaby <x> từ, Ambrose <y> từ.

| Mốc | Chain, shot | Bối cảnh | Người nói | Lời | Trò đùa | Nguồn |
|---|---|---|---|---|---|---|
| 0:00-0:08 | 01, 1 | Vườn táo | Ambrose | ... | ... | S1 |

## Nguồn
- S1: <tác giả, năm, tên, link>. Dùng cho: <tuyên bố>.

## Tính lại
<lệnh hoặc script, kèm kết quả, cho mọi con số tính ra>

## Cần người bản ngữ đọc
<cụm tiếng Anh có thể sai sắc thái>
```

### Khuôn chain JSON

```json
{
 "name": "science_humor_gravity_test_chain_01",
 "scene": "orchard",
 "aspect_ratio": "16:9",
 "frames": 192,
 "checkpoint": "ref2va",
 "voice_refs": ["previs_h3_test/scripts/skits/science_humor/voice/barnaby.wav", "previs_h3_test/scripts/skits/science_humor/voice/ambrose.wav"],
 "turbo_lora": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
 "turbo_steps": 12,
 "start_image": "previs_h3_test/scripts/skits/science_humor/gravity_test/backgrounds/orchard.png",
 "reference_images": ["previs_h3_test/scripts/skits/science_humor/character/barnaby_sheet.png", "previs_h3_test/scripts/skits/science_humor/character/ambrose_sheet.png"],
 "shots": ["..."]
}
```

- `frames` phải có dạng 17k+5 ở 24 khung/giây: 192 = 8 s, 209 ≈ 8,7 s. Shot có thoại tối thiểu 192 khung. Mỗi shot tối đa 12 s. Các shot trong một chain có cùng độ dài, nên gom những câu dài gần bằng nhau.
- **Gom các shot cùng bối cảnh vào một chain:** H3 nối shot sau từ khung cuối thật của shot trước, nên mặt và vị trí ít lệch hơn so với hai keyframe sinh riêng. Tư thế đầu mỗi shot phải khớp tư thế cuối shot trước. Đã chạy được tới 6 shot mỗi chain.
- Mỗi shot gồm 6 mục của ref2va: `subject_definitions:`, `summary:`, `retention_analysis:`, `detailed_description:`, `overall_soundscape:`, `non_diegetic_music:`, theo nhánh ref2va của `assemble_minimax_h3_prompt`.
- Số thứ tự ảnh cố định: `<Picture 1>` nền, `<Picture 2>` sheet Barnaby, `<Picture 3>` sheet Ambrose; `<Subject 1>` Barnaby, `<Subject 2>` Ambrose.
- `voice_refs` theo thứ tự cố định: `<Audio 1>` là Barnaby, `<Audio 2>` là Ambrose. Giữ giống nhau ở mọi chain, kể cả chain chỉ một người nói.
- **Không ghép ảnh trước.** Qwen-Image chỉ tạo sheet nhân vật và ảnh nền trống; H3 đưa hai người vào cảnh. Nền làm khung đầu (`start_image`) thì `reference_images` chỉ gồm 2 sheet, và shot 1 phải cho họ đi vào khung. Nền chỉ làm tham chiếu thì `start_image` là null và `reference_images` gồm cả nền, xếp đầu tiên. Bài thử trọng lực so sánh hai cách này. Khi nền là khung đầu, chỉ shot 1 có `<Picture 1>`; các shot sau không còn ảnh nền, nên tả bối cảnh bằng chữ, còn sheet vẫn là `<Picture 2>`, `<Picture 3>`.
- Mọi shot đều ghi nhãn `[Shot 1]`, theo khuôn chính thức và lint của repo.

## Quy trình

1. Đọc mục tập trong series bible. Đọc nguồn gốc và tính lại mọi con số trước khi viết lời.
2. Chọn một ý khoa học chính, một cuộc cãi nhau cổ điển và hiện đại, một trò đùa kết.
3. Chọn bối cảnh minh hoạ cho từng đoạn, viết bảng kịch bản.
4. Viết chain JSON.
5. Điền bảng tự kiểm, sửa tới khi đạt.
6. Chạy `longform-minimax-h3-script-review`, sửa tới khi sạch CHẶN và CẢNH BÁO.

## Cấu trúc long-form

- **Độ dài:** 6-7 phút, khoảng 550-700 từ. Số từ thấp vì toàn bộ lời do H3 nói trong shot ngắn; sẽ đo lại sau tập đầu.
- **Mở đầu:** nêu câu hỏi và lời hứa trong 30 giây đầu.
- **Giữ chân:** khoảng 60-90 giây có một cú kéo mới, ví dụ đổi bối cảnh, kết quả ngược dự đoán, một bên thua cãi.
- **Kết:** trò đùa quay lại từ đầu tập, không kết bằng tóm tắt khô.
- **Khác tập trước:** đổi thứ tự cãi nhau, ai thắng, bối cảnh và trò đùa. YouTube cấm nội dung theo khuôn lặp lại.

## Phân vai

- **Barnaby nói kiến thức hiện đại, Ambrose nói khoa học cổ điển.** Không đổi vai, trừ khi nhân vật đang trích lại lời bên kia để cãi.
- **Không ai ngốc.** Khoa học cổ điển sai ở đâu thì nói đúng phạm vi đó; nơi nó vẫn đúng thì phải nhận là đúng.
- **Xen kẽ lời.** Không để một người nói quá 2 shot liền nếu không có lý do; người nghe vẫn phản ứng.

## Bối cảnh minh hoạ

- Bối cảnh phải khớp điều đang nói ngay lúc đó. Ghi lý do chọn trong cột Bối cảnh nếu không hiển nhiên.
- Đổi bối cảnh bằng cú cắt giữa hai chain, không chuyển trong một shot. Có thể đùa về việc đổi cảnh.
- **Bối cảnh chỉ là phông nền.** Không yêu cầu H3 diễn thí nghiệm hay chuyển động cần đúng vật lý. Không có chữ, sơ đồ, công thức, đồ thị.
- Chi tiết nguy hiểm thật (không có không khí, nhiệt độ) phải được thoại đùa tới, để không ai tưởng thật.
- Đạo cụ giữ đơn giản và cố định. Mặc định chỉ có quả táo Ambrose cầm.

## Science humor

- **Trò đùa đến từ khoa học hoặc từ cuộc cãi nhau.** Nó dẫn tới ý khoa học hoặc đến từ chính ý đó.
- **Không có đoạn dài thiếu trò đùa:** mỗi 30-45 giây có ít nhất một nhịp hài.
- **Không giải thích trò đùa.** Để phản ứng im lặng của người nghe sau câu chốt.
- **Phóng đại phải nhận ra được là phóng đại.** Nếu người xem có thể tin là thật, phải đính chính ngay trong tập.
- **Nguồn:** mỗi tuyên bố khoa học có mã nguồn. Điều còn tranh cãi phải nói là còn tranh cãi. Ngoặc kép chỉ dành cho câu nói có nguồn thật.
- **Ghi công:** nói đúng tên người phát hiện. Nhân vật không tự nhận công.
- **Tiếng Anh tự nhiên:** dùng dạng rút gọn như nói thật ("isn't", "I'm"). Tránh chơi chữ mà bạn không chắc. Đánh dấu cụm dễ sai sắc thái.
- **Không dùng** y tế, pháp lý, tài chính, chính trị làm nội dung tư vấn từ nhân vật AI.

## Nhân vật

Chép nguyên văn khối mô tả trong series bible vào mọi shot có mặt mỗi người.

- **Không liên hệ với Einstein hay Newton trong truyện:** Barnaby không phải Einstein, Ambrose không phải Newton. Không nhắc tới sự giống nhau, không đùa về nó.
- **Không dùng dấu hiệu gắn với Einstein:** lè lưỡi, phòng cấp bằng sáng chế, bảng E=mc², tẩu thuốc, giọng Đức.
- **Tên Einstein** chỉ được nói khi ghi công đúng trong nội dung khoa học. Không đặt trong tiêu đề hay thumbnail.
- **Tên Newton** nói bình thường khi ghi công; Ambrose không tự nhận công của ông.

## Quy tắc H3 (từng gây lỗi thật)

- **Gắn giọng vào tên:** `Tên (S1) says in a warm, amused voice, the voice in <Audio 1>: <d>[English] ...</d>`, không viết `a man (S1)`. Khi có 2 người, "a man" khiến model gán lời nhầm người.
- **Mỗi shot chỉ một người nói,** nêu tên ngay trong mệnh đề. Người còn lại ghi "stays silent with closed lips" và đang làm gì.
- **Vị trí trái/phải nêu rõ ở mọi shot,** không đổi trong một bối cảnh: Barnaby ở phần ba bên trái, Ambrose ở phần ba bên phải, cùng cỡ, cùng độ sâu, đúng tỉ lệ với bối cảnh.
- **Không để mặt quay nghiêng:** đứng ba phần tư về phía nhau và về phía máy. Viết "face each other" đơn thuần sẽ ra hai mặt nghiêng, khó khớp môi. Người đang nói không quay đi chỗ khác; nhìn bối cảnh thì làm trước khi nói.
- **Tay gần máy:** Barnaby cử chỉ bằng tay phải, Ambrose cầm táo bằng tay trái, để không bị thân che.
- **Nắng sau máy, hơi lệch trái,** để hai mặt đều sáng.
- **Mô tả chép nguyên văn ở mọi shot:** câu mô tả ngắn của từng người trong series bible (ảnh sheet mang phần còn lại), bối cảnh, ánh sáng, vật cố định. Shot sinh độc lập, không nhớ shot trước. Không viết "the same man", "him", "as before".
- **Một shot một sự kiện liên tục,** không cắt cảnh. Đổi góc máy là shot mới.
- **Tính thoại trước khi viết:** đếm âm tiết của từng `<d>`, chia cho số giây nói, phải ≤ 3 âm tiết/giây. Thoại bắt đầu từ 1.0 s (1.75 s nếu hai người đi vào khung) và kết thúc khoảng 1,7 s trước cuối shot 8 s. Bài thử ep01 đo được H3 nói một câu 14 âm tiết trong khoảng 3,3 s dù prompt cho nhiều hơn.
- **Chặn lời thừa sau câu thoại:** H3 đã tự nói thêm trong đoạn trống cuối shot (ep01, 2026-11-05, đoạn trống 1,5-3 s). Shot có thoại luôn từ 192 khung (8 s): generator ghi rằng ngắn hơn thì mối nối bị clip. Vì vậy sau mỗi `<d>` chép câu chính thức "Exactly as the voice stops, the lips close and the jaw ceases all speaking motion. This single line is the only speech in the video." Sau mốc "finishes" ghi rõ cả hai im lặng, ngậm miệng tới khung cuối. Cách này chưa kiểm chứng; nghe lại audio sau khi sinh.
- **Mốc giây tăng dần,** không vượt thời lượng, mỗi 1-2 s có một thay đổi nhìn thấy được.
- **Hành vi quan sát được:** "lifts one eyebrow, lips pressed", không phải "looks amused". Mỗi shot tối đa một lần đổi cảm xúc.
- **Từ cấm:** "slowly", "the same ... as before".
- **Kết shot** là tư thế tĩnh rõ ràng, không dùng "continues" hay "keeps".
- **Thoại đang nói không kèm hành động miệng:** "lips pressed", "smiles" chỉ đặt sau mốc "finishes", nếu không dễ hỏng khớp môi.
- **Thoại nguyên văn** trong `<d>[English] ...</d>`, không dấu nháy kép bọc ngoài.
- **Dòng cuối phần mô tả:** "The camera holds this framing until the final frame. All motion happens at natural real-time speed, not slow motion. There are no subtitles, captions, on-screen text, logos or watermarks anywhere in frame."
- **Không nêu** người thật hay thương hiệu trong phần tả cảnh. Tên Newton, Einstein, Galileo chỉ nằm trong `<d>` khi ghi công.

## Khung 16:9

- Dòng phong cách ghi "horizontal 16:9 framing". `aspect_ratio` bắt buộc là `"16:9"`.
- **Máy cố định, ngang mắt, cỡ medium two-shot.** Hai người nhìn nhau, không nhìn ống kính, trừ khi trò đùa cần.
- **Chừa đầu và chân khung:** bản 1344×768 bị cắt khoảng 1% trên và dưới khi về đúng 16:9. Đỉnh đầu, kể cả tóc giả, không sát mép.
- **Không đổi cỡ cảnh trong chain** nếu không có lý do.
- **Âm nhạc:** `non_diegetic_music:` luôn là `N/A`. Nhạc thêm lúc dựng, vì nhạc sinh riêng từng shot sẽ lộ khi cắt.

## Prompt Qwen-Image

- **Chỉ có hai loại ảnh:** sheet nhân vật (một người, 2 góc cạnh nhau, nền xám) và ảnh nền trống (mặt đất phía trước để trống).
- **Viết dương, không viết phủ định:** nêu cái cần có ("a clean-shaven upper lip", "untouched grass", "a pure black sky"). Từ như "no moustache", "no labels", "no flags" có thể kéo model vẽ đúng thứ đó.
- Một nguồn sáng, tương phản dịu. Không dùng từ đẩy độ nét như "ultra detailed", "sharp", "realistic detail".
- Dùng chung một ảnh nền cho mọi chain ở cùng bối cảnh.

## Bảng tự kiểm (trả lời từng dòng trước khi báo xong)

1. Tổng thời lượng ___, số từ ___, Barnaby ___, Ambrose ___?
2. Câu hỏi và lời hứa nằm trong 30 giây đầu? Các cú kéo ở mốc nào? Trò đùa cuối quay lại từ đâu?
3. Cấu trúc và trò đùa có trùng tập trước không?
4. Mỗi tuyên bố có mã nguồn? Điều gì còn tranh cãi đã nói rõ? Phạm vi đúng của khoa học cổ điển đã nói rõ?
5. Barnaby chỉ nói phần hiện đại, Ambrose chỉ nói phần cổ điển? Có liên hệ hay dấu hiệu Einstein/Newton trong truyện không? Có ai nhận công không?
6. Mỗi bối cảnh khớp lời? Có yêu cầu H3 diễn vật lý, chữ hay sơ đồ không?
7. Mỗi `<d>`: ___ âm tiết / ___ s = ___ (≤ 3)? Bắt đầu ≥ 1.0 s, kết thúc khoảng 1,7 s trước cuối shot, có câu lip-close sau `<d>`?
8. Có "slowly", "same ... as before" không? (grep)
9. Mô tả nhân vật, bối cảnh, vị trí trái/phải giống hệt ở mọi shot cùng bối cảnh? Mỗi shot chỉ một người nói?
10. Mốc giây tăng dần, trong thời lượng shot?
11. `aspect_ratio` là `"16:9"`, `non_diegetic_music` là `N/A`, đủ 6 mục và các dòng cuối shot?
12. Mỗi chain có `voice_refs` đúng thứ tự, `reference_images`, ảnh nền, và số `<Picture N>` khớp?

Sau đó chạy `longform-minimax-h3-script-review`.
