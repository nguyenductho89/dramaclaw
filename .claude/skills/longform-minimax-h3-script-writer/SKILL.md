---
name: longform-minimax-h3-script-writer
description: Viết kịch bản video YouTube long-form 16:9 (6-7 phút, "Science explained with humor") dạng hai nhân vật Einstein và Newton đối thoại, toàn bộ bằng MiniMax H3, bối cảnh minh hoạ cho lời nói. Dùng khi user nhờ viết hoặc sửa một tập long-form, thêm chain H3 16:9, hoặc đổi lời trong tập. Viết xong luôn chạy longform-minimax-h3-script-review.
---

# Viết kịch bản long-form 16:9 cho MiniMax H3

Đọc trước khi viết:
- `video_production_with_skills/series/science_humor/series-bible.md`: nhân vật, phân vai, bối cảnh, luật truyện, danh sách tập.
- Các tập đã viết (`video_production_with_skills/series/science_humor/<tập>/script.md`): tránh trùng cấu trúc và trò đùa.
- `src/novelvideo/agents/prompts/minimax_h3_rules.md`: quy tắc gốc của H3 (riêng quy tắc camera tĩnh khi có hai người trở lên **không áp** cho long-form: góc quay và chuyển động theo skill `longform-camera-angles`).

## File đầu ra

1. `video_production_with_skills/series/<series>/<tập>/script.md`: kịch bản đầy đủ, viết bằng skill này.
2. Mục `## Storyboard` trong file kịch bản và file prompt keyframe `<tập>/keyframes/qwen_keyframe_prompts.json`: viết bằng skill `script-to-qwen-storyboard` (prompt soạn và review bằng `qwen-image-prompting`).
3. `video_production_with_skills/series/<series>/<tập>/chains/chain_NN.json`: mỗi đoạn H3 liên tục một file, viết bằng skill này sau khi user duyệt ảnh keyframe storyboard.

Không có code nào viết hoặc sinh lại kịch bản, storyboard hay prompt: mọi thay đổi sửa thẳng vào các file trên bằng skill tương ứng.

### Khuôn file kịch bản

```markdown
# <câu hỏi tiếng Anh>
Tổng: <phút:giây>, <số từ> từ. Einstein <x> từ, Newton <y> từ.

| Mốc | Chain, shot | Bối cảnh | Người nói | Lời | Trò đùa | Nguồn |
|---|---|---|---|---|---|---|
| 0:00-0:08 | 01, 1 | Vườn táo | Newton | ... | ... | S1 |

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
 "name": "science_humor_ep01_chain_01",
 "scene": "orchard",
 "aspect_ratio": "16:9",
 "frames": 192,
 "checkpoint": "ref2va",
 "voice_refs": ["video_production_with_skills/series/science_humor/assets/voices/einstein.wav", "video_production_with_skills/series/science_humor/assets/voices/newton.wav"],
 "turbo_lora": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
 "turbo_steps": 12,
 "start_image": "video_production_with_skills/series/science_humor/ep01/keyframes/images/chain_01_k0.png",
 "reference_images": ["video_production_with_skills/series/science_humor/assets/characters/einstein_sheet.png", "video_production_with_skills/series/science_humor/assets/characters/newton_sheet.png"],
 "shots": ["..."]
}
```

