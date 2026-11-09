# Series bible: Science explained with humor

Tên nhân vật và tên kênh dưới đây là đề xuất, chưa kiểm trùng trên YouTube hay về nhãn hiệu.

- **Kênh (đề xuất):** Barnaby and Ambrose
- **Mô tả kênh:** Science explained with humor.
- **Format (đổi 2026-11-09, lần 2 trong ngày):** hai nhà du hành thời gian trò chuyện về khoa học khi dừng chân ở các thời điểm lịch sử khác nhau (quá khứ hoặc tương lai, tuỳ tập), đi lại bằng một **cỗ máy wormhole xuyên thời gian** — xem mục "Cỗ máy wormhole" bên dưới. Bối cảnh phía sau minh hoạ cho điều họ nói. Không có minh hoạ thí nghiệm hay công thức, không có voiceover.
- **Đổi so với format cũ (2026-11-05 → 2026-11-09):** trước đây hai ông chỉ "tự nhiên xuất hiện", không giải thích, không thấy lạ — trò đùa nằm ở việc họ thản nhiên trước hoàn cảnh phi lý. Nay đổi sang có cơ chế rõ ràng (wormhole): trò đùa chuyển sang độ hoành tráng/buồn cười của cảnh bay qua cổng, và vào ai mới thực sự "lái" được cỗ máy (xem chi tiết chạy xuyên series của Barnaby).
- **Ngôn ngữ:** chỉ tiếng Anh. Khán giả mục tiêu là Mỹ/Anh; xem rủi ro giấy phép trong [risks.md](risks.md).
- **Khổ hình:** 16:9, xuất 1920×1080. Mỗi tập 6-7 phút, khoảng 550-700 từ (sẽ đo lại).

## Phân vai

- **Barnaby nói kiến thức hiện đại** (từ khoảng năm 1900 tới nay). **Ambrose nói khoa học cổ điển** (Galileo, Newton và thế kỷ 17-19).
- Họ tranh luận, nhưng không ai là kẻ ngốc: khoa học cổ điển vẫn đúng trong phạm vi của nó, và lời thoại phải nói rõ phạm vi đó.
- Không ai tự nhận công. Cả hai nhắc đúng tên người phát hiện.

## Nhân vật: Barnaby Quill

Người đàn ông hư cấu 70 tuổi, sống ở thời nay. Từng sửa máy móc cho một xưởng in đã đóng cửa, không có học vị. Ông tò mò, đãng trí, tự tin quá mức, thua cãi mà vẫn vui. Ông đọc nghiên cứu của người khác, nên luôn ghi công đúng người.

**Khối mô tả, dùng cho prompt sheet:**

> Barnaby (S1), a cheerful 70-year-old man closely resembling Albert Einstein: a wild halo of frizzy white hair, a thick white moustache, a weathered round face with deep smile-lines, round wire-rimmed glasses, a mustard-yellow wool cardigan over a blue checked shirt, and a stubby pencil tucked behind his right ear

**Giọng:** tiếng Anh giọng Mỹ, ấm, khô khan, thích thú, thoải mái (đổi từ giọng Anh nhẹ ngày 2026-11-05 để hai nhân vật khác nhau rõ). Tạo giọng mới bằng Qwen3-TTS; không dùng giọng thu âm của người thật. Lời thoại dùng cách nói Mỹ ("Nice", "Sure"), không dùng "Lovely", "Quite".

**Luật ngoại hình và danh tính (đổi 2026-11-09, theo yêu cầu dùng ảnh thật)**
- Ông **cố tình giống hẳn** Albert Einstein — ngược với luật cũ "chỉ gợi không khí, giữ điểm khác biệt". Sheet dựng bằng Gemini, dùng ảnh thật Einstein năm 1921 (Ferdinand Schmutzer, public domain) làm identity reference; xem `character/real_refs/SOURCES.md`. Áo cardigan vàng mù tạt và bút chì sau tai là chi tiết riêng của Barnaby, không đổi.
- Trong truyện, ông vẫn **không phải Einstein** và không phải người quen của Einstein — không có lời thoại nào tự nhận là ông, họ hàng, hay Einstein đổi tên. Không nhắc tới sự giống nhau, không đùa về nó.
- Không dùng tư thế lè lưỡi, phòng cấp bằng sáng chế, bảng E=mc², tẩu thuốc, giọng Đức.
- Tên Einstein chỉ xuất hiện khi ghi công trong nội dung khoa học. Không đặt ở tiêu đề, thumbnail, tên kênh — **quy tắc này quan trọng hơn trước** vì ngoại hình giờ giống thật; Hebrew University/GreenLight thực thi quyền hình ảnh Einstein tách biệt khỏi bản quyền ảnh đã hết hạn. Rủi ro đã ghi và được người dùng chấp nhận, xem `risks.md`.

