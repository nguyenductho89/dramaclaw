# Series bible: Science explained with humor

Tên nhân vật và tên kênh là đề xuất, chưa kiểm trùng trên YouTube hay về nhãn hiệu.

- **Kênh (đề xuất):** Barnaby and Ambrose
- **Mô tả kênh:** Science explained with humor.
- **Format:** hai nhà du hành thời gian trò chuyện về khoa học khi dừng chân ở các thời điểm lịch sử khác nhau (quá khứ hoặc tương lai, tuỳ tập), đi lại bằng một cổng wormhole xuyên thời gian (mục "Cỗ máy wormhole"). Bối cảnh phía sau minh hoạ cho điều họ nói. Không có minh hoạ thí nghiệm, công thức hay voiceover.
- **Ngôn ngữ:** chỉ tiếng Anh. Khán giả mục tiêu là Mỹ/Anh; rủi ro giấy phép trong [risks.md](risks.md).
- **Khổ hình:** 16:9, xuất 1920×1080. Mỗi tập 6-7 phút, khoảng 550-700 từ.
- **Đo lường:** nói đơn vị mét kèm feet hoặc inch khi con số quan trọng.

## Phân vai

- **Barnaby nói kiến thức hiện đại** (từ khoảng năm 1900 tới nay). **Ambrose nói khoa học cổ điển** (Galileo, Newton và thế kỷ 17-19).
- Họ tranh luận, nhưng không ai là kẻ ngốc: khoa học cổ điển vẫn đúng trong phạm vi của nó, và lời thoại nói rõ phạm vi đó.
- Không ai tự nhận công. Cả hai nhắc đúng tên người phát hiện.

## Nhân vật: Barnaby Quill

Người đàn ông hư cấu 70 tuổi, sống ở thời nay. Từng sửa máy móc cho một xưởng in đã đóng cửa, không có học vị. Tò mò, đãng trí, tự tin quá mức, thua cãi mà vẫn vui. Đọc nghiên cứu của người khác nên luôn ghi công đúng người.

**Khối mô tả, dùng cho prompt sheet:**

> Barnaby (S1), a cheerful 70-year-old man closely resembling Albert Einstein: a wild halo of frizzy white hair, a thick white moustache, a weathered round face with deep smile-lines, round wire-rimmed glasses, a mustard-yellow wool cardigan over a blue checked shirt, and a stubby pencil tucked behind his right ear

**Mô tả ngắn trong prompt H3:** a wild halo of frizzy white hair, a thick white moustache, a weathered round face, round wire-rimmed glasses, a mustard-yellow cardigan and a pencil behind his right ear.

**Giọng:** tiếng Anh giọng Mỹ, ấm, khô khan, thích thú, thoải mái. Lời thoại dùng cách nói Mỹ ("Nice", "Sure"), không dùng "Lovely", "Quite". Tạo giọng bằng Qwen3-TTS; không dùng giọng thu âm của người thật.

**Ngoại hình và danh tính**
- Ông cố tình giống hẳn Albert Einstein. Sheet dựng bằng Gemini, dùng ảnh thật năm 1921 (Ferdinand Schmutzer, public domain) làm identity reference (`assets/characters/real_refs/SOURCES.md`). Áo cardigan vàng mù tạt và bút chì sau tai là chi tiết riêng của Barnaby.
- Trong truyện ông không phải Einstein và không phải người quen của Einstein: không có lời thoại nào tự nhận là ông, họ hàng hay Einstein đổi tên. Không nhắc tới sự giống nhau, không đùa về nó.
- Không dùng tư thế lè lưỡi, phòng cấp bằng sáng chế, bảng E=mc², tẩu thuốc, giọng Đức.
- Tên Einstein chỉ xuất hiện khi ghi công trong nội dung khoa học, không đặt ở tiêu đề, thumbnail, tên kênh (xem `risks.md`).

**Chi tiết chạy xuyên series**
- Cây bút chì sau tai: ông hay tìm nó mà không thấy.
- Mỗi lần xuyên wormhole, Ambrose luôn nhận mình là người lái cỗ máy, dù chính Barnaby mới giữ cho nó chạy được (nghề sửa máy cũ). Barnaby không cãi, chỉ lặng lẽ chỉnh lại thứ gì đó trước khi bước qua cổng.

## Nhân vật: Ambrose Whitlock

Người đàn ông hư cấu, tên tạm, chưa kiểm trùng. Kiêu hãnh, chính xác, khó chịu vì bị thế kỷ sau sửa lại, nhưng tò mò hơn ông chịu nhận. Nhắc Newton bằng tên như một người hâm mộ cuồng nhiệt, không tự nhận phát hiện của Newton.

**Khối mô tả, dùng cho prompt sheet:**

> Ambrose (S2), a lean, intent 65-year-old man closely resembling the young Isaac Newton: a long narrow face with deep-set eyes, a long wavy grey wig falling past his shoulders, a long dark brown late-17th-century coat with a white linen cravat

**Mô tả ngắn trong prompt H3:** a long wavy grey wig, a long narrow face with deep-set eyes, a long dark brown coat and a white linen cravat.

**Giọng:** tiếng Anh giọng Anh trang trọng (Received Pronunciation), sắc, kiêu hãnh, dứt khoát. Hai giọng phải khác giọng vùng, không chỉ khác tính cách: hai giọng cùng mô tả "giọng Anh" nghe như một (Resemblyzer, cùng người 0,90, khác người 0,88). Tạo giọng bằng Qwen3-TTS; không dùng giọng thu âm của người thật.

