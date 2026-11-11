# Rủi ro pháp lý và chính sách

Cập nhật 2026-11-11. Đây không phải tư vấn pháp lý. Nên hỏi luật sư trước khi bật kiếm tiền.

**Hiện chưa có gì được phép đăng:** mọi ảnh và video đã sinh là bản thử, vì hai license dưới đây (MiniMax H3, Qwen-Image 2.1) chưa cho phép dùng cho bản đăng.

## MiniMax H3: rủi ro lớn nhất

Đã đọc [văn bản license](https://huggingface.co/MiniMaxAI/MiniMax-H3/raw/main/LICENSE) (ngày 2 Aug 2026).

- **Lãnh thổ bị loại:** EU, Anh, Hàn Quốc, Mỹ.
- **§V.4:** cấm dùng, tái tạo, phân phối hoặc trình chiếu kết quả sinh ra ở ngoài lãnh thổ được phép.
- **Xung đột:** khán giả mục tiêu của kênh là Mỹ/Anh, đúng các nơi bị loại. Đăng YouTube toàn cầu là trình chiếu kết quả ở đó.
- **Doanh thu trên 20 triệu USD/năm:** cần phép bằng văn bản.
- **Sản phẩm thương mại:** phải hiển thị rõ "MiniMax H3" trên giao diện. Chưa rõ cách áp dụng cho kênh video; tạm ghi trong mô tả.
- **Phụ lục A mục 12:** nội dung công khai phải nói rõ là do máy tạo.
- **Khác:** không dùng kết quả để cải thiện model AI khác. MiniMax không đòi quyền với kết quả.
- **Hướng xử lý cần cân nhắc:** xin license riêng từ MiniMax, chặn theo vùng (gần như bỏ khán giả mục tiêu), hoặc đổi model video cho bản đăng. Thử nội bộ chưa đăng thì chưa trình chiếu kết quả.
- **Vùng chạy:** bản đăng phải chạy ở data center ngoài vùng bị loại. Lượt thử 2026-11-05 chạy ở RunPod EU-RO-1 (Romania, thuộc EU) nên chỉ là bản thử.

## Các model khác

| Thành phần | Tình trạng | Hành động |
|---|---|---|
| Qwen-Image 2.1 (keyframe, khung đầu của H3) | [License](https://huggingface.co/Qwen/Qwen-Image-2.1/raw/main/LICENSE) chỉ cho nghiên cứu hoặc đánh giá; §2(b) cần license thương mại riêng | Đang dùng trong luồng này, nên mọi video dựng từ keyframe là bản thử. Trước khi đăng: xin license thương mại hoặc đổi model ảnh |
| Gemini qua WebAI-to-API (sheet nhân vật, ảnh nền) | Không phải API có hợp đồng: WebAI-to-API lái trình duyệt đăng nhập tài khoản Google cá nhân (`google_webapi`/Playwright), không phải Google AI Studio/Vertex API; chưa đọc điều khoản Gemini web áp dụng thế nào. Mọi ảnh ra có watermark SynthID | Chỉ dùng cho bản thử cục bộ. Trước khi kiếm tiền: đổi sang Google AI Studio API trả phí (`GOOGLE_AI_API_KEY`, selection `google_gemini*` có sẵn trong app, model `gemini-3.1-flash-lite-image`/`-flash-image`) và đọc điều khoản thương mại của API đó |
| Qwen3-TTS | [Apache 2.0](https://raw.githubusercontent.com/QwenLM/Qwen3-TTS/main/LICENSE); [model card VoiceDesign](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign) gắn apache-2.0 | Dùng được |

## Einstein

Hebrew University/GreenLight giữ và thực thi quyền về tên và hình ảnh Einstein.

Từ 2026-11-11 nhân vật là **Albert Einstein thật** (theo yêu cầu của người dùng), không còn là nhân vật hư cấu giống ông. Việc này bỏ hai lớp giảm rủi ro cũ: nhân vật không còn là người hư cấu, và tên Einstein nằm trong nội dung chứ không chỉ khi ghi công. Hình ảnh không đổi: ảnh thật năm 1921 (Ferdinand Schmutzer, Wikimedia Commons, public domain do tác giả mất 1928) làm identity reference. Quyền hình ảnh và nhãn hiệu của Hebrew University/GreenLight tách biệt với bản quyền ảnh, nên ảnh public domain không xoá rủi ro này. Rủi ro lớn hơn trước và chưa kiểm; cần hỏi luật sư trước khi đăng hay kiếm tiền. Các lớp giảm rủi ro còn giữ:
- nội dung hư cấu rõ ràng (hai người thật gặp nhau qua wormhole), ghi trong mô tả mỗi tập;
- không dùng tên hay ảnh thật ở tiêu đề, thumbnail, tên kênh, merch, quảng cáo, logo cho tới khi rà quyền;
- không bịa đời tư, quan điểm chính trị, tôn giáo hay phát ngôn ngoài khoa học; ngoặc kép chỉ cho câu có nguồn;
- giọng sinh bằng Qwen3-TTS, không nhái hay clone giọng thu âm thật;
- bật nhãn "AI-generated" cho mọi tập (mục YouTube).

Chưa kiểm: H3 có lọc nội dung khi tên người thật nằm trong prompt hay không (skill giữ tên ngoài phần tả cảnh cho tới khi chạy thử).

Ảnh nguồn và ghi chú: `assets/characters/real_refs/SOURCES.md`.

## Newton

Nhân vật là **Isaac Newton thật**, dùng chân dung Godfrey Kneller 1689 (public domain, tác giả mất 1723) làm identity reference. Newton mất năm 1727; chưa thấy ai thực thi quyền hình ảnh cho ông, và chưa kiểm luật hay thương hiệu nào liên quan tới tên ông. Rủi ro thấp hơn Einstein rõ rệt nhưng cùng nguyên tắc: nội dung hư cấu rõ ràng, không bịa lời và quan điểm ngoài khoa học.

## YouTube

- **Nhãn altered/synthetic:** bật cho mọi tập. [Trang trợ giúp](https://support.google.com/youtube/answer/14328491) yêu cầu công bố cảnh thực tế không có thật. Nhân vật là người thật được dựng bằng AI nên bật nhãn là bắt buộc trong cách đọc an toàn.
- **Mô tả mọi tập:** "AI-generated fictional conversation between historical figures. Made with MiniMax H3. Sources below."
- **Nội dung lặp lại:** toàn bộ hình là AI. Mỗi tập phải đổi câu hỏi, bối cảnh, cấu trúc và trò đùa; có kịch bản viết riêng và nguồn rõ. [TechCrunch](https://techcrunch.com/2026/07/20/youtube-clarifies-policies-around-ai-slop-and-upsetting-videos/) mô tả chính sách tháng 7/2026; chưa đọc đủ văn bản chính thức.