- `frames` phải có dạng 17k+5 ở 24 khung/giây: 192 = 8 s, 209 ≈ 8,7 s. Shot có thoại tối thiểu 192 khung. Mỗi shot tối đa 12 s. Các shot trong một chain có cùng độ dài, nên gom những câu dài gần bằng nhau.
- **Gom các shot cùng setup vào một chain:** H3 nối shot sau từ khung cuối thật của shot trước, nên mặt và vị trí ít lệch hơn so với hai keyframe sinh riêng. Tư thế đầu mỗi shot phải khớp tư thế cuối shot trước, camera đầu shot i+1 là camera cuối shot i. Đã chạy được tới 6 shot mỗi chain. Đổi góc hay vị trí máy là chain mới (skill `longform-camera-angles`); chain nhiều shot chỉ khi các shot chung một góc.
- Mỗi shot gồm 6 mục của ref2va: `subject_definitions:`, `summary:`, `retention_analysis:`, `detailed_description:`, `overall_soundscape:`, `non_diegetic_music:`, theo nhánh ref2va của `assemble_minimax_h3_prompt`.
- Số thứ tự ảnh cố định: `<Picture 1>` khung đầu (keyframe K0), `<Picture 2>` sheet Einstein, `<Picture 3>` sheet Newton; `<Subject 1>` Einstein, `<Subject 2>` Newton.
- `voice_refs` theo thứ tự cố định: `<Audio 1>` là Einstein, `<Audio 2>` là Newton. Giữ giống nhau ở mọi chain, kể cả chain chỉ một người nói.
- **Khung đầu là keyframe đã duyệt:** `start_image` = keyframe K0 của cảnh (`<tập>/keyframes/images/chain_NN_k0.png`), `reference_images` = [sheet Einstein, sheet Newton]. Hai người đứng sẵn ở khung đầu, không đi vào khung. Tư thế đầu và cuối, vật cầm và cỡ khung của từng shot lấy đúng từ dòng tương ứng của mục Storyboard. Chỉ render video từ keyframe đã duyệt (`video_production_with_skills/tools/approve_keyframes.py`).
- **Hai giọng phải khác giọng vùng, không chỉ khác tính cách:** Einstein giọng Mỹ, Newton giọng Anh. Hai giọng cùng "English accent" nghe như một (Resemblyzer: cùng người 0,90, khác người 0,88). Sau khi thiết kế, kiểm cosine giữa hai giọng mẫu và nghe thật trước khi sinh video. Lời của Einstein dùng cách nói Mỹ ("Nice", "Sure"), không dùng "Lovely", "Quite".
- Mọi shot đều ghi nhãn `[Shot 1]`, theo khuôn chính thức và lint của repo.

## Quy trình

1. Đọc mục tập trong series bible. Đọc nguồn gốc và tính lại mọi con số trước khi viết lời.
2. Chọn một ý khoa học chính, một cuộc cãi nhau cổ điển và hiện đại, một trò đùa kết.
3. Chọn địa điểm minh hoạ cho từng đoạn, rồi dùng skill `longform-camera-angles` gán góc, cỡ khung đầu và chuyển động cho từng shot, chia chain và ghi lý do (vào mục Storyboard); thêm địa điểm hoặc phông mới nếu lời cần. Viết bảng kịch bản.
4. Viết storyboard và prompt keyframe bằng `script-to-qwen-storyboard`; sinh ảnh keyframe; user duyệt.
5. Viết chain JSON theo storyboard.
6. Điền bảng tự kiểm, sửa tới khi đạt.
7. Chạy `longform-minimax-h3-script-review`, sửa tới khi sạch CHẶN và CẢNH BÁO.

## Cấu trúc long-form

- **Độ dài:** 6-7 phút (cả các đoạn wormhole: mỗi đoạn dài 2,8 s, crossfade 0,4 s hai đầu, thêm ròng ~2 s mỗi lần đổi địa điểm), khoảng 420-520 từ. Số từ thấp vì toàn bộ lời do H3 nói trong shot 8 s, thoại tối đa 15 âm tiết mỗi shot (tập 1: 480 từ); sẽ đo lại sau tập đầu.
- **Mở đầu:** nêu câu hỏi và lời hứa trong 30 giây đầu.
- **Giữ chân:** khoảng 60-90 giây có một cú kéo mới, ví dụ đổi bối cảnh, kết quả ngược dự đoán, một bên thua cãi.
- **Kết:** trò đùa quay lại từ đầu tập, không kết bằng tóm tắt khô.
- **Khác tập trước:** đổi thứ tự cãi nhau, ai thắng, bối cảnh và trò đùa. YouTube cấm nội dung theo khuôn lặp lại.

## Phân vai

- **Einstein nói kiến thức hiện đại, Newton nói khoa học cổ điển.** Không đổi vai, trừ khi nhân vật đang trích lại lời bên kia để cãi.
- **Không ai ngốc.** Khoa học cổ điển sai ở đâu thì nói đúng phạm vi đó; nơi nó vẫn đúng thì phải nhận là đúng.
- **Xen kẽ lời.** Không để một người nói quá 2 shot liền nếu không có lý do; người nghe vẫn phản ứng.