**Chi tiết chạy xuyên series (đổi cách dùng mỗi tập)**
- Cây bút chì sau tai: ông hay tìm nó mà không thấy.
- **Đổi 2026-11-09**, thay cho "ông bị lạc giữa các bối cảnh và không thấy có gì lạ": mỗi lần xuyên wormhole, Ambrose luôn nhận mình là người lái cỗ máy, dù chính Barnaby mới là người thực sự giữ cho nó chạy được — bắt nguồn từ nghề sửa máy cũ của ông (xem lý lịch phía trên). Barnaby không cãi lại, chỉ lặng lẽ chỉnh lại thứ gì đó trước khi bước qua cổng.

## Nhân vật: Ambrose Whitlock

Người đàn ông hư cấu, tên tạm, chưa kiểm trùng. **Ngoại hình giống hẳn Isaac Newton (đổi 2026-11-09, theo yêu cầu dùng ảnh thật)** — sheet dựng bằng Gemini, dùng chân dung Godfrey Kneller 1689 (Newton 46 tuổi, public domain) làm identity reference; xem `character/real_refs/SOURCES.md`. Mặc trang phục cùng kiểu thế kỷ 17. Ông kiêu hãnh, chính xác, khó chịu vì bị thế kỷ sau sửa lại, nhưng tò mò hơn ông chịu nhận. Trong truyện ông không phải Newton: ông nhắc Newton bằng tên, như một người hâm mộ cuồng nhiệt, và không tự nhận phát hiện của Newton. Newton mất năm 1727, chưa ghi nhận ai thực thi quyền hình ảnh cho ông (khác Einstein) — xem `risks.md`.

**Khối mô tả, dùng cho prompt sheet:**

> Ambrose (S2), a lean, intent 65-year-old man closely resembling the young Isaac Newton: a long narrow face with deep-set eyes, a long wavy grey wig falling past his shoulders, a long dark brown late-17th-century coat with a white linen cravat

**Giọng:** tiếng Anh giọng Anh trang trọng (Received Pronunciation), sắc, kiêu hãnh, dứt khoát. Hai giọng khác nhau cả về giọng vùng: Barnaby Mỹ, Ambrose Anh. Đo bằng Resemblyzer ngày 2026-11-05: hai giọng cùng mô tả "giọng Anh" nghe như một (cosine cùng người 0,90, khác người 0,88). Tạo giọng mới bằng Qwen3-TTS; không dùng giọng thu âm của người thật.

**Mô tả ngắn trong prompt H3:** Barnaby: a wild halo of frizzy white hair, a thick white moustache, a weathered round face, round wire-rimmed glasses, a mustard-yellow cardigan and a pencil behind his right ear. Ambrose: a long wavy grey wig, a long narrow face with deep-set eyes, a long dark brown coat and a white linen cravat.

**Chi tiết chạy xuyên series:** ông luôn cầm một quả táo đỏ bằng tay trái, và luôn giành phần công cho khoa học cổ điển ("you're welcome").

## Cỗ máy wormhole (mới 2026-11-09)

Hai ông đi giữa các thời điểm bằng một **cổng wormhole xuyên thời gian có thể đi qua được (traversable wormhole time machine)**: một cổng tròn phát sáng, lơ lửng giữa không trung, viền ánh sáng xanh-tím, một đường hầm ánh sáng và sao cuộn xoáy hút vào tâm. Không giải thích nguồn gốc hay cách chế tạo cỗ máy — đó không phải trọng tâm của chương trình, chỉ cần người xem hiểu đây là cách họ di chuyển.

**Khối mô tả, dùng lại y nguyên mỗi lần nhắc tới cổng:**

> a swirling, glowing circular wormhole portal hanging in mid-air, rimmed with blue-violet light, a tunnel of light and stars receding into its center

**Cảnh chuyển cảnh:** giữa hai bối cảnh trong cùng một tập, hai ông nắm tay nhau, bước vào cổng wormhole, rồi xuất hiện ở bối cảnh tiếp theo. Cảnh này dựng bằng **ffmpeg thuần, không qua H3** (`make_ken_burns_transition.py`, mở rộng 2026-11-09): không vi phạm luật "camera cố định" vì không phải cảnh do H3 sinh — H3 chỉ render hai cảnh trò chuyện tĩnh, đoạn nắm-tay-bay-qua-cổng là hiệu ứng dựng phim trên ảnh tĩnh (xem mục "Bối cảnh" bên dưới cho ảnh nắm tay dùng trong đoạn này).