**Ngoại hình:** giống hẳn Isaac Newton; sheet dùng chân dung Godfrey Kneller 1689 (public domain) làm identity reference. Trang phục thế kỷ 17.

**Chi tiết chạy xuyên series:** luôn cầm một quả táo đỏ bằng tay trái, và luôn giành phần công cho khoa học cổ điển ("you're welcome").

## Cỗ máy wormhole

Hai ông đi giữa các thời điểm bằng một cổng wormhole xuyên thời gian có thể đi qua được. Không giải thích nguồn gốc hay cách chế tạo: chỉ cần người xem hiểu đây là cách họ di chuyển.

**Khối mô tả, dùng lại nguyên văn mỗi lần nhắc tới cổng:**

> a swirling, glowing circular wormhole portal hanging in mid-air, rimmed with blue-violet light, a tunnel of light and stars receding into its center

**Cảnh chuyển cảnh** giữa hai bối cảnh trong cùng một tập: hai ông nắm tay nhau, bước vào cổng, rồi xuất hiện ở bối cảnh tiếp theo. Dựng bằng ffmpeg trên ảnh tĩnh, không qua H3 (`tools/make_ken_burns_transition.py`, ảnh `assets/transition/wormhole_flight.png`), nên không tính vào luật camera của shot H3.

## Bối cảnh

Mỗi tập chọn bối cảnh minh hoạ cho điều đang nói, ở một thời điểm cụ thể mà wormhole đưa họ tới. Bối cảnh phi thực tế là trò đùa: hai ông xuất hiện ở đó trong trang phục thường ngày. Khi một chi tiết nguy hiểm thật (không có không khí trên Mặt Trăng), lời thoại đùa về nó để không ai tưởng thật.

**Vị trí đứng (mọi keyframe và shot):** Barnaby ở phần ba bên trái, Ambrose ở phần ba bên phải, cùng cỡ và cùng độ sâu, quay ba phần tư về phía nhau và về phía máy, không đổi chỗ. Cách đứng này giữ mặt không quay nghiêng, bút chì sau tai phải của Barnaby không bị khuất, và Ambrose cầm táo bằng tay trái, phía gần máy. Nắng đặt sau máy, hơi lệch trái, để hai mặt đều sáng.

**Luật chiếu sáng keyframe:** sheet nhân vật chụp kiểu studio (nền xám, ánh sáng đều), nên mọi prompt compose phải nêu rõ cả ba điều: (1) chiếu sáng lại nhân vật theo hướng và tông màu ảnh nền, (2) bóng đổ dưới chân khớp bóng trong ảnh nền, (3) một phần cảnh tiền cảnh che nhẹ chân hoặc ống quần.

**Phông nền chuyển động:** người và vật thêm vào ở xa là phông nền chuyển động nhẹ, lặp lại, mờ, không phải nhân vật thứ ba (không nói, không có `<Subject N>`). Chúng không ảnh hưởng luật "chỉ hai người nói".

**Bối cảnh đã có** (prompt ảnh nền ở `ep01/image_prompts.json`, ảnh ở `ep01/backgrounds/`):
- **Vườn Địa Đàng:** Cây Tri Thức giữa nền, trĩu táo đỏ, một con rắn cuộn quanh cành thấp. Xa phía sau, hai bóng người nhỏ, mờ (gợi ý Adam và Eva): người nữ hái táo đưa cho người nam, người nam cắn một miếng, lặp vòng. Nắng vàng chiều tà.
- **Mặt Trăng, bãi đáp Apollo 11 (1969):** bề mặt xám, bầu trời đen, Trái Đất nhỏ ở xa, cờ Mỹ trên nền đất, mô-đun đổ bộ gần đó, một phi hành gia vô danh (mặt khuất sau tấm che vàng) đi bước nhảy chậm quanh mô-đun, thỉnh thoảng cúi nhặt đá. Nắng trắng lạnh, im lặng tuyệt đối (đúng khoa học: không có khí quyển).

Bối cảnh chỉ là phông nền; điều cần chính xác nằm ở lời thoại có nguồn. Không yêu cầu H3 diễn thí nghiệm, chuyển động vật lý, chữ, sơ đồ hay công thức.

## Camera và cỡ khung

- Camera ngang mắt, cố định. Mỗi shot có cỡ khung đầu và cỡ khung cuối ghi ở mục `## Storyboard` của kịch bản tập: `wide` (thấy trọn từ đầu tới chân), `medium` (từ giữa đùi trở lên), `close` (từ dưới eo trở lên).
- Shot có hai cỡ khác nhau thì máy chỉ tiến thẳng (push-in) tới cỡ khung cuối; không pan, arc hay handheld.
- Cỡ khung đầu shot sau bằng cỡ khung cuối shot trước.

## Luật nội dung

- Mỗi tập có câu hỏi, bối cảnh và trò đùa mới; cấu trúc khác tập trước.
- Trò đùa đến từ khoa học hoặc từ cuộc cãi nhau giữa cổ điển và hiện đại. Phóng đại phải nhận ra được là phóng đại.
- Mọi tuyên bố có nguồn. Điều còn tranh cãi phải nói là còn tranh cãi.

## Series 1: cổ điển và hiện đại (nháp, nguồn chưa kiểm)

Viết tập nào phải đọc nguồn của tập đó.

| Tập | Câu hỏi | Ambrose (cổ điển) | Barnaby (hiện đại) | Bối cảnh |
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
