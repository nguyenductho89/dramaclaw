# Series bible: Science explained with humor

Hai nhân vật là Albert Einstein (1879-1955) và Isaac Newton (1643-1727), người thật, trong một cuộc trò chuyện hư cấu xuyên thời gian. Tên kênh là đề xuất, chưa rà quyền và nhãn hiệu: dùng tên thật ở tên kênh, tiêu đề hay thumbnail cần rà quyền trước (xem [risks.md](risks.md)).

- **Kênh (đề xuất, chưa rà trùng và nhãn hiệu):** The Wormhole Debate. Không dùng tên người thật làm tên kênh, tiêu đề hay thumbnail trước khi rà quyền (xem [risks.md](risks.md)).
- **Mô tả kênh:** Science explained with humor.
- **Format:** Albert Einstein và Isaac Newton gặp nhau và trò chuyện về khoa học khi dừng chân ở các thời điểm lịch sử khác nhau (quá khứ hoặc tương lai, tuỳ tập; rõ ràng là hư cấu), đi lại bằng một cổng wormhole xuyên thời gian (mục "Cỗ máy wormhole"). Bối cảnh phía sau minh hoạ cho điều họ nói. Không có minh hoạ thí nghiệm, công thức hay voiceover.
- **Ngôn ngữ:** chỉ tiếng Anh. Khán giả mục tiêu là Mỹ/Anh; rủi ro giấy phép trong [risks.md](risks.md).
- **Khổ hình:** 16:9, xuất 1920×1080. H3 render 1344×768, rồi upscale (SeedVR2 1.5x, sau đó Lanczos lên đúng kích thước 2x; không upscale 2x thẳng vì mặt nhỏ bị sinh chi tiết giả). Mỗi tập 6-7 phút (tính cả các đoạn wormhole), khoảng 420-520 từ: shot 8 s, thoại tối đa 15 âm tiết mỗi shot.
- **Đo lường:** nói đơn vị mét kèm feet hoặc inch khi con số quan trọng.

## Phân vai

- **Einstein nói kiến thức hiện đại** (từ khoảng năm 1900 tới nay). Điều xảy ra sau khi ông mất năm 1955 (sóng hấp dẫn được phát hiện, Apollo) ông nói như người đến từ tương lai. **Newton nói khoa học cổ điển** (công trình của chính ông, Galileo và thế kỷ 17-19).
- Họ tranh luận, nhưng không ai là kẻ ngốc: khoa học cổ điển vẫn đúng trong phạm vi của nó, và lời thoại nói rõ phạm vi đó.
- Mỗi người nói về công trình của chính mình bằng ngôi thứ nhất, chỉ điều có nguồn; việc của người khác thì nói đúng tên người đó.
- Là người thật: không bịa đời tư, quan điểm chính trị, tôn giáo hay phát ngôn ngoài khoa học; ngoặc kép chỉ dành cho câu có nguồn thật.

## Nhân vật: Albert Einstein

Trong tập: tò mò, hay đùa, hơi đãng trí (hay tìm cây bút chì), thua cãi mà vẫn vui. Đọc nghiên cứu của người khác nên luôn ghi công đúng người.

**Khối mô tả, dùng cho prompt sheet:**

> Albert Einstein (S1), a cheerful man of about 70: a wild halo of frizzy white hair, a thick white moustache, a weathered round face with deep smile-lines, round wire-rimmed glasses, a mustard-yellow wool cardigan over a blue checked shirt, and a stubby pencil tucked behind his right ear

**Mô tả ngắn trong prompt H3:** a wild halo of frizzy white hair, a thick white moustache, a weathered round face, round wire-rimmed glasses, a mustard-yellow cardigan and a pencil behind his right ear.

**Giọng:** tiếng Anh giọng Mỹ, ấm, khô khan, thích thú, thoải mái; lời thoại dùng cách nói Mỹ ("Nice", "Sure"), không dùng "Lovely", "Quite". Tạo giọng bằng Qwen3-TTS; không nhái hay clone giọng thu âm của người thật. **Quyết định cho tập 1:** giữ giọng Mỹ (Einstein thật nói tiếng Anh giọng Đức; chọn giọng Mỹ để tránh bắt chước giọng ngoại và vì cặp giọng này đã đo: cosine giữa `einstein.wav` và `newton.wav` = 0,662, thấp hơn rõ 0,88-0,90 của phép thử cùng giọng vùng, Resemblyzer, 2026-11-11). Muốn đổi sang giọng Đức phải thiết kế lại giọng và đo lại.

**Ngoại hình và danh tính**
- Sheet dựng bằng Gemini, dùng ảnh thật năm 1921 (Ferdinand Schmutzer, public domain) làm identity reference (`assets/characters/real_refs/SOURCES.md`). Áo cardigan vàng mù tạt và bút chì sau tai là chi tiết riêng của truyện.
- Tránh hình ảnh sáo: lè lưỡi, tẩu thuốc, bảng E=mc².