## Bối cảnh

Mỗi tập chọn bối cảnh minh hoạ cho điều đang nói, ở một thời điểm cụ thể (quá khứ hoặc tương lai) mà wormhole đưa họ tới. Bối cảnh phi thực tế là trò đùa: hai ông xuất hiện ở đó trong trang phục thường ngày, nên người xem nhận ra là hư cấu. Khi một chi tiết nguy hiểm thật (như không có không khí trên Mặt Trăng), lời thoại phải đùa về nó để không ai tưởng thật.

Gemini WebAI tạo ảnh nền trống, sheet nhân vật, và (từ 2026-11-09) storyboard frame — ảnh ghép sẵn hai người vào đúng bố cục cảnh, dùng làm khung đầu cho H3 thay vì chỉ nền trống. `gemini_webai_images.py` tự xoá watermark sparkle hiển thị khỏi mọi ảnh tải về (`remove_watermark()` trong `fit_16x9()`), không cần xử lý tay.

**Luật chiếu sáng storyboard (mới 2026-11-09, sau khi phát hiện ảnh "dán cắt")**: ảnh sheet nhân vật chụp kiểu studio (nền xám, ánh sáng đều) — nếu prompt compose không yêu cầu rõ, Gemini có xu hướng giữ nguyên ánh sáng phẳng đó khi ghép người vào cảnh, tạo cảm giác người bị dán lên nền thay vì đứng trong đó (không bóng đổ dưới chân, tông sáng lệch khỏi nền, không có gì tiền cảnh che chân). Mọi prompt storyboard compose (`storyboard_prompt()` trong `gravity_test/gen_chains.py`) phải luôn yêu cầu rõ cả 3: (1) chiếu sáng lại nhân vật đúng hướng/tông màu ảnh nền, không theo ánh sáng sheet; (2) bóng đổ dưới chân khớp bóng đã có trong ảnh nền; (3) một phần cảnh tiền cảnh che nhẹ chân/ống quần.

Barnaby đứng ở phần ba bên trái, Ambrose ở phần ba bên phải, cùng cỡ và cùng độ sâu, quay ba phần tư về phía nhau và về phía máy. Cách đứng này để mặt không quay nghiêng, bút chì sau tai phải của Barnaby không bị khuất, và Ambrose cầm táo bằng tay trái, phía gần máy. Nắng đặt sau máy, hơi lệch trái, để hai mặt đều sáng. **Khung toàn thân (đổi 2026-11-09, theo yêu cầu):** cả hai thấy trọn từ đầu tới chân, không còn khung nửa người — cỡ cảnh đổi từ "medium two-shot" sang "wide two-shot", chừa khoảng trống cả trên đỉnh đầu lẫn dưới chân.

**Bối cảnh (đổi 2026-11-09, theo yêu cầu dùng cảnh chi tiết hơn, có chuyển động):** hai bối cảnh trống trước đây đổi thành cảnh có chủ đề; người/vật thêm vào là phông nền có chuyển động nhẹ, lặp lại, xa và mờ — không phải nhân vật thứ ba (không nói, không có `<Subject N>` riêng), không ảnh hưởng luật "chỉ hai người nói" trong prompt H3. Chuyển động nền độc lập với hành động của Barnaby/Ambrose ở tiền cảnh, lặp vòng đều trong suốt shot (không cần khớp đầu/cuối giữa các shot như hành động của hai ông).

- **Vườn Địa Đàng** (trước là "vườn táo" trống): Cây Tri Thức giữa nền, trĩu táo đỏ, một con rắn cuộn quanh cành thấp. Xa phía sau, hai bóng người nhỏ, mờ (gợi ý Adam và Eva, che bằng lá và vải) — người nữ hái một quả táo rồi đưa cho người nam, người nam cắn một miếng, lặp lại vòng cử chỉ nhỏ này suốt shot, quá xa để thấy rõ chi tiết hay biểu cảm. Nắng vàng chiều tà như cũ.
- **Mặt Trăng, bãi đáp Apollo 11 1969** (trước là mặt trăng trống): bề mặt xám, bầu trời đen, Trái Đất nhỏ ở xa; cờ Mỹ cắm trên nền đất; mô-đun đổ bộ (lunar module) gần đó; một phi hành gia vô danh (mặt khuất sau tấm che vàng phản chiếu, không giống ai cụ thể) đi bước nhảy chậm kiểu trọng lực yếu quanh mô-đun, thỉnh thoảng cúi nhặt đá — lặp lại suốt shot, quá xa để thấy rõ chi tiết. Giữ nguyên nắng trắng lạnh và sự im lặng tuyệt đối (vẫn đúng khoa học: Mặt Trăng không có khí quyển).