## Bối cảnh minh hoạ

- Bối cảnh phải khớp điều đang nói ngay lúc đó. Ghi lý do chọn trong cột Bối cảnh nếu không hiển nhiên.
- Đổi bối cảnh bằng cú cắt giữa hai chain, không chuyển trong một shot. Có thể đùa về việc đổi cảnh.
- Địa điểm mới khi lời cần và bible chưa có: thêm vào bible và `image_prompts.json` (không tái dùng phông cũ chỉ vì tiện). Mỗi địa điểm đủ phông cho các góc dùng (`front`, `low`, `high`).
- **Bối cảnh chỉ là phông nền.** Không yêu cầu H3 diễn thí nghiệm hay chuyển động cần đúng vật lý. Không có chữ, sơ đồ, công thức, đồ thị.
- Chi tiết nguy hiểm thật (không có không khí, nhiệt độ) phải được thoại đùa tới, để không ai tưởng thật.
- Đạo cụ giữ đơn giản và cố định. Mặc định chỉ có quả táo Newton cầm.

## Science humor

- **Trò đùa đến từ khoa học hoặc từ cuộc cãi nhau.** Nó dẫn tới ý khoa học hoặc đến từ chính ý đó.
- **Không có đoạn dài thiếu trò đùa:** mỗi 30-45 giây có ít nhất một nhịp hài.
- **Không giải thích trò đùa.** Để phản ứng im lặng của người nghe sau câu chốt.
- **Phóng đại phải nhận ra được là phóng đại.** Nếu người xem có thể tin là thật, phải đính chính ngay trong tập.
- **Nguồn:** mỗi tuyên bố khoa học có mã nguồn. Điều còn tranh cãi phải nói là còn tranh cãi. Ngoặc kép chỉ dành cho câu nói có nguồn thật.
- **Ghi công:** mỗi người chỉ nhận công việc có nguồn xác nhận là của chính mình, nói ở ngôi thứ nhất; việc của người khác thì nói đúng tên người đó. Không bịa công trạng.
- **Tiếng Anh tự nhiên:** dùng dạng rút gọn như nói thật ("isn't", "I'm"). Tránh chơi chữ mà bạn không chắc. Đánh dấu cụm dễ sai sắc thái.
- **Không dùng** y tế, pháp lý, tài chính, chính trị làm nội dung tư vấn từ nhân vật AI.

## Nhân vật

Chép nguyên văn khối "Mô tả ngắn trong prompt H3" của series bible vào mọi shot có mặt mỗi người. Không chép khối "dùng cho prompt sheet" (có tên người thật).

- **Hai nhân vật là Albert Einstein và Isaac Newton thật**, gặp nhau qua wormhole (hư cấu rõ ràng): không tên giả, không giả vờ là người khác. Mỗi người nói về công trình của mình bằng ngôi thứ nhất ("I settled it, with an apple"), và chỉ nói điều có trong nguồn của tập.
- **Không bịa lời của người thật:** ngoặc kép chỉ dành cho câu có nguồn thật; không đặt vào miệng họ chuyện đời tư, quan điểm chính trị, tôn giáo hay phát ngôn ngoài khoa học; điều họ không thể biết lúc còn sống (Einstein và sóng hấp dẫn, Apollo) nói như người đến từ tương lai. Tránh hình ảnh sáo gắn với Einstein: lè lưỡi, tẩu thuốc, bảng E=mc².
- **Tên trong tiêu đề, thumbnail, tên kênh, mô tả:** dùng tên thật cần rà quyền trước (Einstein có chủ thể quyền thực thi, xem `risks.md`); không đặt trước khi rà.
- **Tên trong phần tả cảnh H3:** dùng mô tả ngoại hình của bible và sheet; tên Newton, Einstein, Galileo nằm trong `<d>`, tiêu đề và metadata. Đặt tên thật trong phần tả cảnh chưa kiểm trên H3 (có thể bị lọc nội dung): chỉ thêm sau khi chạy thử một chain.

## Quy tắc H3 (từng gây lỗi thật)