**Chi tiết chạy xuyên series**
- Cây bút chì sau tai: ông hay tìm nó mà không thấy.
- Mỗi lần xuyên wormhole, Newton luôn nhận mình là người lái cỗ máy, dù chính Einstein mới giữ cho nó chạy được. Einstein không cãi, chỉ lặng lẽ chỉnh lại thứ gì đó trước khi bước qua cổng.

## Nhân vật: Isaac Newton

Trong tập: kiêu hãnh, chính xác, khó chịu vì bị thế kỷ sau sửa lại, nhưng tò mò hơn ông chịu nhận. Nói về công trình của chính mình bằng ngôi thứ nhất.

**Khối mô tả, dùng cho prompt sheet:**

> Isaac Newton (S2), a lean, intent man of about 65: a long narrow face with deep-set eyes, a long wavy grey wig falling past his shoulders, a long dark brown late-17th-century coat with a white linen cravat

**Mô tả ngắn trong prompt H3:** a long wavy grey wig, a long narrow face with deep-set eyes, a long dark brown coat and a white linen cravat.

**Giọng:** tiếng Anh giọng Anh trang trọng (Received Pronunciation), sắc, kiêu hãnh, dứt khoát. Hai giọng phải khác giọng vùng, không chỉ khác tính cách: hai giọng cùng mô tả "giọng Anh" nghe như một (Resemblyzer, cùng người 0,90, khác người 0,88). Tạo giọng bằng Qwen3-TTS; không nhái hay clone giọng thu âm của người thật.

**Ngoại hình:** sheet dùng chân dung Godfrey Kneller 1689 (public domain) làm identity reference cho khuôn mặt; hình ảnh ở tuổi khoảng 65, trang phục thế kỷ 17 (Newton lúc 46 tuổi trong chân dung).

**Chi tiết chạy xuyên series:** luôn cầm một quả táo đỏ bằng tay trái, và luôn giành phần công cho khoa học cổ điển ("you're welcome").

## Cỗ máy wormhole

Hai ông đi giữa các thời điểm bằng một cổng wormhole xuyên thời gian có thể đi qua được. Không giải thích nguồn gốc hay cách chế tạo: chỉ cần người xem hiểu đây là cách họ di chuyển.

**Khối mô tả, dùng lại nguyên văn mỗi lần nhắc tới cổng:**

> a swirling, glowing circular wormhole portal hanging in mid-air, rimmed with blue-violet light, a tunnel of light and stars receding into its center

**Cảnh chuyển cảnh** giữa hai bối cảnh trong cùng một tập: hai ông nắm tay nhau, bước vào cổng, rồi xuất hiện ở bối cảnh tiếp theo. Dựng bằng ffmpeg trên ảnh tĩnh, không qua H3 (`tools/make_ken_burns_transition.py`, ảnh `assets/transition/wormhole_flight.png`), nên không tính vào luật camera của shot H3.

## Bối cảnh

Mỗi tập chọn bối cảnh minh hoạ cho điều đang nói, ở một thời điểm cụ thể mà wormhole đưa họ tới. Bối cảnh phi thực tế là trò đùa: hai ông xuất hiện ở đó trong trang phục thường ngày. Khi một chi tiết nguy hiểm thật (không có không khí trên Mặt Trăng), lời thoại đùa về nó để không ai tưởng thật.

**Vị trí đứng (mọi keyframe và shot):** Einstein ở phần ba bên trái, Newton ở phần ba bên phải, cùng cỡ và cùng độ sâu, quay ba phần tư về phía nhau và về phía máy, không đổi chỗ. Cách đứng này giữ mặt không quay nghiêng, bút chì sau tai phải của Einstein không bị khuất, và Newton cầm táo bằng tay trái, phía gần máy. Ánh sáng theo ảnh phông thật (vườn: nắng vàng thấp từ phía sau tán cây; Mặt Trăng: nắng trắng thấp, bóng đổ dài sang trái và về phía máy); prompt relight viết đúng như ảnh và thêm ánh sáng bù mềm trên mặt để hai mặt không tối.

**Luật chiếu sáng keyframe:** sheet nhân vật chụp kiểu studio (nền xám, ánh sáng đều), nên mọi prompt compose phải nêu rõ cả ba điều: (1) chiếu sáng lại nhân vật theo hướng và tông màu ảnh nền, (2) bóng đổ dưới chân khớp bóng trong ảnh nền, (3) một phần cảnh tiền cảnh che nhẹ chân hoặc ống quần.

**Phông nền chuyển động:** người và vật thêm vào ở xa là phông nền chuyển động nhẹ, lặp lại, mờ, không phải nhân vật thứ ba (không nói, không có `<Subject N>`). Chúng không ảnh hưởng luật "chỉ hai người nói".

