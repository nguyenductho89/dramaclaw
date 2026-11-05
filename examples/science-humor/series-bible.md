# Series bible: Science explained with humor

Tên nhân vật và tên kênh dưới đây là đề xuất, chưa kiểm trùng trên YouTube hay về nhãn hiệu.

- **Kênh (đề xuất):** Barnaby Breaks Things
- **Mô tả kênh:** Science explained with humor.
- **Ngôn ngữ:** chỉ tiếng Anh. Khán giả mục tiêu là Mỹ/Anh; xem rủi ro giấy phép trong [risks.md](risks.md).
- **Khổ hình:** 16:9, xuất 1920×1080. Mỗi tập 6-7 phút.

## Nhân vật: Barnaby Quill

Người đàn ông hư cấu 70 tuổi, sống ở thời nay. Từng sửa máy móc cho một xưởng in đã đóng cửa, không có học vị. Ông tò mò, đãng trí, tự tin quá mức, thua thí nghiệm mà vẫn vui. Ông đọc nghiên cứu của người khác rồi tự thử ở nhà, nên luôn ghi công đúng người.

**Khối mô tả, chép nguyên văn vào mọi shot có mặt ông:**

> Barnaby (S1), a cheerful 70-year-old man with messy curly silver-white hair, a clean-shaven round face, thick black square-rimmed glasses, a mustard-yellow wool cardigan over a blue checked shirt, and a stubby pencil tucked behind his right ear

**Giọng:** tiếng Anh dễ nghe, ấm, khô khan, thích thú, âm sắc Anh nhẹ. Tạo giọng mới bằng Qwen3-TTS; không dùng giọng thu âm của người thật.

**Luật ngoại hình và danh tính**
- Ông chỉ gợi không khí của ngoại hình Einstein. Mặt tròn cạo sạch, kính vuông dày và áo vàng là các điểm khác biệt, không bỏ.
- Nếu sheet làm ông giống chân dung Einstein thì sửa sheet.
- Trong truyện, ông không phải Einstein và không phải người quen của Einstein. Không nhắc tới sự giống nhau, không đùa về nó.
- Không dùng tư thế lè lưỡi, phòng cấp bằng sáng chế, bảng E=mc², tẩu thuốc, giọng Đức.
- Tên Einstein chỉ xuất hiện khi ghi công trong nội dung khoa học. Không đặt ở tiêu đề, thumbnail, tên kênh.

**Chi tiết chạy xuyên series (đổi cách dùng mỗi tập)**
- Ông đánh số thí nghiệm: tập 1 là "Experiment one", các tập sau đếm tiếp.
- Cây bút chì sau tai: ông hay tìm nó mà không thấy.
- Chiếc áo cardigan chịu hậu quả của khoa học.

## Bối cảnh

Chép nguyên văn vào mọi shot của cảnh đó.

- **Bếp:** a small modern home kitchen with pale green cabinets on the back wall and a window on the right letting in soft morning daylight
- **Xưởng:** a cluttered modern home workshop with a pegboard of hand tools on the back wall and a bright work lamp on the left

## Hình ảnh

- **Bảng màu minh hoạ (Manim, Three.js):** nền `#1F2A30`, chữ `#F4EFE3`, vàng cardigan `#D9A441`, xanh áo `#5B8DB8`, đỏ cảnh báo `#D1495B`.
- **Font:** IBM Plex Sans.
- **Đo lường:** nói đơn vị mét kèm feet hoặc inch khi con số quan trọng.

## Luật nội dung

- Mỗi tập có một thí nghiệm và một trò đùa mới, và cấu trúc phải khác tập trước.
- Trò đùa đến từ khoa học. Phóng đại phải nhận ra được là phóng đại.
- Mọi tuyên bố có nguồn. Điều còn tranh cãi phải nói là còn tranh cãi.
- Camera cố định, ngang mắt, chưa thử selfie cầm tay.

## Series 1: danh sách tập đã kiểm nguồn (2026-11-05)

Chú thích: **đã đọc** là đã mở tài liệu gốc; **tóm tắt** là mới đọc abstract; **thứ cấp** là chưa đọc nguồn gốc. Viết tập nào phải đọc lại nguồn của tập đó.

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