- **Gắn giọng vào tên:** `Tên (S1) says in a warm, amused voice, the voice in <Audio 1>: <d>[English] ...</d>`, không viết `a man (S1)`. Khi có 2 người, "a man" khiến model gán lời nhầm người.
- **Mỗi shot chỉ một người nói,** nêu tên ngay trong mệnh đề. Người còn lại ghi "stays silent with closed lips" và đang làm gì.
- **Vị trí trái/phải nêu rõ ở mọi shot,** không đổi trong một bối cảnh: Einstein ở phần ba bên trái, Newton ở phần ba bên phải, cùng cỡ, cùng độ sâu, đúng tỉ lệ với bối cảnh.
- **Không để mặt quay nghiêng:** đứng ba phần tư về phía nhau và về phía máy. Viết "face each other" đơn thuần sẽ ra hai mặt nghiêng, khó khớp môi. Người đang nói không quay đi chỗ khác; nhìn bối cảnh thì làm trước khi nói.
- **Tay gần máy:** Einstein cử chỉ bằng tay phải, Newton cầm táo bằng tay trái, để không bị thân che.
- **Ánh sáng theo ảnh phông thật:** viết câu relight trong prompt K0 và chain theo hướng ánh sáng và bóng đổ nhìn thấy trong ảnh phông (nắng thấp phía sau hay bên hông thì ghi đúng như vậy), kèm ánh sáng bù mềm trên mặt để mặt không tối; không ghi "nắng sau máy" nếu ảnh phông không như vậy.
- **Mô tả chép nguyên văn ở mọi shot:** câu mô tả ngắn của từng người trong series bible (ảnh sheet mang phần còn lại), bối cảnh, ánh sáng, vật cố định. Shot sinh độc lập, không nhớ shot trước. Không viết "the same man", "him", "as before".
- **Một shot một sự kiện liên tục,** không cắt cảnh, tối đa một chuyển động camera. Đổi góc máy là chain mới.
- **Tính thoại trước khi viết:** đếm âm tiết của từng `<d>`, chia cho số giây nói, phải ≤ 3 âm tiết/giây. Thoại bắt đầu từ 1.0 s (1.75 s nếu hai người đi vào khung) và kết thúc khoảng 1,7 s trước cuối shot 8 s. Bài thử ep01 đo được H3 nói một câu 14 âm tiết trong khoảng 3,3 s dù prompt cho nhiều hơn.
- **Chặn lời thừa sau câu thoại:** H3 đã tự nói thêm trong đoạn trống cuối shot (ep01, 2026-11-05, đoạn trống 1,5-3 s). Shot có thoại luôn từ 192 khung (8 s): generator ghi rằng ngắn hơn thì mối nối bị clip. Sau mỗi `<d>` chép câu chính thức "Exactly as the voice stops, the lips close and the jaw ceases all speaking motion. This single line is the only speech in the video." **Nghi ngờ chưa kiểm chứng:** ở bài thử trọng lực, đuôi hai shot bắt đầu bằng "Exactly ..." (có thể H3 đọc to câu này); thử một shot không có câu đó để so. Sau mốc "finishes" ghi rõ cả hai im lặng, ngậm miệng tới khung cuối. Cách này chưa kiểm chứng; nghe lại audio sau khi sinh.
- **Người và vật ở xa trong phông** (Adam và Eve, phi hành gia, cờ): `subject_definitions` nêu rõ họ là phông không tên, không nói, không nhìn máy; chỉ có hai nhân vật chính.
- **Mốc giây tăng dần,** không vượt thời lượng, mỗi 1-2 s có một thay đổi nhìn thấy được.
- **Hành vi quan sát được:** "lifts one eyebrow, lips pressed", không phải "looks amused". Mỗi shot tối đa một lần đổi cảm xúc.
- **Từ cấm:** "slowly", "the same ... as before".
- **Kết shot** là tư thế tĩnh rõ ràng, không dùng "continues" hay "keeps".
- **Thoại đang nói không kèm hành động miệng:** "lips pressed", "smiles" chỉ đặt sau mốc "finishes", nếu không dễ hỏng khớp môi.
- **Thoại nguyên văn** trong `<d>[English] ...</d>`, không dấu nháy kép bọc ngoài.
- **Dòng cuối phần mô tả** (shot `static` dùng câu giữ khung; shot có chuyển động thì thay câu giữ khung bằng câu tả chuyển động và điểm cuối của nó, mẫu trong skill `longform-camera-angles`): "The camera holds this framing until the final frame. All motion happens at natural real-time speed, not slow motion. There are no subtitles, captions, on-screen text, logos or watermarks anywhere in frame."
- **Thương hiệu:** không nêu thương hiệu trong phần tả cảnh. Tên người thật chỉ theo mục "Tên trong phần tả cảnh H3" ở trên.