**Bối cảnh đã có** (prompt ảnh nền ở `ep01/image_prompts.json`, ảnh ở `ep01/backgrounds/`):
- **Vườn Địa Đàng:** Cây Tri Thức giữa nền, trĩu táo đỏ, một con rắn cuộn quanh cành thấp. Xa phía sau, hai bóng người nhỏ, mờ (gợi ý Adam và Eva): người nữ hái táo đưa cho người nam, người nam cắn một miếng, lặp vòng. Nắng vàng chiều tà.
- **Mặt Trăng, bãi đáp Apollo 11 (1969)** (thoại ep01 nhắc thí nghiệm búa và lông vũ của Apollo 15 như một sự kiện lịch sử, không phải ở địa điểm này): bề mặt xám, bầu trời đen, Trái Đất nhỏ ở xa, cờ Mỹ trên nền đất, mô-đun đổ bộ gần đó, một phi hành gia vô danh (mặt khuất sau tấm che vàng) đi bước nhảy chậm quanh mô-đun, thỉnh thoảng cúi nhặt đá. Nắng trắng lạnh, im lặng tuyệt đối (đúng khoa học: không có khí quyển).

- **Vách núi nhìn ra đường chân trời Trái Đất lúc hoàng hôn** (quỹ đạo, khẩu pháo của Newton, ep01): mỏm đá trống ở tiền cảnh, đường chân trời cong và biển mây thấp ở xa, một khẩu pháo gang cũ nhỏ, mờ, ở mép trái xa. Nắng cam thấp.
- **Không gian sâu cạnh cặp sao xung** (sóng hấp dẫn, ep01): mặt đá xám phẳng ở tiền cảnh, bầu trời đen đầy sao, hai ngôi sao sáng xoắn quanh nhau ở xa. Không có sơ đồ hay vòng sóng vẽ trên nền.

**Phông theo góc:** mỗi địa điểm có phông `front` (ngang mắt) tên `<địa điểm>`, và thêm `<địa điểm>_low`, `<địa điểm>_high` khi có góc thấp hoặc cao (`ep01/image_prompts.json`). Chọn góc và phông bằng skill `longform-camera-angles`.

Bối cảnh chỉ là phông nền; điều cần chính xác nằm ở lời thoại có nguồn. Không yêu cầu H3 diễn thí nghiệm, chuyển động vật lý, chữ, sơ đồ hay công thức.

## Camera, góc quay và phông

Góc quay, chuyển động camera và phông từng chain chọn bằng skill `longform-camera-angles` (danh mục góc, chuyển động, luật hướng màn hình); mỗi shot ghi góc, cỡ khung, chuyển động và lý do ở mục `## Storyboard` của kịch bản tập. Nguồn tham khảo: `video_production_with_skills/camera-research.md`.

## Luật nội dung

- Mỗi tập có câu hỏi, bối cảnh và trò đùa mới; cấu trúc khác tập trước.
- Trò đùa đến từ khoa học hoặc từ cuộc cãi nhau giữa cổ điển và hiện đại. Phóng đại phải nhận ra được là phóng đại.
- Mọi tuyên bố có nguồn. Điều còn tranh cãi phải nói là còn tranh cãi.

## Series 1: cổ điển và hiện đại (nháp, nguồn chưa kiểm)

Viết tập nào phải đọc nguồn của tập đó.

| Tập | Câu hỏi | Newton (cổ điển) | Einstein (hiện đại) | Bối cảnh |
|---|---|---|---|---|
| 1 | What is gravity, really? | Lực hấp dẫn | Không-thời gian cong | Vườn Địa Đàng, Mặt Trăng |
| 2 | What is light made of? | Lăng kính, hạt ánh sáng | Photon, lưỡng tính | Phòng tối có lăng kính, cạnh một ngôi sao |
| 3 | Is time the same for everyone? | Thời gian tuyệt đối | Tương đối, GPS | Tháp đồng hồ cổ, quỹ đạo Trái Đất |
| 4 | Is empty space really empty? | Không gian tuyệt đối | Vũ trụ giãn nở | Đài thiên văn, không gian sâu |
| 5 | What is everything made of? | Hạt cứng | Lượng tử | Phòng giả kim, phông trừu tượng |
| 6 | Why do tides happen? | Lực của Mặt Trăng | Mô hình hiện đại | Bờ biển, nhìn từ quỹ đạo |
| 7 | Why did Mercury break the rules? | Quỹ đạo | Thuyết tương đối rộng | Hệ Mặt Trời |
| 8 | How fast is sound? | Newton tính thiếu | Giải thích đúng | Cánh đồng đại bác |
| 9 | Do black holes exist? | "Sao tối" của Michell, 1783 | Lỗ đen | Thư viện, gần lỗ đen |
| 10 | What did Newton get right? | Vẫn đủ cho nhiều chuyến bay vũ trụ | Giới hạn của lý thuyết | Bệ phóng, Mặt Trăng |