Prompt đầy đủ nằm trong `SCENES` của `gravity_test/gen_chains.py` (field `place`/`plate`/`motion`), không chép lại ở đây để tránh lệch khi sửa. Ảnh "hai ông nắm tay bay qua cổng wormhole" dùng cho đoạn chuyển cảnh (không phải H3, xem mục "Cỗ máy wormhole") nằm ở `gravity_test/transition/`.

Bối cảnh chỉ là phông nền. Điều cần chính xác nằm trong lời thoại có nguồn. Không yêu cầu H3 diễn thí nghiệm, chuyển động vật lý, chữ, sơ đồ hay công thức. **Camera cố định (dưới) áp dụng cho mọi shot do H3 sinh** — đoạn nắm tay bay qua wormhole không phải shot H3, dựng bằng ffmpeg trên ảnh tĩnh nên không tính vào luật này.

## Đo lường

Nói đơn vị mét kèm feet hoặc inch khi con số quan trọng.

## Luật nội dung

- Mỗi tập có câu hỏi, bối cảnh và trò đùa mới, và cấu trúc phải khác tập trước.
- Trò đùa đến từ khoa học hoặc từ cuộc cãi nhau giữa cổ điển và hiện đại. Phóng đại phải nhận ra được là phóng đại.
- Mọi tuyên bố có nguồn. Điều còn tranh cãi phải nói là còn tranh cãi.
- Camera cố định, ngang mắt. **Ngoại lệ đang thử nghiệm (2026-11-09), chỉ riêng bài test gravity, chưa áp dụng toàn series:** mỗi shot có thể đi kèm một chuyển động camera đơn giản (chỉ push-in chậm, không pan/arc/handheld) để nhấn nội dung đang nói — xem `CAMERA`/`_camera_text()` trong `gravity_test/gen_chains.py`. Shot 1 của mỗi chain (đang mang theo hành động vào khung) và 1 nhịp chốt hài vẫn giữ camera tĩnh có chủ đích, không phải bỏ sót.

## Series 1: cổ điển và hiện đại (nháp, nguồn chưa kiểm)

Viết tập nào phải đọc nguồn của tập đó.

| Tập | Câu hỏi | Ambrose (cổ điển) | Barnaby (hiện đại) | Bối cảnh |
|---|---|---|---|---|
| 1 | What is gravity, really? | Lực hấp dẫn | Không-thời gian cong | Vườn táo, Mặt Trăng |
| 2 | What is light made of? | Lăng kính, hạt ánh sáng | Photon, lưỡng tính | Phòng tối có lăng kính, cạnh một ngôi sao |
| 3 | Is time the same for everyone? | Thời gian tuyệt đối | Tương đối, GPS | Tháp đồng hồ cổ, quỹ đạo Trái Đất |
| 4 | Is empty space really empty? | Không gian tuyệt đối | Vũ trụ giãn nở | Đài thiên văn, không gian sâu |
| 5 | What is everything made of? | Hạt cứng | Lượng tử | Phòng giả kim, phông trừu tượng |
| 6 | Why do tides happen? | Lực của Mặt Trăng | Mô hình hiện đại | Bờ biển, nhìn từ quỹ đạo |
| 7 | Why did Mercury break the rules? | Quỹ đạo | Thuyết tương đối rộng | Hệ Mặt Trời |
| 8 | How fast is sound? | Newton tính thiếu | Giải thích đúng | Cánh đồng đại bác |
| 9 | Do black holes exist? | "Sao tối" của Michell, 1783 | Lỗ đen | Thư viện, gần lỗ đen |
| 10 | What did Newton get right? | Vẫn đủ cho nhiều chuyến bay vũ trụ | Giới hạn của lý thuyết | Bệ phóng, Mặt Trăng |

## Kho đề đời thường (format cũ, chưa dùng)

Các đề này viết cho format một người có thí nghiệm. Giữ lại vì nguồn đã kiểm. `ep01-script.md` và thư mục `ep01/` là bài thử của format đó.

Chú thích: **đã đọc** là đã mở tài liệu gốc; **tóm tắt** là mới đọc abstract; **thứ cấp** là chưa đọc nguồn gốc.