## Khung 16:9

- Dòng phong cách ghi "horizontal 16:9 framing". `aspect_ratio` bắt buộc là `"16:9"`.
- **Góc, cỡ khung và chuyển động từng shot theo mục Storyboard** (skill `longform-camera-angles`). Hai người nhìn nhau, không nhìn ống kính, trừ khi trò đùa cần.
- **Chừa đầu và chân khung:** bản 1344×768 bị cắt khoảng 1% trên và dưới khi về đúng 16:9. Đỉnh đầu, kể cả tóc giả, không sát mép.
- **Âm nhạc:** `non_diegetic_music:` luôn là `N/A`. Nhạc thêm lúc dựng, vì nhạc sinh riêng từng shot sẽ lộ khi cắt.

## Ảnh

- Sheet nhân vật (một người, 2 góc cạnh nhau, nền xám) và ảnh nền trống (mặt đất phía trước để trống). Mỗi địa điểm có phông `front` và thêm `_low`/`_high` khi dùng góc thấp/cao; chain dùng phông đúng loại góc của K0.
- Keyframe storyboard: skill `script-to-qwen-storyboard`. Mọi prompt Qwen-Image soạn và review bằng `qwen-image-prompting`.

## Bảng tự kiểm (trả lời từng dòng trước khi báo xong)

1. Tổng thời lượng ___, số từ ___, Einstein ___, Newton ___?
2. Câu hỏi và lời hứa nằm trong 30 giây đầu? Các cú kéo ở mốc nào? Trò đùa cuối quay lại từ đâu?
3. Cấu trúc và trò đùa có trùng tập trước không?
4. Mỗi tuyên bố có mã nguồn? Điều gì còn tranh cãi đã nói rõ? Phạm vi đúng của khoa học cổ điển đã nói rõ?
5. Einstein chỉ nói phần hiện đại, Newton chỉ nói phần cổ điển? Mỗi người chỉ nhận công việc có nguồn là của mình? Có câu nào đặt vào miệng người thật điều không có nguồn, chuyện đời tư hay quan điểm ngoài khoa học không?
6. Mỗi bối cảnh khớp lời? Có yêu cầu H3 diễn vật lý, chữ hay sơ đồ không?
7. Mỗi `<d>`: ___ âm tiết / ___ s = ___ (≤ 3)? Bắt đầu ≥ 1.0 s, kết thúc khoảng 1,7 s trước cuối shot, có câu lip-close sau `<d>`?
8. Có "slowly", "same ... as before" không? (grep)
9. Mô tả nhân vật, bối cảnh, vị trí trái/phải giống hệt ở mọi shot cùng bối cảnh? Mỗi shot chỉ một người nói?
10. Mốc giây tăng dần, trong thời lượng shot?
11. `aspect_ratio` là `"16:9"`, `non_diegetic_music` là `N/A`, đủ 6 mục và các dòng cuối shot?
12. Mỗi chain có `voice_refs` đúng thứ tự, `reference_images`, khung đầu là keyframe đã duyệt, và số `<Picture N>` khớp?
13. Tư thế đầu và cuối, vật cầm, góc, cỡ khung, chuyển động của từng shot khớp dòng Storyboard?
14. Skill `longform-camera-angles`: đủ ≥ 6 setup và ≥ 3 kiểu chuyển động? Mỗi shot tối đa một chuyển động? Hai chain liền nhau không cùng góc và cỡ khung đầu? Mỗi địa điểm có đủ phông cho các góc dùng? Mỗi shot có lý do góc theo lời hoặc trò đùa?

Sau đó chạy `longform-minimax-h3-script-review`.
