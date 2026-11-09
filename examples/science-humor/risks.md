# Rủi ro pháp lý và chính sách

Cập nhật 2026-11-05. Đây không phải tư vấn pháp lý. Nên hỏi luật sư trước khi bật kiếm tiền.

## MiniMax H3: rủi ro lớn nhất, cần bạn quyết lại trước khi đăng

Đã đọc [văn bản license](https://huggingface.co/MiniMaxAI/MiniMax-H3/raw/main/LICENSE) (ngày 2 Aug 2026).

- **Lãnh thổ bị loại:** EU, Anh, Hàn Quốc, Mỹ.
- **§V.4:** cấm dùng, tái tạo, phân phối hoặc trình chiếu kết quả sinh ra ở ngoài lãnh thổ được phép.
- **Xung đột:** khán giả mục tiêu của kênh là Mỹ/Anh, đúng các nơi bị loại. Đăng YouTube toàn cầu là trình chiếu kết quả ở đó. Quyết định "tự chịu rủi ro" trước đây dựa trên nguồn thứ cấp, nên cần được xem lại với văn bản này.
- **Doanh thu trên 20 triệu USD/năm:** cần phép bằng văn bản.
- **Sản phẩm thương mại:** phải hiển thị rõ "MiniMax H3" trên giao diện. Chưa rõ cách áp dụng cho kênh video; tạm ghi trong mô tả.
- **Phụ lục A mục 12:** nội dung công khai phải nói rõ là do máy tạo.
- **Khác:** không dùng kết quả để cải thiện model AI khác. MiniMax không đòi quyền với kết quả.
- **Hướng xử lý cần cân nhắc:** xin license riêng từ MiniMax, chặn theo vùng (gần như bỏ khán giả mục tiêu), hoặc đổi model video cho bản đăng. Thử 60 giây chưa đăng thì chưa trình chiếu kết quả.

Worker đã chạy ở vùng nào thì ghi vào đây:
- 2026-11-05, bài thử 60 giây: pod RunPod `tynnxv04fxmedi`, data center EU-RO-1 (Romania, thuộc EU, nằm trong vùng bị loại). Chạy H3 ở đó cũng có thể vướng license. Bản đăng nên chọn data center ngoài vùng bị loại.

## Các model khác

| Thành phần | Tình trạng | Hành động |
|---|---|---|
| Qwen-Image 2.1 | [License](https://huggingface.co/Qwen/Qwen-Image-2.1/raw/main/LICENSE) chỉ cho nghiên cứu hoặc đánh giá; §2(b) cần license thương mại riêng | **Đã bỏ khỏi luồng gravity test (2026-11-09)**, không dùng cho bản đăng |
| Gemini qua WebAI-to-API (2026-11-09, sheet/plate/storyboard cho gravity test) | Không phải API có hợp đồng — WebAI-to-API lái trình duyệt đăng nhập tài khoản Google cá nhân (`google_webapi`/Playwright), không phải Google AI Studio/Vertex API; chưa đọc điều khoản dịch vụ Gemini web áp dụng thế nào cho việc này. Mọi ảnh ra đều có watermark SynthID (`alt` trả về ghi "watermarked_img_...") | Chỉ dùng cho previs/thử nghiệm cục bộ, chưa phải output dùng để đăng. **Trước khi kiếm tiền phải đổi sang Google AI Studio API trả phí** (`GOOGLE_AI_API_KEY`, selection `google_gemini*` đã sẵn trong app pipeline chính, model `gemini-3.1-flash-lite-image`/`-flash-image`) và đọc kỹ điều khoản thương mại của API đó |
| Qwen Image 3.0 API | [Giá Singapore](https://www.alibabacloud.com/help/en/model-studio/model-pricing): $0,03/ảnh 1K-2K; Pro $0,04 ở 1K, $0,075 ở 2K. [Điều khoản](https://www.alibabacloud.com/help/en/doc-detail/42416.htm) không đòi quyền sở hữu kết quả, nhưng tôi không thấy câu cho phép thương mại rõ ràng; kết quả từ gói dùng thử bị cấm thương mại | Không dùng trong luồng gravity test hiện tại (đã đổi sang Gemini WebAI, xem trên); nếu quay lại dùng thì không dùng gói dùng thử, hỏi Alibaba nếu cần chắc chắn |
| Qwen3-TTS | [Apache 2.0](https://raw.githubusercontent.com/QwenLM/Qwen3-TTS/main/LICENSE); [model card VoiceDesign](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign) gắn apache-2.0 | Dùng được |
| Manim Community | [MIT](https://raw.githubusercontent.com/ManimCommunity/manim/main/LICENSE.community) | Dùng được |

## Einstein

Hebrew University/GreenLight giữ và thực thi quyền về tên, hình ảnh Einstein. Nhân vật hư cấu giảm rủi ro, nhưng không xoá hết. Không dùng tên hay ảnh thật của ông trên merch, quảng cáo, logo, thumbnail. Xem mục nhân vật trong [series-bible.md](series-bible.md).

**Quyết định đổi (2026-11-09, theo yêu cầu người dùng):** Barnaby đổi từ "chỉ gợi không khí, giữ điểm khác biệt bắt buộc" sang **cố tình giống hẳn Einstein**, dùng ảnh thật năm 1921 (Ferdinand Schmutzer, Wikimedia Commons, public domain do tác giả mất 1928) làm identity reference khi dựng sheet bằng Gemini. Đã nêu rõ rủi ro ở trên (quyền hình ảnh Hebrew University/GreenLight tách biệt với bản quyền ảnh, ảnh public domain không xoá rủi ro này) trước khi làm; người dùng xác nhận muốn tiếp tục. Các lớp giảm rủi ro còn lại **vẫn giữ nguyên, quan trọng hơn trước**: nhân vật hư cấu (không tự nhận là Einstein), không dùng tên/ảnh ở tiêu đề/thumbnail/tên kênh/quảng cáo, không đùa về sự giống nhau, nhãn "AI-generated" bật cho mọi tập (xem mục YouTube dưới). Ảnh nguồn + ghi chú: `previs_h3_test/scripts/skits/science_humor/character/real_refs/SOURCES.md`.

## Newton

Ambrose lấy cảm hứng từ Newton và mặc trang phục cùng kiểu. Newton mất năm 1727, nhưng tôi chưa kiểm luật hay thương hiệu nào liên quan tới tên ông.

**Quyết định đổi (2026-11-09):** cùng lúc với Barnaby, Ambrose đổi sang giống hẳn Newton, dùng chân dung Godfrey Kneller 1689 (public domain, tác giả mất 1723) làm identity reference. Rủi ro thấp hơn Einstein rõ rệt (đã mất hơn 100 năm, chưa thấy ai thực thi quyền hình ảnh), nhưng vẫn giữ nguyên tắc: nhân vật hư cấu, không đặt tên Newton ở tên kênh.

## YouTube

- **Nhãn altered/synthetic:** bật cho mọi tập. [Trang trợ giúp](https://support.google.com/youtube/answer/14328491) yêu cầu công bố cảnh thực tế không có thật. Không có ví dụ về người dẫn AI hư cấu; bật là cách đọc an toàn của tôi.
- **Mô tả mọi tập:** "AI-generated fictional characters. Made with MiniMax H3. Sources below."
- **Nội dung lặp lại:** từ 2026-11-05 toàn bộ hình là AI, không còn lớp minh hoạ bằng code tạo khác biệt. Mỗi tập phải đổi câu hỏi, bối cảnh, cấu trúc và trò đùa; cần có kịch bản viết riêng và nguồn rõ. [TechCrunch](https://techcrunch.com/2026/07/20/youtube-clarifies-policies-around-ai-slop-and-upsetting-videos/) mô tả chính sách tháng 7/2026, tôi chưa đọc đủ văn bản chính thức.
- **Tập 6:** [chính sách nội dung nguy hiểm](https://support.google.com/youtube/answer/2801964) không nêu tên lò vi sóng, nhưng câu "don't try this at home" riêng nó không đủ làm bối cảnh. Không hướng dẫn từng bước, dùng hình động.