| Tập | Tiêu đề nháp | Nói được | Không được nói | Nguồn |
|---|---|---|---|---|
| 1 | Why does toast land butter-side down? | Xem `ep01-script.md` | "Always"; bơ nặng là nguyên nhân | Matthews 1995; Bacon, Heald & James 2001 (đã đọc) |
| 2 | Why does your own voice sound awful on recordings? | Ở 1-2 kHz, âm truyền qua xương chiếm ưu thế với hầu hết âm vị được đo | Con số dB chính xác | [Reinfeldt 2010](https://doi.org/10.1121/1.3458855) (tóm tắt) |
| 3 | Why do you sing better in the shower? | Âm vang làm giọng hoà lẫn; tường đối diện tăng một số bước sóng | "Hay hơn một cách khách quan"; con số 150 Hz | [Deseret 1995](https://www.deseret.com/1995/7/2/19180622/shower-makes-you-sound-like-pavarotti-well-almost) (thứ cấp, chưa có nguồn bình duyệt; thay tập nếu không tìm được) |
| 4 | Why does the shower curtain attack you? | Mô phỏng của Schmidt 2001 cho thấy xoáy do tia nước, Ig Nobel gọi là lời giải một phần | "Đã giải xong"; các giải thích còn tranh cãi | [Scientific American](https://www.scientificamerican.com/article/why-does-the-shower-curta/), [Ig Nobel](https://improbable.com/ig/winners/) (đã đọc; chưa có paper gốc) |
| 5 | Why won't spaghetti break in two? | Sóng uốn gây gãy thêm, thường 3-4 mảnh; xoắn rồi uốn chậm cho 2 mảnh | "Không bao giờ gãy làm đôi" | [Audoly & Neukirch 2005](https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.95.095505) (tóm tắt); [Heisser 2018](https://doi.org/10.1073/pnas.1802831115) (đã đọc) |
| 6 | Why do grapes make plasma in a microwave? | Hai quả cầu chạm nhau tạo điểm nóng do cộng hưởng Mie; nước hạt cũng vậy | Giải thích cũ về cầu nối bằng vỏ; hướng dẫn từng bước | [Khattak 2019](https://doi.org/10.1073/pnas.1818350116) (đã đọc) |
| 7 | Why does coffee leave a ring? | Mép bị ghim, nước bay hơi ở mép được bù từ trong, kéo chất rắn ra ngoài | "Yếu tố duy nhất" | [Deegan 1997](https://doi.org/10.1038/39827) (tóm tắt) |
| 8 | Why do onions make you cry? | Một enzyme riêng tạo chất gây chảy nước mắt; dao sắc tạo ít giọt hơn | Để lạnh giúp đỡ cay; mẹo nước và kính bơi có chứng cứ | [Imai 2002](https://pubmed.ncbi.nlm.nih.gov/12384686/) (chưa đọc được bản đầy đủ); [Wu](https://arxiv.org/abs/2505.06016) (preprint, đã đọc) |
| 9 | How does a cat usually land on its feet? | Hai phần thân uốn mà không xoắn; mô-men động lượng quanh khối tâm vẫn bằng 0 | "Luôn luôn" | [Kane & Scher 1969](https://pentagono.uniandes.edu.co/~jarteaga/geosem/taller7/minicursoJK-Uniandes/robotic%20examples/kane.pdf) (đã đọc) |
| 10 | Why are GPS satellite clocks set wrong on purpose? | Đồng hồ vệ tinh được chỉnh tần số trước khi phóng, tính ra lệch khoảng 38 µs/ngày nếu không chỉnh | "Điện thoại của bạn sửa 38 µs" | [Ashby 2003](https://doi.org/10.12942/lrr-2003-1), [NIST TN 1385](https://nvlpubs.nist.gov/nistpubs/Legacy/TN/nbstechnicalnote1385.pdf) (đã đọc) |

**Đã đổi so với danh sách nháp**
- **Tập 6:** ông không làm thí nghiệm. Trò đùa mới: chủ nhà và công ty bảo hiểm cấm ông đến gần lò vi sóng, nên toàn bộ hiện tượng là hình động. Không có hướng dẫn từng bước. Đây là nhận định của tôi về chính sách YouTube, không phải phán quyết của họ.
- **Tập 10:** đổi đề tài từ đồng hồ điện thoại sang đồng hồ vệ tinh, vì việc chỉnh tần số nằm trên vệ tinh.
- **Tập 1 và 9:** bỏ chữ "always" khỏi tiêu đề.
